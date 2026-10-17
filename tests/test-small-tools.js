/**
 * test-small-tools.js — Tests for the Idle Behavior worker, Injector Duty Cycle (duty-analysis.js) and Charge Cooling Gain
 * (cc-analysis.js) analyses, on synthetic 100 Hz logs.
 * Run: node tests/test-small-tools.js
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var ROOT = __dirname + '/../';

function load(files, extra) {
    var ctx = vm.createContext(Object.assign({ console: console, Math: Math }, extra || {}));
    files.forEach(function (f) { vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f }); });
    return ctx;
}

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/** Rows at 100 Hz from segments [{ seconds, row: function (t, i) → { channel: value } }]. */
function build(columns, segments) {
    var rows = [], t = 0;
    segments.forEach(function (seg) {
        var n = Math.round(seg.seconds * 100);
        for (var i = 0; i < n; i++, t += 0.01) {
            var v = seg.row(t, i);
            rows.push(columns.map(function (c) { return c === 'Time' ? t : v[c] !== undefined ? v[c] : NaN; }));
        }
    });
    return rows;
}

// ---- Charge cooling ---------------------------------------------------------------------------------------------------

var CC_COLS = ['Time', 'Fuel Mixture Aim', 'Exhaust Lambda', 'Fuel Closed Loop Control Bank 1 Trim', 'Engine Speed', 'Inlet Manifold Pressure',
               'Inlet Air Temperature'];
function ccLog(stepLambda, opts) {
    opts = opts || {};
    var idle = function (aim, lambda, delayFrom) {
        return function (t, i) {
            var lam = delayFrom !== undefined && i < 50 ? delayFrom : lambda;   // the sensor answers 0.5 s late
            return { 'Fuel Mixture Aim': aim, 'Exhaust Lambda': lam, 'Fuel Closed Loop Control Bank 1 Trim': opts.trim || 0,
                     'Engine Speed': 900 + 20 * Math.sin(t), 'Inlet Manifold Pressure': 50, 'Inlet Air Temperature': 35 };
        };
    };
    var to = opts.to || 0.9, segs = [];
    for (var k = 0; k < 2; k++) {
        segs.push({ seconds: 6, row: idle(1.0, 1.0, k ? stepLambda : undefined) });
        segs.push({ seconds: 6, row: idle(to, stepLambda, 1.0) });
    }
    segs.push({ seconds: 6, row: idle(1.0, 1.0, stepLambda) });
    return build(CC_COLS, segs);
}

test('charge cooling: a rich step that stays lean means raise the gain', function () {
    var c = load(['charge-cooling/cc-analysis.js']);
    var r = c.ccAnalyze(CC_COLS, ccLog(0.94), { currentGain: 17 });
    assert.strictEqual(r.steps.length, 4, 'two rich steps and two back');
    assert.strictEqual(r.usable, 4);
    assert.strictEqual(r.direction, 'raise');
    assert.ok(Math.abs(r.signal - (0.94 / 0.9 - 1)) < 0.002, 'tracking ≈ +4.4 %: ' + r.signal);
    assert.strictEqual(r.nextGain, 19);
    assert.ok(r.consistent);
    assert.ok(Math.abs(r.iat - 35) < 0.01);
});

test('charge cooling: a rich step that goes richer means lower the gain; tracking within 0.5 % is right', function () {
    var c = load(['charge-cooling/cc-analysis.js']);
    assert.strictEqual(c.ccAnalyze(CC_COLS, ccLog(0.88), { currentGain: 17 }).direction, 'lower');
    assert.strictEqual(c.ccAnalyze(CC_COLS, ccLog(0.9)).direction, 'ok');
    assert.strictEqual(c.ccAnalyze(CC_COLS, ccLog(0.9)).nextGain, undefined);
});

test('charge cooling: a lean step that goes richer than asked also means raise', function () {
    var c = load(['charge-cooling/cc-analysis.js']);
    var r = c.ccAnalyze(CC_COLS, ccLog(1.02, { to: 1.05 }));
    assert.strictEqual(r.direction, 'raise');
    assert.ok(r.steps.some(function (s) { return !s.rich; }));
});

