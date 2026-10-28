/**
 * log-health/worker.js — Log Health worker. Loaded after lib/ld-parser.js, ve-table/worker.js (splitCsvLine for CSV logs),
 * log-viewer/log-file.js, lib/xz-decoder.js, lib/m1pkg-parser.js and health-checks.js; replaces the VE worker's handler.
 *
 *   { type: 'analyze', data: ArrayBuffer | string, name, tune: m1pkgHealth() | null, tuneBytes: ArrayBuffer | null }
 *     → { type: 'result', result: lhAnalyze() }  |  { type: 'error', message }
 * tuneBytes (the original .m1pkg) gives the firmware's names for diagnostic values (m1pkgChannelEnums).
 */

self.onmessage = function (e) {
    var msg = e.data;
    if (!msg || msg.type !== 'analyze') return;
    try {
        var enums = null;
        if (msg.tuneBytes) {
            try { enums = m1pkgChannelEnums(msg.tuneBytes); } catch (err) { enums = null; }
        }
        var log = lvOpenLog(msg.data, msg.name);
        self.postMessage({ type: 'result', result: lhAnalyze(log, { tune: msg.tune || null, enums: enums }) });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
