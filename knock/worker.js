/**
 * worker.js — Knock Analyzer Analysis Worker.
 * Performs all heavy CSV/.ld parsing and knock analysis computation off the main thread.
 */

// ---------------------------------------------------------------------------
// MoTeC .ld Binary Parser
// ---------------------------------------------------------------------------

/**
 * Maps .ld dot-separated channel names to the CSV-style names used in CHANNEL_MAP.
 * The .ld format uses dots as hierarchy separators and truncates at 32 chars.
 */
const LD_NAME_MAP = {
    'Engine.Speed':                          'Engine Speed',
    'Inlet.Manifold.Pressure':               'Inlet Manifold Pressure',
    'Exhaust.Lambda.Bank 1':                 'Exhaust Lambda Bank 1',
    'Exhaust.Lambda.Bank 2':                 'Exhaust Lambda Bank 2',
    'Exhaust.Lambda':                        'Exhaust Lambda',
    'Throttle.Position':                     'Throttle Position',
    'Fuel.Pressure.Direct.Bank 1':           'Fuel Pressure Direct Bank 1',
    'Fuel.Pressure.Direct.Bank 1.Aim':       'Fuel Pressure Direct Bank 1 Aim',
    'Coolant.Temperature':                   'Coolant Temperature',
    'Inlet.Air.Temperature':                 'Inlet Air Temperature',
    'Fuel.Mixture Aim':                      'Fuel Mixture Aim',
};

/**
 * Converts an .ld dot-separated channel name to CSV-style name.
 * First checks the explicit map, then falls back to replacing dots with spaces.
 *
 * @param {string} ldName - Channel name from .ld file
 * @returns {string} Normalized channel name matching CSV conventions
 */
function normalizeLdChannelName(ldName) {
    if (LD_NAME_MAP[ldName]) {
        return LD_NAME_MAP[ldName];
    }
    return ldName.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Special handling for truncated .ld channel names that need matching
 * against our CHANNEL_MAP. The .ld format truncates at 32 chars.
 *
 * @param {string} ldName - Possibly truncated channel name from .ld file
 * @param {string} unit - Unit string from the channel header (stored in short_name field)
 * @returns {string} Best-guess normalized channel name
 */
function normalizeLdChannelNameWithUnit(ldName, unit) {
    if (LD_NAME_MAP[ldName]) {
        return LD_NAME_MAP[ldName];
    }

    // Handle truncated names using unit hints
    if (ldName === 'Fuel.Cylinder 1.Primary.Output.P' && unit === 'ms') {
        return 'Fuel Cylinder 1 Primary Output Pulse Width 1';
    }
    if (ldName === 'Fuel.Cylinder 1.Primary.Output.P' && unit === 'dBTDC') {
        return 'Fuel Cylinder 1 Primary Output Pulse Angle 1';
    }
    if (ldName === 'Fuel.Closed Loop.Control.Bank 1.' && unit === '%Trim') {
        return 'Fuel Closed Loop Control Bank 1 Trim';
    }
    if (ldName === 'Fuel.Closed Loop.Control.Bank 2.' && unit === '%Trim') {
        return 'Fuel Closed Loop Control Bank 2 Trim';
    }

    // Fallback: replace dots with spaces
    return ldName.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Decodes a null-terminated ASCII string from a DataView.
 *
 * @param {DataView} view - DataView of the buffer
 * @param {number} offset - Byte offset to start reading
 * @param {number} length - Maximum number of bytes to read
 * @returns {string} Decoded string with trailing nulls removed
 */
function readString(view, offset, length) {
    var bytes = [];
    for (var i = 0; i < length; i++) {
        var b = view.getUint8(offset + i);
        if (b === 0) break;
        bytes.push(b);
    }
    return String.fromCharCode.apply(null, bytes).trim();
}

/**
 * Decodes an IEEE 754 half-precision (float16) value from a uint16.
 *
 * @param {number} h - The uint16 representation of a float16
 * @returns {number} The decoded floating-point value
 */
function decodeFloat16(h) {
    var sign = (h >> 15) & 1;
    var exp = (h >> 10) & 0x1f;
    var frac = h & 0x3ff;

    if (exp === 0) {
        // Subnormal or zero
        return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
    } else if (exp === 31) {
        // Infinity or NaN
        return frac ? NaN : (sign ? -Infinity : Infinity);
    }

    return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * Reads raw numeric data for a single channel from the .ld buffer.
 *
 * @param {ArrayBuffer} buffer - The raw .ld file
 * @param {Object} chan - Channel metadata object
 * @returns {Float64Array} Raw (untransformed) numeric values
 */
function readChannelData(buffer, chan) {
    if (!chan.dataType || chan.bytesPerSample === 0) {
        return new Float64Array(chan.nData);
    }

    var result = new Float64Array(chan.nData);
    var view = new DataView(buffer);
    var offset = chan.dataPtr;

    for (var i = 0; i < chan.nData; i++) {
        if (offset + chan.bytesPerSample > buffer.byteLength) break;

        switch (chan.dataType) {
            case 'float32':
                result[i] = view.getFloat32(offset, true);
                break;
            case 'float16':
                result[i] = decodeFloat16(view.getUint16(offset, true));
                break;
            case 'int16':
                result[i] = view.getInt16(offset, true);
                break;
            case 'int32':
                result[i] = view.getInt32(offset, true);
                break;
            default:
                result[i] = 0;
        }
        offset += chan.bytesPerSample;
    }

    return result;
}

/**
 * Parses a MoTeC .ld binary file from an ArrayBuffer.
 * Returns column names and data in the same format as the CSV parser.
 *
 * @param {ArrayBuffer} buffer - The raw .ld file contents
 * @param {function} progressCallback - Called with (channelsProcessed, totalChannels)
 * @returns {{columnNames: string[], data: number[][], maxFreq: number}}
 */
function parseLdFile(buffer, progressCallback) {
    var view = new DataView(buffer);

    var metaPtr = view.getUint32(8, true);
    var dataPtr = view.getUint32(12, true);
    var numChanns = view.getUint32(86, true);

    if (metaPtr === 0 || numChanns === 0) {
        throw new Error('Invalid .ld file: no channel metadata found');
    }

    // --- Parse channel metadata ---
    var CHAN_HEADER_SIZE = 124;
    var channels = [];
    var ptr = metaPtr;

    for (var ch = 0; ch < numChanns && ptr !== 0; ch++) {
        if (ptr + CHAN_HEADER_SIZE > buffer.byteLength) break;

        var prevPtr = view.getUint32(ptr, true);
        var nextPtr = view.getUint32(ptr + 4, true);
        var chanDataPtr = view.getUint32(ptr + 8, true);
        var nData = view.getUint32(ptr + 12, true);

        var dtypeA = view.getUint16(ptr + 18, true);
        var dtypeVal = view.getUint16(ptr + 20, true);
        var freq = view.getUint16(ptr + 22, true);

        var shift = view.getInt16(ptr + 24, true);
        var mul = view.getInt16(ptr + 26, true);
        var scale = view.getInt16(ptr + 28, true);
        var dec = view.getInt16(ptr + 30, true);

        var name = readString(view, ptr + 32, 32);
        var shortName = readString(view, ptr + 64, 8);
        var unit = readString(view, ptr + 72, 12);

        // Determine data type and bytes per sample
        var bytesPerSample = 0;
        var dataType = null;
        if (dtypeA === 0x07) {
            if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'float16'; }
            else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'float32'; }
        } else if (dtypeA === 0 || dtypeA === 0x03 || dtypeA === 0x05) {
            if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'int16'; }
            else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'int32'; }
        }

        channels.push({
            name: name,
            shortName: shortName,
            unit: unit,
            freq: freq,
            dataPtr: chanDataPtr,
            nData: nData,
            dataType: dataType,
            bytesPerSample: bytesPerSample,
            shift: shift,
            mul: mul,
            scale: scale,
            dec: dec
        });

        ptr = nextPtr;
    }

    if (channels.length === 0) {
        throw new Error('No channels found in .ld file');
    }

    // --- Determine the highest frequency (base sample rate) ---
    var maxFreq = 0;
    for (var i = 0; i < channels.length; i++) {
        if (channels[i].freq > maxFreq) maxFreq = channels[i].freq;
    }

    // Total samples at the base rate
    var baseSamples = 0;
    for (var i = 0; i < channels.length; i++) {
        if (channels[i].freq === maxFreq) {
            baseSamples = channels[i].nData;
            break;
        }
    }

    if (baseSamples === 0) {
        throw new Error('Could not determine sample count from .ld file');
    }

    // --- Read channel data and resample to base rate ---
    var columnNames = ['Time'];
    var channelData = [];

    // Generate time column based on max frequency
    var timeArr = new Float64Array(baseSamples);
    var dt = 1.0 / maxFreq;
    for (var t = 0; t < baseSamples; t++) {
        timeArr[t] = t * dt;
    }
    channelData.push(timeArr);

    for (var ci = 0; ci < channels.length; ci++) {
        var chan = channels[ci];

        // Normalize channel name for CHANNEL_MAP compatibility
        var normalizedName = normalizeLdChannelNameWithUnit(chan.name, chan.shortName);
        columnNames.push(normalizedName);

        // Read raw data
        var rawData = readChannelData(buffer, chan);

        // Apply scale/shift/mul/dec transformation
        var transformed = new Float64Array(rawData.length);
        var decFactor = Math.pow(10, -chan.dec);
        for (var s = 0; s < rawData.length; s++) {
            transformed[s] = (rawData[s] / chan.scale * decFactor + chan.shift) * chan.mul;
        }

        // Resample to base rate if needed
        if (chan.freq === maxFreq) {
            channelData.push(transformed);
        } else {
            var ratio = maxFreq / chan.freq;
            var upsampled = new Float64Array(baseSamples);
            for (var u = 0; u < baseSamples; u++) {
                var srcIdx = Math.min(Math.floor(u / ratio), transformed.length - 1);
                upsampled[u] = transformed[srcIdx];
            }
            channelData.push(upsampled);
        }

        if (progressCallback) {
            progressCallback(ci + 1, channels.length);
        }
    }

    // --- Convert to row-based format matching CSV parser output ---
    var numCols = columnNames.length;
    var data = new Array(baseSamples);
    for (var r = 0; r < baseSamples; r++) {
        var row = new Array(numCols);
        for (var c = 0; c < numCols; c++) {
            row[c] = channelData[c][r];
        }
        data[r] = row;
    }

    return { columnNames: columnNames, data: data, maxFreq: maxFreq };
}