test('charge cooling: steps with closed loop active or no steps at all are not used', function () {
    var c = load(['charge-cooling/cc-analysis.js']);
    var r = c.ccAnalyze(CC_COLS, ccLog(0.94, { trim: 3 }));
    assert.strictEqual(r.usable, 0);
    assert.ok(/closed loop active/.test(r.steps[0].rejected[0]));
    var drive = build(CC_COLS, [{ seconds: 30, row: function (t) {
        return { 'Fuel Mixture Aim': 0.95 + 0.03 * Math.sin(t / 3), 'Exhaust Lambda': 0.95, 'Engine Speed': 2000, 'Inlet Manifold Pressure': 60 };
    } }]);
    assert.strictEqual(c.ccAnalyze(CC_COLS, drive).steps.length, 0, 'an aim that moves gradually has no steps');
});

// ---- Duty cycle -------------------------------------------------------------------------------------------------------

var DC_COLS = ['Time', 'Engine Speed', 'Fuel Injector Primary Duty Cycle', 'Fuel Injector Secondary Duty Cyc', 'Inlet Manifold Pressure',
               'Fuel Cylinder 1 Primary Output Pulse Width 1'];
function dcRow(rpm, dc, map) {
    // pulse width that makes a 160° window: degrees = 1.6 × duty cycle
    return { 'Engine Speed': rpm, 'Fuel Injector Primary Duty Cycle': dc, 'Fuel Injector Secondary Duty Cyc': 0, 'Inlet Manifold Pressure': map,
             'Fuel Cylinder 1 Primary Output Pulse Width 1': 1.6 * dc * 1000 / (rpm * 6) };
}

test('duty cycle: measured in seconds and held peaks, not single samples', function () {
    var c = load(['duty-cycle/duty-analysis.js']);
    var rows = build(DC_COLS, [
        { seconds: 5, row: function () { return dcRow(2000, 20, 60); } },
        { seconds: 1, row: function () { return dcRow(5000, 85, 180); } },
        { seconds: 2, row: function (t, i) { return dcRow(3000, i === 50 ? 97 : 30, 90); } }
    ]);
    var r = c.dcAnalyze(DC_COLS, rows, {});
    assert.ok(Math.abs(r.sustainedPeak - 85) < 1e-9, 'the single 97 % sample is not the peak');
    assert.strictEqual(Math.round(r.sustainedPeakRpm), 5000);
    assert.ok(Math.abs(r.secondsAboveWarn - 1.01) < 0.02, 'one second above 80 % (plus the spike): ' + r.secondsAboveWarn);
    assert.strictEqual(r.episodeCount, 1, 'the spike is shorter than 0.3 s');
    assert.ok(Math.abs(r.episodes[0].duration - 1) < 0.02);
    assert.strictEqual(r.recommendations[0].severity, 'warning');
    assert.ok(Math.abs(r.window - 160) < 0.5, 'implied injection window');
    assert.strictEqual(r.hasSecondary, false, 'an all-zero secondary channel is not "used"');
    assert.strictEqual(r.bins.filter(function (b) { return b.min === 3000; })[0].peak, 97, 'the single highest sample is still shown');
    assert.ok(/1\.0 s above 100 kPa/.test(r.recommendations[1].text) && r.recommendations[1].severity === 'warning', 'too little boost to judge');
});

test('duty cycle: finds truncated channel names and rejects a log without them', function () {
    var c = load(['duty-cycle/duty-analysis.js']);
    assert.strictEqual(c.dcFind(DC_COLS, ['Fuel Injector Secondary Duty Cycle']), 3);
    assert.throws(function () { c.dcAnalyze(['Time', 'Engine Speed'], [[0, 1000]], {}); }, /duty cycle channel/);
});

// ---- Idle -------------------------------------------------------------------------------------------------------------

var IDLE_COLS = ['Time', 'Engine Speed', 'Throttle Pedal', 'Idle Aim', 'Vehicle Speed', 'Clutch Switch Position', 'Idle Mass Flow',
                 'Idle Mass Flow Feed Forward', 'Coolant Temperature', 'Engine Post Start Idle Mass Flow'];
