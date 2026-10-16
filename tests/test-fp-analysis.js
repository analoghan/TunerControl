/**
 * test-fp-analysis.js — DI Fuel Pressure Deep Dive: units, running-only statistics, aim steps, pump limit,
 * tracking grid and the full pipeline.
 * Run with: node tests/test-fp-analysis.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let posted = [];
const ctx = vm.createContext({ console, Math, Map, DataView, Float64Array, Float32Array, Uint8Array, self: { postMessage: function (m) { posted.push(m); } } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'fuel-pressure', 'worker.js'), 'utf8'), ctx);
const F = ctx;

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + ': ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || '') + ' expected ≈' + b + ', got ' + a); }

console.log('Units:');
check('M1 rail pressure units convert to bar', function () {
    eq(F.pressureToBar('MPa').factor, 10);
    eq(F.pressureToBar('dMPa').factor, 10, 'd = differential, not ×10');
    eq(F.pressureToBar('kPa').factor, 0.01);
    eq(F.pressureToBar('bar').factor, 1);
    near(F.pressureToBar('psi').factor, 0.0689476, 1e-9);
});
check('without a unit, the size of the values decides', function () {
    const mpa = F.pressureToBar('', [2, 3, 15, 16]);
    eq(mpa.factor, 10); eq(mpa.guessed, true);
    eq(F.pressureToBar('', [2000, 15000]).factor, 0.01);
    eq(F.pressureToBar('', [50, 150]).factor, 1);
});

// A log as rows: Time, Engine Speed, rail (MPa), aim (MPa), pump control (%), MAP (kPa)
const NAMES = ['Time', 'Engine Speed', 'Fuel Pressure Direct Bank 1', 'Fuel Pressure Direct Bank 1 Aim', 'Fuel Pressure Direct Bank 1 Control', 'Inlet Manifold Pressure'];
const UNITS = ['s', 'rpm', 'dMPa', 'MPa', '%', 'kPa'];
function log(n, f) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const r = [i * 0.01, 2000, 5, 5, 20, 60];
        if (f) f(r, i);
        out.push(r);
    }
    return out;
}
function run(data, units) {
    posted = [];
    F.runAnalysis(NAMES, data, 100, units === undefined ? UNITS : units);
    const res = posted.find(m => m.type === 'result');
    if (!res) throw new Error(JSON.stringify(posted.filter(m => m.type === 'error')));
    return res.analysis;
}

console.log('Statistics:');
check('error is in bar and tolerance is ±2 bar', function () {
    // 1 MPa = 10 bar: a 0.1 MPa error is 1 bar (within), 0.3 MPa is 3 bar (outside).
    const a = run(log(400, (r, i) => { r[2] = i < 200 ? 5.1 : 5.3; }));
    eq(a.pressureUnit, 'MPa');
    near(a.pctWithinTolerance, 50, 1e-9);
    near(a.pctOvershoot, 50, 1e-9);
    near(a.maxOvershoot, 3, 1e-9);
});
check('only samples with the engine running and an aim count', function () {
    const a = run(log(400, (r, i) => { if (i < 100) { r[1] = 0; r[2] = 0; r[3] = 5; } if (i >= 300) { r[3] = 0; r[2] = 0.5; } }));
    eq(a.runningSamples, 200);
    near(a.pctWithinTolerance, 100, 1e-9);
    if (!a.diagnostics.some(d => /200 samples with the engine running/.test(d))) throw new Error('expected a note on the samples used');
});

console.log('Aim steps:');
check('finds an aim step of 20 bar or more and its settle time', function () {
    // Aim 5 → 10 MPa (50 → 100 bar) at 1 s; the rail follows 0.3 s later.
    const a = run(log(400, (r, i) => { if (i >= 100) r[3] = 10; r[2] = i >= 130 ? 10 : 5; }));
    eq(a.transientEvents.length, 1);
    const e = a.transientEvents[0];
    eq(e.direction, 'up');
    near(e.aimChange, 50, 1e-9);
    eq(e.settled, true);
    near(e.aimFrom, 50, 1e-9); near(e.aimTo, 100, 1e-9);
});
check('small aim changes are not steps', function () {
    eq(run(log(400, (r, i) => { if (i >= 100) { r[3] = 6.5; r[2] = 6.5; } })).transientEvents.length, 0);
});

console.log('Pump limit:');
check('undershoot with the pump control at its maximum = at its limit', function () {
    const a = run(log(1000, (r, i) => { if (i >= 500) { r[3] = 15; r[2] = 13; r[4] = 95; } }));
    eq(a.pump.likelyLimited, true);
    if (!a.diagnostics.some(d => /^Pump at its limit/.test(d))) throw new Error('expected pump limit message');
});
check('undershoot with the pump well below its maximum = control response', function () {
    const a = run(log(1000, (r, i) => { if (i < 50) r[4] = 90; if (i >= 500) { r[3] = 15; r[2] = 13; r[4] = 40; } }));
    eq(a.pump.likelyLimited, false);
    if (!a.diagnostics.some(d => /not at the pump's limit/.test(d))) throw new Error('expected control-response message');
});

console.log('Tracking grid:');
check('mean error and share within tolerance by rpm × MAP, cells with ≥ 20 samples', function () {
    const a = run(log(300, (r, i) => { if (i >= 100) { r[1] = 3200; r[5] = 110; r[2] = 5.4; } if (i >= 290) r[1] = 6000; }));
    const g = a.errorGrid;
    eq(g.rpmLabels.join(','), '2000–2500,3000–3500');
    eq(g.mapLabels.join(','), '60–80,100–120');
    eq(g.cells[0][0].samples, 100);
    eq(g.cells[0][0].meanError, 0);
    eq(g.cells[1][1].meanError, 4);
    eq(g.cells[1][1].pctWithin, 0);
    eq(g.cells[0][1], null);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
