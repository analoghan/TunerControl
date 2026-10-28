/**
 * test-cl-period.js — Closed-Loop Period (cl-period/cl-analysis.js) on synthetic 100 Hz CSV logs with a known lambda delay.
 * Run: node tests/test-cl-period.js
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var ROOT = __dirname + '/../';

var ctx = vm.createContext({ console: console, Math: Math, Float64Array: Float64Array, Float32Array: Float32Array, Uint8Array: Uint8Array,
    Int32Array: Int32Array, Uint32Array: Uint32Array, Int16Array: Int16Array, Uint16Array: Uint16Array, Int8Array: Int8Array,
    ArrayBuffer: ArrayBuffer, DataView: DataView, TextDecoder: TextDecoder, Map: Map, Set: Set, JSON: JSON });
['lib/ld-parser.js', 've-table/worker.js', 'log-viewer/log-file.js', 'log-health/health-checks.js', 'cl-period/cl-analysis.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f });
});

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ', got ' + a); }

// Engine Speed wobbles (a constant one reads as a logger hold). Engine Load 50 mg × 8 cyl × 2000 rpm / 120 / 1000 = 6.67 g/s air, + fuel at stoich 12.5 × λ 1 → 7.2 g/s exhaust: nearest site 10 g/s
var TUNE = { tuneName: 'T', period: { flow: [0, 10, 30, 50], ms: [1300, 1000, 850, 675], cylinders: 8 }, gain: 50 };

/**
 * 100 Hz MoTeC CSV. aimAt(t) → aim; cutAt(t) → true while Engine Overrun State is 2. Lambda follows the aim (or air in a cut)
 * `delay` seconds later with a 50 ms first-order lag.
 */
function csv(seconds, aimAt, cutAt, delay) {
    var names = ['Engine Speed', 'Inlet Manifold Pressure', 'Fuel Mixture Aim', 'Engine Overrun State', 'Engine Load', 'Fuel Stoichiometric Ratio',
        'Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2'];
    var lines = ['Time,' + names.join(','), 's,' + names.map(function () { return ''; }).join(',')], lam = 1, hist = [];
    for (var i = 0; i < seconds * 100; i++) {
        var t = i / 100, aim = aimAt(t), cut = cutAt ? cutAt(t) : false;
        hist.push(cut ? 3 : aim);
        var target = hist[Math.max(0, i - Math.round(delay * 100))];
        lam += (target - lam) * (1 - Math.exp(-0.01 / 0.05));
        lines.push([t.toFixed(2), (2000 + 30 * Math.sin(t * 3)).toFixed(1), 40, aim, cut ? 2 : 0, 50, 12.5, lam.toFixed(4), lam.toFixed(4)].join(','));
    }
    return lines.join('\n');
}
function run(texts, tune) {
    ctx.texts = texts; ctx.tune = tune === undefined ? TUNE : tune;
    return vm.runInContext('clAnalyze(texts.map(function (x) { return lvOpenLog(x, "x.csv"); }), tune)', ctx);
}
function find(r, re) { return r.findings.filter(function (f) { return re.test(f.title); }); }
// Aim 1.00 → 0.90 at 40, 46, 52 s, back 3 s later
function steps(t) { return t >= 40 && t < 58 && Math.floor((t - 40) / 3) % 2 === 0 ? 0.9 : 1.0; }

test('aim steps are timed to the lambda onset and a shorter Period is suggested', function () {
    var r = run([csv(70, steps, null, 0.3)]);
    var aims = r.events.filter(function (e) { return e.source === 'aim'; });
    assert.strictEqual(aims.length, 6, JSON.stringify(r.events.map(function (e) { return e.t; })));
    aims.forEach(function (e) { near(e.banks[0], 315, 25, 't=' + e.t); });       // 300 ms delay + the lag to a quarter of the step
    near(aims[0].flow, 7.2, 0.15);
    var s = r.sites[1];
    assert.strictEqual(s.nAim, 6);
    assert.strictEqual(s.suggested, 350);
    assert.strictEqual(s.action, 'shorter');
    assert.ok(find(r, /Period is longer than the measured delay at 10 g\/s/).length, JSON.stringify(r.findings.map(function (f) { return f.title; })));
});

test('a Period that matches is kept', function () {
    var tune = JSON.parse(JSON.stringify(TUNE));
    tune.period.ms[1] = 350;
    var r = run([csv(70, steps, null, 0.3)], tune);
    assert.strictEqual(r.sites[1].action, 'keep');
    assert.ok(find(r, /matches the measured delay/).length);
});

test('clean overrun cuts count; a cut entered already lean does not', function () {
    function cuts(t) { return (t > 40 && t < 41.5) || (t > 50 && t < 51.5) || (t > 60 && t < 61.5) || (t > 70 && t < 71.5); }
    var r = run([csv(80, function () { return 1; }, cuts, 0.25)]);
    var c = r.events.filter(function (e) { return e.source === 'cut'; });
    assert.strictEqual(c.length, 4);
    c.forEach(function (e) { near(e.banks[0], 250, 25); });   // a jump to air passes +0.1 λ in the first sample
    assert.strictEqual(r.sites[1].suggested, 300, 'median ~247 + 50 for the 10 Hz cut state, rounded up to 50');
    // lean before the cut (aim 1.0, lambda already at air from an earlier cut 0.3 s before) → not clean
    r = run([csv(60, function () { return 1; }, function (t) { return (t > 40 && t < 40.6) || (t > 40.9 && t < 42); }, 0.25)]);
    assert.strictEqual(r.events.filter(function (e) { return e.source === 'cut'; }).length, 0);
});

test('steps from several logs are pooled; too few steps ask for more', function () {
    function one(t) { return t >= 40 && t < 43 ? 0.9 : 1.0; }
    var r = run([csv(60, one, null, 0.3)]);
    assert.strictEqual(r.sites[1].action, 'more steps');
    r = run([csv(60, one, null, 0.3), csv(60, one, null, 0.3)]);
    assert.strictEqual(r.sites[1].nAim, 4);
    assert.deepStrictEqual(r.events.map(function (e) { return e.file; }).join(), '0,0,1,1');
    assert.ok(find(r, /To measure the other sites/).length);
});

test('a moving operating point is not a step test', function () {
    var names = ['Engine Speed', 'Fuel Mixture Aim', 'Exhaust Lambda Bank 1'], lines = ['Time,' + names.join(','), 's,,,'];
    for (var i = 0; i < 6000; i++) {
        var t = i / 100;
        lines.push([t.toFixed(2), 1500 + 200 * t, steps(t), 1].join(','));   // rpm sweeps 500 rpm in 2.5 s
    }
    var r = run([lines.join('\n')]);
    assert.strictEqual(r.events.length, 0);
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
