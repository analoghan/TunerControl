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
    coolant_temp:   ['Coolant Temperature']
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

/**
 * Classifies knock events from parsed log data based on a threshold.
 *
 * For each data row, checks each cylinder's knock level channel. If the knock
 * level is strictly greater than the threshold, a KnockEvent is created with
 * all associated operating condition data from that row.
 *
 * @param {number[][]} data - Array of row arrays (numeric values)
 * @param {Object<string, number>} channels - The resolved channel index map from resolveChannels
 * @param {number} threshold - Knock threshold percentage (0–100); events are knockLevel > threshold
 * @returns {Array<Object>} Array of KnockEvent objects
 */
function classifyKnockEvents(data, channels, threshold) {
    var events = [];

    // Pre-resolve optional channel indices (-1 means unavailable → null)
    var rpmIdx = channels.rpm;
    var mapIdx = channels.map;
    var ignTimingIdx = channels.ign_timing;
    var ignTimingCompIdx = channels.ign_timing_comp;
    var tpsIdx = channels.tps;
    var gearIdx = channels.gear;

    // Collect resolved knock cylinder indices (only those != -1)
    var knockChannels = [];
    for (var n = 1; n <= 8; n++) {
        var key = 'knock_cyl_' + n;
        var idx = channels[key];
        if (idx !== -1) {
            knockChannels.push({ cylinderIndex: n, colIdx: idx });
        }
    }

    // Iterate all data rows
    for (var r = 0; r < data.length; r++) {
        var row = data[r];
        var timestamp = row[0]; // Time is always column 0

        // Check each resolved knock cylinder channel
        for (var k = 0; k < knockChannels.length; k++) {
            var knockLevel = row[knockChannels[k].colIdx];

            // Classify as knock event if strictly greater than threshold
            if (knockLevel > threshold) {
                events.push({
                    timestamp: timestamp,
                    cylinderIndex: knockChannels[k].cylinderIndex,
                    knockLevel: knockLevel,
                    rpm: rpmIdx !== -1 ? row[rpmIdx] : null,
                    load: mapIdx !== -1 ? row[mapIdx] : null,
                    ignTiming: ignTimingIdx !== -1 ? row[ignTimingIdx] : null,
                    ignTimingComp: ignTimingCompIdx !== -1 ? row[ignTimingCompIdx] : null,
                    tps: tpsIdx !== -1 ? row[tpsIdx] : null,
                    gear: gearIdx !== -1 ? row[gearIdx] : null
                });
            }
        }
    }

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
 * Assigns an RPM value to a bin index.
 * Bins are 500 RPM wide, covering 0–7500 RPM (15 bins total).
 * Values below 0 clamp to bin 0; values at or above 7500 clamp to bin 14.
 *
 * @param {number} rpm - Engine speed in RPM
 * @returns {number} Bin index in range [0, 14]
 */
function assignRpmBin(rpm) {
    if (rpm < 0) return 0;
    var bin = Math.floor(rpm / 500);
    return bin > 14 ? 14 : bin;
}

/**
 * Assigns a load (inlet manifold pressure) value to a bin index.
 * Bins are 10 kPa wide, covering 0–250 kPa (25 bins total).
 * Values below 0 clamp to bin 0; values at or above 250 clamp to bin 24.
 *
 * @param {number} kpa - Inlet manifold pressure in kPa
 * @returns {number} Bin index in range [0, 24]
 */
function assignLoadBin(kpa) {
    if (kpa < 0) return 0;
    var bin = Math.floor(kpa / 10);
    return bin > 24 ? 24 : bin;
}

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
    // Build bin boundary arrays
    var rpmBins = [];
    for (var r = 0; r <= 15; r++) {
        rpmBins.push(r * 500);
    }

    var loadBins = [];
    for (var l = 0; l <= 25; l++) {
        loadBins.push(l * 10);
    }

    // Initialize 15x25 counts matrix to zero
    var counts = [];
    for (var i = 0; i < 15; i++) {
        var row = [];
        for (var j = 0; j < 25; j++) {
            row.push(0);
        }
        counts.push(row);
    }

    // Tally events into bins
    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        if (evt.rpm === null || evt.rpm === undefined ||
            evt.load === null || evt.load === undefined) {
            continue;
        }
        var rpmIdx = assignRpmBin(evt.rpm);
        var loadIdx = assignLoadBin(evt.load);
        counts[rpmIdx][loadIdx]++;
    }

    return {
        rpmBins: rpmBins,
        loadBins: loadBins,
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
    var rpmIdx = channels.rpm;
    var mapIdx = channels.map;
    if (rpmIdx === -1 || mapIdx === -1) return null;

    var NUM_RPM_BINS = 15;
    var NUM_LOAD_BINS = 25;
    var RPM_WIDTH = 500;
    var LOAD_WIDTH = 10;

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
        if (isNaN(rpm) || isNaN(load)) continue;
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
                row.push({ events: 0, levelSum: 0, maxLevel: 0 });
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
        if (evt.rpm === null || evt.load === null) continue;
        var rBin = assignRpmBin(evt.rpm);
        var lBin = assignLoadBin(evt.load);

        // All cylinders
        var cellAll = grids[0][lBin][rBin];
        cellAll.events++;
        cellAll.levelSum += evt.knockLevel;
        if (evt.knockLevel > cellAll.maxLevel) cellAll.maxLevel = evt.knockLevel;

        // Per cylinder
        var cylGrid = grids[evt.cylinderIndex];
        if (cylGrid) {
            var cellCyl = cylGrid[lBin][rBin];
            cellCyl.events++;
            cellCyl.levelSum += evt.knockLevel;
            if (evt.knockLevel > cellCyl.maxLevel) cellCyl.maxLevel = evt.knockLevel;
        }
    }

    // Finalize: compute rate and avgLevel
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
                    maxLevel: Math.round(cell.maxLevel * 10) / 10
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

    // Build labels
    var rpmLabels = [];
    for (var r = 0; r < NUM_RPM_BINS; r++) {
        rpmLabels.push((r * RPM_WIDTH) + '–' + ((r + 1) * RPM_WIDTH));
    }
    var loadLabels = [];
    for (var l = 0; l < NUM_LOAD_BINS; l++) {
        loadLabels.push((l * LOAD_WIDTH) + '–' + ((l + 1) * LOAD_WIDTH));
    }

    return {
        rpmLabels: rpmLabels,
        loadLabels: loadLabels,
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

    for (var r = 0; r < data.length; r++) {
        var load = data[r][mapIdx];
        if (load === null || load === undefined || isNaN(load)) continue;
        var bin = assignLoadBin(load);
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
        var bin = assignLoadBin(evt.load);
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
    var rpmBinSums = new Array(15);
    var rpmBinMaxes = new Array(15);
    var rpmBinCounts = new Array(15);
    for (var i = 0; i < 15; i++) {
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
    var perRpmBin = new Array(15);
    for (var r = 0; r < 15; r++) {
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
 * Computes timing retard statistics from the ignition timing compensation channel.
 *
 * Analyzes the full data set for non-zero timing compensation samples, finds the
 * maximum retard value, computes the mean retard during knock events, and builds
 * time series arrays for chart rendering.
 *
 * @param {number[][]} data - Array of row arrays (numeric values)
 * @param {Object<string, number>} channels - The resolved channel index map from resolveChannels
 * @param {Array<Object>} events - Array of KnockEvent objects
 * @returns {Object|null} RetardStats object, or null if timing compensation channel unavailable
 */
function computeTimingRetardStats(data, channels, events) {
    // Return null if timing compensation channel is unavailable
    if (channels.ign_timing_comp === -1) {
        return null;
    }

    var compIdx = channels.ign_timing_comp;

    // Compute non-zero count and max retard across ALL data rows
    var nonZeroCount = 0;
    var maxRetard = -Infinity;
    var timeArr = [];
    var valuesArr = [];

    for (var r = 0; r < data.length; r++) {
        var row = data[r];
        var compVal = row[compIdx];
        var timeVal = row[0]; // Time is always column 0

        // Build time series for chart rendering
        timeArr.push(timeVal);
        valuesArr.push(compVal);

        // Count non-zero samples
        if (compVal !== 0) {
            nonZeroCount++;
        }

        // Track maximum
        if (compVal > maxRetard) {
            maxRetard = compVal;
        }
    }

    // Handle edge case: if data is empty, set maxRetard to 0
    if (data.length === 0) {
        maxRetard = 0;
    }

    // Compute mean timing retard during knock events
    // Use events[i].ignTimingComp, skip nulls
    var sum = 0;
    var count = 0;
    for (var i = 0; i < events.length; i++) {
        var comp = events[i].ignTimingComp;
        if (comp !== null && comp !== undefined) {
            sum += comp;
            count++;
        }
    }
    var meanDuringKnock = count > 0 ? sum / count : 0;

    return {
        nonZeroCount: nonZeroCount,
        maxRetard: maxRetard,
        meanDuringKnock: meanDuringKnock,
        timeSeries: { time: timeArr, values: valuesArr }
    };
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
    var rpmBinCounts = new Array(15);
    for (var i = 0; i < 15; i++) rpmBinCounts[i] = 0;
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
        for (var r = 0; r < 15; r++) {
            if (rpmBinCounts[r] > maxRpmCount) {
                maxRpmCount = rpmBinCounts[r];
                maxRpmIdx = r;
            }
        }
        var rpmLow = maxRpmIdx * 500;
        var rpmHigh = rpmLow + 500;
        worstRpmBin = {
            binIndex: maxRpmIdx,
            rpmRange: rpmLow + '-' + rpmHigh + ' RPM',
            count: maxRpmCount
        };
    }

    // --- Worst Load Bin ---
    var loadBinCounts = new Array(25);
    for (var i = 0; i < 25; i++) loadBinCounts[i] = 0;
    var hasLoadData = false;

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        if (evt.load !== null && evt.load !== undefined && !isNaN(evt.load)) {
            hasLoadData = true;
            var loadBin = assignLoadBin(evt.load);
            loadBinCounts[loadBin]++;
        }
    }

    var worstLoadBin = null;
    if (hasLoadData) {
        var maxLoadCount = 0;
        var maxLoadIdx = 0;
        for (var l = 0; l < 25; l++) {
            if (loadBinCounts[l] > maxLoadCount) {
                maxLoadCount = loadBinCounts[l];
                maxLoadIdx = l;
            }
        }
        var loadLow = maxLoadIdx * 10;
        var loadHigh = loadLow + 10;
        worstLoadBin = {
            binIndex: maxLoadIdx,
            loadRange: loadLow + '-' + loadHigh + ' kPa',
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
 * Computes per-cylinder timing reduction recommendations based on knock event
 * distribution. Cylinders with more knock events receive proportionally larger
 * timing reductions, scaled relative to the cylinder with the fewest events.
 *
 * Formula: reductionDeg = (count - minCount) / (maxCount - minCount) * 5
 * The cylinder with the fewest events gets 0 degrees.
 * All reductions are capped at 5 degrees maximum.
 * Results are rounded to 1 decimal place.
 *
 * @param {Object} distribution - CylinderDistribution object with counts[8] and total
 * @returns {Array<{cylinderIndex: number, reductionDeg: number}>} Array of 8 TimingRecommendation objects, or empty array if total is zero
 */
function computeTimingRecommendations(distribution) {
    // Return empty array if total events is zero
    if (distribution.total === 0) {
        return [];
    }

    var counts = distribution.counts;

    // Find minCount and maxCount from distribution.counts
    var minCount = counts[0];
    var maxCount = counts[0];
    for (var i = 1; i < 8; i++) {
        if (counts[i] < minCount) minCount = counts[i];
        if (counts[i] > maxCount) maxCount = counts[i];
    }

    var recommendations = [];
    for (var c = 0; c < 8; c++) {
        var reductionDeg;
        if (maxCount === minCount) {
            // All cylinders have equal counts — all get 0 degrees
            reductionDeg = 0;
        } else {
            // Proportional scaling: (count - minCount) / (maxCount - minCount) * 5
            reductionDeg = (counts[c] - minCount) / (maxCount - minCount) * 5;
            // Cap at 5 degrees maximum
            reductionDeg = Math.min(reductionDeg, 5);
        }
        // Round to 1 decimal place
        reductionDeg = Math.round(reductionDeg * 10) / 10;

        recommendations.push({
            cylinderIndex: c + 1,
            reductionDeg: reductionDeg
        });
    }

    return recommendations;
}

// ---------------------------------------------------------------------------
// Diagnostic Message Generation
// ---------------------------------------------------------------------------

/**
 * Generates diagnostic summary messages based on knock analysis results.
 *
 * If no knock events were detected (distribution.total === 0), returns a single
 * message indicating no events at the current threshold. Otherwise, generates
 * messages identifying the worst cylinder, RPM band, and load range.
 *
 * @param {Object} distribution - CylinderDistribution object with counts, percentages, total, ranking
 * @param {Object} worstConditions - WorstConditions object with worstRpmBin, worstLoadBin, worstGear
 * @param {Object|null} retardStats - RetardStats object or null if timing comp unavailable
 * @returns {string[]} Array of diagnostic message strings
 */
function generateDiagnostics(distribution, worstConditions, retardStats) {
    // No knock events case
    if (distribution.total === 0) {
        return ['No knock events detected at the current threshold.'];
    }

    var messages = [];

    // Message 1: Cylinder with highest knock percentage
    // ranking[0] is the cylinder number (1–8) with the most events
    var worstCyl = distribution.ranking[0];
    var worstPct = distribution.percentages[worstCyl - 1];
    messages.push('Cylinder ' + worstCyl + ' has the highest knock activity at ' + worstPct + '% of total events.');

    // Message 2: Worst RPM band (skip if null)
    if (worstConditions.worstRpmBin !== null) {
        messages.push('Most knock events occur in the ' + worstConditions.worstRpmBin.rpmRange + ' RPM band (' + worstConditions.worstRpmBin.count + ' events).');
    }

    // Message 3: Worst load range (skip if null)
    if (worstConditions.worstLoadBin !== null) {
        messages.push('Most knock events occur in the ' + worstConditions.worstLoadBin.loadRange + ' load range (' + worstConditions.worstLoadBin.count + ' events).');
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
            handleAnalyzeCsv(msg.logText);
        } else if (msg.type === 'analyze_ld') {
            handleAnalyzeLd(msg.buffer);
        } else if (msg.type === 'reanalyze') {
            handleReanalyze(msg.threshold);
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

    // Run analysis pipeline with default threshold
    runAnalysisPipeline(5);
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

    // Run analysis pipeline with default threshold
    runAnalysisPipeline(5);
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

    // Run analysis pipeline with the provided threshold (skip parsing, use cached data)
    runAnalysisPipeline(threshold);
}

/**
 * Runs the complete knock analysis pipeline on cached data.
 * Calls resolveChannels → classifyKnockEvents → all analysis functions in sequence.
 * Posts progress updates, channel warnings, and the final result message.
 *
 * @param {number} threshold - Knock threshold percentage (0–100)
 */
function runAnalysisPipeline(threshold) {
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

    // Step 2: Classify knock events
    var events = classifyKnockEvents(cachedData, resolved, threshold);

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
    var recommendations = computeTimingRecommendations(distribution);

    self.postMessage({ type: 'progress', phase: 'Computing knock vs load normalized', percent: 80 });

    // Step 8b: Compute knock vs engine load normalized
    var knockByLoad = computeKnockByLoadNormalized(events, cachedData, resolved);

    // Step 8c: Compute per-cylinder RPM × Load knock grid
    var knockRpmLoadGrid = computeKnockRpmLoadGrid(events, cachedData, resolved);

    self.postMessage({ type: 'progress', phase: 'Generating diagnostics', percent: 85 });

    // Step 9: Generate diagnostics
    var diagnostics = generateDiagnostics(distribution, worstConditions, retardStats);

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
            retardTimeSeries = { time: downsampledTime, values: downsampledValues };
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
            threshold: threshold
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