function idleRow(rpm, pedal, clutch, speed, mfOffset) {
    return { 'Engine Speed': rpm, 'Throttle Pedal': pedal, 'Idle Aim': 870, 'Vehicle Speed': speed, 'Clutch Switch Position': clutch,
             'Idle Mass Flow': 55 + (mfOffset || 0), 'Idle Mass Flow Feed Forward': 55, 'Coolant Temperature': 72, 'Engine Post Start Idle Mass Flow': 0 };
}

test('idle: returns to idle, gear changes left out, idle above aim with air taken away', function () {
    var out = [];
    var c = load(['idle/worker.js'], { self: { postMessage: function (m) { out.push(m); } } });
    var rows = build(IDLE_COLS, [
        { seconds: 3, row: function () { return idleRow(3000, 20, 0, 60); } },
        { seconds: 0.5, row: function (t, i) { return idleRow(3000 - i * 10, 0, 1, 58); } },          // gear change: clutch in, 3000 → 2500
        { seconds: 3, row: function () { return idleRow(2600, 20, 0, 55); } },
        { seconds: 2, row: function (t, i) { return idleRow(Math.max(950, 2600 - i * 20), 0, 1, Math.max(0, 50 - i)); } },   // to idle
        { seconds: 20, row: function (t, i) { return idleRow(950 + (i % 2 ? 10 : -10), 0, 1, 0, -3.8); } }
    ]);
    c.runAnalysis(IDLE_COLS, rows, 100);
    var res = out.filter(function (m) { return m.type === 'result'; })[0];
    assert.ok(res, JSON.stringify(out.filter(function (m) { return m.type === 'error'; })));
    var a = res.analysis;
    assert.strictEqual(a.totalDecelEvents, 1, 'one return to idle');
    assert.strictEqual(a.skippedEvents, 1, 'the gear change is left out');
    var st = a.steadyIdle;
    assert.ok(st.seconds > 15 && st.seconds < 21, 'steady idle starts 2 s into the stop: ' + st.seconds);
    assert.ok(Math.abs(st.rpmAboveAim.p50 - 80) <= 10);
    assert.ok(Math.abs(st.massFlowMinusFF.p50 + 3.8) < 0.01);
    assert.strictEqual(st.diags[0].severity, 'warning');
    assert.ok(/takes 3\.8 % of air away/.test(st.diags[0].text) && /Lower Idle Mass Flow Feed Forward Main/.test(st.diags[0].text));
});

function idlePkg() {
    function item(name, unit, value) { return { name: name, kind: 'Value', type: 'f32', unit: unit, value: value }; }
    var aimSites = [4800, 5400, 6000, 0], coolSites = [60, 80, 0];
    return { tuneName: 'Test V1', items: [
        item('Idle.Mass Flow.Integral.Minimum', 'ratio', -0.03), item('Idle.Mass Flow.Integral.Maximum', 'ratio', 0.35),
        item('Idle.Mass Flow.Proportional.Gain', 'ratio/(deg/s)', 0.0000166667),
        { name: 'Idle.Mass Flow.Feed Forward.Main', kind: 'Table', unit: 'ratio', axes: [
            { axis: 'X', input: 'Idle.Aim.Value', unit: 'deg/s', maxSites: 4, sites: 3, values: aimSites },
            { axis: 'Y', input: 'Coolant.Temperature.Value', unit: 'C', maxSites: 3, sites: 2, values: coolSites }],
          // 800 / 900 / 1000 rpm at 60 °C, then at 80 °C
          values: [0.47, 0.475, 0.50, 0, 0.445, 0.455, 0.48, 0, 0, 0, 0, 0] },
        { name: 'Idle.Aim.Main', kind: 'Table', unit: 'deg/s', axes: [{ axis: 'X', input: 'Coolant.Temperature.Value', unit: 'C', maxSites: 2, sites: 2, values: [60, 80] }],
          values: [5700, 5220] }] };
}

test('idle: reads the idle settings from a tune in display units', function () {
    var c = load(['idle/m1pkg-idle.js']);
    var t = JSON.parse(JSON.stringify(c.m1pkgIdle(idlePkg())));   // plain objects (the result comes from the vm context)
    assert.deepStrictEqual([t.integralMin, t.integralMax, t.pGain], [-3, 35, 0.01]);
    assert.deepStrictEqual(t.feedForward.aim, [800, 900, 1000]);
    assert.deepStrictEqual(t.feedForward.coolant, [60, 80]);
    assert.deepStrictEqual(t.feedForward.values, [[47, 47.5, 50], [44.5, 45.5, 48]]);
    assert.deepStrictEqual(t.aimMain.values, [950, 870]);
});

