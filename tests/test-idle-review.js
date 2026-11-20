/**
 * test-idle-review.js — Idle page pull-aways and feed forward by coolant (idle/idle-review.js), the pedal settings read by
 * m1pkg-idle.js, and the Log Health start review (lhCheckStarts), on synthetic 100 Hz CSV logs.
 * Run: node tests/test-idle-review.js
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var ROOT = __dirname + '/../';

var ctx = vm.createContext({ console: console, Math: Math, Float64Array: Float64Array, Float32Array: Float32Array, Uint8Array: Uint8Array,
    Int32Array: Int32Array, Uint32Array: Uint32Array, Int16Array: Int16Array, Uint16Array: Uint16Array, Int8Array: Int8Array,
    ArrayBuffer: ArrayBuffer, DataView: DataView, TextDecoder: TextDecoder, Map: Map, Set: Set });
['lib/ld-parser.js', 've-table/worker.js', 'log-viewer/log-file.js', 'log-health/health-checks.js', 'idle/idle-review.js', 'idle/m1pkg-idle.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f });
});

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/** 100 Hz MoTeC CSV: base values, overridden per row by row(t). A running engine speed gets a little ripple (a perfectly constant
 *  one reads as a logging hold). */
function csv(seconds, base, row) {
    var names = Object.keys(base), lines = ['Time,' + names.join(','), 's,' + names.map(function () { return ''; }).join(',')];
    for (var i = 0; i < seconds * 100; i++) {
        var t = i / 100, v = Object.assign({}, base, row(t));
        if (v['Engine Speed'] > 400) v['Engine Speed'] += 3 * Math.sin(t * 7);
        lines.push(t.toFixed(2) + ',' + names.map(function (n) { return v[n]; }).join(','));
    }
    return lines.join('\n');
}
function open(text) { ctx.text = text; return vm.runInContext('lvOpenLog(text, "x.csv")', ctx); }
function review(text, tune) { ctx.L = open(text); ctx.T = tune || null; return JSON.parse(JSON.stringify(vm.runInContext('irAnalyze(L, T)', ctx))); }
function find(r, re) { return r.findings.filter(function (f) { return re.test(f.title); }); }

var IDLE_BASE = { 'Engine Speed': 900, 'Idle Aim': 900, 'Vehicle Speed': 0, 'Throttle Pedal': 0, 'Throttle Pedal Sensor': -1, 'Throttle Aim': 10,
    'Throttle Aim State': 1, 'Idle State': 1, 'Idle Mass Flow': 50, 'Idle Mass Flow Feed Forward': 50, 'Coolant Temperature': 70, 'Clutch State': 2,
    'Gear': 0, 'Ignition Timing': 13 };

/** A tune as m1pkgIdle returns it: throttle aim maximum 20 %, translation 0/6/14/24 % at 0/10/20/30 % pedal, coolant rows 60 / 80 °C. */
var TUNE = { tuneName: 'T', integralMin: -10, integralMax: 30, pGain: 0.01, throttleAimMax: 20, pedalThreshold: 0,
    pedalTranslation: { sensor: [0, 10, 20, 30, 100], rpm: [0], yInput: 'Engine.Speed.Reference.Engine Speed', rows: [[0, 6, 14, 24, 100]] },
    feedForward: { aim: [800, 900, 1000], coolant: [60, 80], values: [[44, 46, 48], [40, 42, 44]], coolantAxis: true }, aimMain: null, notes: [] };

test('m1pkgIdle reads the throttle aim maximum, pedal threshold and pedal translation in display units', function () {
    var pkg = { tuneName: 'T', items: [
        { name: 'Idle.Actuator.Throttle Aim.Maximum', value: 0.2 }, { name: 'Idle.Activate.Throttle Pedal.Threshold', value: 0.01 },
        { name: 'Throttle.Pedal.Translation', kind: 'Table', values: [0, 0.06, 0.14, 1, 0, 0, 0.1, 0.18, 1, 0], axes: [
            { axis: 'X', input: 'Throttle.Pedal.Sensor.Value', unit: 'ratio', maxSites: 5, sites: 4, values: [0, 0.1, 0.2, 1, 0] },
            { axis: 'Y', input: 'Engine.Speed.Reference.Engine Speed', unit: 'deg/s', maxSites: 2, sites: 2, values: [6000, 12000] }] }] };
    var t = JSON.parse(JSON.stringify(ctx.m1pkgIdle(pkg)));
    assert.deepStrictEqual([t.throttleAimMax, t.pedalThreshold], [20, 1]);
    assert.deepStrictEqual(t.pedalTranslation.sensor, [0, 10, 20, 100]);
    assert.deepStrictEqual(t.pedalTranslation.rpm, [1000, 2000]);
    assert.deepStrictEqual(t.pedalTranslation.rows, [[0, 6, 14, 100], [0, 10, 18, 100]]);
});

