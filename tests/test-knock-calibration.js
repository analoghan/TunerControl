/**
 * test-knock-calibration.js — Knock Threshold and Knock Cylinder Gain suggestions (knock/knock-calibration.js) on synthetic
 * 100 Hz rows, and the gains read from a tune (m1pkg-knock.js).
 * Run: node tests/test-knock-calibration.js
 */

'use strict';

var assert = require('assert');
var K = require('../knock/knock-calibration.js');
var M = require('../knock/m1pkg-knock.js');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ', got ' + a); }

// Columns: 0 time, 1 rpm, 2 map, 3 coolant, 4 overrun, 5–12 knock level cyl 1–8
var CH = { rpm: 1, map: 2, coolant_temp: 3, overrun: 4, load_norm: -1 };
for (var c = 1; c <= 8; c++) { CH['knock_cyl_' + c] = 4 + c; CH['knock_trim_' + c] = -1; }
var INPUTS = ['Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2'];
var THR = { rpm: [1000, 3000, 5000], load: null, values: [[20, 20, 30]] };

/** Rows of `seconds` at 100 Hz; f(t, i) → { rpm, map, levels: [8] } overrides. Levels wobble ±10 % so percentiles differ from medians. */
function rows(seconds, f) {
    var out = [];
    for (var i = 0; i < seconds * 100; i++) {
        var t = i / 100, o = f(t, i), w = 1 + 0.1 * Math.sin(i * 0.7);
        out.push([t, o.rpm, o.map, 85, 0].concat(o.levels.map(function (l) { return l * w; })));
    }
    return out;
}
function levels(a, b) { return [a, b, a, b, a, b, a, b]; }

test('even banks: no gain changes; a quiet cylinder on its input gets a higher gain', function () {
    var d = rows(60, function () { return { rpm: 3000, map: 100, levels: [4, 4, 4, 4, 2.8, 4, 4, 4] }; });
    var r = K.knockCalibrate(d, CH, { threshold: THR, gains: [100, 100, 100, 100, 100, 100, 100, 100], inputs: INPUTS });
    var g5 = r.gains[4];
    assert.ok(g5.suggested > 130 && g5.suggested < 150, JSON.stringify(g5));
    assert.strictEqual(r.gains[0].change, null);
    assert.strictEqual(r.weakGroup, null);
});

test('a knock input reading 10x lower is flagged and its cylinders get no gain changes', function () {
    var d = rows(60, function () { return { rpm: 3000, map: 100, levels: [3, 0.3, 3, 0.25, 3, 0.35, 3, 0.3] }; });
    var r = K.knockCalibrate(d, CH, { threshold: THR, gains: [100, 100, 100, 100, 100, 100, 100, 100], inputs: INPUTS });
    assert.strictEqual(r.weakGroup.input, 'Knock Input 2');
    [1, 3, 5, 7].forEach(function (i) { assert.strictEqual(r.gains[i].change, null); });
    assert.ok(r.notes.some(function (n) { return /Knock Input 2 reads/.test(n); }));
});

test('threshold: ≥ 10 s at load sets noise × 1.25; less data at load never lowers it', function () {
    var d = rows(30, function (t) { return { rpm: 3000, map: t < 15 ? 110 : 50, levels: levels(4, 4) }; });
    var r = K.knockCalibrate(d, CH, { threshold: THR, inputs: INPUTS });
    var row = r.threshold.filter(function (x) { return x.rpm === 3000; })[0];
    near(row.noise, 4.4, 0.05);
    assert.strictEqual(row.suggested, 5.5);
    assert.strictEqual(row.action, 'lower');
    d = rows(30, function (t) { return { rpm: 3000, map: t < 5 ? 110 : 50, levels: levels(4, 4) }; });
    row = K.knockCalibrate(d, CH, { threshold: THR, inputs: INPUTS }).threshold.filter(function (x) { return x.rpm === 3000; })[0];
    assert.strictEqual(row.suggested, null);
    assert.ok(/before lowering/.test(row.note), row.note);
});

test('part-load noise above the threshold raises it, unless one cylinder stands out (maybe real knock)', function () {
    var d = rows(30, function () { return { rpm: 3000, map: 50, levels: levels(18, 18) }; });
    var row = K.knockCalibrate(d, CH, { threshold: THR, inputs: INPUTS }).threshold.filter(function (x) { return x.rpm === 3000; })[0];
    assert.strictEqual(row.action, 'raise');
    assert.strictEqual(row.suggested, 24.5);   // 18 × 1.0996 (99.5th percentile of the wobble) × 1.25, to 0.5
    d = rows(30, function () { return { rpm: 3000, map: 50, levels: [18, 3, 3, 3, 3, 3, 3, 3] }; });
    row = K.knockCalibrate(d, CH, { threshold: THR, inputs: INPUTS }).threshold.filter(function (x) { return x.rpm === 3000; })[0];
    assert.strictEqual(row.suggested, null);
    assert.ok(/check for real knock/.test(row.note), row.note);
});

test('levels above the current threshold (and 0.5 s around them) are not counted as noise', function () {
    var d = rows(30, function (t) { return { rpm: 3000, map: 110, levels: t > 10 && t < 10.2 ? [60, 4, 4, 4, 4, 4, 4, 4] : levels(4, 4) }; });
    var row = K.knockCalibrate(d, CH, { threshold: THR, inputs: INPUTS }).threshold.filter(function (x) { return x.rpm === 3000; })[0];
    near(row.noise, 4.4, 0.05);
});

test('with the frequency far off, measurements only', function () {
    var d = rows(30, function () { return { rpm: 3000, map: 110, levels: [4, 4, 4, 4, 2.5, 4, 4, 4] }; });
    var r = K.knockCalibrate(d, CH, { threshold: THR, gains: [100, 100, 100, 100, 100, 100, 100, 100], inputs: INPUTS, frequencyOk: false });
    assert.ok(r.gains.every(function (g) { return g.change === null; }));
    assert.ok(r.threshold.every(function (t) { return t.suggested === null; }));
    assert.ok(r.notes.some(function (n) { return /Choose the frequency first/.test(n); }));
});

test('threshold lookup and the tune\'s cylinder gains', function () {
    near(K.kcalThresholdAt(THR, 4000), 25, 1e-9);
    near(K.kcalThresholdAt(THR, 500), 20, 1e-9);
    assert.strictEqual(K.kcalThresholdAt(null, 3000), Infinity);
    var pkg = { tuneName: 'T', items: [{ name: 'Knock.Cylinder 1.Gain.Value', value: 1 }, { name: 'Knock.Cylinder 5.Gain.Value', value: 0.85 }] };
    var g = M.m1pkgKnock(pkg).gains;
    assert.deepStrictEqual([g[0], g[4], g[1]], [100, 85, null]);
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
