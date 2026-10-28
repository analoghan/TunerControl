/**
 * cl-period/worker.js — Closed-Loop Period worker. Loaded after lib/ld-parser.js, ve-table/worker.js (splitCsvLine for CSV logs),
 * log-viewer/log-file.js, log-health/health-checks.js (log helpers) and cl-analysis.js; replaces the VE worker's handler.
 *
 *   { type: 'analyze', logs: [{ data: ArrayBuffer | string, name }], tune: m1pkgClPeriod() | null }
 *     → { type: 'result', result: clAnalyze() } | { type: 'error', message }
 */

self.onmessage = function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'analyze') return;
    try {
        var logs = msg.logs.map(function (l) { return lvOpenLog(l.data, l.name); });
        self.postMessage({ type: 'result', result: clAnalyze(logs, msg.tune || null) });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
