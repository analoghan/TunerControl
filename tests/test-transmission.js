/**
 * test-transmission.js — Tests for the TurboLamik Shift Analyzer: transmission/shift-analysis.js (shift timing, flare, adaptation,
 * findings) and bin-reader.js extractShiftSettings (tables found by pattern across XDF versions), on synthetic logs.
 * Run: node tests/test-transmission.js
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var ROOT = __dirname + '/../';

var ctx = vm.createContext({ console: console, Math: Math, Float64Array: Float64Array });
['transmission/xdl-parser.js', 'transmission/bin-reader.js', 'transmission/shift-analysis.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f });
});

var tests = [];
/** Plain copies: deepStrictEqual fails on objects made in the vm context. */
function plain(x) { return JSON.parse(JSON.stringify(x)); }
/** The upshifts (the synthetic log drops back to 2nd 5 s after each shift, which reads as a downshift). */
function ups(a) { return a.shifts.filter(function (s) { return s.up; }); }
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var COLS = ['Time', 'Gear', 'Gear Target', 'Input RPM', 'Output RPM', 'Engine RPM', 'Vehicle Speed (km/h)', 'Oil Temp (C)', 'TPS', 'Engine TQ (NM)',
    'Time 1 Shift Time', 'Adaptation Activation Parameter', 'Blip Status', 'Foot brake'];
var R2 = 3.14, R3 = 2.11, KMH = 0.0342;

/**
 * A log at 50 Hz with every row written twice (TunerPro writes rows with the same timestamp). Upshifts 2→3 requested at each time in
 * `shifts`: the ratio holds for 0.5 s, then moves to 3rd over 0.5 s; Gear changes 0.05 s after that. flare: rpm the input rises above
 * 2nd gear's speed during the delay.
 */
function upshiftLog(shifts, opts) {
    opts = opts || {};
    var rows = [], oil = opts.oil === undefined ? 70 : opts.oil;
    for (var i = 0; i < 50 * 60; i++) {
        var t = i / 50, out = 400 + (t % 15) * 10, gear = 2, target = 2, ratio = R2, extra = 0, st = 0;
        shifts.forEach(function (s) {
            var dt = t - s.at;
            if (dt < 0 || dt > 5) return;
            target = 3;
            if (dt < 0.5) { ratio = R2; if (s.flare && dt > 0.2) extra = s.flare; }
            else if (dt < 1.0) { ratio = R2 + (R3 - R2) * (dt - 0.5) / 0.5; st = (dt - 0.5) * 1000; }
            else { ratio = R3; st = 500; }
            if (dt >= 1.05) gear = 3;
        });
        if (shifts.some(function (s) { return t - s.at > 1.05 && t - s.at <= 5; })) { gear = 3; target = 3; }
        var input = out * ratio + extra;
        var row = { 'Time': Math.round(t * 1000) / 1000, 'Gear': gear, 'Gear Target': target, 'Input RPM': input, 'Output RPM': out, 'Engine RPM': input + 50,
            'Vehicle Speed (km/h)': out * KMH, 'Oil Temp (C)': oil, 'TPS': 20, 'Engine TQ (NM)': 120, 'Time 1 Shift Time': st,
            'Adaptation Activation Parameter': opts.code === undefined ? 0 : opts.code, 'Blip Status': 0, 'Foot brake': 0 };
        var r = COLS.map(function (c) { return row[c]; });
        rows.push(r, r.slice());
    }
    return rows;
}

test('times a shift from the Gear Target request to the Gear change, using timestamps', function () {
    var a = ctx.tsaAnalyze(COLS, upshiftLog([{ at: 5 }]), null);
    assert.strictEqual(ups(a).length, 1);
    var s = ups(a)[0];
    assert.deepStrictEqual(plain([s.from, s.to, s.up, s.kind]), [2, 3, true, 'power']);
    assert.ok(Math.abs(s.delay - 0.5) <= 0.06, 'delay ' + s.delay);
    assert.ok(Math.abs(s.ratioChange - 0.5) <= 0.08, 'ratio change ' + s.ratioChange);
    assert.ok(Math.abs(s.total - 1.06) <= 0.04, 'total ' + s.total);
    assert.strictEqual(s.flare, 0);
    assert.ok(s.tcuShiftTime >= 480 && s.tcuShiftTime <= 520, 'TCU shift time ' + s.tcuShiftTime);
    assert.deepStrictEqual(plain([s.applying, s.releasing]), ['C', 'A']);
    assert.strictEqual(a.ratios.source[2], 'log');
    assert.ok(Math.abs(a.ratios.ratios[2] - R2) < 0.01);
});