// ---------------------------------------------------------------------------
// CSV Parsing Functions
// ---------------------------------------------------------------------------

/**
 * Scans the first 25 lines to locate the header row whose first field is "Time".
 *
 * @param {string[]} lines - Array of raw CSV lines
 * @returns {number} 0-based row index of the header row
 * @throws {Error} If "Time" header not found within first 25 lines
 */
function detectHeaderRow(lines) {
    const MAX_SCAN = 25;
    for (let i = 0; i < Math.min(MAX_SCAN, lines.length); i++) {
        const firstField = lines[i].split(',')[0].trim().replace(/^"|"$/g, '');
        if (firstField === 'Time') {
            return i;
        }
    }
    throw new Error('Could not find "Time" header row in first 25 lines. Please ensure this is a MoTeC M1 CSV export.');
}

/**
 * Finds the first numeric data row after the header row.
 * Skips the units row and any blank rows.
 *
 * @param {string[]} lines - Array of CSV lines
 * @param {number} headerRowIdx - Index of the header row
 * @returns {number} Index of the first data row
 */
function findDataStart(lines, headerRowIdx) {
    for (let j = headerRowIdx + 1; j < Math.min(headerRowIdx + 6, lines.length); j++) {
        const firstField = lines[j].split(',')[0].trim().replace(/^"|"$/g, '');
        if (firstField !== '' && !isNaN(parseFloat(firstField))) {
            return j;
        }
    }
    return headerRowIdx + 2; // fallback: assume units row + 1 blank
}

/**
 * Parses all data rows into numeric arrays.
 * Non-numeric values become NaN. Posts progress every ~1000 rows.
 *
 * @param {string[]} lines - Array of CSV lines
 * @param {number} dataStart - Index of the first data row
 * @param {number} numCols - Number of columns expected
 * @param {function} progressCallback - Called with (rowsProcessed, totalRows)
 * @returns {number[][]} Array of numeric row arrays
 */
function parseDataRows(lines, dataStart, numCols, progressCallback) {
    const totalRows = lines.length - dataStart;
    const data = [];
    let lastProgress = 0;

    for (let i = dataStart; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') continue;

        const fields = line.split(',');
        const row = new Array(numCols);
        for (let c = 0; c < numCols; c++) {
            if (c < fields.length) {
                const val = parseFloat(fields[c].trim().replace(/^"|"$/g, ''));
                row[c] = val; // NaN if not numeric
            } else {
                row[c] = NaN;
            }
        }
        data.push(row);

        // Post progress every 1000 rows
        const rowsProcessed = i - dataStart + 1;
        if (rowsProcessed - lastProgress >= 1000 || i === lines.length - 1) {
            lastProgress = rowsProcessed;
            if (progressCallback) {
                progressCallback(rowsProcessed, totalRows);
            }
        }
    }

    return data;
}

// ---------------------------------------------------------------------------
// Channel Resolution
// ---------------------------------------------------------------------------

/**
 * Maps logical channel names to arrays of possible MoTeC column name candidates.
 * Each key maps to an array of possible column header strings that may appear
 * in MoTeC CSV or .ld exports.
 */
const CHANNEL_MAP = {
    knock_cyl_1:    ['Ignition Cylinder 1 Knock Level'],
    knock_cyl_2:    ['Ignition Cylinder 2 Knock Level'],
    knock_cyl_3:    ['Ignition Cylinder 3 Knock Level'],
    knock_cyl_4:    ['Ignition Cylinder 4 Knock Level'],
    knock_cyl_5:    ['Ignition Cylinder 5 Knock Level'],
    knock_cyl_6:    ['Ignition Cylinder 6 Knock Level'],
    knock_cyl_7:    ['Ignition Cylinder 7 Knock Level'],
    knock_cyl_8:    ['Ignition Cylinder 8 Knock Level'],
    ign_timing:     ['Ignition Timing'],
    ign_timing_comp:['Ignition Timing Compensation', 'Ignition Timing Comp'],
    rpm:            ['Engine Speed'],
    map:            ['Inlet Manifold Pressure'],
    tps:            ['Throttle Position'],
    gear:           ['Gear'],
    coolant_temp:   ['Coolant Temperature'],
    overrun:        ['Engine Overrun State'],
    load_norm:      ['Engine Load Normalised', 'Engine Load Normalized'],
    knock_trim_1:   ['Ignition Cylinder 1 Knock Trim'],
    knock_trim_2:   ['Ignition Cylinder 2 Knock Trim'],
    knock_trim_3:   ['Ignition Cylinder 3 Knock Trim'],
    knock_trim_4:   ['Ignition Cylinder 4 Knock Trim'],
    knock_trim_5:   ['Ignition Cylinder 5 Knock Trim'],
    knock_trim_6:   ['Ignition Cylinder 6 Knock Trim'],
    knock_trim_7:   ['Ignition Cylinder 7 Knock Trim'],
    knock_trim_8:   ['Ignition Cylinder 8 Knock Trim']
};

/**
 * Resolves logical channel names to column indices using case-insensitive matching.
 *
 * For each key in CHANNEL_MAP, finds the first matching column name (case-insensitive,
 * trimmed) and records its index. Missing knock channels (knock_cyl_1 through knock_cyl_8)
 * generate warnings. Missing optional channels (ign_timing, ign_timing_comp, rpm, map,
 * tps, gear, coolant_temp) do NOT generate warnings.
 *
 * Analysis can proceed with partial knock channels or missing optional channels.
 *
 * @param {string[]} columnNames - Array of CSV/ld column header strings
 * @returns {{ resolved: Object<string, number>, warnings: string[] }}
 *   resolved: mapping of logical name → column index (-1 if not found)
 *   warnings: array of warning strings for missing knock channels
 */
function resolveChannels(columnNames) {
    // Build normalized lookup map (first occurrence wins for duplicates)
    const nameToIdx = new Map();
    for (let i = 0; i < columnNames.length; i++) {
        const normalized = columnNames[i].trim().toLowerCase();
        if (!nameToIdx.has(normalized)) {
            nameToIdx.set(normalized, i);
        }
    }

    // Find first matching candidate (case-insensitive) from a list
    const find = function(candidates) {
        for (let c = 0; c < candidates.length; c++) {
            const idx = nameToIdx.get(candidates[c].toLowerCase());
            if (idx !== undefined) return idx;
        }
        return -1;
    };

    // Resolve each channel from CHANNEL_MAP
    const resolved = {};
    for (const key of Object.keys(CHANNEL_MAP)) {
        resolved[key] = find(CHANNEL_MAP[key]);
    }

    // Generate warnings for missing knock channels (1–8)
    const warnings = [];
    for (let n = 1; n <= 8; n++) {
        const key = 'knock_cyl_' + n;
        if (resolved[key] === -1) {
            warnings.push('Missing knock channel: Ignition Cylinder ' + n + ' Knock Level');
        }
    }

    return { resolved: resolved, warnings: warnings };
}

// ---------------------------------------------------------------------------
// Knock Analysis Engine
// ---------------------------------------------------------------------------

/** Default fixed knock threshold (%) when no tune is chosen. M1 detects knock when a cylinder's Knock Level
 *  exceeds the Knock Threshold table (a ratio by engine speed, typically 20–40 %). */
var KNOCK_DEFAULT_THRESHOLD = 20;
/** Below this engine speed the engine is cranking or stopped; knock levels there are not combustion. */
var KNOCK_MIN_RPM = 500;
/** A knock event ends when the level stays at or below the threshold for longer than this (s). */
var KNOCK_EVENT_GAP_S = 0.1;

/** Linear interpolation in sorted breakpoints, clamped at the ends. */
function knockInterp(xs, ys, x) {
    if (!xs || !xs.length) return NaN;
    if (xs.length === 1 || x <= xs[0]) return ys[0];
    for (var i = 1; i < xs.length; i++) {
        if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / ((xs[i] - xs[i - 1]) || 1);
    }
    return ys[ys.length - 1];
}

/**
 * Knock threshold (%) at an operating point.
 * spec: a number (fixed %), or { rpm: [..], load: [..] | null, values: [[%]] } from the tune's Knock Threshold table.
 */
