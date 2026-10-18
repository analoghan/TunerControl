/**
 * transmission/worker.js — Transmission Shift Analyzer worker: reads a TurboLamik TunerPro RT log (.csv, or .xdl with its .adx)
 * and optionally the TCU bin (.bin with its .xdf), then runs shift-analysis.js.
 * Loaded after xdl-parser.js, bin-reader.js and shift-analysis.js (importScripts).
 *
 * Message in:  { type: 'analyze', logText | (xdlBuffer + adxText), binBuffer?, xdfText? }
 * Messages out: { type: 'progress', phase, percent }, { type: 'error', message },
 *               { type: 'result', analysis (tsaAnalyze), bin: { settings, metadata } | null, log: { channels, rows, date } }
 */

// ---------------------------------------------------------------------------
// CSV Parsing (TunerPro RT format)
// ---------------------------------------------------------------------------

function parseTunerProCsv(text, onProgress) {
    var lines = text.split(/\r?\n/);

    // TunerPro RT CSV format:
    // Line 0: "TunerPro Engine data log recorded on ..."
    // Line 1: Channel names (without units) — comma separated, first field empty or "Time"
    // Line 2: Channel names with units — "Sample #,Seconds,..." — THIS is our header
    // Line 3+: Data rows

    // Find the header row (starts with "Sample #" or has "Seconds" as second field)
    var headerIdx = -1;
    for (var i = 0; i < Math.min(10, lines.length); i++) {
        var firstField = lines[i].split(',')[0].trim();
        if (firstField === 'Sample #' || firstField === 'Sample') {
            headerIdx = i;
            break;
        }
    }

    // Fallback: use line 2 if not found
    if (headerIdx === -1) headerIdx = 2;

    // But we actually want the channel names from line 1 (simpler names without units)
    // However line 1 starts with empty field + "Time", while line 2 starts with "Sample #" + "Seconds"
    // Use line 1 for channel names since they're cleaner
    var nameLineIdx = headerIdx - 1;
    if (nameLineIdx < 0) nameLineIdx = 0;

    var nameFields = lines[nameLineIdx].split(',');
    var headerFields = lines[headerIdx].split(',');

    // Build column names: prefer the name line but use header line for first two cols
    var columnNames = [];
    for (var i = 0; i < headerFields.length; i++) {
        var name = i < nameFields.length ? nameFields[i].trim() : headerFields[i].trim();
        // Clean up quotes
        if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
        columnNames.push(name);
    }

    // Parse data rows
    var dataStart = headerIdx + 1;
    var data = [];
    var numCols = columnNames.length;

    for (var i = dataStart; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;

        var fields = line.split(',');
        var row = new Array(numCols);
        for (var c = 0; c < numCols; c++) {
            if (c < fields.length) {
                var val = fields[c].trim().replace(/^"|"$/g, '');
                // Handle hex values (like "0x03")
                if (val.startsWith('0x')) {
                    row[c] = parseInt(val, 16);
                } else {
                    row[c] = parseFloat(val);
                }
            } else {
                row[c] = NaN;
            }
        }
        data.push(row);

        if (data.length % 5000 === 0 && onProgress) {
            onProgress(i - dataStart, lines.length - dataStart);
        }
    }

    return { columnNames: columnNames, data: data };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'analyze') return;
    function progress(phase, percent) { self.postMessage({ type: 'progress', phase: phase, percent: percent }); }
    try {
        var columnNames, data, date = '';
        if (msg.xdlBuffer) {
            progress('Reading the ADX channel definitions…', 5);
            var adx = parseAdx(msg.adxText);
            progress('Reading the XDL log…', 10);
            var x = parseXdl(msg.xdlBuffer, adx, function (done, total) { progress('Reading the XDL log…', 10 + Math.round(done / total * 30)); });
            columnNames = x.columnNames; data = x.data; date = x.metadata.date;
        } else {
            progress('Reading the CSV log…', 5);
            var c = parseTunerProCsv(msg.logText, function (done, total) { progress('Reading the CSV log…', 5 + Math.round(done / total * 35)); });
            columnNames = c.columnNames; data = c.data;
        }
        if (data.length < 10) throw new Error('Not enough data in the log.');
        var bin = null;
        if (msg.binBuffer && msg.xdfText) {
            progress('Reading the bin…', 45);
            var cfg = readBinConfig(msg.binBuffer, parseXdf(msg.xdfText));
            bin = { settings: cfg.settings, metadata: cfg.metadata };
        }
        progress('Finding shifts…', 60);
        var analysis = tsaAnalyze(columnNames, data, bin ? bin.settings : null);
        progress('Complete', 100);
        self.postMessage({ type: 'result', analysis: analysis, bin: bin, log: { channels: columnNames.length, rows: data.length, date: date } });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error during analysis.' });
    }
};
