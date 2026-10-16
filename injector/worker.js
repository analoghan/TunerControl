/**
 * worker.js — Injector Characterization Analysis Worker.
 * Performs all heavy CSV parsing and analysis computation off the main thread.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Analysis thresholds used across all analysis modules.
 */
const THRESHOLDS = {
    LEAN_SPIKE_LAMBDA: 1.06,    // Lambda above this = lean
    LEAN_MIN_EPISODE_S: 0.3,    // a lean episode lasts at least this long (logs hold 10 Hz lambda at 100 Hz)
    LEAN_MERGE_GAP_S: 0.3,      // lean stretches closer than this are one episode
    LEAN_LOOKBACK_S: 0.5,       // window before an episode checked for an injection cut (lambda lags injection)
    SHORT_PW_MS: 1.0,           // below this a DI injector is non-linear (MoTeC/GM: short-pulse region, ~1 ms)
    TARGET_LAMBDA: 1.0,         // Stoichiometric target
    IDLE_RPM_MAX: 1500,         // Max RPM considered idle
    LIGHT_LOAD_MAP_KPA: 60,     // kPa gauge for light load
    LOW_FUEL_PRESS_BELOW_AIM_BAR: 10,   // Rail pressure this far below aim = significant pressure drop
    MPA_TO_BAR: 10,             // M1 logs rail pressure in MPa ("dMPa" = differential MPa)
    MIN_RUNNING_RPM: 400,       // below this the engine is cranking or stopped
    OPTIMAL_TIMING_START: 240,  // dBTDC - optimal injection window start
    OPTIMAL_TIMING_END: 320,    // dBTDC - optimal injection window end
    COMPRESSION_STROKE: 180,    // dBTDC - compression stroke boundary
    MAX_CHART_POINTS: 5000,     // Maximum points for chart rendering (Chart.js performance limit)
};

/**
 * RPM bin boundaries. Bin i contains values where RPM_BINS[i] < rpm <= RPM_BINS[i+1].
 * Last bin is 5500 < rpm <= 7500.
 */
const RPM_BINS = [0, 800, 1200, 1500, 2000, 2500, 3000, 4000, 5500, 7500];

/**
 * Human-readable labels for each RPM bin.
 */
const RPM_LABELS = ["<800", "800-1.2k", "1.2-1.5k", "1.5-2k", "2-2.5k", "2.5-3k", "3-4k", "4-5.5k", "5.5k+"];

/**
 * Maps logical channel names to their MoTeC CSV column name candidates.
 * Each key maps to an array of possible column header strings.
 */
const CHANNEL_MAP = {
    time:             ["Time"],
    rpm:              ["Engine Speed"],
    map:              ["Inlet Manifold Pressure"],
    lambda_b1:        ["Exhaust Lambda Bank 1"],
    lambda_b2:        ["Exhaust Lambda Bank 2"],
    lambda_avg:       ["Exhaust Lambda"],
    inj_pw:           ["Fuel Cylinder 1 Primary Output Pulse Width 1"],
    inj_timing:       ["Fuel Cylinder 1 Primary Output Pulse Angle 1"],
    tps:              ["Throttle Position"],
    fuel_press_di:    ["Fuel Pressure Direct Bank 1"],
    fuel_press_di_aim:["Fuel Pressure Direct Bank 1 Aim"],
    coolant_temp:     ["Coolant Temperature"],
    iat:              ["Inlet Air Temperature"],
    cl_trim_b1:       ["Fuel Closed Loop Control Bank 1 Trim"],
    cl_trim_b2:       ["Fuel Closed Loop Control Bank 2 Trim"],
    fuel_mix_aim:     ["Fuel Mixture Aim"],
    overrun:          ["Engine Overrun State"],
};

// ---------------------------------------------------------------------------
// MoTeC .ld Binary Parser
// ---------------------------------------------------------------------------

/**
 * Maps .ld dot-separated channel names to the CSV-style names used in CHANNEL_MAP.
 * The .ld format uses dots as hierarchy separators and truncates at 32 chars.
 * This map provides exact matches for known channels.
 */