function knockThresholdAt(spec, rpm, load) {
    if (typeof spec === 'number') return spec;
    if (!spec || !spec.values || !spec.values.length) return KNOCK_DEFAULT_THRESHOLD;
    var byRpm = spec.values.map(function (row) { return knockInterp(spec.rpm, row, isNaN(rpm) ? 0 : rpm); });
    if (!spec.load || spec.load.length < 2 || isNaN(load)) return byRpm[0];
    return knockInterp(spec.load, byRpm, load);
}

/**
 * Finds knock events: for each cylinder, a stretch where its Knock Level is above the threshold (gaps up to
 * KNOCK_EVENT_GAP_S joined). One event per stretch, so a log stored at a higher rate than the knock channel
 * (or a long knock) does not multiply the count. Samples below KNOCK_MIN_RPM or during overrun are ignored.
 *
 * @param {number[][]} data - rows (column 0 = time)
 * @param {Object} channels - resolved channel indices
 * @param {number|Object} threshold - fixed % or a threshold table (see knockThresholdAt)
 * @returns {Array<Object>} events { timestamp, duration, cylinderIndex, knockLevel (peak), threshold, ratio, rpm, load,
 *   ignTiming, ignTimingComp, knockTrim, tps, gear } — conditions at the peak sample
 */
function classifyKnockEvents(data, channels, threshold) {
    var events = [];
    var col = function (key) { return channels[key] !== undefined ? channels[key] : -1; };
    var rpmIdx = col('rpm'), mapIdx = col('map'), loadNormIdx = col('load_norm'), overrunIdx = col('overrun');
    var opt = function (row, idx) { return idx !== -1 ? row[idx] : null; };

    for (var n = 1; n <= 8; n++) {
        var kIdx = col('knock_cyl_' + n);
        if (kIdx === -1) continue;
        var trimIdx = col('knock_trim_' + n), open = null, lastAbove = -Infinity;
        for (var r = 0; r <= data.length; r++) {
            var row = data[r], t = row ? row[0] : Infinity, above = false, thr = NaN, level = NaN;
            if (row) {
                var rpm = rpmIdx !== -1 ? row[rpmIdx] : NaN;
                var running = rpmIdx === -1 || rpm >= KNOCK_MIN_RPM;
                var overrun = overrunIdx !== -1 && row[overrunIdx] > 0;
                level = row[kIdx];
                thr = knockThresholdAt(threshold, rpm, loadNormIdx !== -1 ? row[loadNormIdx] : NaN);
                above = running && !overrun && level > thr;
            }
            if (open && (!row || (!above && t - lastAbove > KNOCK_EVENT_GAP_S))) {
                open.duration = Math.round((lastAbove - open.timestamp) * 1000) / 1000;
                events.push(open);
                open = null;
            }
            if (!above) continue;
            lastAbove = t;
            if (!open || level > open.knockLevel) {
                var peak = {
                    timestamp: open ? open.timestamp : t, cylinderIndex: n, knockLevel: level, threshold: thr,
                    ratio: thr > 0 ? level / thr : null,
                    rpm: opt(row, rpmIdx), load: opt(row, mapIdx), loadNorm: opt(row, loadNormIdx),
                    ignTiming: opt(row, col('ign_timing')), ignTimingComp: opt(row, col('ign_timing_comp')),
                    knockTrim: opt(row, trimIdx), tps: opt(row, col('tps')), gear: opt(row, col('gear'))
                };
                open = peak;
            }
        }
    }
    events.sort(function (a, b) { return a.timestamp - b.timestamp || a.cylinderIndex - b.cylinderIndex; });
    return events;
}

/**
 * Computes per-cylinder knock event distribution statistics.
 *
 * @param {Array<Object>} events - Array of KnockEvent objects (each has cylinderIndex 1–8)
 * @returns {{counts: number[], percentages: number[], total: number, ranking: number[]}}
 *   counts: array of 8 elements (index 0 = cylinder 1, index 7 = cylinder 8)
 *   percentages: percentage per cylinder rounded to 1 decimal place (0 if total is 0)
 *   total: sum of all counts
 *   ranking: cylinder numbers (1–8) sorted by count descending, ascending index tie-break
 */
function computeCylinderDistribution(events) {
    // Initialize per-cylinder counts (index 0 = cyl 1, ..., index 7 = cyl 8)
    var counts = [0, 0, 0, 0, 0, 0, 0, 0];

    // Tally events per cylinder
    for (var i = 0; i < events.length; i++) {
        var idx = events[i].cylinderIndex - 1; // convert 1-based to 0-based
        if (idx >= 0 && idx < 8) {
            counts[idx]++;
        }
    }

    // Compute total
    var total = 0;
    for (var c = 0; c < 8; c++) {
        total += counts[c];
    }

    // Compute percentages (rounded to 1 decimal place)
    var percentages = new Array(8);
    for (var c = 0; c < 8; c++) {
        if (total === 0) {
            percentages[c] = 0;
        } else {
            percentages[c] = Math.round((counts[c] / total * 100) * 10) / 10;
        }
    }

    // Compute ranking: cylinder numbers (1–8) sorted by count descending,
    // ascending cylinder index as tie-breaker
    var ranking = [1, 2, 3, 4, 5, 6, 7, 8];
    ranking.sort(function(a, b) {
        var countDiff = counts[b - 1] - counts[a - 1]; // descending by count
        if (countDiff !== 0) return countDiff;
        return a - b; // ascending by cylinder index
    });

    return {
        counts: counts,
        percentages: percentages,
        total: total,
        ranking: ranking
    };
}

// ---------------------------------------------------------------------------
// Bin Assignment Utilities
// ---------------------------------------------------------------------------

/**
 * Bins for the knock grids. By default 500 rpm × 10 kPa (MAP) cells; with a tune, the sites of Ignition Timing
 * Main (engine speed × Engine Load Normalised when that is logged), so each cell matches a table cell.
 * Each bin covers the range nearest to its site.
 */
var KNOCK_BINS = null;

function knockFixedEdges(step, count) {
    var e = [];
    for (var i = 0; i <= count; i++) e.push(i * step);
    return e;
}

function knockSiteEdges(sites) {
    var e = [sites[0] - (sites.length > 1 ? (sites[1] - sites[0]) / 2 : 1)];
    for (var i = 1; i < sites.length; i++) e.push((sites[i - 1] + sites[i]) / 2);
    e.push(sites[sites.length - 1] + (sites.length > 1 ? (sites[sites.length - 1] - sites[sites.length - 2]) / 2 : 1));
    return e;
}

/**
 * Sets the bins: axes = { rpm: [sites], load: [sites] | null } from the tune (load sites are used only when
 * useLoadNorm, i.e. Engine Load Normalised is logged), or null for the default bins.
 */
function configureKnockBins(axes, useLoadNorm) {
    var fmtRpm = function (v) { return String(Math.round(v)); };
    if (axes && axes.rpm && axes.rpm.length) {
        var loadSites = useLoadNorm && axes.load && axes.load.length ? axes.load : null;
        KNOCK_BINS = {
            source: 'tune',
            rpmEdges: knockSiteEdges(axes.rpm), rpmLabels: axes.rpm.map(fmtRpm),
            loadEdges: loadSites ? knockSiteEdges(loadSites) : knockFixedEdges(10, 25),
            loadLabels: loadSites ? loadSites.map(function (v) { return v.toFixed(2); }) : null,
            loadKind: loadSites ? 'loadNorm' : 'map'
        };
    } else {
        KNOCK_BINS = { source: 'default', rpmEdges: knockFixedEdges(500, 15), rpmLabels: null, loadEdges: knockFixedEdges(10, 25),
                       loadLabels: null, loadKind: 'map' };
    }
    if (!KNOCK_BINS.rpmLabels) {
        KNOCK_BINS.rpmLabels = KNOCK_BINS.rpmEdges.slice(0, -1).map(function (e, i) { return e + '–' + KNOCK_BINS.rpmEdges[i + 1]; });
    }
    if (!KNOCK_BINS.loadLabels) {
        KNOCK_BINS.loadLabels = KNOCK_BINS.loadEdges.slice(0, -1).map(function (e, i) { return e + '–' + KNOCK_BINS.loadEdges[i + 1]; });
    }
    return KNOCK_BINS;
}

function knockBins() { return KNOCK_BINS || configureKnockBins(null); }

function knockEdgeBin(edges, v) {
    var last = edges.length - 2;
    if (!(v >= edges[1])) return 0;
    for (var i = 1; i <= last; i++) if (v < edges[i + 1]) return i;
    return last;
}

/** RPM bin index (500 rpm bins over 0–7500 by default; clamped at the ends). */
function assignRpmBin(rpm) { return knockEdgeBin(knockBins().rpmEdges, rpm); }

/** Load bin index (10 kPa bins over 0–250 by default; clamped at the ends). */
function assignLoadBin(kpa) { return knockEdgeBin(knockBins().loadEdges, kpa); }

/** The load value an event or sample is binned by: Engine Load Normalised with a tune that uses it, else MAP. */
function knockLoadOf(evt) { return knockBins().loadKind === 'loadNorm' ? evt.loadNorm : evt.load; }

// ---------------------------------------------------------------------------
// Heatmap Binning
// ---------------------------------------------------------------------------

