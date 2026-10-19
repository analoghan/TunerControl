/**
 * test-diagnostics.js — Cross-Tool Diagnostics knock findings (diagnostics/worker-diagnostics.js).
 * Run: node tests/test-diagnostics.js
 * Loads injector/worker.js then the diagnostics worker, as diagnostics/app.js does, and runs runCrossDiagnostics on
 * synthetic 100 Hz logs with knock stretches at chosen lambdas.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ self: { postMessage() {} }, importScripts() {}, console });
['lib/ld-parser.js', 'injector/worker.js', 'diagnostics/worker-diagnostics.js'].forEach(function (f) {
    if (fs.existsSync(path.join(__dirname, '..', f))) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
});

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ': ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const COLUMNS = ['Time', 'Engine Speed', 'Exhaust Lambda Bank 1', 'Fuel Cylinder 1 Primary Output Pulse Width 1', 'Ignition Cylinder 1 Knock Level'];

/** A log at 3000 rpm, lambda 0.85, 2 ms pulses, with one 0.5 s knock stretch (level 50 %) per entry of `knocks` (the lambda during it). */
function log(knocks) {
    const rows = [];
    let t = 0;
    function add(seconds, lambda, knock) {
        for (let i = 0; i < seconds * 100; i++, t += 0.01) rows.push([t, 3000, lambda, 2, knock]);
    }
    add(2, 0.85, 0);
    knocks.forEach(function (lambda) { add(0.5, lambda, 50); add(2, 0.85, 0); });
    return rows;
}
function knockFindings(rows) {
    return ctx.runCrossDiagnostics(COLUMNS, rows, null).findings.filter(function (f) { return /Knock/.test(f.title); });
}

console.log('Diagnostics knock findings');

test('no knock: no knock finding', function () {
    assert(knockFindings(log([])).length === 0, 'expected none');
});

test('knock, none lean: timing-related warning', function () {
    const f = knockFindings(log([0.85, 0.85, 0.85]));
    assert(f.length === 1 && f[0].title === 'Knock Events Detected (Not Lean-Related)' && f[0].severity === 'warning', JSON.stringify(f));
    assert(/^3 knock events/.test(f[0].body), f[0].body);
});

test('few knock events, some lean: still reported (too few to blame fuelling)', function () {
    const f = knockFindings(log([1.1, 0.85, 0.85]));
    assert(f.length === 1 && f[0].title === 'Knock Events Detected', JSON.stringify(f));
    assert(/1 of them while lean/.test(f[0].body) && /too few events/.test(f[0].body), f[0].body);
});

test('many knock events, a small share lean: reported as mostly timing', function () {
    const f = knockFindings(log([1.1, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85]));
    assert(f.length === 1 && f[0].title === 'Knock Events Detected', JSON.stringify(f));
    assert(/only 10%/.test(f[0].body), f[0].body);
});

test('many knock events, mostly lean: critical lean correlation, no second knock finding', function () {
    const f = knockFindings(log([1.1, 1.1, 1.1, 0.85, 0.85, 0.85]));
    assert(f.length === 1 && f[0].title === 'Knock Events Correlated with Lean Fueling' && f[0].severity === 'critical', JSON.stringify(f));
    assert(/^50% of knock events \(3\/6\)/.test(f[0].body), f[0].body);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
