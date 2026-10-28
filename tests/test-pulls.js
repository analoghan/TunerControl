/**
 * test-pulls.js — Pull Report (pulls/pull-analysis.js) on synthetic 100 Hz CSV logs with planted problems.
 * Run: node tests/test-pulls.js
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var ROOT = __dirname + '/../';

var ctx = vm.createContext({ console: console, Math: Math, Float64Array: Float64Array, Float32Array: Float32Array, Uint8Array: Uint8Array,
    Int32Array: Int32Array, Uint32Array: Uint32Array, Int16Array: Int16Array, Uint16Array: Uint16Array, Int8Array: Int8Array,
    ArrayBuffer: ArrayBuffer, DataView: DataView, TextDecoder: TextDecoder, Map: Map, Set: Set, JSON: JSON });
['lib/ld-parser.js', 've-table/worker.js', 'log-viewer/log-file.js', 'log-health/health-checks.js', 'pulls/pull-analysis.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f });
});

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ', got ' + a); }

var TUNE = { tuneName: 'T', threshold: { rpm: [1000, 6000], values: [[20, 30]] } };

/** 100 Hz CSV, 60 s: cruise, then a full-throttle pull from 40 to 44 s. pull(t, u) → overrides during the pull (u = 0…1 through it). */
function csv(pull) {
    var names = ['Engine Speed', 'Inlet Manifold Pressure', 'Throttle Pedal', 'Fuel Mixture Aim', 'Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2',
        'Ignition Cylinder 1 Knock Level', 'Ignition Cylinder 2 Knock Level', 'Fuel Pressure Direct Bank 1', 'Fuel Pressure Direct Bank 1 Aim', 'Fuel Pressure',
        'Engine Oil Pressure', 'ECU Battery Voltage', 'Inlet Air Temperature'];
    var lines = ['Time,' + names.join(','), 's,' + names.map(function () { return ''; }).join(',')];
    for (var i = 0; i < 6000; i++) {
        var t = i / 100, inPull = t >= 40 && t < 44, u = (t - 40) / 4;
        var o = { rpm: 2000 + 30 * Math.sin(t * 3), map: 50, pedal: 15, aim: 1, l1: 1, l2: 1, k1: 3, k2: 3, rail: 5, railAim: 5, low: 480, oil: 400, batt: 14.2, iat: 40 };
        if (inPull) Object.assign(o, { rpm: 2500 + 3000 * u, map: 140, pedal: 100, aim: 0.85, l1: 0.85, l2: 0.85, rail: 15, railAim: 15, oil: 450 }, pull ? pull(t, u) : {});
        lines.push([t.toFixed(2), o.rpm.toFixed(1), o.map, o.pedal, o.aim, o.l1, o.l2, o.k1, o.k2, o.rail, o.railAim, o.low, o.oil, o.batt, o.iat].join(','));
    }
    return lines.join('\n');
}
function run(texts, tune) {
    ctx.texts = texts; ctx.tune = tune === undefined ? TUNE : tune;
    return vm.runInContext('puAnalyze(texts.map(function (x) { return lvOpenLog(x, "x.csv"); }), tune)', ctx);
}
function flags(p, re) { return p.flags.filter(function (f) { return re.test(f.text); }); }

test('a clean full-throttle pull is found and nothing is flagged', function () {
    var r = run([csv()]);
    assert.strictEqual(r.pulls.length, 1);
    var p = r.pulls[0];
    assert.ok(p.full);
    near(p.t0, 40, 0.02); near(p.seconds, 4, 0.02);
    assert.strictEqual(p.flags.length, 0, JSON.stringify(p.flags));
    assert.ok(r.findings.some(function (f) { return /Nothing flagged/.test(f.title); }));
});

test('lean against the delayed aim, knock over the threshold and a bank split are flagged', function () {
    var r = run([csv(function (t, u) { return { l1: u > 0.5 ? 0.92 : 0.85, k2: u > 0.6 ? 40 : 3 }; })]);
    var p = r.pulls[0];
    var lean = flags(p, /Bank 1 ran up to/)[0];
    assert.ok(lean && lean.severity === 'fail' && /0\.070 λ leaner/.test(lean.text), JSON.stringify(p.flags));
    assert.ok(flags(p, /Knock above the threshold on cylinder 2/).length);
    assert.ok(flags(p, /Banks differ/).length);
});

test('fuel supply: rail under aim, low side sagging, oil pressure under 10 psi per 1000 rpm, low voltage', function () {
    var r = run([csv(function (t, u) { return { rail: u > 0.3 ? 11 : 15, low: u > 0.5 ? 400 : 480, oil: u > 0.8 ? 250 : 450, batt: 12.1 }; })]);
    var p = r.pulls[0];
    assert.ok(flags(p, /Rail pressure 40 bar under aim/).length, JSON.stringify(p.flags));
    assert.ok(flags(p, /Low-side fuel pressure dropped 80 kPa/).length);
    assert.ok(flags(p, /Oil pressure 250 kPa/).length);
    assert.ok(flags(p, /Battery voltage fell to 12\.1 V/).length);
});

test('boost at part pedal is a pull but marked as not full throttle; pulls from several logs are pooled', function () {
    var r = run([csv(function () { return { pedal: 45 }; }), csv()]);
    assert.strictEqual(r.pulls.length, 2);
    assert.strictEqual(r.pulls[0].full, false);
    assert.ok(flags(r.pulls[0], /not a full-throttle pull/).length);
    assert.strictEqual(r.pulls.map(function (p) { return p.file; }).join(), '0,1');
});

test('the worst case of a flag across pulls is quoted, with how many pulls had it', function () {
    var a = csv(function (t, u) { return { l1: u > 0.5 ? 0.89 : 0.85 }; }), b = csv(function (t, u) { return { l1: u > 0.5 ? 0.895 : 0.85 }; });
    var r = run([a, b]);
    var f = r.findings.filter(function (x) { return x.group === 'Across pulls'; })[0];
    assert.ok(/0\.045 λ leaner/.test(f.title) && /in 2 of 2 pulls/.test(f.title), f.title);
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
