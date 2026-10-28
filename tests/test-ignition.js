/**
 * test-ignition.js — Ignition Review (ignition/ign-analysis.js) on synthetic 100 Hz CSV logs, and the tune reader (m1pkg-ignition.js).
 * Run: node tests/test-ignition.js
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var ROOT = __dirname + '/../';

var ctx = vm.createContext({ console: console, Math: Math, Float64Array: Float64Array, Float32Array: Float32Array, Uint8Array: Uint8Array,
    Int32Array: Int32Array, Uint32Array: Uint32Array, Int16Array: Int16Array, Uint16Array: Uint16Array, Int8Array: Int8Array,
    ArrayBuffer: ArrayBuffer, DataView: DataView, TextDecoder: TextDecoder, Map: Map, Set: Set, JSON: JSON });
['lib/ld-parser.js', 've-table/worker.js', 'log-viewer/log-file.js', 'log-health/health-checks.js', 'ignition/ign-analysis.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f });
});
var IG = require('../ignition/m1pkg-ignition.js');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ', got ' + a); }

// Main: 20° everywhere at ≤ 100 kPa, 15° at 140 kPa; Alternative 2° more at part load, 1° less in boost. Blend 0 → 100 % over 0–40 % composition.
function tbl(v100, v140) { return { name: 'T', axes: [{ input: 'Engine.Speed.Reference.Engine Speed', values: [1000, 6000] }, { input: 'Engine.Load.Normalised.Value', values: [100, 140] }], v: [[v100, v100], [v140, v140]] }; }
var IAT = { name: 'Inlet.Air.Temperature.Ignition Timing Compensation', axes: [{ input: 'Inlet.Air.Temperature.Value', values: [40, 60, 80] }], v: [[0, -1.5, -3]] };
function trim(r) { return { name: 'trim', axes: [{ input: 'x', values: [2000] }, { input: 'y', values: [100, 140] }], v: [[0], [r]] }; }
var TUNE = { tuneName: 'T', loadIsMap: true, main: tbl(20, 15), alt: tbl(22, 14), blend: { x: [0, 40, 100], y: [0, 100, 100] }, slice: { index: 0, label: 'A', differ: false },
    compensations: [IAT], cylinderTrims: [trim(-1), trim(0), trim(-1), trim(0), trim(-1.5), trim(0), trim(-2), trim(0)],
    knock: { threshold: { rpm: [1000, 6000], load: null, values: [[20, 30]] }, inputs: ['Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2'] } };

/** 100 Hz MoTeC CSV; row(t) → overrides. Timing follows the tune unless `offset(t)` adds to it. */
function csv(seconds, row) {
    var names = ['Engine Speed', 'Inlet Manifold Pressure', 'Ignition Timing', 'Ignition Timing Compensation', 'Ignition Timing State', 'Fuel Composition', 'Inlet Air Temperature'];
    for (var c = 1; c <= 8; c++) names.push('Ignition Cylinder ' + c + ' Knock Level');
    var lines = ['Time,' + names.join(','), 's,' + names.map(function () { return ''; }).join(',')];
    for (var i = 0; i < seconds * 100; i++) {
        var t = i / 100, o = Object.assign({ rpm: 3000, map: 100, iat: 60, comp: 45, state: 0, off: 0, knock: [2, 0.2, 2, 0.2, 2, 0.2, 2, 0.2] }, row ? row(t) : {});
        var m = o.map <= 100 ? 20 : o.map >= 140 ? 15 : 20 - 5 * (o.map - 100) / 40, a = o.map <= 100 ? 22 : o.map >= 140 ? 14 : 22 - 8 * (o.map - 100) / 40;
        var b = Math.min(1, o.comp / 40), iatComp = o.iat <= 40 ? 0 : o.iat >= 80 ? -3 : -1.5 * (o.iat - 40) / 20;   // IAT table: 0 / −1.5 / −3 at 40 / 60 / 80 °C
        var ign = m + (a - m) * b + iatComp + o.off;
        lines.push([t.toFixed(2), o.rpm, o.map, ign.toFixed(3), iatComp.toFixed(3), o.state, o.comp, o.iat].concat(o.knock).join(','));
    }
    return lines.join('\n');
}
function run(text, tune) { ctx.text = text; ctx.tune = tune === undefined ? TUNE : tune; return vm.runInContext('igAnalyze(lvOpenLog(text, "x.csv"), tune)', ctx); }
function find(r, re) { return r.findings.filter(function (f) { return re.test(f.title); }); }

test('timing that follows the tune is fully accounted for; composition above the blend runs the Alternative table', function () {
    var r = run(csv(60, function (t) { return { map: t < 30 ? 90 : 120 }; }));
    var f = find(r, /follows the tune/)[0];
    assert.ok(f && f.severity === 'ok', JSON.stringify(r.findings.map(function (x) { return x.title; })));
    near(r.blendPct, 100, 1e-6);
    assert.strictEqual(find(r, /below the tune|above the tune/).length, 0);
});