test('a pull-away where the pedal stays below the idle opening is found, with the translation change that fixes it', function () {
    // Stopped 0–20 s; at 14 s the pedal goes to 8 % (sensor 13 %) but Throttle Aim stays at the 10 % idle opening (State Idle),
    // idle control off, and engine speed falls 900 → 450 by 16 s; at 16.5 s the pedal passes 14 % and the car moves at 20 s.
    var text = csv(40, IDLE_BASE, function (t) {
        if (t < 14) return {};
        if (t < 16.5) return { 'Throttle Pedal': 8, 'Throttle Pedal Sensor': 13, 'Idle State': 0, 'Engine Speed': 900 - 450 * Math.min(1, (t - 14) / 2) };
        return { 'Throttle Pedal': 16, 'Throttle Pedal Sensor': 22, 'Throttle Aim': 16, 'Throttle Aim State': 0, 'Idle State': 0, 'Engine Speed': 1200,
                 'Vehicle Speed': t < 20 ? 0 : (t - 20) * 5, 'Clutch State': 1, 'Gear': 1 };
    });
    var r = review(text, TUNE);
    assert.strictEqual(r.pullAways.length, 1);
    var p = r.pullAways[0];
    assert.ok(Math.abs(p.t - 20) < 0.2 && p.outcome === 'near stall' && p.minInDeadBand, JSON.stringify(p));
    assert.ok(Math.abs(p.deadBandS - 2.5) < 0.1 && p.deadBandDrop > 400 && Math.abs(p.deadBandThrottle - 10) < 0.01, JSON.stringify(p));
    var f = find(r, /throttle held at the idle opening in 1 pull-away/)[0];
    assert.ok(f && f.severity === 'warn', JSON.stringify(r.findings.map(function (x) { return x.title; })));
    // Translation reaches 10 % at 15 % pedal; 10 % site 6 → 11 (idle opening + 0.5, rounded up), 20 % site 14 → (11 + 24) / 2 ≈ 18.
    assert.ok(/reaches 10\.0 % at 15\.0 % pedal/.test(f.detail) && /10 % pedal site from 6\.0 to about 11 %/.test(f.detail) && /20 % from 14\.0 to about 18 %/.test(f.detail), f.detail);
    assert.ok(/Throttle Pedal Threshold is 0\.0 %/.test(f.detail) && /add sites/.test(f.detail), f.detail);
    assert.ok(/dead band from 15\.0 % to 9\.5 % of pedal travel/.test(f.detail), f.detail);
    // A linear translation already passes the 10 % opening at the 10 % site: no "raise 10 → 10", say what is left instead.
    var lin = JSON.parse(JSON.stringify(TUNE));
    lin.pedalTranslation.rows = [[0, 10, 20, 30, 100]];
    var g = find(review(text, lin), /idle opening in 1 pull-away/)[0];
    assert.ok(!/Raising the 10 %/.test(g.detail) && /already passes the idle opening/.test(g.detail) && /first 10\.0 % of pedal travel/.test(g.detail), g.detail);
});

