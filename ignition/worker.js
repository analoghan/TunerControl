/**
 * ignition/worker.js — Ignition Review worker. Loaded after lib/ld-parser.js, ve-table/worker.js (splitCsvLine for CSV logs),
 * log-viewer/log-file.js, log-health/health-checks.js (log helpers) and ign-analysis.js; replaces the VE worker's handler.
 *
 *   { type: 'analyze', data: ArrayBuffer | string, name, tune: m1pkgIgnition() | null } → { type: 'result', result: igAnalyze() } | { type: 'error', message }
 */

self.onmessage = function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'analyze') return;
    try {
        self.postMessage({ type: 'result', result: igAnalyze(lvOpenLog(msg.data, msg.name), msg.tune || null) });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