test('a steady stretch below the tune is listed; a jump during a fast load change is not', function () {
    var r = run(csv(60, function (t) { return { off: t > 20 && t < 21.5 ? -3 : 0 }; }));
    var f = find(r, /below the tune/)[0];
    assert.ok(f && /1 episode, 1\.5 s/.test(f.title) && /up to 3\.0°/.test(f.detail), f && f.title + ' / ' + f.detail);
    r = run(csv(60, function (t) { return { map: t < 20 ? 60 : 120, off: t > 19.9 && t < 20.3 ? -3 : 0 }; }));
    assert.strictEqual(find(r, /below the tune/).length, 0);
});

test('compensation is explained by the IAT table, and what it took under boost is reported', function () {
    var r = run(csv(60, function (t) { return { map: t < 30 ? 80 : 120, iat: 70 }; }));
    var f = find(r, /Ignition Timing Compensation: median -2\.3°/)[0];
    assert.ok(f && f.severity === 'ok' && /Inlet Air Temperature -2\.3° median/.test(f.detail), f && f.title + ' / ' + f.detail);
    assert.ok(find(r, /Under boost, inlet air temperature 70–70 °C took 2\.3° out/).length);
});

test('flex: Alternative with less advance in boost rows, and trims only on the louder knock input', function () {
    var r = run(csv(60));
    var f = find(r, /less advance than Main at 140 kPa/)[0];
    assert.ok(f && f.severity === 'warn', JSON.stringify(r.findings.map(function (x) { return x.title; })));
    var ct = find(r, /Retard trims only on Knock Input 1 cylinders/)[0];
    assert.ok(ct && /cylinders 2\/4\/6\/8 have none and Knock Input 2 reads 10\.0× lower/.test(ct.title), ct && ct.title);
    assert.strictEqual(r.cylinders[6].retard, -2);
    assert.strictEqual(r.cylinders[6].retardFrom, 140);
});

test('states are counted; cells carry timing and knock margin', function () {
    var r = run(csv(60, function (t) { return { state: t < 20 ? 5 : 0, rpm: t < 20 ? 850 : 3000, knock: t < 20 ? [1, 1, 1, 1, 1, 1, 1, 1] : [21, 1, 1, 1, 1, 1, 1, 1] }; }));
    assert.strictEqual(r.states.map(function (s) { return s.name; }).join(), 'Normal,Idle');
    var cell = r.cells.filter(function (x) { return x.rpm === 1000 || x.rpm === 6000; })[0];
    assert.ok(cell && cell.seconds > 30, JSON.stringify(r.cells));
    assert.ok(find(r, /Knock level reaches/).length, 'a 21 % level against 24 % (the threshold at 3000 rpm) is ≥ 80 %');
});

test('tune reader: dBTDC = −stored, Main Switch slice, 1-D compensation, zero tables skipped', function () {
    function ax(axis, input, unit, values, max) { return { axis: axis, input: input, unit: unit, maxSites: max || values.length, sites: values.length, values: values }; }
    var main = { name: 'Ignition.Timing.Main', kind: 'Table', unit: 'deg', axes: [ax('X', 'Engine.Speed.Reference.Engine Speed', 'deg/s', [6000, 12000]),
        ax('Y', 'Engine.Load.Normalised.Value', 'ratio', [1, 1.4]), { axis: 'Z', input: 'Driver.Ignition Timing Main Switch.Value', maxSites: 2, sites: null, values: null }],
        values: [-20, -21, -15, -16, -10, -11, -5, -6] };
    var iat = { name: 'Inlet.Air.Temperature.Ignition Timing Compensation', kind: 'Table', unit: 'deg', axes: [ax('X', 'Inlet.Air.Temperature.Value', 'C', [40, 60], 3),
        ax('Y', 'Engine.Load.Normalised.Value', 'ratio', [0], 2)], values: [0, 1.5, 0, 0, 0, 0] };
    var cool = { name: 'Coolant.Temperature.Ignition Timing Compensation', kind: 'Table', unit: 'deg', axes: [ax('X', 'Coolant.Temperature.Value', 'C', [0])], values: [0] };
    var pkg = { tuneName: 'T', items: [main, iat, cool, { name: 'Engine.Load.Normalised.Mode', label: 'Inlet Manifold Pressure' },
        { name: 'Driver.Ignition Timing Main Switch.Mapping.Default.Value', label: 'B' }, { name: 'Engine.Cylinders', value: 4 }] };
    var t = IG.m1pkgIgnition(pkg);
    assert.ok(t.loadIsMap);
    assert.deepStrictEqual(t.main.axes[0].values, [1000, 2000]);
    assert.deepStrictEqual(t.main.axes[1].values, [100, 140]);
    assert.deepStrictEqual(t.main.v, [[10, 11], [5, 6]], 'slice B, sign flipped');
    assert.ok(t.slice.differ && t.slice.label === 'B');
    assert.deepStrictEqual(t.compensations.map(function (c) { return c.name; }), ['Inlet.Air.Temperature.Ignition Timing Compensation']);
    assert.strictEqual(t.compensations[0].axes.length, 1);
    assert.deepStrictEqual(t.compensations[0].v, [[0, -1.5]]);
    assert.strictEqual(t.cylinderTrims.length, 4);
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
