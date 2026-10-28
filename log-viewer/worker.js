/**
 * log-viewer/worker.js — Log Viewer worker. Loaded after ve-table/worker.js, transient-fuel/worker.js and
 * log-viewer/log-file.js (see log-panel.js), so it replaces the VE worker's message handler.
 *
 * Messages in → out:
 *   { type: 'open', data, name }                → { type: 'opened', channels, duration, baseFreq }
 *   { type: 'channels', ids: [i] }              → { type: 'channels', list: [{ id, freq, values, time? }] }
 *   { type: 'analyze', ve, tf, veTable? }       → { type: 'analysis', ve: { segments, counts, used } | { error },
 *                                                    tf: { events, skipped } | { error } }
 *   { type: 'cell', m, r }                      → { type: 'cell', segments, weight, mean }   (needs a veTable)
 * Errors → { type: 'error', message, for }
 */

var lvLog = null, lvVe = null;

/** Run-length segments [t0, t1, code] of the non-zero codes; t1 is the end of the last sample. */
function lvSegments(codes, time, dt) {
    var out = [], start = -1;
    for (var i = 0; i <= codes.length; i++) {
        var c = i < codes.length ? codes[i] : 0;
        if (start >= 0 && c !== codes[start]) { out.push([time[start], time[i - 1] + dt, codes[start]]); start = -1; }
        if (start < 0 && c !== 0) start = i;
    }
    return out;
}

function lvBaseArrays(names) {
    var out = {};
    names.forEach(function (key) {
        var i = lvFind(lvLog, CHANNEL_NAMES[key]);
        out[key] = i >= 0 ? lvAtBase(lvLog, i) : null;
    });
    return out;
}

function lvAnalyzeVe(settings, veTable) {
    resolveChannels(lvLog.channels.map(function (c) { return c.name; }));   // throws when a required channel is missing
    var hasBank = lvFind(lvLog, CHANNEL_NAMES.LAMBDA_B1) >= 0 || lvFind(lvLog, CHANNEL_NAMES.LAMBDA_B2) >= 0;
    var a = lvBaseArrays(['RPM', 'MAP', 'LAMBDA_B1', 'LAMBDA_B2', 'LAMBDA_AVG', 'LAMBDA_TARGET', 'CL_TRIM_B1', 'CL_TRIM_B2',
        'COOLANT_TEMP', 'THROTTLE_POS', 'OVERRUN_STATE', 'FUEL_CUT_COUNT', 'ENGINE_LOAD', 'STOICH', 'EXHAUST_FLOW']);
    if (hasBank) a.LAMBDA_AVG = null;   // as resolveChannels: overall lambda only without bank channels
    var time = lvBaseTime(lvLog), n = time.length, samples = new Array(n);
    function v(key, i) { return a[key] ? a[key][i] : NaN; }
    for (var i = 0; i < n; i++) {
        samples[i] = { time: time[i], rpm: v('RPM', i), map: v('MAP', i), lambdaB1: v('LAMBDA_B1', i), lambdaB2: v('LAMBDA_B2', i),
            lambdaAvg: v('LAMBDA_AVG', i), lambdaTarget: v('LAMBDA_TARGET', i), clTrimB1: v('CL_TRIM_B1', i), clTrimB2: v('CL_TRIM_B2', i),
            coolantTemp: v('COOLANT_TEMP', i), throttlePos: v('THROTTLE_POS', i), overrunState: v('OVERRUN_STATE', i),
            fuelCutCount: v('FUEL_CUT_COUNT', i), engineLoad: v('ENGINE_LOAD', i), stoich: v('STOICH', i), exhaustFlow: v('EXHAUST_FLOW', i) };
    }
    var reasons = new Uint8Array(n), corrections = new Float32Array(n);
    var table = veTable || { mapBreakpoints: [1000, 0], rpmBreakpoints: [0, 30000], values: [[0, 0], [0, 0]] };
    var res = analyzeVE(samples, table, Object.assign({}, settings, { reasons: reasons, corrections: corrections }));
    lvVe = { samples: samples, reasons: reasons, corrections: corrections, table: veTable || null, time: time };
    var counts = {};
    for (i = 0; i < n; i++) counts[reasons[i]] = (counts[reasons[i]] || 0) + 1;
    return { segments: lvSegments(reasons, time, 1 / lvLog.baseFreq), counts: counts, used: counts[0] || 0,
             totalSamples: res.totalSamples, cellsAboveThreshold: res.cellsAboveThreshold };
}