test('finds a repeated flare and points at the documented tables', function () {
    var a = ctx.tsaAnalyze(COLS, upshiftLog([{ at: 5, flare: 250 }, { at: 20, flare: 250 }, { at: 35 }]), null);
    var flares = ups(a).map(function (s) { return s.flare; });
    assert.ok(flares[0] >= 240 && flares[1] >= 240 && flares[2] === 0, JSON.stringify(flares));
    var f = a.findings.filter(function (x) { return /flare/.test(x.title); })[0];
    assert.ok(f, JSON.stringify(a.findings.map(function (x) { return x.title; })));
    assert.ok(/2 of 3/.test(f.title) && /Pulse Correction UP/.test(f.action) && /Slow Ram UP/.test(f.action));
});

test('says nothing about a transition from a single shift', function () {
    var a = ctx.tsaAnalyze(COLS, upshiftLog([{ at: 5, flare: 250 }]), null);
    assert.strictEqual(ups(a)[0].flare >= 240, true);
    assert.ok(!a.findings.some(function (x) { return /flare/.test(x.title); }));
});

test('warns about cold oil and reads the adaptation codes', function () {
    var a = ctx.tsaAnalyze(COLS, upshiftLog([{ at: 5 }], { oil: 30, code: 10 }), { adaptOil: { min: 55, max: 80, source: 'bin' } });
    assert.ok(a.findings.some(function (f) { return /cold oil/.test(f.title) && /55–80 °C adaptation window set in the bin/.test(f.text); }));
    var ok = ctx.tsaAnalyze(COLS, upshiftLog([{ at: 5 }], { oil: 70 }), null);
    assert.ok(!ok.findings.some(function (f) { return /cold oil/.test(f.title); }));
    // 2→3 is not a learning shift; the time in 3rd is counted by code
    assert.strictEqual(a.adaptation.learnShifts.length, 0);
    assert.strictEqual(a.adaptation.codes[0].code, 10);
    assert.ok(/oil too cold/.test(a.adaptation.codes[0].meaning));
});

test('applying and releasing elements follow the 8HP chart', function () {
    assert.deepStrictEqual(plain(ctx.tsaClutches(1, 2)), { applying: 'E', releasing: 'C' });
    assert.deepStrictEqual(plain(ctx.tsaClutches(3, 2)), { applying: 'A', releasing: 'C' });
    assert.deepStrictEqual(plain(ctx.tsaClutches(6, 7)), { applying: 'A', releasing: 'E' });
    assert.deepStrictEqual(plain(ctx.tsaClutches(6, 5)), { applying: 'B', releasing: 'E' });
});

test('counts a request that returns to the current gear as cancelled', function () {
    var rows = upshiftLog([]);
    rows.forEach(function (r) { if (r[0] >= 8 && r[0] < 8.2) r[2] = 3; });   // Gear Target 3 for 0.2 s, Gear stays 2
    var a = ctx.tsaAnalyze(COLS, rows, null);
    assert.strictEqual(ups(a).length, 0);
    assert.strictEqual(a.summary.cancelled, 1);
});

test('the bin settings are found under the V10.75 and V10.78 table names', function () {
    function tbl(values, x, y) { return { values: values, rows: values.length, cols: values[0].length, xLabels: x || [], yLabels: y || [] }; }
    var common = { 'Gear Ratio': tbl([[3.29, 4.71, 3.14, 2.11, 1.67, 1.28, 1, 0.84, 0.67]], ['-1', '1', '2', '3', '4', '5', '6', '7', '8']),
        'Program Selector': tbl([[1, 2], [0, 1], [0, 0], [2, 2]], ['1 P1', '2 P2'], ['AUTO', 'Time UP', '. Time DOWN', 'ST. GEAR']),
        'Oil Temp MIN': tbl([[55]]), 'Oil Temp Max': tbl([[80]]), 'Min RPM for blip': tbl([[2000], [1600], [1600]]), 'Max TPS for blip': tbl([[20]]) };
    var v75 = Object.assign({ '3-2 Downshift Correction Start': tbl([[1, 2]]), 'Brake ADAP': tbl([[0, 0, 0, 0, 0]]) }, common);
    var v78 = Object.assign({ '3-2 DOWN Correction Start': tbl([[1, 2]]), '6-7 UP Coreection Start': tbl([[3]]), 'Brake Clutch DOWN Adaptation': tbl([[0, 0]]) }, common);
    var a = ctx.extractShiftSettings(v75), b = ctx.extractShiftSettings(v78);
    [a, b].forEach(function (s) {
        assert.strictEqual(s.gearRatios[2], 3.14);
        assert.strictEqual(s.gearRatios[8], 0.67);
        assert.deepStrictEqual(plain(s.startGear), [2, 2]);
        assert.deepStrictEqual([s.adaptOil.min, s.adaptOil.max], [55, 80]);
        assert.deepStrictEqual(plain(s.blip.minRpm), [2000, 1600, 1600]);
        assert.ok(s.corrections['3-2'].start, Object.keys(s.corrections).join());
        assert.strictEqual(s.adaptationTables.length, 1);
    });
    assert.ok(b.corrections['6-7'].start, 'the "Coreection" spelling in V10.78');
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('PASS ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.message)); }
});
console.log((tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