test('idle: with the tune, finds the integral at its minimum and the feed forward cells used', function () {
    var out = [];
    var c = load(['idle/worker.js', 'idle/m1pkg-idle.js'], { self: { postMessage: function (m) { out.push(m); } } });
    var tune = c.m1pkgIdle(idlePkg());
    // Idle aim 900, rpm 980 (+80): P = 0.01 × (900 − 980) = −0.8 %; feed forward 54 % (Main 45.5 % at 80 °C + 8.5 % compensations);
    // Idle Mass Flow = 54 − 3 − 0.8 = 50.2 % → integral −3 % (its minimum).
    function row(i) {
        return { 'Engine Speed': 980, 'Throttle Pedal': 0, 'Idle Aim': 900, 'Vehicle Speed': 0, 'Clutch Switch Position': 1,
                 'Idle Mass Flow': 50.2, 'Idle Mass Flow Feed Forward': 54, 'Coolant Temperature': 80, 'Engine Post Start Idle Mass Flow': 0 };
    }
    c.runAnalysis(IDLE_COLS, build(IDLE_COLS, [{ seconds: 20, row: row }]), 100, tune);
    var st = out.filter(function (m) { return m.type === 'result'; })[0].analysis.steadyIdle;
    assert.ok(Math.abs(st.integral.p50 + 3) < 1e-6, 'integral ' + st.integral.p50);
    assert.strictEqual(st.integralAtMin, 1);
    assert.ok(Math.abs(st.ffMain.p50 - 45.5) < 1e-9 && Math.abs(st.ffCompensation.p50 - 8.5) < 1e-9);
    assert.strictEqual(st.ffCells.length, 1);
    assert.deepStrictEqual([st.ffCells[0].aim, st.ffCells[0].coolant, st.ffCells[0].value, st.ffCells[0].suggested], [900, 80, 45.5, 41.7]);
    assert.ok(/integral is at its minimum of -3 % in Test V1 for 100 %/.test(st.diags[0].text), st.diags[0].text);
    assert.ok(st.diags.every(function (d) { return !/probably at the Idle Mass Flow Integral Minimum/.test(d.text); }), 'no guess when the tune says');
    assert.ok(Math.abs(st.aimVsTable.p50 - 30) < 1e-9, 'logged aim 900 vs table 870 at 80 °C');
});

test('idle: needs the pedal and Idle Aim, not the throttle blade', function () {
    var out = [];
    var c = load(['idle/worker.js'], { self: { postMessage: function (m) { out.push(m); } } });
    c.runAnalysis(['Time', 'Engine Speed', 'Throttle Position'], [[0, 900, 10], [0.01, 900, 10]], 100);
    var err = out.filter(function (m) { return m.type === 'error'; })[0];
    assert.ok(err && /Throttle Pedal and Idle Aim/.test(err.message));
});

// ---- Injector settings from the tune ------------------------------------------------------------------------------

function injPkg() {
    function item(name, unit, value) { return { name: name, kind: 'Parameter', unit: unit, value: value }; }
    return { tuneName: 'Test V1', items: [
        item('Fuel.Injector.Primary.Minimum Volume', 'm3', 4e-9), item('Fuel.Injector.Primary.Minimum Volume Hysteresis.Value', 'm3', 5e-10),
        item('Fuel.Injector.Primary.Open Time', 's', 0.00032), item('Fuel.Injector.Primary.Reference Flow', 'm3/s', 0.0000357),
        item('Fuel.Injector.Primary.Reference Pressure', 'dPa', 10000000),
        { name: 'Fuel.Injector.Primary.Linearisation', kind: 'Table', unit: 's', axes: [
            { axis: 'X', input: 'Fuel.Volume.Value', unit: 'm3', maxSites: 21, sites: 1, values: [0] },
            { axis: 'Y', input: 'Fuel.Injector.Primary.Differential Pressure.Value', unit: 'dPa', maxSites: 3, sites: 3, values: [0, 1000000, 4000000] }],
          values: (function () { var v = new Array(63).fill(0); v[0] = 0.00003863; v[21] = 0.00001105; return v; })() }] };
}