/**
 * Computes a 2D heatmap of knock event counts binned by RPM and load.
 * Events with null rpm or load are skipped.
 *
 * @param {Array<Object>} events - Array of KnockEvent objects (each has rpm and load fields)
 * @returns {{ rpmBins: number[], loadBins: number[], counts: number[][] }}
 *   rpmBins: 16 boundary values [0, 500, 1000, ..., 7500]
 *   loadBins: 26 boundary values [0, 10, 20, ..., 250]
 *   counts: 15x25 matrix where counts[rpmBinIdx][loadBinIdx] = event count
 */
function computeHeatmapBins(events) {
    var bins = knockBins(), rpmBins = bins.rpmEdges.slice(), loadBins = bins.loadEdges.slice();

    // Initialize the counts matrix [rpm bin][load bin] to zero
    var counts = [];
    for (var i = 0; i < rpmBins.length - 1; i++) {
        var row = [];
        for (var j = 0; j < loadBins.length - 1; j++) {
            row.push(0);
        }
        counts.push(row);
    }

    // Tally events into bins
    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        var evLoad = knockLoadOf(evt);
        if (evt.rpm === null || evt.rpm === undefined || evLoad === null || evLoad === undefined || isNaN(evLoad)) {
            continue;
        }
        var rpmIdx = assignRpmBin(evt.rpm);
        var loadIdx = assignLoadBin(evLoad);
        counts[rpmIdx][loadIdx]++;
    }

    return {
        rpmBins: rpmBins,
        loadBins: loadBins,
        loadKind: bins.loadKind,
        counts: counts
    };
}

// ---------------------------------------------------------------------------
// Knock vs Engine Load Normalized
// ---------------------------------------------------------------------------

/**
 * Computes a per-cylinder 2D grid of knock event rate (events/minute) normalized
 * by dwell time, binned by RPM and Load. This aligns with spark table layout in
 * MoTeC M1 Tune for targeted timing reduction.
 *
 * Returns data for "All Cylinders" plus each individual cylinder (1–8).
 * Grid dimensions: 15 RPM bins (500 RPM wide) × 25 Load bins (10 kPa wide).
 *
 * @param {Array<Object>} events - Array of KnockEvent objects
 * @param {number[][]} data - Full log data (row arrays)
 * @param {Object} channels - Resolved channel indices
 * @returns {Object|null} { rpmLabels, loadLabels, dwellGrid, cylinders: { 0: grid, 1: grid, ... } }
 *   Each grid is a 2D array [loadIdx][rpmIdx] of { events, rate, avgLevel, maxLevel }
 */
function computeKnockRpmLoadGrid(events, data, channels) {
    var bins = knockBins();
    var rpmIdx = channels.rpm;
    var mapIdx = bins.loadKind === 'loadNorm' ? channels.load_norm : channels.map;
    if (rpmIdx === -1 || mapIdx === -1 || mapIdx === undefined) return null;

    var NUM_RPM_BINS = bins.rpmEdges.length - 1;
    var NUM_LOAD_BINS = bins.loadEdges.length - 1;

    // Estimate sample period
    var samplePeriod = 0.01;
    if (data.length >= 2) {
        var dt = data[1][0] - data[0][0];
        if (dt > 0 && dt < 1) samplePeriod = dt;
    }

    // Compute dwell time per RPM×Load cell from full dataset
    var dwellSamples = [];
    for (var l = 0; l < NUM_LOAD_BINS; l++) {
        var row = new Array(NUM_RPM_BINS);
        for (var r = 0; r < NUM_RPM_BINS; r++) row[r] = 0;
        dwellSamples.push(row);
    }

    for (var i = 0; i < data.length; i++) {
        var rpm = data[i][rpmIdx];
        var load = data[i][mapIdx];
        if (isNaN(rpm) || isNaN(load) || rpm < KNOCK_MIN_RPM) continue;
        var rBin = assignRpmBin(rpm);
        var lBin = assignLoadBin(load);
        dwellSamples[lBin][rBin]++;
    }

    // Convert to seconds
    var dwellGrid = [];
    for (var l = 0; l < NUM_LOAD_BINS; l++) {
        var row = new Array(NUM_RPM_BINS);
        for (var r = 0; r < NUM_RPM_BINS; r++) {
            row[r] = dwellSamples[l][r] * samplePeriod;
        }
        dwellGrid.push(row);
    }

    // Helper to create an empty grid of cell objects
    function makeEmptyGrid() {
        var g = [];
        for (var l = 0; l < NUM_LOAD_BINS; l++) {
            var row = [];
            for (var r = 0; r < NUM_RPM_BINS; r++) {
                row.push({ events: 0, levelSum: 0, maxLevel: 0, timingSum: 0, timingCount: 0 });
            }
            g.push(row);
        }
        return g;
    }

    // Build grids: index 0 = all cylinders, 1–8 = per cylinder
    var grids = {};
    grids[0] = makeEmptyGrid(); // all
    for (var c = 1; c <= 8; c++) {
        grids[c] = makeEmptyGrid();
    }

    // Tally events
    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        var evLoad = knockLoadOf(evt);
        if (evt.rpm === null || evLoad === null || evLoad === undefined || isNaN(evLoad)) continue;
        var rBin = assignRpmBin(evt.rpm);
        var lBin = assignLoadBin(evLoad);
        var hasTiming = evt.ignTiming !== null && !isNaN(evt.ignTiming);

        // All cylinders
        var cellAll = grids[0][lBin][rBin];
        cellAll.events++;
        cellAll.levelSum += evt.knockLevel;
        if (evt.knockLevel > cellAll.maxLevel) cellAll.maxLevel = evt.knockLevel;
        if (hasTiming) { cellAll.timingSum += evt.ignTiming; cellAll.timingCount++; }

        // Per cylinder
        var cylGrid = grids[evt.cylinderIndex];
        if (cylGrid) {
            var cellCyl = cylGrid[lBin][rBin];
            cellCyl.events++;
            cellCyl.levelSum += evt.knockLevel;
            if (evt.knockLevel > cellCyl.maxLevel) cellCyl.maxLevel = evt.knockLevel;
            if (hasTiming) { cellCyl.timingSum += evt.ignTiming; cellCyl.timingCount++; }
        }
    }

    // Finalize: compute rate, avgLevel, and avgTiming
    function finalizeGrid(grid) {
        var result = [];
        for (var l = 0; l < NUM_LOAD_BINS; l++) {
            var row = [];
            for (var r = 0; r < NUM_RPM_BINS; r++) {
                var cell = grid[l][r];
                var dwell = dwellGrid[l][r];
                var rate = dwell > 0 ? (cell.events / dwell) * 60 : 0;
                row.push({
                    events: cell.events,
                    rate: Math.round(rate * 100) / 100,
                    avgLevel: cell.events > 0 ? Math.round((cell.levelSum / cell.events) * 10) / 10 : 0,
                    maxLevel: Math.round(cell.maxLevel * 10) / 10,
                    avgTiming: cell.timingCount > 0 ? Math.round((cell.timingSum / cell.timingCount) * 10) / 10 : null,
                    weightedRate: dwell > 0 ? Math.round((cell.levelSum / dwell) * 60 * 100) / 100 : 0
                });
            }
            result.push(row);
        }
        return result;
    }

    var cylinders = {};
    for (var c = 0; c <= 8; c++) {
        cylinders[c] = finalizeGrid(grids[c]);
    }

    return {
        rpmLabels: bins.rpmLabels.slice(),
        loadLabels: bins.loadLabels.slice(),
        loadKind: bins.loadKind,
        binSource: bins.source,
        dwellGrid: dwellGrid,
        cylinders: cylinders
    };
}

/**
 * Computes knock event frequency normalized by time spent at each load bin.
 *
 * For each load bin (10 kPa wide, 0–250 kPa), computes:
 *   - Total knock events in that bin
 *   - Total time (seconds) the engine spent in that bin (from all log data)
 *   - Normalized rate: knock events per minute at that load
 *   - Average knock level of events in that bin
 *   - Max knock level in that bin
 *
 * This reveals which load ranges are most knock-prone relative to how much
 * time is spent there, eliminating the bias of simply spending more time
 * at certain loads.
 *
 * @param {Array<Object>} events - Array of KnockEvent objects
 * @param {number[][]} data - Full log data (row arrays)
 * @param {Object} channels - Resolved channel indices
 * @returns {{ bins: Array<{loadMin: number, loadMax: number, events: number, dwellTime: number, rate: number, avgLevel: number, maxLevel: number}> } | null}
 */