const INJ_LD_NAME_MAP = {
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
function injNormalizeLdChannelName(ldName) {
    if (INJ_LD_NAME_MAP[ldName]) {
        return INJ_LD_NAME_MAP[ldName];
    }
    // Fallback: replace dots with spaces, collapse multiple spaces
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
function injNormalizeLdChannelNameWithUnit(ldName, unit) {
    // Check explicit map first
    if (INJ_LD_NAME_MAP[ldName]) {
        return INJ_LD_NAME_MAP[ldName];
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
function injReadString(view, offset, length) {
    var bytes = [];
    for (var i = 0; i < length; i++) {
        var b = view.getUint8(offset + i);
        if (b === 0) break;
        bytes.push(b);
    }
    return String.fromCharCode.apply(null, bytes).trim();
}

/**
 * Parses a MoTeC .ld binary file from an ArrayBuffer.
 * Returns column names and data in the same format as the CSV parser.
 *
 * @param {ArrayBuffer} buffer - The raw .ld file contents
 * @param {function} progressCallback - Called with (channelsProcessed, totalChannels)
 * @returns {{columnNames: string[], data: number[][], maxFreq: number}}
 */
function injParseLdFile(buffer, progressCallback) {
    var view = new DataView(buffer);

    // --- Parse header ---
    // Offsets based on ldHead.fmt:
    // 0: marker (4) + 4x padding = 8 bytes
    // 8: meta_ptr (4), 12: data_ptr (4)
    // 16: 20x padding = 20 bytes
    // 36: event_ptr (4)
    // 40: 24x padding = 24 bytes
    // 64: 3x uint16 = 6 bytes
    // 70: device_serial (4)
    // 74: device_type (8)
    // 82: device_version (2)
    // 84: unknown (2)
    // 86: num_channs (4)
    // 90: 4x padding
    // 94: date (16), 110: 16x, 126: time (16), 142: 16x
    // Total header: 1762 bytes

    var metaPtr = view.getUint32(8, true);
    var dataPtr = view.getUint32(12, true);
    var numChanns = view.getUint32(86, true);

    if (metaPtr === 0 || numChanns === 0) {
        throw new Error('Invalid .ld file: no channel metadata found');
    }

    // --- Parse channel metadata ---
    // Channel header format (120 bytes per channel):
    // 0: prev_ptr (4), 4: next_ptr (4), 8: data_ptr (4), 12: n_data (4)
    // 16: counter (2)
    // 18: dtype_a (2), 20: dtype (2), 22: freq (2)
    // 24: shift (2, signed), 26: mul (2, signed), 28: scale (2, signed), 30: dec (2, signed)
    // 32: name (32), 64: short_name (8), 72: unit (12)
    // 84: padding (40)
    // Total: 124 bytes (but ldparser uses 40x padding = 124 total)
    var CHAN_HEADER_SIZE = 124; // 4+4+4+4 + 2 + 2+2+2 + 2+2+2+2 + 32+8+12 + 40 = 124

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

        var name = injReadString(view, ptr + 32, 32);
        var shortName = injReadString(view, ptr + 64, 8);  // actually contains unit in MoTeC M1 files
        var unit = injReadString(view, ptr + 72, 12);

        // Determine data type and bytes per sample
        var bytesPerSample = 0;
        var dataType = null;
        if (dtypeA === 0x07) {
            // Float types
            if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'float16'; }
            else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'float32'; }
        } else if (dtypeA === 0 || dtypeA === 0x03 || dtypeA === 0x05) {
            // Integer types
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
    // Build column names (Time + all channels) and a data array
    var columnNames = ['Time'];
    var channelData = []; // array of Float64Arrays, one per channel

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
        var normalizedName = injNormalizeLdChannelNameWithUnit(chan.name, chan.shortName);
        columnNames.push(normalizedName);

        // Read raw data
        var rawData = injReadChannelData(buffer, chan);

        // Apply scale/shift/mul/dec transformation: (raw/scale * 10^(-dec) + shift) * mul
        var transformed = new Float64Array(rawData.length);
        var decFactor = Math.pow(10, -chan.dec);
        for (var s = 0; s < rawData.length; s++) {
            transformed[s] = (rawData[s] / chan.scale * decFactor + chan.shift) * chan.mul;
        }

        // Resample to base rate if needed
        if (chan.freq === maxFreq) {
            channelData.push(transformed);
        } else {
            // Upsample by repeating values (sample-and-hold)
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

/**
 * Reads raw numeric data for a single channel from the .ld buffer.
 *
 * @param {ArrayBuffer} buffer - The raw .ld file
 * @param {Object} chan - Channel metadata object
 * @returns {Float64Array} Raw (untransformed) numeric values
 */
function injReadChannelData(buffer, chan) {
    if (!chan.dataType || chan.bytesPerSample === 0) {
        // Unknown data type — return zeros
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
                // JavaScript doesn't have native float16, decode manually
                result[i] = injDecodeFloat16(view.getUint16(offset, true));
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
 * Decodes an IEEE 754 half-precision (float16) value from a uint16.
 *
 * @param {number} h - The uint16 representation of a float16
 * @returns {number} The decoded floating-point value
 */
function injDecodeFloat16(h) {
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
// Statistics Helper Functions
// ---------------------------------------------------------------------------

/**
 * Computes the arithmetic mean of an array of numbers.
 *
 * Precondition: values is a non-empty array of finite numbers.
 * Postcondition: Returns sum(values) / values.length.
 *
 * @param {number[]} values - Non-empty array of finite numbers
 * @returns {number} Arithmetic mean
 */
function computeMean(values) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
    }
    return sum / values.length;
}

/**
 * Computes the median of a pre-sorted array.
 *
 * Precondition: sortedArray is a non-empty array sorted in ascending order.
 * Postcondition: Returns the middle element (odd length) or average of two
 *   middle elements (even length).
 *
 * @param {number[]} sortedArray - Non-empty sorted array
 * @returns {number} Median value
 */
function computeMedian(sortedArray) {
    const n = sortedArray.length;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1) {
        return sortedArray[mid];
    }
    return (sortedArray[mid - 1] + sortedArray[mid]) / 2;
}

/**
 * Computes the value at a given percentile using linear interpolation.
 *
 * Preconditions:
 *   - sortedArray is sorted in ascending order
 *   - sortedArray.length > 0
 *   - 0 <= p <= 1
 *
 * Postcondition: Returns the value at position p * (n - 1) using linear
 *   interpolation. Result is within [sortedArray[0], sortedArray[n-1]].
 *
 * @param {number[]} sortedArray - Non-empty sorted array
 * @param {number} p - Percentile value between 0 and 1
 * @returns {number} Interpolated percentile value
 */
function computePercentile(sortedArray, p) {
    const n = sortedArray.length;
    if (n === 1) return sortedArray[0];

    const pos = p * (n - 1);
    const lower = Math.floor(pos);
    const upper = Math.ceil(pos);

    if (lower === upper) {
        return sortedArray[lower];
    }

    const frac = pos - lower;
    return sortedArray[lower] + frac * (sortedArray[upper] - sortedArray[lower]);
}

/**
 * Computes the population standard deviation of an array of numbers.
 *
 * Precondition: values is a non-empty array of finite numbers.
 * Postcondition: Returns sqrt(sum((x - mean)^2) / n). Result is non-negative.
 *
 * @param {number[]} values - Non-empty array of finite numbers
 * @returns {number} Population standard deviation
 */
function computeStdDev(values) {
    const mean = computeMean(values);
    let sumSqDiff = 0;
    for (let i = 0; i < values.length; i++) {
        const diff = values[i] - mean;
        sumSqDiff += diff * diff;
    }
    return Math.sqrt(sumSqDiff / values.length);
}

/**
 * Assigns an RPM value to a bin index using RPM_BINS boundaries.
 *
 * Bin assignment: value falls in bin i if RPM_BINS[i] < rpm <= RPM_BINS[i+1].
 * The first bin (<800) contains values where 0 < rpm <= 800.
 * The last bin (5.5k+) contains values where 5500 < rpm <= 7500.
 *
 * Precondition: rpm is a number (may be NaN).
 * Postcondition: Returns index into RPM_LABELS (0-8), or -1 if NaN or outside all bins.
 *
 * @param {number} rpm - RPM value to classify
 * @returns {number} Bin index (0-8) or -1 if unclassifiable
 */
function assignRPMBin(rpm) {
    if (isNaN(rpm) || rpm <= RPM_BINS[0] || rpm > RPM_BINS[RPM_BINS.length - 1]) {
        return -1;
    }
    for (let i = 1; i < RPM_BINS.length; i++) {
        if (rpm <= RPM_BINS[i]) {
            return i - 1;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Channel Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves logical channel names to column indices using case-insensitive matching.
 *
 * Preconditions:
 *   - columnNames is a non-empty array of trimmed strings
 *
 * Postconditions:
 *   - Returns object with integer indices for each channel key in CHANNEL_MAP
 *   - Index is -1 for channels not found in columnNames
 *   - Matching is case-insensitive after trimming
 *   - Throws if "Engine Speed" (rpm) is not found
 *   - Throws if no lambda source is found (all three lambda channels missing)
 *   - warnings array is populated for missing optional channels
 *
 * @param {string[]} columnNames - Array of CSV column header strings
 * @returns {Object} Resolved channel indices plus warnings array
 * @throws {Error} If required channels are missing
 */
function resolveInjectorChannels(columnNames) {
    // Build normalized lookup map (first occurrence wins for duplicates)
    const nameToIdx = new Map();
    for (let i = 0; i < columnNames.length; i++) {
        const normalized = columnNames[i].trim().toLowerCase();
        if (!nameToIdx.has(normalized)) {
            nameToIdx.set(normalized, i);
        }
    }

    // Find first matching candidate (case-insensitive) from a list
    const find = function (candidates) {
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

    // Validate required channels
    if (resolved.rpm === -1) {
        throw new Error('Required channel "Engine Speed" not found');
    }

    const hasLambda = resolved.lambda_b1 !== -1 ||
                      resolved.lambda_b2 !== -1 ||
                      resolved.lambda_avg !== -1;
    if (!hasLambda) {
        throw new Error('No lambda channel found');
    }

    // Generate warnings for missing optional channels
    const warnings = [];
    if (resolved.inj_pw === -1) {
        warnings.push('Injector PW channel not found — PW analysis skipped');
    }
    if (resolved.fuel_press_di === -1) {
        warnings.push('DI fuel pressure not found — pressure analysis skipped');
    }
    if (resolved.inj_timing === -1) {
        warnings.push('Injection timing not found — timing analysis skipped');
    }
    if (resolved.cl_trim_b1 === -1) {
        warnings.push('Closed-loop trim Bank 1 not found — Bank 1 trim analysis skipped');
    }
    if (resolved.cl_trim_b2 === -1) {
        warnings.push('Closed-loop trim Bank 2 not found — Bank 2 trim analysis skipped');
    }

    resolved.warnings = warnings;
    return resolved;
}

// ---------------------------------------------------------------------------
// Analysis Modules
// ---------------------------------------------------------------------------

/**
 * Seconds per row: from the Time channel when there is one, else the 100 Hz resample rate.
 */
function injSampleTime(data, channels, i) {
    return channels.time !== -1 ? data[i][channels.time] : i / 100;
}

/** The engine is running (not stopped or cranking). Without an engine speed channel every row counts. */
function injRunning(data, channels, i) {
    return channels.rpm === -1 || data[i][channels.rpm] >= THRESHOLDS.MIN_RUNNING_RPM;
}

/**
 * Finds lean episodes and sorts them by cause.
 *
 * A lean episode is a stretch, while the engine runs, where lambda on either bank (or the average when there are no
 * bank channels) stays above LEAN_SPIKE_LAMBDA for at least LEAN_MIN_EPISODE_S; gaps up to LEAN_MERGE_GAP_S are joined.
 * Logs are resampled to 100 Hz by holding values, so episodes are counted, not samples.
 *
 * Each episode is classified from the window LEAN_LOOKBACK_S before it to its end (lambda lags the injection):
 *   - overrun cut: Engine Overrun State was Enabled (2) — the intended overrun fuel cut;
 *   - injection off: the injector pulse width was zero with no overrun cut — on an M1 usually Fuel Injector Primary
 *     Minimum Volume switching all injectors off;
 *   - fuelled: the injectors kept firing, so lambda really was lean. These are split by bank, by a pulse in the
 *     short-pulse (non-linear) region and by rail pressure below aim.
 *
 * Returns null without a lambda channel.
 */
function analyzeLeanSpikes(data, channels) {
    var banks = ['lambda_b1', 'lambda_b2'].filter(function (k) { return channels[k] !== -1; });
    var lambdaCols = banks.length ? banks : (channels.lambda_avg !== -1 ? ['lambda_avg'] : []);
    if (!lambdaCols.length) return null;
    var hasPW = channels.inj_pw !== -1, hasOverrun = channels.overrun !== undefined && channels.overrun !== -1, n = data.length;

    function leanAt(i) {
        for (var k = 0; k < lambdaCols.length; k++) if (data[i][channels[lambdaCols[k]]] > THRESHOLDS.LEAN_SPIKE_LAMBDA) return true;
        return false;
    }

    // Running time per RPM band, for the episode rate.
    var binSeconds = new Array(RPM_LABELS.length).fill(0), runningSeconds = 0;
    var raw = [], cur = null;
    for (var i = 0; i < n; i++) {
        var dt = i > 0 ? Math.max(0, Math.min(0.1, injSampleTime(data, channels, i) - injSampleTime(data, channels, i - 1))) : 0;
        var running = injRunning(data, channels, i);
        if (running) {
            runningSeconds += dt;
            var b = assignRPMBin(data[i][channels.rpm]);
            if (b >= 0) binSeconds[b] += dt;
        }
        var t = injSampleTime(data, channels, i);
        if (running && leanAt(i)) {
            if (cur && t - cur.endTime <= THRESHOLDS.LEAN_MERGE_GAP_S) { cur.end = i; cur.endTime = t; }
            else { if (cur) raw.push(cur); cur = { start: i, end: i, startTime: t, endTime: t }; }
        }
    }
    if (cur) raw.push(cur);

    var episodes = [];
    raw.forEach(function (e) {
        var duration = e.endTime - e.startTime + 0.1;
        if (duration < THRESHOLDS.LEAN_MIN_EPISODE_S) return;
        var from = e.start;
        while (from > 0 && injSampleTime(data, channels, from - 1) >= e.startTime - THRESHOLDS.LEAN_LOOKBACK_S) from--;
        var pwOff = false, overrunCut = false, minPW = Infinity, minPressErr = Infinity, maxLambda = 0, b1 = false, b2 = false;
        for (var k = from; k <= e.end; k++) {
            if (!injRunning(data, channels, k)) continue;
            if (hasOverrun && Math.round(data[k][channels.overrun]) === 2) overrunCut = true;
            if (hasPW) {
                var pw = data[k][channels.inj_pw];
                if (!(pw > 0.05)) pwOff = true; else if (pw < minPW) minPW = pw;
            }
            if (k >= e.start) {
                lambdaCols.forEach(function (c) { if (data[k][channels[c]] > maxLambda) maxLambda = data[k][channels[c]]; });
                if (channels.lambda_b1 !== -1 && data[k][channels.lambda_b1] > THRESHOLDS.LEAN_SPIKE_LAMBDA) b1 = true;
                if (channels.lambda_b2 !== -1 && data[k][channels.lambda_b2] > THRESHOLDS.LEAN_SPIKE_LAMBDA) b2 = true;
            }
            if (channels.fuel_press_di !== -1 && channels.fuel_press_di_aim !== -1) {
                var err = (data[k][channels.fuel_press_di] - data[k][channels.fuel_press_di_aim]) * THRESHOLDS.MPA_TO_BAR;
                if (data[k][channels.fuel_press_di_aim] > 0 && err < minPressErr) minPressErr = err;
            }
        }
        episodes.push({
            time: Math.round(e.startTime * 10) / 10,
            duration: Math.round(duration * 10) / 10,
            rpm: Math.round(data[e.start][channels.rpm]),
            map: channels.map !== -1 ? Math.round(data[e.start][channels.map]) : null,
            maxLambda: Math.round(maxLambda * 100) / 100,
            cause: overrunCut ? 'overrun' : pwOff ? 'injection-off' : 'fuelled',
            minPW: minPW < Infinity ? Math.round(minPW * 1000) / 1000 : null,
            banks: b1 && b2 ? 'both' : b1 ? 'b1' : b2 ? 'b2' : null,
            lowPressure: minPressErr < -THRESHOLDS.LOW_FUEL_PRESS_BELOW_AIM_BAR
        });
    });

    var fuelled = episodes.filter(function (e) { return e.cause === 'fuelled'; });
    var off = episodes.filter(function (e) { return e.cause === 'injection-off'; });
    var overrun = episodes.filter(function (e) { return e.cause === 'overrun'; });
    var rpmDistribution = RPM_LABELS.map(function (band, bi) {
        var count = fuelled.filter(function (e) { return assignRPMBin(e.rpm) === bi; }).length;
        return { band: band, spikes: count, seconds: binSeconds[bi], perMinute: binSeconds[bi] > 0 ? count / binSeconds[bi] * 60 : 0 };
    });

    var result = {
        lambdaChannelUsed: lambdaCols.join(' + '),
        runningSeconds: runningSeconds,
        episodeCount: episodes.length,
        overrunCount: overrun.length,
        injectionOffCount: off.length,
        fuelledCount: fuelled.length,
        hasOverrunChannel: hasOverrun,
        hasPW: hasPW,
        bothBanksLean: banks.length === 2 ? fuelled.filter(function (e) { return e.banks === 'both'; }).length : null,
        onlyB1Lean: banks.length === 2 ? fuelled.filter(function (e) { return e.banks === 'b1'; }).length : null,
        onlyB2Lean: banks.length === 2 ? fuelled.filter(function (e) { return e.banks === 'b2'; }).length : null,
        fuelledShortPW: hasPW ? fuelled.filter(function (e) { return e.minPW !== null && e.minPW < THRESHOLDS.SHORT_PW_MS; }).length : null,
        fuelledLowPressure: fuelled.filter(function (e) { return e.lowPressure; }).length,
        injectionOff: off.slice(0, 200),
        fuelled: fuelled.slice(0, 200),
        rpmDistribution: rpmDistribution,
        diagnostics: []
    };
    result.diagnostics = generateLeanSpikeDiagnostics(result);
    return result;
}

function injRange(list, key) {
    var v = list.map(function (e) { return e[key]; }).filter(function (x) { return x !== null && !isNaN(x); }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var lo = v[Math.floor(v.length * 0.1)], hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.9))];
    return lo === hi ? String(lo) : lo + '–' + hi;
}

/**
 * Diagnostic messages for the lean episodes (see analyzeLeanSpikes).
 *
 * @param {Object} result - LeanSpikeResult with counts populated
 * @returns {string[]} Array of diagnostic message strings
 */
function generateLeanSpikeDiagnostics(result) {
    var d = [];
    if (!result.episodeCount) {
        d.push('No lean episodes (lambda above ' + THRESHOLDS.LEAN_SPIKE_LAMBDA + ' for ' + THRESHOLDS.LEAN_MIN_EPISODE_S +
            ' s or more) while the engine was running.');
        return d;
    }
    if (result.injectionOffCount) {
        var off = result.injectionOff;
        d.push(result.injectionOffCount + ' of ' + result.episodeCount + ' lean episodes are the injectors switched OFF' +
            (result.hasOverrunChannel ? ' without the overrun fuel cut' : '') + ' (rpm ' + injRange(off, 'rpm') +
            (injRange(off, 'map') ? ', MAP ' + injRange(off, 'map') + ' kPa' : '') + '). Lambda then reads air, not lean combustion. ' +
            'On an M1 the usual cause is Fuel Injector Primary Minimum Volume: when any cylinder\'s request falls below it, all ' +
            'injectors stop until every cylinder is above Minimum Volume + Hysteresis — typically on closed-throttle decel, often ' +
            'pushed there by the fuel film decrease compensation. Log Fuel Cylinder 1 Primary Volume to confirm.');
    }
    if (result.overrunCount) {
        d.push(result.overrunCount + ' lean episodes are the overrun fuel cut (Engine Overrun State Enabled) — expected.');
    } else if (!result.hasOverrunChannel && result.injectionOffCount) {
        d.push('Engine Overrun State is not logged, so the overrun fuel cut cannot be told apart from other injection cuts.');
    }
    if (!result.hasPW) d.push('Injector pulse width is not logged, so injection cuts cannot be told apart from lean combustion.');

    var f = result.fuelledCount;
    if (!f) {
        d.push('No lean episodes while the injectors were firing.');
        return d;
    }
    var fl = result.fuelled;
    var text = f + ' lean episode' + (f > 1 ? 's' : '') + ' with the injectors firing (rpm ' + injRange(fl, 'rpm') +
        (injRange(fl, 'map') ? ', MAP ' + injRange(fl, 'map') + ' kPa' : '') + ', ' + (result.runningSeconds / 60).toFixed(1) + ' min of running).';
    if (result.bothBanksLean !== null) {
        if (result.bothBanksLean >= f * 0.7) text += ' Both banks go lean together in ' + result.bothBanksLean + ' — a whole-engine cause (fuel model, film, pressure or injector data).';
        else if (result.onlyB1Lean > result.onlyB2Lean * 2) text += ' Bank 1 alone in ' + result.onlyB1Lean + ' — look at that bank\'s injectors, wiring or lambda sensor.';
        else if (result.onlyB2Lean > result.onlyB1Lean * 2) text += ' Bank 2 alone in ' + result.onlyB2Lean + ' — look at that bank\'s injectors, wiring or lambda sensor.';
    }
    d.push(text);
    if (result.fuelledShortPW) {
        d.push(result.fuelledShortPW + ' of them had pulses under ' + THRESHOLDS.SHORT_PW_MS + ' ms, the injector\'s non-linear (short-pulse) region. ' +
            'Fuel delivered there depends on Fuel Injector Primary Linearisation — check it against the injector\'s small-pulse data (volume vs pulse width by pressure).');
    }
    if (result.fuelledLowPressure) {
        d.push(result.fuelledLowPressure + ' of them had rail pressure more than ' + THRESHOLDS.LOW_FUEL_PRESS_BELOW_AIM_BAR + ' bar below aim — see the DI Fuel Pressure tool.');
    }
    return d;
}

/**
 * Counts elements in a sorted array that are strictly below a threshold.
 *
 * Precondition: sortedArray is sorted in ascending order.
 * Postcondition: Returns the number of elements where value < threshold.
 *
 * @param {number[]} sortedArray - Sorted array of numbers
 * @param {number} threshold - Threshold value
 * @returns {number} Count of elements below threshold
 */
function countBelow(sortedArray, threshold) {
    var count = 0;
    for (var i = 0; i < sortedArray.length; i++) {
        if (sortedArray[i] < threshold) {
            count++;
        } else {
            break; // sorted, so no more below threshold
        }
    }
    return count;
}

/**
 * Diagnostic messages for the pulse width distribution: time in the short-pulse (non-linear) region.
 *
 * @param {Object} stats - PW statistics object (pct1st, pct5th, belowThresholdPct)
 * @returns {string[]} Array of diagnostic message strings
 */
function generatePWDiagnostics(stats) {
    var d = [];
    if (stats.belowThresholdPct > 0) {
        d.push(stats.belowThresholdPct.toFixed(1) + '% of injecting time is below ' + THRESHOLDS.SHORT_PW_MS + ' ms (5th percentile ' +
            stats.pct5th.toFixed(2) + ' ms, 1st ' + stats.pct1st.toFixed(2) + ' ms). Below about 1 ms a DI injector is non-linear: ' +
            'fuelling there is only as good as Fuel Injector Primary Linearisation, which should come from the injector\'s small-pulse data.');
    } else {
        d.push('All injections are at or above ' + THRESHOLDS.SHORT_PW_MS + ' ms (5th percentile ' + stats.pct5th.toFixed(2) + ' ms).');
    }
    return d;
}

/**
 * Analyzes injector pulse width while the engine runs and the injectors fire (PW > 0.05 ms).
 *
 * @param {number[][]} data - Array of numeric row arrays
 * @param {Object} channels - Resolved channel indices
 * @returns {Object|null} PWStabilityResult or null if no PW channel available
 */
function analyzePWStability(data, channels) {
    if (channels.inj_pw === -1) return null;

    var validPW = [];
    for (var i = 0; i < data.length; i++) {
        var pw = data[i][channels.inj_pw];
        if (!isNaN(pw) && pw > 0.05 && injRunning(data, channels, i)) {
            validPW.push(pw);
        }
    }

    if (validPW.length === 0) return null;

    validPW.sort(function (a, b) { return a - b; });

    var stats = {
        channelUsed: 'inj_pw',
        min: validPW[0],
        max: validPW[validPW.length - 1],
        mean: computeMean(validPW),
        median: computeMedian(validPW),
        stdDev: computeStdDev(validPW),
        pct5th: computePercentile(validPW, 0.05),
        pct1st: computePercentile(validPW, 0.01),
        belowThresholdCount: countBelow(validPW, THRESHOLDS.SHORT_PW_MS),
    };

    stats.belowThresholdPct = (stats.belowThresholdCount / validPW.length) * 100;
    stats.diagnostics = generatePWDiagnostics(stats);

    return stats;
}

/**
 * Analyzes closed-loop fuel trim statistics per bank.
 *
 * Preconditions:
 *   - data is a non-empty array of numeric row arrays
 *   - channels is a resolved channels object with valid indices
 *
 * Postconditions:
 *   - For each available bank: mean, std, min, max computed from non-NaN values
 *   - diagnostics generated if |mean| > 5% (rich/lean VE error)
 *   - diagnostics generated if std > 4% (inconsistent fueling)
 *   - Returns result with both banks null and empty diagnostics if both channels missing
 *
 * @param {number[][]} data - Array of numeric row arrays
 * @param {Object} channels - Resolved channel indices
 * @returns {Object} ClosedLoopResult with bank1, bank2, and diagnostics
 */
function analyzeClosedLoop(data, channels) {
    var result = { bank1: null, bank2: null, diagnostics: [] };

    var bankConfigs = [['Bank 1', 'cl_trim_b1'], ['Bank 2', 'cl_trim_b2']];

    for (var b = 0; b < bankConfigs.length; b++) {
        var bankLabel = bankConfigs[b][0];
        var chKey = bankConfigs[b][1];

        if (channels[chKey] === -1) continue;

        var values = [];
        for (var i = 0; i < data.length; i++) {
            var v = data[i][channels[chKey]];
            // Running, with closed loop active (the trim sits at exactly 0 while it is not).
            if (!isNaN(v) && v !== 0 && injRunning(data, channels, i)) values.push(v);
        }

        if (values.length === 0) continue;

        // Compute min/max using loop-based approach (safe for large arrays)
        var min = values[0];
        var max = values[0];
        for (var j = 1; j < values.length; j++) {
            if (values[j] < min) min = values[j];
            if (values[j] > max) max = values[j];
        }

        var stats = {
            mean: computeMean(values),
            std: computeStdDev(values),
            min: min,
            max: max,
        };

        if (bankLabel === 'Bank 1') result.bank1 = stats;
        else result.bank2 = stats;

        // Diagnostics: rich/lean VE error when |mean| > 5%
        if (Math.abs(stats.mean) > 5) {
            var direction = stats.mean < 0 ? 'rich' : 'lean';
            result.diagnostics.push(
                bankLabel + ' mean trim of ' + stats.mean.toFixed(1) + '% suggests base VE is ' + direction
            );
        }

        // Diagnostics: inconsistent fueling when std > 4%
        if (stats.std > 4) {
            result.diagnostics.push(
                bankLabel + ' trim std dev ' + stats.std.toFixed(1) + '% is high \u2014 inconsistent fueling'
            );
        }
    }

    return result;
}

/**
 * Builds the FuelPressureResult object from collected pressure data.
 *
 * @param {number[]} pressures - Array of pressure values in bar
 * @param {number[]} errors - Array of pressure error values (actual - aim) in bar
 * @param {number|null} belowAimCount - Count of samples more than 10 bar below aim (null without an aim channel)
 * @param {number} leanSpikePressureSum - Sum of pressure values during lean spikes
 * @param {number} leanSpikeCount - Number of lean spike samples with valid pressure
 * @returns {Object} FuelPressureResult object
 */
function buildFuelPressureResult(pressures, errors, belowAimCount, leanSpikePressureSum, leanSpikeCount) {
    if (pressures.length === 0) return null;

    var meanBar = computeMean(pressures);
    var stdBar = computeStdDev(pressures);
    var minBar = pressures[0];
    var maxBar = pressures[0];
    for (var i = 1; i < pressures.length; i++) {
        if (pressures[i] < minBar) minBar = pressures[i];
        if (pressures[i] > maxBar) maxBar = pressures[i];
    }

    // Pressure error statistics
    var meanErrorBar = null;
    var stdErrorBar = null;
    var largeErrorCount = null;
    if (errors.length > 0) {
        meanErrorBar = computeMean(errors);
        stdErrorBar = computeStdDev(errors);
        largeErrorCount = 0;
        for (var j = 0; j < errors.length; j++) {
            if (Math.abs(errors[j]) > 20) {
                largeErrorCount++;
            }
        }
    }

    // Lean spike pressure mean
    var leanSpikeFPMeanBar = null;
    if (leanSpikeCount > 0) {
        leanSpikeFPMeanBar = leanSpikePressureSum / leanSpikeCount;
    }

    var result = {
        channelUsed: 'fuel_press_di',
        minBar: minBar,
        maxBar: maxBar,
        meanBar: meanBar,
        stdBar: stdBar,
        belowAimCount: errors.length ? belowAimCount : null,
        belowAimPct: errors.length ? (belowAimCount / errors.length) * 100 : null,
        meanErrorBar: meanErrorBar,
        stdErrorBar: stdErrorBar,
        largeErrorCount: largeErrorCount,
        leanSpikeFPMeanBar: leanSpikeFPMeanBar,
        overallFPMeanBar: meanBar,
        diagnostics: []
    };

    // Generate diagnostics
    result.diagnostics = generateFuelPressureDiagnostics(result);

    return result;
}

/**
 * Generates diagnostic messages for fuel pressure analysis.
 *
 * Diagnostic rules:
 * - If aim channel available and largeErrorCount > 1000: HPFP warning
 * - If lean spike mean pressure is > 10 bar below overall mean: fuel delivery warning
 *
 * @param {Object} result - Partial FuelPressureResult with statistics populated
 * @returns {string[]} Array of diagnostic message strings
 */
function generateFuelPressureDiagnostics(result) {
    var diagnostics = [];

    // HPFP diagnostic: large error count exceeds 1000
    if (result.largeErrorCount !== null && result.largeErrorCount > 1000) {
        diagnostics.push(
            'HPFP WARNING: ' + result.largeErrorCount +
            ' samples exceed 20 bar pressure error vs aim \u2014 possible high-pressure fuel pump degradation'
        );
    }

    // Fuel delivery diagnostic: lean spike pressure significantly below overall
    if (result.leanSpikeFPMeanBar !== null && result.overallFPMeanBar !== null) {
        var pressureDrop = result.overallFPMeanBar - result.leanSpikeFPMeanBar;
        if (pressureDrop > 10) {
            diagnostics.push(
                'Fuel pressure during lean spikes averages ' + pressureDrop.toFixed(1) +
                ' bar below overall mean (' + result.leanSpikeFPMeanBar.toFixed(1) +
                ' vs ' + result.overallFPMeanBar.toFixed(1) +
                ' bar) \u2014 fuel delivery may be insufficient during lean events'
            );
        }
    }

    return diagnostics;
}

/**
 * Analyzes DI fuel pressure behavior and its correlation with lean spikes.
 *
 * Preconditions:
 *   - data is a non-empty array of numeric row arrays
 *   - channels is a resolved channels object with valid indices
 *
 * Postconditions:
 *   - Returns FuelPressureResult object or null if fuel_press_di channel unavailable
 *   - All pressure values reported in bar (dMPa * 100)
 *   - Error vs aim computed only if fuel_press_di_aim channel exists
 *   - Lean spike correlation computed only if lambda channel exists
 *   - diagnostics contains HPFP warning if largeErrorCount > 1000
 *   - diagnostics contains fuel delivery warning if lean spike pressure > 10 bar below overall
 *
 * @param {number[][]} data - Array of numeric row arrays
 * @param {Object} channels - Resolved channel indices
 * @returns {Object|null} FuelPressureResult or null if no fuel pressure channel available
 */
function analyzeFuelPressure(data, channels) {
    if (channels.fuel_press_di === -1) return null;

    var pressures = [];  // in bar
    var errors = [];     // actual - aim, in bar
    var belowAimCount = 0;
    var leanSpikePressureSum = 0;
    var leanSpikeCount = 0;

    var lambdaCol = channels.lambda_b1 !== -1 ? channels.lambda_b1
                  : channels.lambda_avg !== -1 ? channels.lambda_avg : -1;

    for (var i = 0; i < data.length; i++) {
        var pressBar = data[i][channels.fuel_press_di] * THRESHOLDS.MPA_TO_BAR;
        if (isNaN(pressBar)) continue;
        // Only while the engine runs: stopped or cranking says nothing about the fuel system.
        if (channels.rpm !== -1 && !(data[i][channels.rpm] >= THRESHOLDS.MIN_RUNNING_RPM)) continue;

        pressures.push(pressBar);

        // Pressure error vs aim
        if (channels.fuel_press_di_aim !== -1) {
            var aimBar = data[i][channels.fuel_press_di_aim] * THRESHOLDS.MPA_TO_BAR;
            if (!isNaN(aimBar) && aimBar > 0) {
                errors.push(pressBar - aimBar);
                if (pressBar - aimBar < -THRESHOLDS.LOW_FUEL_PRESS_BELOW_AIM_BAR) belowAimCount++;
            }
        }

        // Lean spike correlation
        if (lambdaCol !== -1) {
            var lambda = data[i][lambdaCol];
            var firing = channels.inj_pw === -1 || data[i][channels.inj_pw] > 0.05;
            if (lambda > THRESHOLDS.LEAN_SPIKE_LAMBDA && firing) {
                leanSpikePressureSum += pressBar;
                leanSpikeCount++;
            }
        }
    }

    return buildFuelPressureResult(pressures, errors, belowAimCount,
        leanSpikePressureSum, leanSpikeCount);
}

/**
 * Analyzes injection timing distribution relative to the optimal intake stroke window.
 *
 * Preconditions:
 *   - data is a non-empty array of numeric row arrays
 *   - channels is a resolved channels object with valid indices
 *
 * Postconditions:
 *   - Returns InjectionTimingResult object or null if inj_timing channel unavailable
 *   - inOptimalCount = samples where timing is in [240, 320] dBTDC
 *   - inCompressionCount = samples where timing < 180 dBTDC
 *   - Lean spike timing stats computed only if lambda channel available
 *   - diagnostics generated based on compression percentage and lean-spike timing
 *
 * @param {number[][]} data - Array of numeric row arrays
 * @param {Object} channels - Resolved channel indices
 * @returns {Object|null} InjectionTimingResult or null if no timing channel available
 */
function analyzeInjectionTiming(data, channels) {
    if (channels.inj_timing === -1) return null;

    var timingValues = [];
    var inOptimal = 0;
    var inCompression = 0;
    var leanTimings = [];

    var lambdaCol = channels.lambda_b1 !== -1 ? channels.lambda_b1
                  : channels.lambda_avg !== -1 ? channels.lambda_avg : -1;

    for (var i = 0; i < data.length; i++) {
        var timing = data[i][channels.inj_timing];
        if (isNaN(timing)) continue;
        // Only real injections: engine running and the injector firing (the angle holds its last value otherwise).
        if (channels.rpm !== -1 && !injRunning(data, channels, i)) continue;
        if (channels.inj_pw !== -1 && !(data[i][channels.inj_pw] > 0.05)) continue;

        timingValues.push(timing);

        if (timing >= THRESHOLDS.OPTIMAL_TIMING_START &&
            timing <= THRESHOLDS.OPTIMAL_TIMING_END) {
            inOptimal++;
        }
        if (timing < THRESHOLDS.COMPRESSION_STROKE) {
            inCompression++;
        }

        // Lean spike timing correlation
        if (lambdaCol !== -1) {
            var lambda = data[i][lambdaCol];
            if (lambda > THRESHOLDS.LEAN_SPIKE_LAMBDA) {
                leanTimings.push(timing);
            }
        }
    }

    if (timingValues.length === 0) return null;

    // Compute basic statistics
    var mean = computeMean(timingValues);
    var min = timingValues[0];
    var max = timingValues[0];
    for (var j = 1; j < timingValues.length; j++) {
        if (timingValues[j] < min) min = timingValues[j];
        if (timingValues[j] > max) max = timingValues[j];
    }

    // Compute percentages
    var inOptimalPct = (inOptimal / timingValues.length) * 100;
    var inCompressionPct = (inCompression / timingValues.length) * 100;

    // Compute lean spike timing stats
    var leanSpikeMeanTiming = null;
    var leanSpikeMedianTiming = null;
    if (leanTimings.length > 0) {
        leanSpikeMeanTiming = computeMean(leanTimings);
        leanTimings.sort(function (a, b) { return a - b; });
        leanSpikeMedianTiming = computeMedian(leanTimings);
    }

    // Generate diagnostics
    var diagnostics = [];
    if (inCompressionPct > 5) {
        diagnostics.push(
            'WARNING: ' + inCompressionPct.toFixed(1) +
            '% of injections occur during compression stroke (< 180 dBTDC) \u2014 consider advancing injection timing'
        );
    }
    if (leanSpikeMeanTiming !== null && leanSpikeMeanTiming < 240) {
        diagnostics.push(
            'Late injection timing during lean spikes (mean ' + leanSpikeMeanTiming.toFixed(1) +
            ' dBTDC) correlates with lean events \u2014 timing may be contributing to poor atomization'
        );
    }

    return {
        channelUsed: 'inj_timing',
        min: min,
        max: max,
        mean: mean,
        inOptimalCount: inOptimal,
        inOptimalPct: inOptimalPct,
        inCompressionCount: inCompression,
        inCompressionPct: inCompressionPct,
        leanSpikeMeanTiming: leanSpikeMeanTiming,
        leanSpikeMedianTiming: leanSpikeMedianTiming,
        diagnostics: diagnostics
    };
}

// ---------------------------------------------------------------------------
// Data Downsampling
// ---------------------------------------------------------------------------

/**
 * Uniformly downsamples parsed log data for chart rendering.
 *
 * Preconditions:
 *   - data is an array of numeric row arrays (may be empty)
 *   - channels is a resolved channels object from resolveInjectorChannels()
 *   - maxPoints is a positive integer (defaults to THRESHOLDS.MAX_CHART_POINTS)
 *
 * Postconditions:
 *   - Returns a ChartData object with uniformly downsampled arrays
 *   - No output array exceeds maxPoints elements
 *   - Fuel pressure values are converted from dMPa to bar (×100)
 *   - Channels with index -1 produce null arrays
 *
 * @param {number[][]} data - Array of numeric row arrays
 * @param {Object} channels - Resolved channel indices
 * @param {number} [maxPoints] - Maximum number of points (default: 150000)
 * @returns {Object} ChartData object
 */
function downsampleForCharts(data, channels, maxPoints) {
    if (maxPoints === undefined) {
        maxPoints = THRESHOLDS.MAX_CHART_POINTS;
    }

    var downsampleStep = Math.max(1, Math.floor(data.length / maxPoints));

    // Helper: extract every Nth sample for a given channel index
    function extractChannel(channelIdx) {
        if (channelIdx === -1) return null;
        var arr = [];
        for (var i = 0; i < data.length; i += downsampleStep) {
            arr.push(data[i][channelIdx]);
        }
        return arr;
    }

    // Helper: extract every Nth sample with dMPa-to-bar conversion (×100)
    function extractPressureChannel(channelIdx) {
        if (channelIdx === -1) return null;
        var arr = [];
        for (var i = 0; i < data.length; i += downsampleStep) {
            arr.push(data[i][channelIdx] * 100);
        }
        return arr;
    }

    return {
        time: extractChannel(channels.time) || [],
        lambdaB1: extractChannel(channels.lambda_b1),
        lambdaB2: extractChannel(channels.lambda_b2),
        injPW: extractChannel(channels.inj_pw),
        fuelPressDI: extractPressureChannel(channels.fuel_press_di),
        fuelPressDIAim: extractPressureChannel(channels.fuel_press_di_aim),
        rpm: extractChannel(channels.rpm) || [],
        injTiming: extractChannel(channels.inj_timing),
        downsampleStep: downsampleStep
    };
}

// ---------------------------------------------------------------------------
// Worker Message Handler
// ---------------------------------------------------------------------------

/**
 * Handles incoming messages from the main thread.
 * Accepts {type: 'analyze', logText} for CSV and {type: 'analyze_ld', buffer} for .ld files.
 */
self.onmessage = function (event) {
    var msgType = event.data.type;

    if (msgType === 'analyze_ld') {
        // --- .ld binary file parsing path ---
        try {
            var buffer = event.data.buffer;

            self.postMessage({ type: 'progress', rowsProcessed: 0, totalRows: 100 });

            // Parse the .ld binary file
            var ldResult = injParseLdFile(buffer, function (channelsProcessed, totalChannels) {
                var pct = Math.round((channelsProcessed / totalChannels) * 100);
                self.postMessage({ type: 'progress', rowsProcessed: pct, totalRows: 100 });
            });

            var columnNames = ldResult.columnNames;
            var data = ldResult.data;

            if (data.length === 0) {
                self.postMessage({ type: 'error', message: 'No data found in .ld file.' });
                return;
            }

            // Channel resolution (same as CSV path)
            var channels = resolveInjectorChannels(columnNames);

            // Post warnings for missing optional channels
            for (var w = 0; w < channels.warnings.length; w++) {
                self.postMessage({ type: 'warning', message: channels.warnings[w] });
            }

            // Run all analysis modules
            var leanSpikes = analyzeLeanSpikes(data, channels);
            var pwStability = analyzePWStability(data, channels);
            var fuelPressure = analyzeFuelPressure(data, channels);
            var injectionTiming = analyzeInjectionTiming(data, channels);
            var closedLoop = analyzeClosedLoop(data, channels);

            // Downsample for charts
            var chartData = downsampleForCharts(data, channels);

            // Build channel mapping
            var channelMapping = {};
            var channelKeys = Object.keys(CHANNEL_MAP);
            for (var k = 0; k < channelKeys.length; k++) {
                var key = channelKeys[k];
                channelMapping[key] = channels[key] !== -1;
            }

            // Post result
            var analyses = {
                leanSpikes: leanSpikes,
                pwStability: pwStability,
                fuelPressure: fuelPressure,
                injectionTiming: injectionTiming,
                closedLoop: closedLoop,
                channelWarnings: channels.warnings,
                channelMapping: channelMapping
            };

            self.postMessage({ type: 'result', analyses: analyses, chartData: chartData });

        } catch (err) {
            self.postMessage({ type: 'error', message: err.message });
        }
        return;
    }

    if (msgType !== 'analyze') return;

    // --- CSV parsing path (original) ---
    try {
        var logText = event.data.logText;
        const lines = logText.split(/\r?\n/);

        // Step 1: Detect header row
        const headerRowIdx = detectHeaderRow(lines);
        const columnNames = lines[headerRowIdx].split(',').map(function (s) {
            return s.trim().replace(/^"|"$/g, '');
        });
        const numCols = columnNames.length;

        // Step 2: Find data start
        const dataStart = findDataStart(lines, headerRowIdx);

        // Step 3: Parse data rows with progress reporting
        const data = parseDataRows(lines, dataStart, numCols, function (rowsProcessed, totalRows) {
            self.postMessage({ type: 'progress', rowsProcessed: rowsProcessed, totalRows: totalRows });
        });

        if (data.length === 0) {
            self.postMessage({ type: 'error', message: 'No data rows found after header.' });
            return;
        }

        // Step 4: Channel resolution
        const channels = resolveInjectorChannels(columnNames);

        // Post warnings for missing optional channels
        for (let w = 0; w < channels.warnings.length; w++) {
            self.postMessage({ type: 'warning', message: channels.warnings[w] });
        }

        // Step 5: Run all analysis modules in sequence
        const leanSpikes = analyzeLeanSpikes(data, channels);
        const pwStability = analyzePWStability(data, channels);
        const fuelPressure = analyzeFuelPressure(data, channels);
        const injectionTiming = analyzeInjectionTiming(data, channels);
        const closedLoop = analyzeClosedLoop(data, channels);

        // Step 6: Downsample data for chart rendering
        const chartData = downsampleForCharts(data, channels);

        // Step 7: Build channel mapping showing which channels were resolved
        const channelMapping = {};
        const channelKeys = Object.keys(CHANNEL_MAP);
        for (let k = 0; k < channelKeys.length; k++) {
            const key = channelKeys[k];
            channelMapping[key] = channels[key] !== -1;
        }

        // Step 8: Build final analyses object and post result
        const analyses = {
            leanSpikes: leanSpikes,
            pwStability: pwStability,
            fuelPressure: fuelPressure,
            injectionTiming: injectionTiming,
            closedLoop: closedLoop,
            channelWarnings: channels.warnings,
            channelMapping: channelMapping
        };

        self.postMessage({ type: 'result', analyses: analyses, chartData: chartData });

    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
