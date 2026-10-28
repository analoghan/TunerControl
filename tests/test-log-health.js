/**
 * test-log-health.js — Log Health checks (log-health/health-checks.js) on synthetic 100 Hz CSV logs with planted faults,
 * the tune reader (m1pkg-health.js) and channel enum matching.
 * Run: node tests/test-log-health.js
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var ROOT = __dirname + '/../';

var ctx = vm.createContext({ console: console, Math: Math, Float64Array: Float64Array, Float32Array: Float32Array, Uint8Array: Uint8Array,
    Int32Array: Int32Array, Uint32Array: Uint32Array, Int16Array: Int16Array, Uint16Array: Uint16Array, Int8Array: Int8Array,
    ArrayBuffer: ArrayBuffer, DataView: DataView, TextDecoder: TextDecoder, Map: Map, Set: Set });
['lib/ld-parser.js', 've-table/worker.js', 'log-viewer/log-file.js', 'log-health/health-checks.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f });
});
var H = require('../log-health/m1pkg-health.js');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/** 100 Hz MoTeC CSV with these channels; row(t) → { channel: value } overrides the defaults. */
function csv(seconds, row) {
    var base = { 'Engine Speed': 0, 'Inlet Manifold Pressure': 40, 'Ambient Pressure': 100, 'Coolant Temperature': 85, 'Exhaust Lambda Bank 1': 1,
        'Exhaust Lambda Bank 2': 1, 'Fuel Mixture Aim': 1, 'Fuel Pressure': 480, 'Fuel Pressure Sensor': 480, 'Engine Oil Pressure': 400,
        'ECU Battery Voltage': 14.2, 'CAN Bus 2 Diagnostic': 1, 'Inlet Air Temperature': 30, 'Fuel Composition': 45, 'Fuel Stoichiometric Ratio': 12.5 };
    var names = Object.keys(base), lines = ['Time,' + names.join(','), 's,' + names.map(function () { return ''; }).join(',')];
    for (var i = 0; i < seconds * 100; i++) {
        var t = i / 100, v = Object.assign({}, base, { 'Engine Speed': 2000 + 50 * Math.sin(t * 3) }, row ? row(t) : {});
        lines.push(t.toFixed(2) + ',' + names.map(function (n) { return v[n]; }).join(','));
    }
    return lines.join('\n');
}
function run(text, opts) { ctx.text = text; ctx.opts = opts || {}; return vm.runInContext('lhAnalyze(lvOpenLog(text, "x.csv"), opts)', ctx); }
function find(r, re) { return r.findings.filter(function (f) { return re.test(f.title); }); }

test('a clean log passes the core checks', function () {
    var r = run(csv(120));
    assert.strictEqual(r.counts.fail, 0, JSON.stringify(r.findings.filter(function (f) { return f.severity === 'fail'; })));
    assert.ok(find(r, /MAP plausible/).length);
    assert.ok(find(r, /Bank 1 vs bank 2 lambda/)[0].severity === 'ok');
});

test('negative MAP and nonsense ambient pressure fail', function () {
    var r = run(csv(120, function (t) { return { 'Inlet Manifold Pressure': t > 50 && t < 52 ? -3 : 40, 'Ambient Pressure': 38 }; }));
    assert.strictEqual(find(r, /MAP reads -3\.0 kPa/)[0].severity, 'fail');
    assert.strictEqual(find(r, /Ambient Pressure reads 38/)[0].severity, 'fail');
});

test('a hold is reported with the temperature jump across it, and the jump is not a sensor fault', function () {
    var r = run(csv(120, function (t) {
        if (t >= 40 && t < 41) return { 'Engine Speed': 1500, 'Coolant Temperature': 85 };
        return { 'Coolant Temperature': t < 40 ? 85 : 60 };
    }));
    var hold = find(r, /held for 1\.0 s at 0:40\.0/)[0];
    assert.ok(hold && /Coolant Temperature 85\.0 → 60\.0/.test(hold.detail), JSON.stringify(hold));
    assert.strictEqual(find(r, /Coolant Temperature jumps/).length, 0);
});

test('a value the ECU substituted for its sensor is caught; a short filter lag is not', function () {
    var r = run(csv(120, function (t) { return { 'Fuel Pressure Sensor': t > 60 && t < 65 ? 300 : 480 }; }));
    assert.ok(find(r, /Fuel Pressure differs from its sensor reading/).length);
    r = run(csv(120, function (t) { return { 'Fuel Pressure Sensor': t > 60 && t < 60.5 ? 470 : 480 }; }));
    assert.strictEqual(find(r, /differs from its sensor/).length, 0);
});

