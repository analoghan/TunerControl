/**
 * log-viewer/log-file.js — Reads MoTeC logs channel by channel for the Log Viewer.
 * Works in a worker and in Node; uses ldReadChannels and decodeFloat16 from lib/ld-parser.js and splitCsvLine from
 * ve-table/worker.js, so channel names match the analysis tools.
 *
 *   lvOpenLog(data, name)  data: ArrayBuffer (.ld) or string (.csv)
 *     → { kind, channels: [{ name, unit, freq, n }], duration, baseFreq }
 *   lvChannel(log, i)      → Float64Array of channel i's values (at its own rate, or log.time for CSV)
 *   lvAtBase(log, i)       → Float64Array of channel i resampled to the base rate (sample-and-hold), as the tools see it
 *   lvBaseTime(log)        → Float64Array of base-rate times
 */

function lvOpenLd(buffer) {
    var channels = ldReadChannels(buffer).map(function (c) {
        return { name: c.name, unit: c.unit, freq: c.freq, n: c.nData,
                 ld: { ptr: c.dataPtr, type: c.dataType, shift: c.shift, mul: c.mul, scale: c.scale, dec: c.dec } };
    }).filter(function (c) { return c.freq > 0 && c.n > 0; });
    if (!channels.length) throw new Error('No channels found in .ld file');
    // The base rate and length are those of the fastest channel, as the analysis tools use.
    var baseFreq = Math.max.apply(null, channels.map(function (c) { return c.freq; }));
    var baseN = channels.filter(function (c) { return c.freq === baseFreq; })[0].n;
    return { kind: 'ld', buffer: buffer, channels: channels, baseFreq: baseFreq, baseN: baseN, duration: baseN / baseFreq };
}

function lvOpenCsv(text) {
    var lines = text.replace(/\0/g, '').split('\n');
    var header = -1;
    for (var i = 0; i < Math.min(25, lines.length); i++) {
        var f0 = splitCsvLine(lines[i].replace(/\r$/, ''))[0];
        if (f0 !== undefined && f0.trim() === 'Time') { header = i; break; }
    }
    if (header < 0) throw new Error('"Time" header row not found — this does not look like a MoTeC CSV export.');
    var names = splitCsvLine(lines[header].replace(/\r$/, '')).map(function (s) { return s.trim(); });
    var units = splitCsvLine((lines[header + 1] || '').replace(/\r$/, '')).map(function (s) { return s.trim(); });
    var rows = [];
    for (i = header + 2; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');
        if (!line.replace(/[,"\s]/g, '')) continue;
        rows.push(line);
    }
    var cols = names.map(function () { return new Float64Array(rows.length); });
    var time = new Float64Array(rows.length);
    rows.forEach(function (line, r) {
        var f = splitCsvLine(line);
        time[r] = parseFloat(f[0]);
        for (var c = 1; c < names.length; c++) cols[c][r] = f[c] === undefined || f[c].trim() === '' ? NaN : parseFloat(f[c]);
    });
    var dt = rows.length > 1 ? (time[rows.length - 1] - time[0]) / (rows.length - 1) : 0.01;
    var freq = dt > 0 ? Math.round(1 / dt) : 100;
    var channels = [];
    for (var c = 1; c < names.length; c++) channels.push({ name: names[c], unit: units[c] || '', freq: freq, n: rows.length, data: cols[c] });
    return { kind: 'csv', time: time, channels: channels, baseFreq: freq, baseN: rows.length,
             duration: rows.length ? time[rows.length - 1] - time[0] : 0 };
}

function lvOpenLog(data, name) {
    return typeof data === 'string' || /\.csv$/i.test(name || '') ? lvOpenCsv(typeof data === 'string' ? data : new TextDecoder().decode(data))
        : lvOpenLd(data);
}

function lvChannel(log, i) {
    var c = log.channels[i];
    if (c.data) return c.data;
    var ld = c.ld, view = new DataView(log.buffer), out = new Float64Array(c.n);
    var bytes = ld.type === 'float16' || ld.type === 'int16' ? 2 : 4, off = ld.ptr, decFactor = Math.pow(10, -ld.dec);
    for (var k = 0; k < c.n; k++, off += bytes) {
        if (!ld.type || off + bytes > log.buffer.byteLength) { out[k] = NaN; continue; }
        var raw = ld.type === 'float32' ? view.getFloat32(off, true) : ld.type === 'float16' ? decodeFloat16(view.getUint16(off, true))
            : ld.type === 'int16' ? view.getInt16(off, true) : view.getInt32(off, true);
        out[k] = (raw / ld.scale * decFactor + ld.shift) * ld.mul;
    }
    return out;
}

function lvBaseTime(log) {
    if (log.time) return log.time;
    var n = log.baseN, t = new Float64Array(n), dt = 1.0 / log.baseFreq;
    for (var k = 0; k < n; k++) t[k] = k * dt;   // exactly as the VE tool computes it, so filter edges match
    return t;
}

function lvAtBase(log, i) {
    var c = log.channels[i], v = lvChannel(log, i);
    if (log.time || c.freq === log.baseFreq) return v;
    var n = log.baseN, out = new Float64Array(n), ratio = log.baseFreq / c.freq;
    for (var k = 0; k < n; k++) out[k] = v[Math.min(Math.floor(k / ratio), v.length - 1)];
    return out;
}

/** Index of the first channel named `name` (case-insensitive), or -1. */
function lvFind(log, name) {
    var want = name.toLowerCase();
    for (var i = 0; i < log.channels.length; i++) if (log.channels[i].name.toLowerCase() === want) return i;
    return -1;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lvOpenLog: lvOpenLog, lvChannel: lvChannel, lvAtBase: lvAtBase, lvBaseTime: lvBaseTime, lvFind: lvFind };
}