function lvAnalyzeTf(settings) {
    var a = lvBaseArrays(['RPM', 'MAP', 'LAMBDA_B1', 'LAMBDA_B2', 'LAMBDA_AVG', 'LAMBDA_TARGET', 'COOLANT_TEMP', 'THROTTLE_POS',
        'OVERRUN_STATE', 'FUEL_CUT_COUNT']);
    if (!a.MAP) throw new Error('"Inlet Manifold Pressure" channel not found.');
    if (!a.LAMBDA_B1 && !a.LAMBDA_B2 && !a.LAMBDA_AVG) throw new Error('No lambda channel found.');
    var time = lvBaseTime(lvLog), samples = [];
    function v(key, i) { return a[key] ? a[key][i] : NaN; }
    for (var i = 0; i < time.length; i++) {
        var map = v('MAP', i);
        if (isNaN(time[i]) || isNaN(map)) continue;
        // Lambda as the Transient Fuel Analyzer reads it: the bank average, else one bank, else overall lambda.
        var b1 = v('LAMBDA_B1', i), b2 = v('LAMBDA_B2', i), lambda;
        if (b1 > 0 && b2 > 0) lambda = (b1 + b2) / 2;
        else if (b1 > 0) lambda = b1;
        else if (b2 > 0) lambda = b2;
        else lambda = v('LAMBDA_AVG', i);
        samples.push({ time: time[i], map: map, lambda: lambda, lambdaTarget: v('LAMBDA_TARGET', i), rpm: v('RPM', i), tps: v('THROTTLE_POS', i),
            coolant: v('COOLANT_TEMP', i), overrunState: v('OVERRUN_STATE', i), fuelCutCount: v('FUEL_CUT_COUNT', i) });
    }
    var r = analyzeTransientSamples(samples, settings);
    return { events: r.tipIns.concat(r.tipOuts).sort(function (x, y) { return x.time - y.time; }), skipped: r.skipped,
             unsettledTipIns: r.unsettledTipIns };
}

/** Time segments of the used samples that count towards VE cell (m, r), with their weight and mean correction. */
function lvCell(m, r) {
    if (!lvVe || !lvVe.table) throw new Error('No VE table: cell samples need the VE analysis from the VE Table Tuning page.');
    var mapAxis = makeAxis(lvVe.table.mapBreakpoints), rpmAxis = makeAxis(lvVe.table.rpmBreakpoints);
    var n = lvVe.samples.length, mark = new Uint8Array(n), wSum = 0, cSum = 0;
    for (var i = 0; i < n; i++) {
        if (lvVe.reasons[i] !== 0) continue;
        var s = lvVe.samples[i], mw = axisWeights(s.map, mapAxis), rw = axisWeights(s.rpm, rpmAxis);
        if (!mw || !rw) continue;
        var wm = 0, wr = 0;
        mw.forEach(function (x) { if (x[0] === m) wm = x[1]; });
        rw.forEach(function (x) { if (x[0] === r) wr = x[1]; });
        if (wm * wr > 0) { mark[i] = 1; wSum += wm * wr; cSum += wm * wr * lvVe.corrections[i]; }
    }
    return { segments: lvSegments(mark, lvVe.time, 1 / lvLog.baseFreq), weight: wSum, mean: wSum > 0 ? cSum / wSum : null };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    self.onmessage = function (e) {
        var msg = e.data || {};
        try {
            if (msg.type === 'open') {
                lvLog = lvOpenLog(msg.data, msg.name);
                lvVe = null;
                self.postMessage({ type: 'opened', duration: lvLog.duration, baseFreq: lvLog.baseFreq,
                    channels: lvLog.channels.map(function (c, i) { return { id: i, name: c.name, unit: c.unit, freq: c.freq, n: c.n }; }) });
            } else if (msg.type === 'channels') {
                var list = [], transfer = [];
                msg.ids.forEach(function (id) {
                    var src = lvChannel(lvLog, id), values = new Float32Array(src);   // a copy: CSV columns stay in the worker
                    var item = { id: id, freq: lvLog.channels[id].freq, values: values };
                    if (lvLog.time) item.time = lvLog.time.slice();
                    list.push(item);
                    transfer.push(values.buffer);
                    if (item.time) transfer.push(item.time.buffer);
                });
                self.postMessage({ type: 'channels', list: list }, transfer);
            } else if (msg.type === 'analyze') {
                var out = { type: 'analysis' };
                try { out.ve = lvAnalyzeVe(msg.ve || {}, msg.veTable); } catch (err) { out.ve = { error: err.message || String(err) }; }
                try { out.tf = lvAnalyzeTf(msg.tf || {}); } catch (err) { out.tf = { error: err.message || String(err) }; }
                self.postMessage(out);
            } else if (msg.type === 'cell') {
                self.postMessage(Object.assign({ type: 'cell', m: msg.m, r: msg.r }, lvCell(msg.m, msg.r)));
            }
        } catch (err) {
            self.postMessage({ type: 'error', for: msg.type, message: err.message || String(err) });
        }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lvSegments: lvSegments };
}
