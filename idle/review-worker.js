/**
 * idle/review-worker.js — Pull-away and feed forward review worker for the Idle page. Loaded after lib/ld-parser.js,
 * ve-table/worker.js (splitCsvLine for CSV logs), log-viewer/log-file.js, log-health/health-checks.js and idle-review.js.
 *
 *   { type: 'analyze', data: ArrayBuffer | string, name, tune: m1pkgIdle() | null } → { type: 'result', result: irAnalyze() } | { type: 'error', message }
 */

self.onmessage = function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'analyze') return;
    try {
        self.postMessage({ type: 'result', result: irAnalyze(lvOpenLog(msg.data, msg.name), msg.tune || null) });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
