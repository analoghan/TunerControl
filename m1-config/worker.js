/**
 * m1-config/worker.js — Parses an .m1pkg off the main thread.
 * Loaded via a blob wrapper that first importScripts() lib/xz-decoder.js and lib/m1pkg-parser.js.
 * Message in:  { buffer: ArrayBuffer }
 * Message out: { type: 'result', result } | { type: 'error', message }
 */

self.onmessage = function (e) {
    try {
        self.postMessage({ type: 'result', result: parseM1Pkg(e.data.buffer) });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