function computeKnockByLoadNormalized(events, data, channels) {
    var mapIdx = channels.map;
    if (mapIdx === -1) return null;

    var NUM_BINS = 25;
    var BIN_WIDTH = 10; // kPa

    // Compute dwell time per load bin from full dataset
    // Estimate sample period from first two timestamps
    var samplePeriod = 0.01; // default 10ms
    if (data.length >= 2) {
        var dt = data[1][0] - data[0][0];
        if (dt > 0 && dt < 1) {
            samplePeriod = dt;
        }
    }

    var dwellSamples = new Array(NUM_BINS);
    for (var i = 0; i < NUM_BINS; i++) {
        dwellSamples[i] = 0;
    }

    var rpmCol = channels.rpm;
    for (var r = 0; r < data.length; r++) {
        var load = data[r][mapIdx];
        if (load === null || load === undefined || isNaN(load)) continue;
        if (rpmCol !== -1 && !(data[r][rpmCol] >= KNOCK_MIN_RPM)) continue;
        var bin = Math.min(NUM_BINS - 1, Math.max(0, Math.floor(load / BIN_WIDTH)));
        dwellSamples[bin]++;
    }

    // Count knock events per load bin and accumulate knock levels
    var eventCounts = new Array(NUM_BINS);
    var levelSums = new Array(NUM_BINS);
    var maxLevels = new Array(NUM_BINS);
    for (var i = 0; i < NUM_BINS; i++) {
        eventCounts[i] = 0;
        levelSums[i] = 0;
        maxLevels[i] = 0;
    }

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        if (evt.load === null || evt.load === undefined) continue;
        var bin = Math.min(NUM_BINS - 1, Math.max(0, Math.floor(evt.load / BIN_WIDTH)));
        eventCounts[bin]++;
        levelSums[bin] += evt.knockLevel;
        if (evt.knockLevel > maxLevels[bin]) {
            maxLevels[bin] = evt.knockLevel;
        }
    }

    // Build result bins
    var bins = [];
    for (var i = 0; i < NUM_BINS; i++) {
        var dwellTime = dwellSamples[i] * samplePeriod; // seconds
        var rate = dwellTime > 0 ? (eventCounts[i] / dwellTime) * 60 : 0; // events per minute
        var avgLevel = eventCounts[i] > 0 ? levelSums[i] / eventCounts[i] : 0;

        bins.push({
            loadMin: i * BIN_WIDTH,
            loadMax: (i + 1) * BIN_WIDTH,
            events: eventCounts[i],
            dwellTime: Math.round(dwellTime * 10) / 10,
            rate: Math.round(rate * 100) / 100,
            avgLevel: Math.round(avgLevel * 10) / 10,
            maxLevel: Math.round(maxLevels[i] * 10) / 10
        });
    }

    return { bins: bins };
}

// ---------------------------------------------------------------------------
// Timing Correlation Analysis
// ---------------------------------------------------------------------------

/**
 * Computes timing correlation statistics grouped by RPM bin and by cylinder.
 *
 * For each RPM bin (15 bins, 500 RPM wide from 0–7500), computes the mean and
 * maximum ignition timing of knock events falling in that bin, along with the
 * event count. For each cylinder (1–8, stored at index 0–7), computes the same
 * statistics. Events with null ignTiming are skipped.
 *
 * @param {Array<Object>} events - Array of KnockEvent objects
 * @returns {{ perRpmBin: Array<{mean: number, max: number, count: number}>, perCylinder: Array<{mean: number, max: number, count: number}> }}
 */
function computeTimingCorrelation(events) {
    // Initialize per-RPM-bin accumulators (15 bins)
    var NRPM = knockBins().rpmEdges.length - 1;
    var rpmBinSums = new Array(NRPM);
    var rpmBinMaxes = new Array(NRPM);
    var rpmBinCounts = new Array(NRPM);
    for (var i = 0; i < NRPM; i++) {
        rpmBinSums[i] = 0;
        rpmBinMaxes[i] = -Infinity;
        rpmBinCounts[i] = 0;
    }

    // Initialize per-cylinder accumulators (8 cylinders)
    var cylSums = new Array(8);
    var cylMaxes = new Array(8);
    var cylCounts = new Array(8);
    for (var j = 0; j < 8; j++) {
        cylSums[j] = 0;
        cylMaxes[j] = -Infinity;
        cylCounts[j] = 0;
    }

    // Accumulate timing values
    for (var e = 0; e < events.length; e++) {
        var evt = events[e];

        // Skip events where ignTiming is null
        if (evt.ignTiming === null || evt.ignTiming === undefined) continue;

        var timing = evt.ignTiming;

        // Per RPM bin
        if (evt.rpm !== null && evt.rpm !== undefined) {
            var rpmBin = assignRpmBin(evt.rpm);
            rpmBinSums[rpmBin] += timing;
            if (timing > rpmBinMaxes[rpmBin]) {
                rpmBinMaxes[rpmBin] = timing;
            }
            rpmBinCounts[rpmBin]++;
        }

        // Per cylinder (cylinderIndex is 1–8, stored at index 0–7)
        var cylIdx = evt.cylinderIndex - 1;
        if (cylIdx >= 0 && cylIdx < 8) {
            cylSums[cylIdx] += timing;
            if (timing > cylMaxes[cylIdx]) {
                cylMaxes[cylIdx] = timing;
            }
            cylCounts[cylIdx]++;
        }
    }

    // Build result arrays
    var perRpmBin = new Array(NRPM);
    for (var r = 0; r < NRPM; r++) {
        if (rpmBinCounts[r] === 0) {
            perRpmBin[r] = { mean: 0, max: 0, count: 0 };
        } else {
            perRpmBin[r] = {
                mean: rpmBinSums[r] / rpmBinCounts[r],
                max: rpmBinMaxes[r],
                count: rpmBinCounts[r]
            };
        }
    }

    var perCylinder = new Array(8);
    for (var c = 0; c < 8; c++) {
        if (cylCounts[c] === 0) {
            perCylinder[c] = { mean: 0, max: 0, count: 0 };
        } else {
            perCylinder[c] = {
                mean: cylSums[c] / cylCounts[c],
                max: cylMaxes[c],
                count: cylCounts[c]
            };
        }
    }

    return { perRpmBin: perRpmBin, perCylinder: perCylinder };
}

// ---------------------------------------------------------------------------
// Timing Retard Statistics
// ---------------------------------------------------------------------------

/**
 * Timing retard statistics.
 *
 * Knock retard is per cylinder in "Ignition Cylinder N Knock Trim" (degrees retarded, positive = retard). When
 * those are logged, they give the knock retard: per cylinder the largest trim and how long it was active, and
 * the time series is the largest trim across cylinders. "Ignition Timing Compensation" is the sum of every
 * timing compensation (temperatures, etc.), not just knock, so it is reported separately.
 *
 * @returns {Object|null} { source: 'knockTrim'|'timingComp', perCylinder?: [{ cylinderIndex, maxTrim, activeTime }],
 *   maxRetard, meanDuringKnock, nonZeroCount, compensation: { min, max } | null, timeSeries: { time, values, label } }
 *   or null when neither channel is logged
 */
function computeTimingRetardStats(data, channels, events) {
    var trimIdx = [];
    for (var n = 1; n <= 8; n++) {
        var idx = channels['knock_trim_' + n];
        if (idx !== undefined && idx !== -1) trimIdx.push({ cyl: n, idx: idx });
    }
    var compIdx = channels.ign_timing_comp !== undefined ? channels.ign_timing_comp : -1;
    if (!trimIdx.length && compIdx === -1) return null;

    var dt = data.length > 1 ? data[1][0] - data[0][0] : 0.01;
    var time = [], values = [], compMin = Infinity, compMax = -Infinity;
    var perCyl = trimIdx.map(function (t) { return { cylinderIndex: t.cyl, maxTrim: 0, activeTime: 0 }; });
    var nonZero = 0, maxRetard = 0;
    for (var r = 0; r < data.length; r++) {
        var row = data[r];
        if (compIdx !== -1 && !isNaN(row[compIdx])) {
            if (row[compIdx] < compMin) compMin = row[compIdx];
            if (row[compIdx] > compMax) compMax = row[compIdx];
        }
        var v;
        if (trimIdx.length) {
            v = 0;
            for (var k = 0; k < trimIdx.length; k++) {
                var tr = Math.abs(row[trimIdx[k].idx]);
                if (isNaN(tr)) continue;
                if (tr > perCyl[k].maxTrim) perCyl[k].maxTrim = tr;
                if (tr > 0) perCyl[k].activeTime += dt;
                if (tr > v) v = tr;
            }
        } else {
            v = row[compIdx];
        }
        time.push(row[0]);
        values.push(v);
        if (v !== 0 && !isNaN(v)) nonZero++;
        if (trimIdx.length && v > maxRetard) maxRetard = v;
    }

    var sum = 0, count = 0;
    events.forEach(function (e) {
        var v = trimIdx.length ? e.knockTrim : e.ignTimingComp;
        if (v !== null && v !== undefined && !isNaN(v)) { sum += trimIdx.length ? Math.abs(v) : v; count++; }
    });

    return {
        source: trimIdx.length ? 'knockTrim' : 'timingComp',
        perCylinder: trimIdx.length ? perCyl.map(function (p) {
            return { cylinderIndex: p.cylinderIndex, maxTrim: Math.round(p.maxTrim * 10) / 10, activeTime: Math.round(p.activeTime * 10) / 10 };
        }) : null,
        maxRetard: trimIdx.length ? maxRetard : (compMin < Infinity ? compMin : 0),
        meanDuringKnock: count ? sum / count : 0,
        nonZeroCount: nonZero,
        compensation: compMin < Infinity ? { min: compMin, max: compMax } : null,
        timeSeries: { time: time, values: values,
                      label: trimIdx.length ? 'Knock retard (largest cylinder trim)' : 'Ignition Timing Compensation (all compensations)' }
    };
}

// ---------------------------------------------------------------------------
// Knock Sensor Health
// ---------------------------------------------------------------------------