test('a dip with the pedal past the idle opening is a torque dip, not the dead band', function () {
    var text = csv(40, IDLE_BASE, function (t) {
        if (t < 14) return {};
        return { 'Throttle Pedal': 11.5, 'Throttle Pedal Sensor': 18, 'Throttle Aim': 11.5, 'Throttle Aim State': 0, 'Idle State': 0, 'Clutch State': 1,
                 'Engine Speed': t < 15 ? 1100 : t < 17 ? 1100 - 300 * (t - 15) : 700, 'Vehicle Speed': t < 15 ? 0 : (t - 15) * 4 };
    });
    var r = review(text, TUNE);
    assert.strictEqual(r.pullAways[0].outcome, 'dip');
    assert.strictEqual(find(r, /idle opening in/).length, 0);
    var f = find(r, /1 dip with the pedal opening the throttle/)[0];
    assert.ok(f && /throttle 11\.5 %, idle opening 10\.0 %/.test(f.detail) && /barely past the dead band/.test(f.detail), f && f.detail);
});

test('feed forward: a gap at 70 °C counts half toward the 60 and 80 °C rows, with the cells it used', function () {
    // 60 s of steady idle at 70 °C, aim 900, the controller taking 4 % away.
    var r = review(csv(60, IDLE_BASE, function () { return { 'Idle Mass Flow': 46 }; }), TUNE);
    assert.strictEqual(r.ffRows.length, 2);
    r.ffRows.forEach(function (row) {
        assert.ok(Math.abs(row.delta + 4) < 0.01 && Math.abs(row.seconds - 27.5) < 1 && row.suggest, JSON.stringify(row));
        assert.strictEqual(row.cells.length, 1);
        assert.strictEqual(row.cells[0].aim, 900);
    });
    assert.deepStrictEqual(r.ffRows.map(function (row) { return [row.cells[0].value, row.cells[0].suggested]; }), [[46, 42], [42, 38]]);
    var f = find(r, /Idle feed forward off by -4\.0 % at 60 °C, -4\.0 % at 80 °C/)[0];
    assert.ok(f && f.severity === 'warn' && /lowers the throttle opening/.test(f.detail), JSON.stringify(r.findings.map(function (x) { return x.title; })));
});

test('Log Health starts: an attempt that catches and dies, low-side pressure falling while cranking, then a start', function () {
    var base = { 'Engine Speed': 0, 'Fuel Pressure': 480, 'Fuel Pressure Direct Bank 1': 5, 'Coolant Temperature': 18, 'Inlet Manifold Pressure': 100 };
    var text = csv(40, base, function (t) {
        if (t < 2) return {};
        if (t < 3) return { 'Engine Speed': 180, 'Fuel Pressure': 480 - 300 * (t - 2) };   // cranking, low side falling to 180
        if (t < 4) return { 'Engine Speed': 750, 'Fuel Pressure': 180 };                    // caught above 600
        if (t < 5) return { 'Engine Speed': 750 - 700 * (t - 4), 'Fuel Pressure': 180 };    // fell back
        if (t < 8) return { 'Fuel Pressure': 180 };                                         // stopped
        if (t < 9) return { 'Engine Speed': 180 };                                          // second attempt
        return { 'Engine Speed': 1100 + 30 * Math.sin(t * 5) };                             // ran
    });
    ctx.L = open(text);
    ctx.O = { tune: { start: { runThreshold: 600, pumpPrime: 5, pumpHold: 1 }, banks: [1, 2, 1, 2, 1, 2, 1, 2] } };
    var r = JSON.parse(JSON.stringify(vm.runInContext('lhAnalyze(L, O)', ctx)));
    var s = r.findings.filter(function (f) { return f.group === 'Starting'; });
    assert.strictEqual(s.length, 1, JSON.stringify(s));
    assert.ok(/Start at 0:02\.0: ran on attempt 2/.test(s[0].title) && s[0].severity === 'warn', s[0].title);
    assert.ok(/attempt 1 at 0:02\.0: reached 600 rpm after 1\.0 s, up to 75\d rpm/.test(s[0].detail) && /fell back and died/.test(s[0].detail), s[0].detail);
    assert.ok(/Low-side Fuel Pressure fell to 18\d kPa while cranking/.test(s[0].detail) && /Fuel Pump Prime is 5 s and Hold 1 s/.test(s[0].detail), s[0].detail);
    // The dying attempt is part of the start, not a separate stall.
    assert.strictEqual(r.findings.filter(function (f) { return /Engine stopped at|nearly stalled/.test(f.title); }).length, 0);
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
