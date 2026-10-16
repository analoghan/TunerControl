/**
 * test-knock-analysis.js — Knock Analyzer: threshold from the tune, event counting, bins from the tune's ignition
 * table, timing advice, knock retard, sensor check and diagnostics.
 * Run with: node tests/test-knock-analysis.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ console, Math, Map, DataView, Float64Array, Float32Array, Uint8Array, self: { postMessage: function () {} } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'knock', 'worker.js'), 'utf8').replace(/^const /gm, 'var ').replace(/^let /gm, 'var '), ctx);
const K = ctx;
const { m1pkgKnock } = require(path.join(__dirname, '..', 'knock', 'm1pkg-knock.js'));

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + ': ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || '') + ' expected ≈' + b + ', got ' + a); }

// Columns: 0 Time, 1 rpm, 2 MAP, 3–10 knock cyl 1–8, 11 timing, 12 overrun, 13–20 knock trim cyl 1–8
const CH = { rpm: 1, map: 2, ign_timing: 11, ign_timing_comp: -1, tps: -1, gear: -1, overrun: 12, load_norm: -1 };
for (let c = 1; c <= 8; c++) { CH['knock_cyl_' + c] = 2 + c; CH['knock_trim_' + c] = 12 + c; }
function rows(n, f) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const r = [i * 0.01, 3000, 100, 1, 1, 1, 1, 1, 1, 1, 1, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        if (f) f(r, i);
        out.push(r);
    }
    return out;
}
const TABLE = { rpm: [1000, 2000, 3000, 4000], load: null, values: [[20, 20, 22, 28]] };

console.log('Threshold from the tune:');
check('interpolates the Knock Threshold table by engine speed, clamped at the ends', function () {
    eq(K.knockThresholdAt(TABLE, 3000), 22);
    near(K.knockThresholdAt(TABLE, 3500), 25, 1e-9);
    eq(K.knockThresholdAt(TABLE, 500), 20);
    eq(K.knockThresholdAt(TABLE, 9000), 28);
    eq(K.knockThresholdAt(12, 3000), 12, 'a fixed threshold');
});
check('interpolates by load when the table has load sites', function () {
    const t = { rpm: [1000, 3000], load: [0.5, 1.5], values: [[10, 10], [30, 30]] };
    eq(K.knockThresholdAt(t, 2000, 1.0), 20);
    eq(K.knockThresholdAt(t, 2000, NaN), 10, 'no load logged: first load site');
});

console.log('Knock events:');
check('one event per stretch above the threshold, with its peak', function () {
    // Cylinder 3 above 22 % for 0.2 s at 100 Hz (as a 20 Hz channel held over 5 samples would be).
    const data = rows(100, (r, i) => { if (i >= 30 && i < 50) r[5] = i < 40 ? 30 : 45; });
    const ev = K.classifyKnockEvents(data, CH, TABLE);
    eq(ev.length, 1);
    eq(ev[0].cylinderIndex, 3);
    eq(ev[0].knockLevel, 45);
    eq(ev[0].threshold, 22);
    near(ev[0].ratio, 45 / 22, 1e-9);
    near(ev[0].timestamp, 0.30, 1e-9);
    near(ev[0].duration, 0.19, 1e-9);
});
check('stretches more than 0.1 s apart are separate events; short gaps are joined', function () {
    const data = rows(200, (r, i) => { if ((i >= 10 && i < 20) || (i >= 25 && i < 30) || (i >= 60 && i < 70)) r[3] = 40; });
    eq(K.classifyKnockEvents(data, CH, TABLE).length, 2);
});
check('ignores knock levels below the threshold, while cranking and in overrun', function () {
    const data = rows(300, (r, i) => {
        if (i < 50) r[3] = 21;                              // below 22 %
        if (i >= 100 && i < 120) { r[3] = 60; r[1] = 300; } // cranking
        if (i >= 200 && i < 220) { r[3] = 60; r[12] = 1; }  // overrun
    });
    eq(K.classifyKnockEvents(data, CH, TABLE).length, 0);
});
check('records the knock trim at the peak', function () {
    const data = rows(50, (r, i) => { if (i >= 10 && i < 20) { r[4] = 50; r[14] = 2.5; } });
    eq(K.classifyKnockEvents(data, CH, TABLE)[0].knockTrim, 2.5);
});

console.log('Bins:');
check('default bins are 500 rpm × 10 kPa', function () {
    K.configureKnockBins(null);
    eq(K.assignRpmBin(3100), 6);
    eq(K.assignRpmBin(9000), 14);
    eq(K.assignLoadBin(105), 10);
});
check('tune bins follow the Ignition Timing Main sites (nearest site)', function () {
    const b = K.configureKnockBins({ rpm: [0, 500, 1000, 2000, 3000], load: [0, 0.5, 1.0] }, true);
    eq(b.rpmLabels.join(','), '0,500,1000,2000,3000');
    eq(K.assignRpmBin(1400), 2, '1400 is nearest 1000');
    eq(K.assignRpmBin(1600), 3, '1600 is nearest 2000');
    eq(K.assignRpmBin(5000), 4);
    eq(b.loadKind, 'loadNorm');
    eq(K.assignLoadBin(0.8), 2);
    const noLoad = K.configureKnockBins({ rpm: [1000, 2000], load: [0, 1] }, false);
    eq(noLoad.loadKind, 'map', 'Engine Load Normalised not logged: MAP rows');
    K.configureKnockBins(null);
});

console.log('Timing advice:');
check('no events, no advice', function () { eq(K.computeTimingRecommendations([]).length, 0); });
check('reduction by how far over the threshold; single events are not acted on', function () {
    const ev = (cyl, ratio) => ({ cylinderIndex: cyl, ratio: ratio });
    const recs = K.computeTimingRecommendations([ev(1, 1.2), ev(1, 1.4), ev(2, 1.8), ev(2, 1.1), ev(3, 2.5), ev(3, 1), ev(4, 3)]);
    eq(recs.map(r => r.cylinderIndex + ':' + r.reductionDeg).join(','), '1:1,2:2,3:3,4:0');
    if (!/re-log/.test(recs[3].note)) throw new Error('single event note');
});
check('most cylinders knocking points at the main timing table', function () {
    const ev = [];
    for (let c = 1; c <= 6; c++) ev.push({ cylinderIndex: c, ratio: 1.2 }, { cylinderIndex: c, ratio: 1.3 });
    if (!/Ignition Timing Main/.test(K.computeTimingRecommendations(ev)[0].note)) throw new Error('expected main table advice');
});

console.log('Knock retard:');
check('uses the per-cylinder knock trims when logged', function () {
    const data = rows(100, (r, i) => { if (i >= 10 && i < 30) r[13] = 3; if (i >= 50 && i < 60) r[16] = -1.5; });
    const s = K.computeTimingRetardStats(data, CH, [{ knockTrim: 3 }, { knockTrim: 1 }]);
    eq(s.source, 'knockTrim');
    eq(s.maxRetard, 3);
    eq(s.perCylinder[0].maxTrim, 3);
    near(s.perCylinder[0].activeTime, 0.2, 1e-9);
    eq(s.perCylinder[3].maxTrim, 1.5);
    eq(s.meanDuringKnock, 2);
});
check('falls back to timing compensation, labelled as all compensations', function () {
    const ch = Object.assign({}, CH, { ign_timing_comp: 11 });
    for (let c = 1; c <= 8; c++) ch['knock_trim_' + c] = -1;
    const s = K.computeTimingRetardStats(rows(10, (r, i) => { r[11] = -i * 0.2; }), ch, []);
    eq(s.source, 'timingComp');
    near(s.compensation.min, -1.8, 1e-9);
    if (!/all compensations/.test(s.timeSeries.label)) throw new Error('label');
});
check('neither channel: null', function () {
    const ch = Object.assign({}, CH);
    for (let c = 1; c <= 8; c++) ch['knock_trim_' + c] = -1;
    eq(K.computeTimingRetardStats(rows(5), ch, []), null);
});

console.log('Knock sensor check:');
const INPUTS = ['Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2', 'Knock Input 1', 'Knock Input 2'];
check('flags a knock input reading far below the other', function () {
    const data = rows(500, (r, i) => { for (let c = 1; c <= 8; c++) r[2 + c] = c % 2 ? 1 + (i % 5) * 0.1 : 0.1; });
    const h = K.computeKnockSensorHealth(data, CH, INPUTS);
    eq(h.weak.length, 1);
    eq(h.weak[0].label, 'Knock Input 2');
    eq(h.weak[0].cylinders.join(','), '2,4,6,8');
    const msgs = K.generateDiagnostics({ total: 0, counts: [0, 0, 0, 0, 0, 0, 0, 0], percentages: [], ranking: [] }, {}, null, { health: h });
    if (!/KNOCK SENSOR CHECK: Knock Input 2/.test(msgs[0])) throw new Error(msgs[0]);
});
check('no flag when the cylinders read alike; ignores samples while stopped', function () {
    const data = rows(500, (r, i) => { for (let c = 1; c <= 8; c++) r[2 + c] = 1 + (c % 3) * 0.2; if (i < 100) { r[1] = 0; r[4] = 0; } });
    eq(K.computeKnockSensorHealth(data, CH, INPUTS).weak.length, 0);
});
check('without the tune, weak cylinders are reported together', function () {
    const data = rows(500, (r, i) => { for (let c = 1; c <= 8; c++) r[2 + c] = c % 2 ? 1 + (i % 5) * 0.1 : 0.1; });
    const h = K.computeKnockSensorHealth(data, CH, null);
    eq(h.weak.length, 1);
    eq(h.weak[0].label, 'Cylinders 2, 4, 6, 8');
});
check('without the tune, a single weak cylinder is named', function () {
    const data = rows(200, (r) => { r[9] = 0.05; });
    const h = K.computeKnockSensorHealth(data, CH, null);
    eq(h.weak.map(w => w.label).join(','), 'Cylinder 7');
});

console.log('Diagnostics:');
check('no knock: says which threshold was used', function () {
    const m = K.generateDiagnostics({ total: 0, counts: [0, 0, 0, 0, 0, 0, 0, 0], percentages: [], ranking: [] }, {}, null,
        { thresholdLabel: 'the tune\'s Knock Threshold' });
    eq(m.length, 1);
    if (!/the tune's Knock Threshold/.test(m[0])) throw new Error(m[0]);
});
check('asks for the knock trim channels when only timing compensation is logged', function () {
    const dist = { total: 3, counts: [3, 0, 0, 0, 0, 0, 0, 0], percentages: [100, 0, 0, 0, 0, 0, 0, 0], ranking: [1, 2, 3, 4, 5, 6, 7, 8] };
    const m = K.generateDiagnostics(dist, { worstRpmBin: null, worstLoadBin: null }, { source: 'timingComp', meanDuringKnock: 0 }, {});
    if (!m.some(x => /Knock Trim/.test(x))) throw new Error('expected knock trim note');
});
check('many events with almost no knock retard suggests noise', function () {
    const dist = { total: 30, counts: [10, 10, 10, 0, 0, 0, 0, 0], percentages: [33, 33, 33, 0, 0, 0, 0, 0], ranking: [1, 2, 3, 4, 5, 6, 7, 8] };
    const m = K.generateDiagnostics(dist, { worstRpmBin: null, worstLoadBin: null }, { source: 'knockTrim', meanDuringKnock: 0.2 }, {});
    if (!m.some(x => /average knock retard of only 0.2/.test(x))) throw new Error(m.join('\n'));
});

console.log('Tune package:');
check('reads the threshold table, ignition axes and knock inputs from a package', function () {
    const pkg = { tuneName: 'T', items: [
        { name: 'Knock.Threshold', kind: 'Table', unit: 'ratio', values: [0.2, 0.3, 0, 0],
          axes: [{ axis: 'X', unit: 'deg/s', input: 'Engine.Speed.Reference.Engine Speed', sites: 2, maxSites: 4, values: [6000, 12000, 0, 0] },
                 { axis: 'Y', unit: 'ratio', input: 'Engine.Load.Normalised.Value', sites: 1, maxSites: 1, values: [0] }] },
        { name: 'Ignition.Timing.Main', kind: 'Table', unit: 'deg', values: [],
          axes: [{ axis: 'X', unit: 'deg/s', sites: 3, maxSites: 3, values: [0, 3000, 6000] },
                 { axis: 'Y', unit: 'ratio', input: 'Engine.Load.Normalised.Value', sites: 2, maxSites: 2, values: [0.5, 1] }] },
        { name: 'Knock.Cylinder 1.Resource.Value', value: ['0x0000', '0x0000', '0x6100'] },
        { name: 'Knock.Cylinder 2.Resource.Value', value: ['0x0000', '0x0000', '0x6101'] },
        { name: 'Knock.Trim.Limit', values: [8, 0] }
    ] };
    const k = m1pkgKnock(pkg);
    eq(JSON.stringify(k.threshold), JSON.stringify({ rpm: [1000, 2000], load: null, values: [[20, 30]] }));
    eq(k.ignitionAxes.rpm.join(','), '0,500,1000');
    eq(k.ignitionAxes.load.join(','), '0.5,1');
    eq(k.inputs.slice(0, 3).join(','), 'Knock Input 1,Knock Input 2,');
    eq(k.trimLimit, 8);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
