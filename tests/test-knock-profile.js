/**
 * test-knock-profile.js — Knock Noise Profile (knock/knock-profile.js) on synthetic 100 Hz CSV logs: a hump at every load and gear
 * reads as noise, one only under load as possible knock, and the timing test between logs in both directions.
 * Run: node tests/test-knock-profile.js
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var ROOT = __dirname + '/../';

var ctx = vm.createContext({ console: console, Math: Math, Float64Array: Float64Array, Float32Array: Float32Array, Uint8Array: Uint8Array,
    Int32Array: Int32Array, Uint32Array: Uint32Array, Int16Array: Int16Array, Uint16Array: Uint16Array, Int8Array: Int8Array,
    ArrayBuffer: ArrayBuffer, DataView: DataView, TextDecoder: TextDecoder, Map: Map, Set: Set, self: { postMessage: function () {} } });
['lib/ld-parser.js', 've-table/worker.js', 'log-viewer/log-file.js', 'log-health/health-checks.js', 'knock/knock-profile.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f });
});

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var TUNE = { tuneName: 'T', threshold: { rpm: [1000, 6000], load: null, values: [[20, 20]] }, gains: [100, 100, 100, 90, 70, 85, 75, 75] };

/**
 * 160 s, engine speed sweeping 2000 → 4000 rpm every 40 s (8 s per 100 rpm band); cycles alternate 40 / 80 kPa and gear 2 / 3.
 * Every cylinder reads 5 % ± 1.5 (25 % of a 20 % threshold); extra(cyl, rpm, kpa) adds to it. timing = 26° + timingOffset.
 */
function log(extra, timingOffset) {
    var names = ['Engine Speed', 'Inlet Manifold Pressure', 'Coolant Temperature', 'Gear', 'Ignition Timing'];
    for (var c = 1; c <= 8; c++) names.push('Ignition Cylinder ' + c + ' Knock Level');
    var lines = ['Time,' + names.join(','), 's,' + names.map(function () { return ''; }).join(',')];
    for (var i = 0; i < 16000; i++) {
        var t = i / 100, cyc = Math.floor(t / 40), rpm = 2000 + (t % 40) / 40 * 2000, kpa = cyc % 2 ? 80 : 40, gear = cyc < 2 ? 2 : 3;
        var row = [t.toFixed(2), rpm.toFixed(1), kpa, 85, gear, (26 + (timingOffset || 0)).toFixed(1)];
        for (c = 1; c <= 8; c++) row.push((5 + 1.5 * Math.sin(t * 13.7 + c) + (extra ? extra(c, rpm, kpa) : 0)).toFixed(2));
        lines.push(row.join(','));
    }
    return lines.join('\n');
}
function run(texts, tune) {
    ctx.LOGS = texts.map(function (x) { ctx.text = x; return vm.runInContext('lvOpenLog(text, "x.csv")', ctx); });
    ctx.T = tune === undefined ? TUNE : tune;
    return JSON.parse(JSON.stringify(vm.runInContext('kpAnalyze(LOGS, T)', ctx)));
}
function humpFindings(r) { return r.findings.filter(function (f) { return f.group === 'Humps'; }); }

var cyl5 = function (c, rpm) { return c === 5 && rpm >= 2900 && rpm < 3100 ? 10 : 0; };

test('a cylinder louder at one engine speed at every load and gear is found and reads as noise', function () {
    var r = run([log(cyl5)]);
    assert.strictEqual(r.humps.length, 1, JSON.stringify(r.humps.map(function (h) { return [h.cyl, h.r0, h.r1]; })));
    var h = r.humps[0];
    assert.ok(h.cyl === 5 && h.r0 >= 2800 && h.r0 <= 2900 && h.r1 >= 3100 && h.r1 <= 3200, JSON.stringify([h.r0, h.r1]));
    assert.ok(h.light && h.bandsLoud === 2 && h.gearsLoud === 2 && h.verdict === 'noise', JSON.stringify(h));
    assert.ok(Math.abs(r.profile[0][4][Math.floor((3000 - 1000) / 100)].v / 100 * 20 - 15) < 2.5, 'cylinder 5 at 3000 rpm ≈ 15 % logged');
    var f = humpFindings(r)[0];
    assert.ok(/Cylinder 5 at .* most likely noise/.test(f.title) && /at light load too and in 2 gears/.test(f.title), f.title);
    assert.ok(f.times.length > 0 && f.file === 0 && /Ignition Cylinder 5 Knock Level/.test(JSON.stringify(f.channels)), JSON.stringify(f.times.slice(0, 2)));
});

test('a hump only under load is possible knock, and the threshold option appears once it nears the threshold', function () {
    var r = run([log(function (c, rpm, kpa) { return c === 3 && kpa > 60 && rpm >= 3400 && rpm < 3600 ? 14 : 0; })]);
    var h = r.humps.filter(function (x) { return x.cyl === 3; })[0];
    assert.ok(h && !h.light && h.verdict === 'unclear', JSON.stringify(h));
    var f = humpFindings(r).filter(function (x) { return /Cylinder 3/.test(x.title); })[0];
    assert.ok(f.severity === 'warn' && /check for knock/.test(f.title) && /possible knock/.test(f.detail) && !/Raise Knock Threshold/.test(f.detail), f.detail);
    var loud = run([log(function (c, rpm) { return c === 5 && rpm >= 2900 && rpm < 3100 ? 16 : 0; })]);
    assert.ok(/Raise Knock Threshold only around/.test(humpFindings(loud)[0].detail), humpFindings(loud)[0].detail);
    // 12 ± 1.5 % logged = about 65 % of threshold at the 99th percentile: a hump, but no threshold change offered.
    var quiet = humpFindings(run([log(function (c, rpm) { return c === 5 && rpm >= 2900 && rpm < 3100 ? 7 : 0; })]))[0];
    assert.ok(quiet && !/Raise Knock Threshold/.test(quiet.detail) && /well under the threshold/.test(quiet.detail), quiet && quiet.detail);
});

test('timing test between logs: unchanged with 3° less timing is noise; falling with it is possible knock', function () {
    var same = run([log(cyl5, 0), log(cyl5, -3)]).humps[0];
    assert.ok(same.timingTest && Math.abs(same.timingTest.degrees - 3) < 0.01 && same.timingTest.result === 'same' && same.verdict === 'noise', JSON.stringify(same.timingTest));
    var fell = run([log(cyl5, 0), log(function (c, rpm) { return c === 5 && rpm >= 2900 && rpm < 3100 ? 3 : 0; }, -3)]);
    var h = fell.humps[0], f = humpFindings(fell)[0];
    assert.ok(h.timingTest.result === 'fell' && h.verdict === 'unclear' && /fell with timing, as knock does/.test(f.detail), f.detail);
});

test('no hump: an even engine, and the profile without a tune is in logged %', function () {
    var r = run([log(null)], null);
    assert.strictEqual(r.humps.length, 0);
    assert.ok(humpFindings(r)[0].severity === 'ok');
    assert.ok(Math.abs(r.profile[0][0][15].v - 6.4) < 0.5, 'p95 of 5 ± 1.5 in logged %: ' + r.profile[0][0][15].v);
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
