/**
 * di-timing/worker.js — Checks a log's injection events against the valve timing. Loaded after ve-table/worker.js,
 * log-viewer/log-file.js and di-timing/di-calc.js (see app.js), so it replaces the VE worker's message handler.
 *
 * In:  { type: 'analyze', data, name, evc, primaryLimit, table: { rpm, map } | null }
 * Out: { type: 'result', samples, pw: { median, p99, max }, angle: { min, median, max }, counts: { beforeEvc, intoCompression,
 *        truncated, nearSpark }, worst, cells }  |  { type: 'error', message }
 *
 * Uses the logged start angle (Fuel Cylinder 1 Primary Output Pulse Angle), pulse width and Ignition Timing; the end of
 * injection is the start minus the pulse's crank degrees. Only engine-running samples with a real angle are used.
 */

var DI_LOG_CHANNELS = {
    pw: 'Fuel Cylinder 1 Primary Output Pulse Width 1',
    angle: 'Fuel Cylinder 1 Primary Output Pulse Angle 1',
    rpm: 'Engine Speed', map: 'Inlet Manifold Pressure', spark: 'Ignition Timing'
};

function diNearest(sites, v) {
    var best = 0;
    for (var i = 1; i < sites.length; i++) if (Math.abs(sites[i] - v) < Math.abs(sites[best] - v)) best = i;
    return best;
}

function diQuantile(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null; }

function diAnalyzeLog(log, opts) {
    var arr = {};
    Object.keys(DI_LOG_CHANNELS).forEach(function (k) {
        var i = lvFind(log, DI_LOG_CHANNELS[k]);
        arr[k] = i >= 0 ? lvAtBase(log, i) : null;
    });
    var missing = ['pw', 'angle', 'rpm'].filter(function (k) { return !arr[k]; }).map(function (k) { return DI_LOG_CHANNELS[k]; });
    if (missing.length) throw new Error('The log has no ' + missing.join(', ') + ' channel' + (missing.length > 1 ? 's' : '') + '.');

    // One reading per 10 Hz period is enough (pulse width and angle are logged at 10 Hz or slower).
    var step = Math.max(1, Math.round(log.baseFreq / 10)), pws = [], angles = [], n = 0;
    var counts = { beforeEvc: 0, intoCompression: 0, truncated: 0, nearSpark: 0 }, worst = null;
    var t = opts.table, cells = t ? t.map.map(function () { return t.rpm.map(function () { return { n: 0, pw: [], angle: [], worstEoi: null }; }); }) : null;
    for (var i = 0; i < arr.rpm.length; i += step) {
        var rpm = arr.rpm[i], pw = arr.pw[i], soi = arr.angle[i];
        if (!(rpm >= 500) || !(pw > 0) || !(soi > 0)) continue;
        var spark = arr.spark ? arr.spark[i] : NaN;
        var c = diCheckInjection(soi, pw, rpm, { evc: opts.evc, primaryLimit: opts.primaryLimit, spark: isNaN(spark) ? undefined : spark });
        n++; pws.push(pw); angles.push(soi);
        if (c.beforeEvc) counts.beforeEvc++;
        if (c.intoCompression) counts.intoCompression++;
        if (c.truncated) counts.truncated++;
        if (c.nearSpark) counts.nearSpark++;
        if (!worst || c.eoi < worst.eoi) {
            worst = { time: Math.round(i / log.baseFreq * 10) / 10, rpm: Math.round(rpm), map: arr.map ? Math.round(arr.map[i]) : null, pw: pw, soi: soi,
                      eoi: c.eoi, spark: isNaN(spark) ? null : spark };
        }
        if (cells && arr.map && !isNaN(arr.map[i])) {
            var cell = cells[diNearest(t.map, arr.map[i])][diNearest(t.rpm, rpm)];
            cell.n++; cell.pw.push(pw); cell.angle.push(soi);
            if (cell.worstEoi === null || c.eoi < cell.worstEoi) cell.worstEoi = c.eoi;
        }
    }
    if (!n) throw new Error('No engine-running samples with an injection angle and pulse width in this log.');
    pws.sort(function (a, b) { return a - b; });
    angles.sort(function (a, b) { return a - b; });
    var r = function (v, d) { return v === null ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d); };
    return {
        samples: n,
        pw: { median: r(diQuantile(pws, 0.5), 2), p99: r(diQuantile(pws, 0.99), 2), max: r(pws[pws.length - 1], 2) },
        angle: { min: r(angles[0], 1), median: r(diQuantile(angles, 0.5), 1), max: r(angles[angles.length - 1], 1) },
        counts: counts,
        worst: worst ? { time: worst.time, rpm: worst.rpm, map: worst.map, pw: r(worst.pw, 2), soi: r(worst.soi, 1), eoi: r(worst.eoi, 1),
                         spark: r(worst.spark, 1) } : null,
        cells: cells ? cells.map(function (row) {
            return row.map(function (c) {
                if (!c.n) return null;
                c.pw.sort(function (a, b) { return a - b; }); c.angle.sort(function (a, b) { return a - b; });
                return { n: c.n, p99Pw: r(diQuantile(c.pw, 0.99), 2), maxPw: r(c.pw[c.pw.length - 1], 2), angle: r(diQuantile(c.angle, 0.5), 1),
                         worstEoi: r(c.worstEoi, 1) };
            });
        }) : null
    };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    self.onmessage = function (e) {
        var msg = e.data || {};
        try {
            if (msg.type !== 'analyze') return;
            var log = lvOpenLog(msg.data, msg.name);
            self.postMessage(Object.assign({ type: 'result' }, diAnalyzeLog(log, msg)));
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
    };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { diAnalyzeLog: diAnalyzeLog };