/** A cylinder (or knock input) whose typical level is below this fraction of the others' is flagged. */
var KNOCK_WEAK_RATIO = 0.25;

/**
 * Background knock level per cylinder while the engine runs. A healthy sensor always hears some engine noise,
 * so a cylinder (or all cylinders on one knock input) reading far below the others suggests a sensor, wiring,
 * gain or input fault — knock there may go undetected.
 *
 * @param {Array<string|null>} inputs - knock input per cylinder (index 0 = cylinder 1), from the tune, or null
 * @returns {{ perCylinder: [{ cylinderIndex, median, p99, input }], weak: [{ label, cylinders, median, othersMedian }] }}
 */
function computeKnockSensorHealth(data, channels, inputs) {
    var rpmIdx = channels.rpm, per = [];
    for (var n = 1; n <= 8; n++) {
        var idx = channels['knock_cyl_' + n];
        if (idx === -1 || idx === undefined) continue;
        var vals = [];
        for (var r = 0; r < data.length; r++) {
            if (rpmIdx !== -1 && !(data[r][rpmIdx] >= KNOCK_MIN_RPM)) continue;
            var v = data[r][idx];
            if (!isNaN(v)) vals.push(v);
        }
        if (!vals.length) continue;
        vals.sort(function (a, b) { return a - b; });
        per.push({ cylinderIndex: n, median: vals[vals.length >> 1], p99: vals[Math.floor(vals.length * 0.99)],
                   input: inputs ? inputs[n - 1] || null : null });
    }
    var weak = [];
    function med(list) { var s = list.slice().sort(function (a, b) { return a - b; }); return s.length ? s[s.length >> 1] : 0; }
    if (per.length >= 2) {
        var groups = {};
        per.forEach(function (p) { var g = p.input || ('Cylinder ' + p.cylinderIndex); (groups[g] = groups[g] || []).push(p); });
        Object.keys(groups).forEach(function (g) {
            var mine = groups[g], others = per.filter(function (p) { return mine.indexOf(p) < 0; });
            if (!others.length) return;
            var m = med(mine.map(function (p) { return p.median; })), o = med(others.map(function (p) { return p.median; }));
            if (o > 0 && m < o * KNOCK_WEAK_RATIO) {
                weak.push({ label: g, cylinders: mine.map(function (p) { return p.cylinderIndex; }), median: m, othersMedian: o });
            }
        });
        // Without knock inputs from the tune, report the weak cylinders together, against the cylinders that are not weak.
        if (!inputs && weak.length > 1) {
            var cyls = [], weakSet = {};
            weak.forEach(function (w) { cyls = cyls.concat(w.cylinders); weakSet[w.cylinders[0]] = true; });
            var rest = per.filter(function (p) { return !weakSet[p.cylinderIndex]; });
            var wm = med(per.filter(function (p) { return weakSet[p.cylinderIndex]; }).map(function (p) { return p.median; }));
            var om = med(rest.map(function (p) { return p.median; }));
            weak = rest.length ? [{ label: 'Cylinders ' + cyls.join(', '), cylinders: cyls, median: wm, othersMedian: om }] : [];
        }
    }
    return { perCylinder: per, weak: weak };
}

// ---------------------------------------------------------------------------
// Worst Conditions Identification
// ---------------------------------------------------------------------------

/**
 * Identifies the operating conditions (RPM bin, load bin, gear) with the
 * highest knock event counts.
 *
 * For RPM and load bins, events are tallied using assignRpmBin/assignLoadBin.
 * The bin with the highest count is selected; ties are broken by lowest bin index.
 * For gear, events are tallied per gear value; ties are broken by lowest gear number.
 *
 * @param {Array<Object>} events - Array of KnockEvent objects
 * @returns {{ worstRpmBin: {binIndex: number, rpmRange: string, count: number}|null, worstLoadBin: {binIndex: number, loadRange: string, count: number}|null, worstGear: {gear: number, count: number}|null }}
 */
function identifyWorstConditions(events) {
    // --- Worst RPM Bin ---
    var bins = knockBins(), NRPM = bins.rpmEdges.length - 1, NLOAD = bins.loadEdges.length - 1;
    var rpmBinCounts = new Array(NRPM);
    for (var i = 0; i < NRPM; i++) rpmBinCounts[i] = 0;
    var hasRpmData = false;

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        if (evt.rpm !== null && evt.rpm !== undefined && !isNaN(evt.rpm)) {
            hasRpmData = true;
            var rpmBin = assignRpmBin(evt.rpm);
            rpmBinCounts[rpmBin]++;
        }
    }

    var worstRpmBin = null;
    if (hasRpmData) {
        var maxRpmCount = 0;
        var maxRpmIdx = 0;
        for (var r = 0; r < NRPM; r++) {
            if (rpmBinCounts[r] > maxRpmCount) {
                maxRpmCount = rpmBinCounts[r];
                maxRpmIdx = r;
            }
        }
        worstRpmBin = {
            binIndex: maxRpmIdx,
            rpmRange: (bins.source === 'tune' ? 'around ' + bins.rpmLabels[maxRpmIdx] : bins.rpmLabels[maxRpmIdx].replace('–', '-')) + ' RPM',
            count: maxRpmCount
        };
    }

    // --- Worst Load Bin ---
    var loadBinCounts = new Array(NLOAD);
    for (var i = 0; i < NLOAD; i++) loadBinCounts[i] = 0;
    var hasLoadData = false;

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        var evLoad = knockLoadOf(evt);
        if (evLoad !== null && evLoad !== undefined && !isNaN(evLoad)) {
            hasLoadData = true;
            var loadBin = assignLoadBin(evLoad);
            loadBinCounts[loadBin]++;
        }
    }

    var worstLoadBin = null;
    if (hasLoadData) {
        var maxLoadCount = 0;
        var maxLoadIdx = 0;
        for (var l = 0; l < NLOAD; l++) {
            if (loadBinCounts[l] > maxLoadCount) {
                maxLoadCount = loadBinCounts[l];
                maxLoadIdx = l;
            }
        }
        worstLoadBin = {
            binIndex: maxLoadIdx,
            loadRange: bins.loadKind === 'loadNorm' ? 'load (normalised) around ' + bins.loadLabels[maxLoadIdx]
                : bins.loadLabels[maxLoadIdx].replace('–', '-') + ' kPa',
            count: maxLoadCount
        };
    }

    // --- Worst Gear ---
    var gearCounts = {}; // gear number → count
    var hasGearData = false;

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        if (evt.gear !== null && evt.gear !== undefined && !isNaN(evt.gear)) {
            hasGearData = true;
            var g = evt.gear;
            if (gearCounts[g] === undefined) {
                gearCounts[g] = 0;
            }
            gearCounts[g]++;
        }
    }

    var worstGear = null;
    if (hasGearData) {
        var maxGearCount = 0;
        var maxGearValue = Infinity;
        var gears = Object.keys(gearCounts);
        for (var gi = 0; gi < gears.length; gi++) {
            var gearNum = Number(gears[gi]);
            var cnt = gearCounts[gears[gi]];
            if (cnt > maxGearCount || (cnt === maxGearCount && gearNum < maxGearValue)) {
                maxGearCount = cnt;
                maxGearValue = gearNum;
            }
        }
        worstGear = {
            gear: maxGearValue,
            count: maxGearCount
        };
    }

    return {
        worstRpmBin: worstRpmBin,
        worstLoadBin: worstLoadBin,
        worstGear: worstGear
    };
}

// ---------------------------------------------------------------------------
// Timing Recommendations
// ---------------------------------------------------------------------------

/**
 * Timing advice from the knock events (which are already above the ECU's threshold).
 *
 * Per cylinder with knock: a suggested reduction in the cells where it knocked, by how far the worst event went
 * over the threshold — 1° up to 1.5× the threshold, 2° up to 2×, 3° beyond. A cylinder with a single event gets
 * no reduction (re-log to confirm). When most cylinders knock, the advice is to reduce Ignition Timing Main in
 * those cells instead of trimming cylinders.
 *
 * @param {Array<Object>} events - knock events (with ratio = peak level / threshold)
 * @returns {Array<{ cylinderIndex, events, maxRatio, reductionDeg, note }>} only cylinders with events; [] for none
 */
function computeTimingRecommendations(events) {
    if (!events || !events.length) return [];
    var byCyl = {};
    events.forEach(function (e) {
        var c = byCyl[e.cylinderIndex] = byCyl[e.cylinderIndex] || { cylinderIndex: e.cylinderIndex, events: 0, maxRatio: 0 };
        c.events++;
        if (e.ratio !== null && e.ratio !== undefined && e.ratio > c.maxRatio) c.maxRatio = e.ratio;
    });
    var list = Object.keys(byCyl).map(function (k) { return byCyl[k]; }).sort(function (a, b) { return a.cylinderIndex - b.cylinderIndex; });
    var widespread = list.length >= 5;
    list.forEach(function (c) {
        c.maxRatio = Math.round(c.maxRatio * 100) / 100;
        if (c.events < 2) {
            c.reductionDeg = 0;
            c.note = 'Single event — re-log to confirm before changing timing.';
        } else {
            c.reductionDeg = c.maxRatio <= 1.5 ? 1 : c.maxRatio <= 2 ? 2 : 3;
            c.note = widespread ? 'Most cylinders knock: reduce Ignition Timing Main in these cells rather than trimming cylinders.'
                : 'Cylinder trim in the cells where it knocked.';
        }
    });
    return list;
}

