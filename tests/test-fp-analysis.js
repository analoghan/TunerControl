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

console.log('Rail pressure control advice:');
const RAIL = { tuneName: 'T', pGainPctPerBar: 0.4, iGainPctPerBarS: 1.8, margin: 20, displacement: 0.885,
    aim: { rpm: [1000, 3000], volume: [0, 400, 800], values: [[20, 40, 60], [30, 80, 150]] } };
// 100 Hz arrays: time, rpm, press, aim (bar), error (NaN when not running), control (%), volume (per cylinder)
function rc(n, f) {
    const a = { time: [], rpm: [], press: [], aim: [], error: [], control: [], volume: [] };
    for (let i = 0; i < n; i++) {
        const s = { t: i * 0.01, rpm: 3000, aim: 80, press: 80, ctl: 20, vol: 50 };
        if (f) f(s, i);
        a.time.push(s.t); a.rpm.push(s.rpm); a.aim.push(s.aim); a.press.push(s.press); a.control.push(s.ctl); a.volume.push(s.vol);
        a.error.push(s.rpm >= 400 && s.aim > 0 ? s.press - s.aim : NaN);
    }
    return a;
}
check('looks up the aim table and finds the fuel volume multiplier', function () {
    near(F.railAimAt(RAIL.aim, 3000, 400), 80, 1e-9);
    near(F.railAimAt(RAIL.aim, 2000, 600), (50 + 115) / 2, 1e-9);
    // Logged volume per cylinder × 8 = volume per cycle: 50 µl × 8 = 400 → 80 bar at 3000 rpm.
    const r = F.analyzeRailControl(rc(2000), RAIL, 100);
    eq(r.volumeFactor, 8);
    near(r.aimMatch, 0, 1e-9);
});
check('pressure on aim: no gain advice, error mapped to the table cell', function () {
    const r = F.analyzeRailControl(rc(2000), RAIL, 100);
    if (!/^No gain change suggested/.test(r.advice[0].text)) throw new Error(r.advice[0].text);
    eq(r.cells[1][1].meanError, 0);
    eq(r.cells[1][1].pctWithin, 100);
});
check('brief excursions (ripple, single 10 Hz readings) are ignored', function () {
    const r = F.analyzeRailControl(rc(3000, (s, i) => { if (i % 100 < 10) s.press = 90; }), RAIL, 100);
    eq(r.classes.steadyHigh.episodes, 0);
});
check('repeated overshoot while the aim rises suggests less proportional gain', function () {
    // Eight ramps of the aim from 40 to 120 bar over 1 s; the rail runs 10 bar over for 0.4 s near the top of each.
    const r = F.analyzeRailControl(rc(20000, (s, i) => {
        const k = i % 2500;
        s.aim = k < 100 ? 40 + k * 0.8 : 120;
        s.press = s.aim + (k >= 60 && k < 100 ? 10 : 0);
    }), RAIL, 100);
    if (!(r.classes.riseOver.episodes >= 3)) throw new Error('episodes ' + r.classes.riseOver.episodes);
    const t = r.advice.map(a => a.text).join('\n');
    if (!/overshoots while the aim rises/.test(t) || !/Proportional Gain to about 0.85×/.test(t)) throw new Error(t);
    eq(r.suggested.p, 0.85);
});
check('above aim with the pump off is reported, with no gain change', function () {
    const r = F.analyzeRailControl(rc(20000, (s, i) => {
        const k = i % 2500;
        s.aim = k < 100 ? 120 - k * 0.8 : 40;
        if (k < 160) { s.press = 120 - k * 0.3; s.ctl = 0; }
        else s.press = s.aim;
    }), RAIL, 100);
    if (!(r.classes.bleed.seconds > 1)) throw new Error('bleed ' + r.classes.bleed.seconds);
    const t = r.advice.map(a => a.text).join('\n');
    if (!/pump already off/.test(t) || !/Gains cannot change this/.test(t)) throw new Error(t);
    if (!/^No gain change suggested/.test(r.advice[0].text)) throw new Error(r.advice[0].text);
});
check('lag and overshoot together: one change at a time, integral first', function () {
    const r = F.analyzeRailControl(rc(20000, (s, i) => {
        const k = i % 2500;
        s.aim = k < 200 ? 40 + k * 0.4 : 120;
        s.press = k >= 20 && k < 70 ? s.aim - 10 : k >= 150 && k < 200 ? s.aim + 10 : s.aim;
    }), RAIL, 100);
    const t = r.advice.map(a => a.text).join('\n');
    if (!/both lags/.test(t) || !/first reduce the Integral Gain to about 0.85×/.test(t)) throw new Error(t);
});
check('flags steep steps in the aim table where the engine ran', function () {
    const r = F.analyzeRailControl(rc(2000, (s) => { s.vol = 75; s.aim = 115; s.press = 115; }), RAIL, 100);
    eq(r.steep.map(x => x.rpm + ':' + x.from + '-' + x.to).join(','), '3000:0-400,3000:400-800');
});
check('without a tune: kinds of error only', function () {
    const r = F.analyzeRailControl(rc(2000), null, 100);
    eq(r.cells, null);
    eq(r.volumeFactor, null);
});

console.log('Low-side pressure:');
/** 100 Hz low-side samples: f(t) → { low, flow, pump2, error }; engine running throughout. */
function lowLog(seconds, f) {
    const a = { time: [], rpm: [], low: [], flow: [], pump2: [], error: [] };
    for (let i = 0; i < seconds * 100; i++) {
        const t = i / 100, o = Object.assign({ low: 480, flow: 200, pump2: 0, error: 0 }, f(t));
        a.time.push(t); a.rpm.push(2000); a.low.push(o.low); a.flow.push(o.flow); a.pump2.push(o.pump2); a.error.push(o.error);
    }
    return a;
}
check('a feed that holds is reported as holding, with the flow bins', function () {
    const r = F.analyzeLowSide(lowLog(60, (t) => (t > 40 ? { flow: 2500, pump2: 1, low: 485 } : {})), 100);
    eq(r.base, 480); eq(r.droop, -5);
    eq(r.bins.map(b => b.from).join(), '0,2000');
    eq(r.bins[1].pump2Pct, 100);
    eq(r.advice[0].severity, 'good');
    eq(r.pump2.switchOns, 1); eq(r.pump2.onFlow, 2500);
});
check('droop at high flow, a dip below 250 kPa, and rail undershoot during the sag', function () {
    const r = F.analyzeLowSide(lowLog(60, (t) => (t > 40 ? { flow: 2500, low: t > 50 && t < 51 ? 200 : 400, error: -5 } : {})), 100);
    eq(r.droop, 80);
    eq(r.below.episodes, 1); near(r.below.seconds, 1, 0.02);
    eq(r.railLinked, 100);
    eq(r.advice.filter(a => a.severity === 'warning').length, 3);
});
check('the first 3 s after a start are not counted (pumps priming)', function () {
    const r = F.analyzeLowSide(lowLog(60, (t) => (t < 2 ? { low: -50 } : {})), 100);
    eq(r.below.episodes, 0); eq(r.min, 480);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