test('injector: reads Minimum Volume and Linearisation in display units', function () {
    var c = load(['injector/m1pkg-injector.js']);
    var t = JSON.parse(JSON.stringify(c.m1pkgInjector(injPkg())));
    assert.deepStrictEqual([t.minVolume, t.minVolumeHysteresis, t.openTime, Math.round(t.referenceFlow), t.referencePressure], [4, 0.5, 320, 2142, 100]);
    assert.deepStrictEqual(t.linearisation.pressures, [0, 10, 40]);
    assert.deepStrictEqual(t.linearisation.volumes, [0]);
    assert.deepStrictEqual(t.linearisation.values, [[38.63], [11.05], [0]]);
});

test('injector: with the tune, injection cuts are explained by its Minimum Volume and Linearisation is checked', function () {
    var c = load(['injector/worker.js', 'injector/m1pkg-injector.js'], { Map: Map, self: { postMessage: function () {} } });
    var tune = c.m1pkgInjector(injPkg());
    var cols = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Fuel Cylinder 1 Primary Output Pulse Width 1',
                'Engine Overrun State', 'Fuel Volume Primary', 'Fuel Pressure Direct Bank 1', 'Inlet Manifold Pressure'];
    var rows = build(cols, [
        { seconds: 5, row: function () { return { 'Engine Speed': 2000, 'Exhaust Lambda Bank 1': 1, 'Exhaust Lambda Bank 2': 1,
            'Fuel Cylinder 1 Primary Output Pulse Width 1': 0.8, 'Engine Overrun State': 0, 'Fuel Volume Primary': 7, 'Fuel Pressure Direct Bank 1': 2, 'Inlet Manifold Pressure': 30 }; } },
        { seconds: 1, row: function () { return { 'Engine Speed': 2400, 'Exhaust Lambda Bank 1': 3, 'Exhaust Lambda Bank 2': 3,
            'Fuel Cylinder 1 Primary Output Pulse Width 1': 0, 'Engine Overrun State': 0, 'Fuel Volume Primary': 4.6, 'Fuel Pressure Direct Bank 1': 2, 'Inlet Manifold Pressure': 10 }; } },
        { seconds: 5, row: function () { return { 'Engine Speed': 2000, 'Exhaust Lambda Bank 1': 1, 'Exhaust Lambda Bank 2': 1,
            'Fuel Cylinder 1 Primary Output Pulse Width 1': 1.5, 'Engine Overrun State': 0, 'Fuel Volume Primary': 9, 'Fuel Pressure Direct Bank 1': 2, 'Inlet Manifold Pressure': 30 }; } }]);
    var ch = c.resolveInjectorChannels(cols);
    var lean = c.analyzeLeanSpikes(rows, ch, tune);
    assert.strictEqual(lean.injectionOffCount, 1);
    assert.strictEqual(lean.injectionOff[0].minVolume, 4.6);
    assert.ok(/Minimum Volume 4 µl with 0\.5 µl hysteresis/.test(lean.diagnostics[0]) && /got down to 4\.6 µl/.test(lean.diagnostics[0]), lean.diagnostics[0]);
    var lin = c.analyzeLinearisation(rows, ch, tune);
    assert.ok(Math.abs(lin.runningPressure.p50 - 20) < 1e-9, '2 MPa = 20 bar');
    assert.strictEqual(lin.atRunning[0], 7.37, 'a third of the way from 10 bar (11.05 µs) to 40 bar (0)');
    assert.ok(Math.abs(lin.shortPulsePct - 50) < 1, 'half the injecting time is below 1 ms: ' + lin.shortPulsePct);
    assert.ok(/single Fuel Volume site/.test(lin.diagnostics[0]));
    assert.ok(/only has values at 0, 10 bar/.test(lin.diagnostics[1]));
    assert.strictEqual(c.analyzeLinearisation(rows, ch, null), null, 'nothing without the tune');
    assert.ok(/usual cause is Fuel Injector Primary Minimum Volume/.test(c.analyzeLeanSpikes(rows, ch, null).diagnostics[0]), 'the general text without it');
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('PASS ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e && e.message)); }
});
console.log((tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
