/**
 * test-ve-lambda-delay.js — VE Table Tuning lambda delay: the tune's Fuel Closed Loop Period at each sample's exhaust mass flow,
 * pairing by time, the steady-state check up to the paired reading, and fuel cuts before it (ve-table/worker.js, m1pkg-ve.js).
 * Run: node tests/test-ve-lambda-delay.js
 */

'use strict';

var assert = require('assert');
var VE = require('../ve-table/worker.js');
var M1VE = require('../ve-table/m1pkg-ve.js');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ', got ' + a); }

var PERIOD = { flow: [0, 10, 30, 200], ms: [1300, 1000, 850, 150], cylinders: 8 };
var TABLE = { mapBreakpoints: [30, 50], rpmBreakpoints: [1000, 3000], values: [[50, 50], [60, 60]] };

/** 100 Hz samples at 2000 rpm, 40 kPa; f(t) may override fields. */
function log(seconds, f) {
    var out = [];
    for (var i = 0; i < seconds * 100; i++) {
        var t = i / 100;
        out.push(Object.assign({ time: t, rpm: 2000, map: 40, lambdaB1: 1, lambdaB2: 1, lambdaAvg: NaN, lambdaTarget: 1, clTrimB1: 0, clTrimB2: 0,
            coolantTemp: 90, throttlePos: 10, overrunState: 0, fuelCutCount: NaN, engineLoad: 150, stoich: 14.7, exhaustFlow: NaN }, f ? f(t) : {}));
    }
    return out;
}
var BASE = { hitThreshold: 1, minRunTime: 0, steadyWindowMs: 300, decelFilterEnabled: false };

test('delay is the Period at exhaust flow from Engine Load × cylinders × rpm', function () {
    // 150 mg × 8 × 2000 / 120 = 20 g/s air, × (1 + 1/14.7) = 21.36 g/s → between 10 (1000 ms) and 30 (850 ms)
    var d = VE.veLambdaDelays(log(1), PERIOD, 0.3);
    near(d.delays[0] * 1000, 1000 - 150 * (21.36 - 10) / 20, 0.5);
    assert.strictEqual(d.fromTable, 100);
    var logged = VE.veLambdaDelays(log(1, function () { return { exhaustFlow: 200 }; }), PERIOD, 0.3);
    near(logged.delays[0], 0.15, 1e-9, 'logged Exhaust Mass Flow wins');
    var noLoad = VE.veLambdaDelays(log(1, function () { return { engineLoad: NaN }; }), PERIOD, 0.3);
    assert.strictEqual(noLoad.fromTable, 0);
    near(noLoad.delays[0], 0.3, 1e-9, 'fixed delay without Engine Load');
});

test('each sample is paired with lambda its delay later', function () {
    // Lambda reads 10 % lean from 6 s on: with ~0.92 s delay the fuelling from ~5.08 s is the cause.
    var samples = log(10, function (t) { return { lambdaB1: t >= 6 ? 1.1 : 1, lambdaB2: t >= 6 ? 1.1 : 1 }; });
    var corr = new Float32Array(samples.length);
    var r = VE.analyzeVE(samples, TABLE, Object.assign({ lambdaDelayTable: PERIOD, corrections: corr }, BASE));
    var i5 = 500, i51 = 510;
    near(corr[i5], 0, 1e-6, 'at 5.00 s lambda (5.92 s) is still on aim');
    near(corr[i51], 10, 1e-4, 'at 5.10 s lambda (6.02 s) reads the lean step');
    assert.strictEqual(r.lambdaDelay.source, 'tune');
    near(r.lambdaDelay.medianMs, 917, 2);
});

test('a MAP change before the paired reading makes the sample not steady; so does a fuel cut', function () {
    var samples = log(10, function (t) { return { map: t >= 6 && t < 6.5 ? 60 : 40 }; });
    var reasons = new Uint8Array(samples.length);
    VE.analyzeVE(samples, TABLE, Object.assign({ lambdaDelayTable: PERIOD, reasons: reasons }, BASE));
    assert.strictEqual(reasons[550], VE.VE_REASON.NOT_STEADY, '5.5 s: MAP steps at 6 s, before its reading at ~6.4 s');
    assert.strictEqual(reasons[400], VE.VE_REASON.USED, '4.0 s: reading at ~4.9 s, before the step');
    var cut = log(10, function (t) { return { overrunState: t >= 6 && t < 6.2 ? 2 : 0 }; });
    reasons = new Uint8Array(cut.length);
    VE.analyzeVE(cut, TABLE, Object.assign({ lambdaDelayTable: PERIOD, reasons: reasons }, BASE));
    assert.strictEqual(reasons[550], VE.VE_REASON.FUEL_CUT, 'cut between the sample and its reading');
});

test('fixed delay without a table; 0 ms pairs each sample with itself', function () {
    var r = VE.analyzeVE(log(5), TABLE, Object.assign({ lambdaDelayMs: 300 }, BASE));
    assert.deepStrictEqual([r.lambdaDelay.source, r.lambdaDelay.medianMs], ['fixed', 300]);
    var samples = log(5, function (t) { return { lambdaB1: t >= 3 ? 1.1 : 1, lambdaB2: t >= 3 ? 1.1 : 1 }; });
    var corr = new Float32Array(samples.length);
    VE.analyzeVE(samples, TABLE, Object.assign({ lambdaDelayMs: 0, corrections: corr }, BASE));
    near(corr[299], 0, 1e-6); near(corr[300], 10, 1e-4);
});

test('the tune reader returns Closed Loop Period in g/s and ms with the cylinder count', function () {
    var pkg = { items: [
        { name: 'Fuel.Closed Loop.Period', kind: 'Table', unit: 's', values: [1.3, 0.85, 0],
          axes: [{ axis: 'X', input: 'Exhaust.Mass Flow.Value', unit: 'kg/s', sites: 2, maxSites: 3, values: [0, 0.03, 0.03] }] },
        { name: 'Engine.Cylinders', kind: 'Parameter', value: 6 }] };
    var p = M1VE.m1pkgVeClosedLoopPeriod(pkg);
    near(p.flow[1], 30, 1e-9); near(p.ms[0], 1300, 1e-9);
    assert.strictEqual(p.flow.length, 2);
    assert.strictEqual(p.cylinders, 6);
    assert.strictEqual(M1VE.m1pkgVeClosedLoopPeriod({ items: [] }), null);
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