test('lambda bank split, stuck sensor and trims are judged', function () {
    var r = run(csv(120, function () { return { 'Exhaust Lambda Bank 1': 1.06 }; }));
    assert.strictEqual(find(r, /Bank 1 vs bank 2 lambda: \+6\.0/)[0].severity, 'warn');
    assert.ok(find(r, /never changed while running/).length, 'constant Inlet Air Temperature is stuck');
});

test('diagnostic codes use the firmware enum (matched by a cut-short name) and severity', function () {
    var enums = { 'CAN Bus 2 Diagnostic': { 0: { name: 'Not in Use', tag: null }, 1: { name: 'OK', tag: null }, 5: { name: 'Transmit Overrun', tag: 'warning' } } };
    var r = run(csv(120, function (t) { return { 'CAN Bus 2 Diagnostic': t > 30 && t < 31 ? 5 : 1 }; }), { enums: enums });
    var f = find(r, /CAN Bus 2 Diagnostic: Transmit Overrun/)[0];
    assert.ok(f && f.severity === 'warn' && /1\.0 s in 1 stretch/.test(f.detail), JSON.stringify(f));
    r = run(csv(120, function (t) { return { 'CAN Bus 2 Diagnostic': t > 30 && t < 31 ? 5 : 1 }; }));
    assert.ok(find(r, /code 5/).length, 'without the tune the code is reported by number');
    var cut = { 'Inlet Manifold Pressure Sensor Diagnostic': { 1: { name: 'OK' } }, 'Inlet Manifold Pressure Sensor Diagnostic Extra': {} };
    assert.strictEqual(ctx.lhEnumFor(cut, 'Inlet Manifold Pressure Sensor D'), cut['Inlet Manifold Pressure Sensor Diagnostic']);
});

test('fuel model: mixture aim explained by the alternative fuel blend, stoich vs ethanol content', function () {
    var tune = { fuel: { stoich: 14.7, density: 755, altStoich: 9.85, altDensity: 777, compositionMode: 'Sensor' },
        aim: { main: { x: [0, 8000], y: [0, 300], v: [[1, 1], [1, 1]] }, alt: { x: [0, 8000], y: [0, 300], v: [[0.93, 0.93], [0.93, 0.93]] },
               blend: { x: [0, 100], y: [0, 100] } },
        clTrim: { min: -15, max: 15 }, banks: [1, 2, 1, 2, 1, 2, 1, 2] };
    // 45 % composition → blend 45 % → aim 1 − 0.07 × 0.45 = 0.9685
    var r = run(csv(120, function () { return { 'Fuel Mixture Aim': 0.9685 }; }), { tune: tune });
    var aim = find(r, /Fuel Mixture Aim runs 0\.03\d λ richer than Fuel Mixture Aim Main — the alternative fuel blend/)[0];
    assert.ok(aim && aim.severity === 'info', JSON.stringify(r.findings.map(function (f) { return f.title; })));
    var st = find(r, /assumes the alternative fuel is stoich 9\.85/)[0];
    assert.ok(st && /stoich ≈ 12\.0/.test(st.detail) && st.severity === 'warn', st && st.detail);
});

test('tune reader: trim limits stored as multipliers read as ± %, cylinder banks, MAP translation', function () {
    function item(name, extra) { return Object.assign({ name: name }, extra); }
    var pkg = { tuneName: 'T', items: [
        item('Fuel.Properties.Stoichiometric Ratio', { value: 14.7 }), item('Fuel.Properties.Density', { value: 755 }),
        item('Fuel.Closed Loop.Control.Trim.Minimum.Value', { kind: 'Table', values: [0.85, 0.9], axes: [{ sites: 2, maxSites: 2, values: [0, 1] }] }),
        item('Fuel.Closed Loop.Control.Trim.Maximum.Value', { kind: 'Table', values: [1.15, 1.1], axes: [{ sites: 2, maxSites: 2, values: [0, 1] }] }),
        item('Engine.Cylinders', { value: 4 }), item('Engine.Cylinder 2.Bank', { value: 1 }),
        item('Inlet.Manifold.Pressure.Sensor.Translation', { kind: 'Table', values: [-17000, 353000], axes: [{ sites: 2, values: [0, 5] }] })] };
    var h = H.m1pkgHealth(pkg);
    assert.deepStrictEqual([Math.round(h.clTrim.min), Math.round(h.clTrim.max)], [-15, 15]);
    assert.deepStrictEqual(h.banks, [1, 1, 1, 2]);
    assert.deepStrictEqual([Math.round(h.map.at0), Math.round(h.map.at5)], [-17, 353]);
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