// ---------------------------------------------------------------------------
// Diagnostic Message Generation
// ---------------------------------------------------------------------------

/**
 * Diagnostic summary messages.
 *
 * @param {Object} distribution - per-cylinder event counts
 * @param {Object} worstConditions
 * @param {Object|null} retardStats - from computeTimingRetardStats
 * @param {Object} [extra] - { health: from computeKnockSensorHealth, thresholdLabel: string, events: [] }
 * @returns {string[]}
 */
function generateDiagnostics(distribution, worstConditions, retardStats, extra) {
    extra = extra || {};
    var messages = [];

    (extra.health && extra.health.weak || []).forEach(function (w) {
        var times = w.median > 0 ? Math.round(w.othersMedian / w.median) : null;
        messages.push('KNOCK SENSOR CHECK: ' + w.label + ' (cylinder' + (w.cylinders.length > 1 ? 's ' : ' ') + w.cylinders.join(', ') +
            ') reads a typical knock level of ' + w.median.toFixed(2) + '%, ' + (times ? 'about ' + times + '× lower than' : 'far below') +
            ' the other cylinders (' + w.othersMedian.toFixed(2) + '%). A working sensor always hears some engine noise, so check that ' +
            'sensor, its wiring and connector, its mounting torque, and the knock gain for these cylinders — knock there may go undetected.');
    });

    if (distribution.total === 0) {
        messages.push('No knock events: no cylinder\'s knock level went above ' + (extra.thresholdLabel || 'the threshold') + '.');
        return messages;
    }

    var worstCyl = distribution.ranking[0];
    var worstPct = distribution.percentages[worstCyl - 1];
    messages.push('Cylinder ' + worstCyl + ' has the highest knock activity at ' + worstPct + '% of total events.');

    if (worstConditions.worstRpmBin !== null) {
        messages.push('Most knock events occur in the ' + worstConditions.worstRpmBin.rpmRange + ' band (' + worstConditions.worstRpmBin.count + ' events).');
    }
    if (worstConditions.worstLoadBin !== null) {
        messages.push('Most knock events occur in the ' + worstConditions.worstLoadBin.loadRange + ' range (' + worstConditions.worstLoadBin.count + ' events).');
    }

    // One cylinder with far more knock than the rest.
    var avgCount = distribution.total / distribution.counts.length;
    for (var c = 0; c < distribution.counts.length; c++) {
        var cylCount = distribution.counts[c];
        if (cylCount > avgCount * 2 && cylCount > 5) {
            var cylNum = c + 1;
            var rpmZone = worstConditions.worstRpmBin ? worstConditions.worstRpmBin.rpmRange : 'all RPM';
            var loadZone = worstConditions.worstLoadBin ? worstConditions.worstLoadBin.loadRange : 'all loads';
            messages.push('CYLINDER TRIM RECOMMENDATION: Cylinder ' + cylNum + ' accounts for ' + distribution.percentages[c] + '% of knock events (' +
                cylCount + ' total). Consider a cylinder trim of -1° to -2° for Cyl ' + cylNum + ' in the ' + rpmZone + ' / ' + loadZone +
                ' zone. After applying the trim, re-log and verify: if knock disappears, it was real knock and the trim is correct. ' +
                'If it persists at the same level, it is more likely noise on that cylinder — check its knock gain and the knock window.');
        }
    }

    // Many events but the ECU barely retarded: the threshold may be too sensitive for this engine's noise.
    if (retardStats && retardStats.source === 'knockTrim' && distribution.total > 20 && retardStats.meanDuringKnock < 0.5) {
        messages.push('NOTE: ' + distribution.total + ' knock events but an average knock retard of only ' + retardStats.meanDuringKnock.toFixed(1) +
            '° during them. Check whether the events coincide with noise sources (gear changes, valvetrain at high rpm) before ' +
            'reducing timing; the knock threshold may be too sensitive in that range.');
    }
    if (retardStats && retardStats.source === 'timingComp') {
        messages.push('Knock retard per cylinder is not in this log: log "Ignition Cylinder 1–8 Knock Trim" to see how much the ECU ' +
            'retarded. "Ignition Timing Compensation" (shown in the chart) includes every compensation, not just knock.');
    }
    return messages;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Downsamples a numeric array for chart rendering while preserving visual shape.
 *
 * For each chunk of `step` consecutive values, the min and max of that chunk are
 * included in the output. This ensures peaks and valleys remain visible in the chart.
 * If the input data is already within the maxPoints limit, it is returned unchanged.
 * The final output is capped at 150,000 points.
 *
 * @param {number[]} data - Array of numeric values to downsample
 * @param {number} [maxPoints=150000] - Maximum number of output points (default 150,000)
 * @returns {number[]} Downsampled array preserving min/max of each chunk
 */
function downsampleForChart(data, maxPoints) {
    if (maxPoints === undefined || maxPoints === null) {
        maxPoints = 150000;
    }

    // If data fits within maxPoints, return as-is
    if (!data || data.length <= maxPoints) {
        return data || [];
    }

    // Compute step size
    var step = Math.max(1, Math.floor(data.length / maxPoints));

    var result = [];

    // Process each chunk of `step` values
    for (var i = 0; i < data.length; i += step) {
        var end = Math.min(i + step, data.length);
        var chunkMin = data[i];
        var chunkMax = data[i];
        var minIdx = i;
        var maxIdx = i;

        for (var j = i + 1; j < end; j++) {
            if (data[j] < chunkMin) {
                chunkMin = data[j];
                minIdx = j;
            }
            if (data[j] > chunkMax) {
                chunkMax = data[j];
                maxIdx = j;
            }
        }

        // Include min and max in order of their occurrence to preserve time ordering
        if (minIdx <= maxIdx) {
            result.push(chunkMin);
            if (chunkMin !== chunkMax) {
                result.push(chunkMax);
            }
        } else {
            result.push(chunkMax);
            if (chunkMin !== chunkMax) {
                result.push(chunkMin);
            }
        }
    }

    // Cap output at 150,000 points
    if (result.length > 150000) {
        result = result.slice(0, 150000);
    }

    return result;
}

/**
 * Computes the arithmetic mean of a numeric array.
 *
 * @param {number[]} values - Array of numeric values
 * @returns {number} Arithmetic mean, or 0 for an empty array
 */
function computeMean(values) {
    if (!values || values.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < values.length; i++) {
        sum += values[i];
    }
    return sum / values.length;
}

/**
 * Computes the maximum value of a numeric array.
 *
 * @param {number[]} values - Array of numeric values
 * @returns {number} Maximum value, or -Infinity for an empty array
 */
function computeMax(values) {
    if (!values || values.length === 0) return -Infinity;
    var max = values[0];
    for (var i = 1; i < values.length; i++) {
        if (values[i] > max) {
            max = values[i];
        }
    }
    return max;
}

/**
 * Computes the median of a numeric array.
 * For even-length arrays, returns the average of the two middle values.
 *
 * @param {number[]} values - Array of numeric values
 * @returns {number} Median value, or 0 for an empty array
 */
function computeMedian(values) {
    if (!values || values.length === 0) return 0;
    var sorted = values.slice().sort(function(a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

// ---------------------------------------------------------------------------
// Worker Message Handler
// ---------------------------------------------------------------------------

/**
 * Cached parsed data for threshold reanalysis without re-parsing.
 */
let cachedColumnNames = null;
let cachedData = null;
let cachedSettings = null;   // { threshold: % | table, thresholdLabel, ignitionAxes, inputs } from the page

/**
 * Handles incoming messages from the main thread.
 * Accepts:
 *   - {type: 'analyze', logText: string} — Parse CSV text and run analysis
 *   - {type: 'analyze_ld', buffer: ArrayBuffer} — Parse .ld binary and run analysis
 *   - {type: 'reanalyze', threshold: number} — Recompute with new threshold using cached data
 */
self.onmessage = function(e) {
    const msg = e.data;

    try {
        if (msg.type === 'analyze') {
            cachedSettings = msg.settings || null;
            handleAnalyzeCsv(msg.logText);
        } else if (msg.type === 'analyze_ld') {
            cachedSettings = msg.settings || null;
            handleAnalyzeLd(msg.buffer);
        } else if (msg.type === 'reanalyze') {
            handleReanalyze(msg.settings || msg.threshold);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unexpected error during analysis' });
    }
};

/**
 * Handles CSV text analysis: parse the file and run knock analysis.
 *
 * @param {string} logText - Raw CSV file content
 */
function handleAnalyzeCsv(logText) {
    // Check for empty file
    if (!logText || logText.trim().length === 0) {
        self.postMessage({ type: 'error', message: 'File contains no data' });
        return;
    }

    self.postMessage({ type: 'progress', phase: 'Parsing CSV', percent: 0 });

    // Split into lines
    const lines = logText.split(/\r?\n/);

    if (lines.length === 0) {
        self.postMessage({ type: 'error', message: 'File contains no data' });
        return;
    }

    // Detect header row
    let headerRowIdx;
    try {
        headerRowIdx = detectHeaderRow(lines);
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
        return;
    }

    self.postMessage({ type: 'progress', phase: 'Parsing CSV', percent: 10 });

    // Extract column names
    const columnNames = lines[headerRowIdx].split(',').map(function(s) {
        return s.trim().replace(/^"|"$/g, '');
    });

    // Find data start
    const dataStart = findDataStart(lines, headerRowIdx);

    self.postMessage({ type: 'progress', phase: 'Parsing CSV', percent: 20 });

    // Parse data rows with progress
    const data = parseDataRows(lines, dataStart, columnNames.length, function(rowsProcessed, totalRows) {
        const percent = 20 + Math.round((rowsProcessed / totalRows) * 70);
        self.postMessage({ type: 'progress', phase: 'Parsing CSV', percent: percent });
    });

    self.postMessage({ type: 'progress', phase: 'Parsing CSV', percent: 100 });

    // Cache parsed data for reanalysis
    cachedColumnNames = columnNames;
    cachedData = data;

    runAnalysisPipeline(cachedSettings);
}

/**
 * Handles .ld binary analysis: parse the file and run knock analysis.
 *
 * @param {ArrayBuffer} buffer - Raw .ld file contents
 */
function handleAnalyzeLd(buffer) {
    // Check for empty file
    if (!buffer || buffer.byteLength === 0) {
        self.postMessage({ type: 'error', message: 'File contains no data' });
        return;
    }

    self.postMessage({ type: 'progress', phase: 'Parsing .ld file', percent: 0 });

    // Parse .ld file with progress
    let result;
    try {
        result = parseLdFile(buffer, function(channelsProcessed, totalChannels) {
            const percent = Math.round((channelsProcessed / totalChannels) * 90);
            self.postMessage({ type: 'progress', phase: 'Parsing .ld file', percent: percent });
        });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
        return;
    }

    self.postMessage({ type: 'progress', phase: 'Parsing .ld file', percent: 100 });

    // Cache parsed data for reanalysis
    cachedColumnNames = result.columnNames;
    cachedData = result.data;

    runAnalysisPipeline(cachedSettings);
}

/**
 * Handles reanalysis with a new threshold using cached parsed data.
 *
 * @param {number} threshold - New knock threshold percentage (0–100)
 */
function handleReanalyze(threshold) {
    if (!cachedColumnNames || !cachedData) {
        self.postMessage({ type: 'error', message: 'No data loaded. Please load a file first.' });
        return;
    }

    // Run analysis pipeline with the provided settings (skip parsing, use cached data)
    runAnalysisPipeline(threshold);
}

/**
 * Runs the complete knock analysis pipeline on cached data.
 * Calls resolveChannels → classifyKnockEvents → all analysis functions in sequence.
 * Posts progress updates, channel warnings, and the final result message.
 *
 * @param {number|Object} settings - fixed threshold %, or { threshold: % | table, thresholdLabel, ignitionAxes, inputs }
 */
function runAnalysisPipeline(settings) {
    if (settings === null || settings === undefined) settings = {};
    if (typeof settings === 'number') settings = { threshold: settings };
    var threshold = settings.threshold !== undefined && settings.threshold !== null ? settings.threshold : KNOCK_DEFAULT_THRESHOLD;
    var thresholdLabel = settings.thresholdLabel || (typeof threshold === 'number' ? 'the ' + threshold + '% threshold' : 'the Knock Threshold table');
    self.postMessage({ type: 'progress', phase: 'Resolving channels', percent: 0 });

    // Step 1: Resolve channels
    var channelResult = resolveChannels(cachedColumnNames);
    var resolved = channelResult.resolved;
    var channelWarnings = channelResult.warnings;

    // Post warnings for each missing channel
    for (var w = 0; w < channelWarnings.length; w++) {
        self.postMessage({ type: 'warning', message: channelWarnings[w] });
    }

    self.postMessage({ type: 'progress', phase: 'Classifying knock events', percent: 10 });

    configureKnockBins(settings.ignitionAxes || null, resolved.load_norm !== -1);
    if (settings.ignitionAxes && resolved.load_norm === -1) {
        self.postMessage({ type: 'warning', message: 'Engine Load Normalised is not logged, so the knock grid uses the tune\'s engine speed sites ' +
            'with 10 kPa MAP rows instead of the Ignition Timing Main load sites. Log "Engine Load Normalised" to match the table.' });
    }

    // Step 2: Classify knock events
    var events = classifyKnockEvents(cachedData, resolved, threshold);
    var health = computeKnockSensorHealth(cachedData, resolved, settings.inputs || null);

    self.postMessage({ type: 'progress', phase: 'Computing cylinder distribution', percent: 25 });

    // Step 3: Compute cylinder distribution
    var distribution = computeCylinderDistribution(events);

    self.postMessage({ type: 'progress', phase: 'Computing heatmap', percent: 35 });

    // Step 4: Compute heatmap bins
    var heatmapData = computeHeatmapBins(events);

    self.postMessage({ type: 'progress', phase: 'Computing timing correlation', percent: 45 });

    // Step 5: Compute timing correlation
    var timingCorrelation = computeTimingCorrelation(events);

    self.postMessage({ type: 'progress', phase: 'Computing timing retard stats', percent: 55 });

    // Step 6: Compute timing retard stats (may be null)
    var retardStats = computeTimingRetardStats(cachedData, resolved, events);

    self.postMessage({ type: 'progress', phase: 'Identifying worst conditions', percent: 65 });

    // Step 7: Identify worst conditions
    var worstConditions = identifyWorstConditions(events);

    self.postMessage({ type: 'progress', phase: 'Computing timing recommendations', percent: 75 });

    // Step 8: Compute timing recommendations
    var recommendations = computeTimingRecommendations(events);

    self.postMessage({ type: 'progress', phase: 'Computing knock vs load normalized', percent: 80 });

    // Step 8b: Compute knock vs engine load normalized
    var knockByLoad = computeKnockByLoadNormalized(events, cachedData, resolved);

    // Step 8c: Compute per-cylinder RPM × Load knock grid
    var knockRpmLoadGrid = computeKnockRpmLoadGrid(events, cachedData, resolved);

    self.postMessage({ type: 'progress', phase: 'Generating diagnostics', percent: 85 });

    // Step 9: Generate diagnostics
    var diagnostics = generateDiagnostics(distribution, worstConditions, retardStats, { health: health, thresholdLabel: thresholdLabel });

    self.postMessage({ type: 'progress', phase: 'Preparing results', percent: 95 });

    // Build channel mapping (logical name → boolean found)
    var channelMapping = {};
    var channelKeys = Object.keys(resolved);
    for (var i = 0; i < channelKeys.length; i++) {
        channelMapping[channelKeys[i]] = resolved[channelKeys[i]] !== -1;
    }

    // Build retard time series for chart data, downsampled if needed
    var retardTimeSeries = null;
    if (retardStats && retardStats.timeSeries) {
        var ts = retardStats.timeSeries;
        if (ts.values.length > 150000) {
            // Downsample both time and values arrays
            var downsampledValues = downsampleForChart(ts.values, 150000);
            // Downsample time array to match (use same step logic)
            var step = Math.max(1, Math.floor(ts.time.length / 150000));
            var downsampledTime = [];
            for (var t = 0; t < ts.time.length; t += step) {
                downsampledTime.push(ts.time[t]);
                // Add second point for min/max pair if values were split
                if (t + 1 < ts.time.length && downsampledTime.length < downsampledValues.length) {
                    downsampledTime.push(ts.time[Math.min(t + step - 1, ts.time.length - 1)]);
                }
            }
            // Trim to match downsampled values length
            downsampledTime = downsampledTime.slice(0, downsampledValues.length);
            retardTimeSeries = { time: downsampledTime, values: downsampledValues, label: ts.label };
        } else {
            retardTimeSeries = ts;
        }
    }

    // Post final result
    self.postMessage({
        type: 'result',
        analysis: {
            channelMapping: channelMapping,
            channelWarnings: channelWarnings,
            cylinderDistribution: distribution,
            heatmapData: heatmapData,
            timingCorrelation: timingCorrelation,
            retardStats: retardStats,
            worstConditions: worstConditions,
            timingRecommendations: recommendations,
            knockByLoad: knockByLoad,
            knockRpmLoadGrid: knockRpmLoadGrid,
            diagnostics: diagnostics,
            sensorHealth: health,
            events: events.slice(0, 2000),
            totalEvents: events.length,
            threshold: threshold,
            thresholdLabel: thresholdLabel,
            binSource: knockBins().source
        },
        chartData: {
            knockEvents: events,
            cylinderDistribution: distribution,
            heatmapData: heatmapData,
            retardTimeSeries: retardTimeSeries,
            timingCorrelation: timingCorrelation
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyKnockEvents: classifyKnockEvents, knockThresholdAt: knockThresholdAt, configureKnockBins: configureKnockBins,
        assignRpmBin: assignRpmBin, assignLoadBin: assignLoadBin, computeTimingRecommendations: computeTimingRecommendations,
        computeTimingRetardStats: computeTimingRetardStats, computeKnockSensorHealth: computeKnockSensorHealth,
        generateDiagnostics: generateDiagnostics, resolveChannels: resolveChannels, computeCylinderDistribution: computeCylinderDistribution,
        identifyWorstConditions: identifyWorstConditions, computeKnockRpmLoadGrid: computeKnockRpmLoadGrid, computeHeatmapBins: computeHeatmapBins };
}
