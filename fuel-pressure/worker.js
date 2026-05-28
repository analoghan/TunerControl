/**
 * worker.js — DI Fuel Pressure Deep Dive Analysis Worker.
 * Performs all heavy CSV/.ld parsing and fuel pressure analysis off the main thread.
 */

// ---------------------------------------------------------------------------
// MoTeC .ld Binary Parser
// ---------------------------------------------------------------------------

/**
 * Maps .ld dot-separated channel names to the CSV-style names used in CHANNEL_MAP.
 */
var LD_NAME_MAP = {
    'Fuel.Pressure.Direct.Bank 1': 'Fuel Pressure Direct Bank 1',
    'Fuel.Pressure.Direct.Bank 1.Aim': 'Fuel Pressure Direct Bank 1 Aim',
    'Fuel.Pressure.Direct.Bank 1.Control': 'Fuel Pressure Direct Bank 1 Control',
    'Engine.Speed': 'Engine Speed',
    'Fuel.Injector.Primary.Duty Cycle': 'Fuel Injector Primary Duty Cycle',
    'Fuel.Flow': 'Fuel Flow',
    'Fuel.Volume': 'Fuel Volume',
    'Throttle.Pedal': 'Throttle Pedal'
};

function normalizeLdChannelName(ldName) {
    if (LD_NAME_MAP[ldName]) {
        return LD_NAME_MAP[ldName];
    }
    return ldName.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeLdChannelNameWithUnit(ldName, unit) {
    if (LD_NAME_MAP[ldName]) {
        return LD_NAME_MAP[ldName];
    }
    return ldName.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

function readString(view, offset, length) {
    var bytes = [];
    for (var i = 0; i < length; i++) {
        var b = view.getUint8(offset + i);
        if (b === 0) break;
        bytes.push(b);
    }
    return String.fromCharCode.apply(null, bytes).trim();
}

function decodeFloat16(h) {
    var sign = (h >> 15) & 1;
    var exp = (h >> 10) & 0x1f;
    var frac = h & 0x3ff;
    if (exp === 0) {
        return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
    } else if (exp === 31) {
        return frac ? NaN : (sign ? -Infinity : Infinity);
    }
    return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

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

function parseLdFile(buffer, progressCallback) {
    var view = new DataView(buffer);
    var metaPtr = view.getUint32(8, true);
    var dataPtr = view.getUint32(12, true);
    var numChanns = view.getUint32(86, true);

    if (metaPtr === 0 || numChanns === 0) {
        throw new Error('Invalid .ld file: no channel metadata found');
    }

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
            name: name, shortName: shortName, unit: unit, freq: freq,
            dataPtr: chanDataPtr, nData: nData, dataType: dataType,
            bytesPerSample: bytesPerSample, shift: shift, mul: mul,
            scale: scale, dec: dec
        });
        ptr = nextPtr;
    }

    if (channels.length === 0) {
        throw new Error('No channels found in .ld file');
    }

    var maxFreq = 0;
    for (var i = 0; i < channels.length; i++) {
        if (channels[i].freq > maxFreq) maxFreq = channels[i].freq;
    }

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

    var columnNames = ['Time'];
    var channelData = [];

    var timeArr = new Float64Array(baseSamples);
    var dt = 1.0 / maxFreq;
    for (var t = 0; t < baseSamples; t++) {
        timeArr[t] = t * dt;
    }
    channelData.push(timeArr);

    for (var ci = 0; ci < channels.length; ci++) {
        var chan = channels[ci];
        var normalizedName = normalizeLdChannelNameWithUnit(chan.name, chan.shortName);
        columnNames.push(normalizedName);

        var rawData = readChannelData(buffer, chan);
        var transformed = new Float64Array(rawData.length);
        var decFactor = Math.pow(10, -chan.dec);
        for (var s = 0; s < rawData.length; s++) {
            transformed[s] = (rawData[s] / chan.scale * decFactor + chan.shift) * chan.mul;
        }

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

function detectHeaderRow(lines) {
    var MAX_SCAN = 25;
    for (var i = 0; i < Math.min(MAX_SCAN, lines.length); i++) {
        var firstField = lines[i].split(',')[0].trim().replace(/^"|"$/g, '');
        if (firstField === 'Time') {
            return i;
        }
    }
    throw new Error('Could not find "Time" header row in first 25 lines. Please ensure this is a MoTeC M1 CSV export.');
}

function findDataStart(lines, headerRowIdx) {
    for (var j = headerRowIdx + 1; j < Math.min(headerRowIdx + 6, lines.length); j++) {
        var firstField = lines[j].split(',')[0].trim().replace(/^"|"$/g, '');
        if (firstField !== '' && !isNaN(parseFloat(firstField))) {
            return j;
        }
    }
    return headerRowIdx + 2;
}

function parseDataRows(lines, dataStart, numCols, progressCallback) {
    var totalRows = lines.length - dataStart;
    var data = [];
    var lastProgress = 0;

    for (var i = dataStart; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;

        var fields = line.split(',');
        var row = new Array(numCols);
        for (var c = 0; c < numCols; c++) {
            if (c < fields.length) {
                row[c] = parseFloat(fields[c].trim().replace(/^"|"$/g, ''));
            } else {
                row[c] = NaN;
            }
        }
        data.push(row);

        var rowsProcessed = i - dataStart + 1;
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

var CHANNEL_MAP = {
    fuel_press:         ['Fuel Pressure Direct Bank 1', 'Fuel Pressure Direct'],
    fuel_press_aim:     ['Fuel Pressure Direct Bank 1 Aim', 'Fuel Pressure Direct Aim'],
    fuel_press_control: ['Fuel Pressure Direct Bank 1 Control', 'Fuel Pressure Direct Control', 'Fuel Pressure Direct Bank 1 Cont'],
    rpm:                ['Engine Speed'],
    inj_duty:           ['Fuel Injector Primary Duty Cycle'],
    fuel_flow:          ['Fuel Flow'],
    fuel_volume:        ['Fuel Volume'],
    throttle_pedal:     ['Throttle Pedal']
};

var REQUIRED_CHANNELS = ['fuel_press', 'fuel_press_aim', 'rpm'];
var OPTIONAL_WARN_CHANNELS = ['fuel_press_control', 'inj_duty', 'fuel_flow', 'fuel_volume', 'throttle_pedal'];

function resolveChannels(columnNames) {
    var nameToIdx = {};
    for (var i = 0; i < columnNames.length; i++) {
        var normalized = columnNames[i].trim().toLowerCase();
        if (!(normalized in nameToIdx)) {
            nameToIdx[normalized] = i;
        }
    }

    var find = function(candidates) {
        for (var c = 0; c < candidates.length; c++) {
            var idx = nameToIdx[candidates[c].toLowerCase()];
            if (idx !== undefined) return idx;
        }
        return -1;
    };

    var resolved = {};
    var keys = Object.keys(CHANNEL_MAP);
    for (var k = 0; k < keys.length; k++) {
        resolved[keys[k]] = find(CHANNEL_MAP[keys[k]]);
    }

    var warnings = [];
    for (var r = 0; r < REQUIRED_CHANNELS.length; r++) {
        var key = REQUIRED_CHANNELS[r];
        if (resolved[key] === -1) {
            warnings.push('REQUIRED channel missing: ' + CHANNEL_MAP[key][0]);
        }
    }
    for (var o = 0; o < OPTIONAL_WARN_CHANNELS.length; o++) {
        var key = OPTIONAL_WARN_CHANNELS[o];
        if (resolved[key] === -1) {
            warnings.push('Optional channel not found: ' + CHANNEL_MAP[key][0]);
        }
    }

    return { resolved: resolved, warnings: warnings };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var TOLERANCE_BAR = 2;          // ±2 bar tolerance band
var TRANSIENT_THRESHOLD = 20;   // bar change to trigger transient detection
var TRANSIENT_WINDOW = 0.5;     // seconds window for aim change detection
var MAX_CHART_POINTS = 5000;

// ---------------------------------------------------------------------------
// Downsampling
// ---------------------------------------------------------------------------

function downsampleArray(arr, maxPoints) {
    if (arr.length <= maxPoints) return arr.slice();
    var step = arr.length / maxPoints;
    var result = new Array(maxPoints);
    for (var i = 0; i < maxPoints; i++) {
        result[i] = arr[Math.floor(i * step)];
    }
    return result;
}

function downsampleParallel(arrays, maxPoints) {
    var len = arrays[0].length;
    if (len <= maxPoints) {
        return arrays.map(function(a) { return a.slice(); });
    }
    var step = len / maxPoints;
    var results = arrays.map(function() { return new Array(maxPoints); });
    for (var i = 0; i < maxPoints; i++) {
        var idx = Math.floor(i * step);
        for (var a = 0; a < arrays.length; a++) {
            results[a][i] = arrays[a][idx];
        }
    }
    return results;
}

function downsampleScatter(points, maxPoints) {
    if (points.length <= maxPoints) return points.slice();
    var step = points.length / maxPoints;
    var result = new Array(maxPoints);
    for (var i = 0; i < maxPoints; i++) {
        result[i] = points[Math.floor(i * step)];
    }
    return result;
}

// ---------------------------------------------------------------------------
// Error Statistics
// ---------------------------------------------------------------------------

function computeErrorStats(errorArr, pressArr, aimArr, rpmArr, data, channels, sampleRate) {
    var n = errorArr.length;
    if (n === 0) {
        return {
            meanError: 0, meanAbsError: 0, maxOvershoot: 0, maxUndershoot: 0,
            stdDevError: 0, pctWithinTolerance: 0, pctOvershoot: 0, pctUndershoot: 0,
            worstOvershootRpm: 0, worstUndershootRpm: 0
        };
    }

    var sumError = 0;
    var sumAbsError = 0;
    var maxOvershoot = 0;
    var maxUndershoot = 0;
    var worstOvershootRpm = 0;
    var worstUndershootRpm = 0;
    var withinCount = 0;
    var overshootCount = 0;
    var undershootCount = 0;

    for (var i = 0; i < n; i++) {
        var e = errorArr[i];
        if (isNaN(e)) continue;
        sumError += e;
        sumAbsError += Math.abs(e);

        if (e > maxOvershoot) {
            maxOvershoot = e;
            worstOvershootRpm = rpmArr[i];
        }
        if (e < maxUndershoot) {
            maxUndershoot = e;
            worstUndershootRpm = rpmArr[i];
        }

        if (Math.abs(e) <= TOLERANCE_BAR) {
            withinCount++;
        } else if (e > TOLERANCE_BAR) {
            overshootCount++;
        } else {
            undershootCount++;
        }
    }

    var meanError = sumError / n;
    var meanAbsError = sumAbsError / n;

    // Standard deviation
    var sumSqDiff = 0;
    for (var i = 0; i < n; i++) {
        if (isNaN(errorArr[i])) continue;
        var diff = errorArr[i] - meanError;
        sumSqDiff += diff * diff;
    }
    var stdDevError = Math.sqrt(sumSqDiff / n);

    return {
        meanError: meanError,
        meanAbsError: meanAbsError,
        maxOvershoot: maxOvershoot,
        maxUndershoot: maxUndershoot,
        stdDevError: stdDevError,
        pctWithinTolerance: (withinCount / n) * 100,
        pctOvershoot: (overshootCount / n) * 100,
        pctUndershoot: (undershootCount / n) * 100,
        worstOvershootRpm: worstOvershootRpm,
        worstUndershootRpm: worstUndershootRpm
    };
}

// ---------------------------------------------------------------------------
// Transient Event Detection
// ---------------------------------------------------------------------------

function detectTransientEvents(data, channels, sampleRate) {
    var pressIdx = channels.fuel_press;
    var aimIdx = channels.fuel_press_aim;
    var rpmIdx = channels.rpm;
    var n = data.length;
    var events = [];

    var windowSamples = Math.round(TRANSIENT_WINDOW * sampleRate);
    if (windowSamples < 1) windowSamples = 1;

    var i = 0;
    while (i < n - windowSamples) {
        var aimStart = data[i][aimIdx];
        var aimEnd = data[i + windowSamples][aimIdx];

        if (isNaN(aimStart) || isNaN(aimEnd)) {
            i++;
            continue;
        }

        var aimChange = aimEnd - aimStart;
        if (Math.abs(aimChange) < TRANSIENT_THRESHOLD) {
            i++;
            continue;
        }

        // Found a transient — track until settled
        var direction = aimChange > 0 ? 'up' : 'down';
        var startTime = data[i][0];
        var newAim = aimEnd;
        var maxError = 0;
        var settled = false;
        var settleTime = 0;
        var endIdx = i + windowSamples;

        // Search forward for settle (within ±2 bar of new aim)
        for (var j = i + windowSamples; j < n; j++) {
            var press = data[j][pressIdx];
            var aim = data[j][aimIdx];
            if (isNaN(press) || isNaN(aim)) continue;

            var err = press - aim;
            if (Math.abs(err) > Math.abs(maxError)) {
                maxError = err;
            }

            if (Math.abs(press - newAim) <= TOLERANCE_BAR) {
                settled = true;
                settleTime = data[j][0] - data[i + windowSamples][0];
                endIdx = j;
                break;
            }

            // Timeout: if more than 5 seconds, give up
            if (data[j][0] - startTime > 5.0) {
                settleTime = data[j][0] - data[i + windowSamples][0];
                endIdx = j;
                break;
            }
        }

        events.push({
            startTime: startTime,
            endTime: data[endIdx][0],
            aimChange: Math.abs(aimChange),
            maxError: maxError,
            settleTime: settleTime,
            direction: direction
        });

        // Skip past this event
        i = endIdx + 1;
        continue;
    }

    return events;
}

// ---------------------------------------------------------------------------
// Build Transient Overlay Chart Data
// ---------------------------------------------------------------------------

function buildTransientOverlayData(data, channels, sampleRate, transientEvents) {
    var pressIdx = channels.fuel_press;
    var aimIdx = channels.fuel_press_aim;
    var overlayTraces = [];

    for (var e = 0; e < transientEvents.length; e++) {
        var evt = transientEvents[e];
        // Find the sample index where the aim change completes (t=0 for overlay)
        var t0Idx = -1;
        for (var i = 0; i < data.length; i++) {
            if (data[i][0] >= evt.startTime + TRANSIENT_WINDOW) {
                t0Idx = i;
                break;
            }
        }
        if (t0Idx === -1) continue;

        // Collect 1 second before and up to 3 seconds after t=0
        var preSamples = Math.round(1.0 * sampleRate);
        var postSamples = Math.round(3.0 * sampleRate);
        var startIdx = Math.max(0, t0Idx - preSamples);
        var endIdx = Math.min(data.length - 1, t0Idx + postSamples);

        var trace = { time: [], error: [], direction: evt.direction };
        var t0Time = data[t0Idx][0];

        var step = Math.max(1, Math.floor((endIdx - startIdx) / 200));
        for (var i = startIdx; i <= endIdx; i += step) {
            var press = data[i][pressIdx];
            var aim = data[i][aimIdx];
            if (isNaN(press) || isNaN(aim)) continue;
            trace.time.push(data[i][0] - t0Time);
            trace.error.push(press - aim);
        }
        overlayTraces.push(trace);
    }

    return overlayTraces;
}

// ---------------------------------------------------------------------------
// Error Histogram
// ---------------------------------------------------------------------------

function buildErrorHistogram(errorArr) {
    // Determine range
    var min = Infinity;
    var max = -Infinity;
    var validCount = 0;
    for (var i = 0; i < errorArr.length; i++) {
        if (isNaN(errorArr[i])) continue;
        if (errorArr[i] < min) min = errorArr[i];
        if (errorArr[i] > max) max = errorArr[i];
        validCount++;
    }

    if (validCount === 0) {
        return { bins: [], counts: [], binWidth: 1 };
    }

    // Use 0.5 bar bin width
    var binWidth = 0.5;
    var binMin = Math.floor(min / binWidth) * binWidth;
    var binMax = Math.ceil(max / binWidth) * binWidth;
    var numBins = Math.round((binMax - binMin) / binWidth);
    if (numBins < 1) numBins = 1;
    if (numBins > 200) {
        binWidth = (binMax - binMin) / 100;
        numBins = 100;
    }

    var bins = new Array(numBins);
    var counts = new Array(numBins);
    for (var b = 0; b < numBins; b++) {
        bins[b] = binMin + (b + 0.5) * binWidth;
        counts[b] = 0;
    }

    for (var i = 0; i < errorArr.length; i++) {
        if (isNaN(errorArr[i])) continue;
        var idx = Math.floor((errorArr[i] - binMin) / binWidth);
        if (idx < 0) idx = 0;
        if (idx >= numBins) idx = numBins - 1;
        counts[idx]++;
    }

    return { bins: bins, counts: counts, binWidth: binWidth };
}

// ---------------------------------------------------------------------------
// Diagnostics Generation
// ---------------------------------------------------------------------------

function generateDiagnostics(stats, transientEvents, errorArr, rpmArr, dutyArr) {
    var diagnostics = [];

    // Tolerance tracking
    if (stats.pctWithinTolerance > 95) {
        diagnostics.push('Pressure tracks aim well: ' + stats.pctWithinTolerance.toFixed(1) + '% of samples within \u00B12 bar tolerance');
    }

    // Undershoot
    if (stats.pctUndershoot > 10) {
        diagnostics.push('Significant undershoot detected: ' + stats.pctUndershoot.toFixed(1) + '% of samples below aim by more than 2 bar');
    }

    // Overshoot
    if (stats.pctOvershoot > 10) {
        diagnostics.push('Significant overshoot detected: ' + stats.pctOvershoot.toFixed(1) + '% of samples above aim by more than 2 bar');
    }

    // Worst undershoot
    if (stats.maxUndershoot < -TOLERANCE_BAR) {
        diagnostics.push('Worst undershoot: ' + stats.maxUndershoot.toFixed(1) + ' bar at ' + Math.round(stats.worstUndershootRpm) + ' RPM');
    }

    // Worst overshoot
    if (stats.maxOvershoot > TOLERANCE_BAR) {
        diagnostics.push('Worst overshoot: ' + stats.maxOvershoot.toFixed(1) + ' bar at ' + Math.round(stats.worstOvershootRpm) + ' RPM');
    }

    // Transient events
    if (transientEvents.length > 0) {
        var totalSettle = 0;
        for (var i = 0; i < transientEvents.length; i++) {
            totalSettle += transientEvents[i].settleTime;
        }
        var avgSettle = totalSettle / transientEvents.length;
        diagnostics.push(transientEvents.length + ' transient events detected, average settle time: ' + avgSettle.toFixed(2) + 's');
    }

    // High duty cycle correlation
    if (dutyArr) {
        var highDutyErrors = [];
        var lowDutyErrors = [];
        for (var i = 0; i < errorArr.length; i++) {
            if (isNaN(errorArr[i]) || isNaN(dutyArr[i])) continue;
            if (dutyArr[i] > 70) {
                highDutyErrors.push(errorArr[i]);
            } else if (dutyArr[i] < 40) {
                lowDutyErrors.push(errorArr[i]);
            }
        }
        if (highDutyErrors.length > 10 && lowDutyErrors.length > 10) {
            var highMean = 0;
            for (var i = 0; i < highDutyErrors.length; i++) highMean += highDutyErrors[i];
            highMean /= highDutyErrors.length;
            var lowMean = 0;
            for (var i = 0; i < lowDutyErrors.length; i++) lowMean += lowDutyErrors[i];
            lowMean /= lowDutyErrors.length;

            if (highMean < lowMean - 2) {
                diagnostics.push('High duty cycle correlation: undershoot increases above 70% duty');
            }
        }
    }

    return diagnostics;
}

// ---------------------------------------------------------------------------
// Main Analysis Pipeline
// ---------------------------------------------------------------------------

function runAnalysis(columnNames, data, sampleRate) {
    // Step 1: Resolve channels
    self.postMessage({ type: 'progress', phase: 'Resolving channels...', percent: 10 });
    var resolution = resolveChannels(columnNames);
    var channels = resolution.resolved;
    var warnings = resolution.warnings;

    // Check required channels
    var missingRequired = false;
    for (var r = 0; r < REQUIRED_CHANNELS.length; r++) {
        if (channels[REQUIRED_CHANNELS[r]] === -1) {
            missingRequired = true;
        }
    }
    if (missingRequired) {
        self.postMessage({
            type: 'error',
            message: 'Required channels missing (fuel_press, fuel_press_aim, rpm). Cannot perform fuel pressure analysis.'
        });
        return;
    }

    // Post warnings for missing optional channels
    for (var w = 0; w < warnings.length; w++) {
        self.postMessage({ type: 'warning', message: warnings[w] });
    }

    // Step 2: Extract arrays
    self.postMessage({ type: 'progress', phase: 'Extracting channel data...', percent: 20 });
    var n = data.length;
    var pressIdx = channels.fuel_press;
    var aimIdx = channels.fuel_press_aim;
    var rpmIdx = channels.rpm;
    var controlIdx = channels.fuel_press_control;
    var dutyIdx = channels.inj_duty;
    var flowIdx = channels.fuel_flow;

    var timeArr = new Array(n);
    var pressArr = new Array(n);
    var aimArr = new Array(n);
    var errorArr = new Array(n);
    var rpmArr = new Array(n);
    var controlArr = controlIdx !== -1 ? new Array(n) : null;
    var dutyArr = dutyIdx !== -1 ? new Array(n) : null;
    var flowArr = flowIdx !== -1 ? new Array(n) : null;

    for (var i = 0; i < n; i++) {
        timeArr[i] = data[i][0];
        pressArr[i] = data[i][pressIdx];
        aimArr[i] = data[i][aimIdx];
        rpmArr[i] = data[i][rpmIdx];
        errorArr[i] = pressArr[i] - aimArr[i];
        if (controlArr) controlArr[i] = data[i][controlIdx];
        if (dutyArr) dutyArr[i] = data[i][dutyIdx];
        if (flowArr) flowArr[i] = data[i][flowIdx];
    }

    // Step 3: Compute error statistics
    self.postMessage({ type: 'progress', phase: 'Computing error statistics...', percent: 40 });
    var stats = computeErrorStats(errorArr, pressArr, aimArr, rpmArr, data, channels, sampleRate);

    // Step 4: Detect transient events
    self.postMessage({ type: 'progress', phase: 'Detecting transient events...', percent: 55 });
    var transientEvents = detectTransientEvents(data, channels, sampleRate);

    // Step 5: Build scatter data
    self.postMessage({ type: 'progress', phase: 'Building correlation data...', percent: 65 });
    var errorVsRpm = [];
    var errorVsDuty = dutyArr ? [] : null;
    var errorVsFlow = flowArr ? [] : null;

    for (var i = 0; i < n; i++) {
        if (isNaN(errorArr[i]) || isNaN(rpmArr[i])) continue;
        errorVsRpm.push({ x: rpmArr[i], y: errorArr[i] });
        if (errorVsDuty && !isNaN(dutyArr[i])) {
            errorVsDuty.push({ x: dutyArr[i], y: errorArr[i] });
        }
        if (errorVsFlow && !isNaN(flowArr[i])) {
            errorVsFlow.push({ x: flowArr[i], y: errorArr[i] });
        }
    }

    // Downsample scatter data
    errorVsRpm = downsampleScatter(errorVsRpm, MAX_CHART_POINTS);
    if (errorVsDuty) errorVsDuty = downsampleScatter(errorVsDuty, MAX_CHART_POINTS);
    if (errorVsFlow) errorVsFlow = downsampleScatter(errorVsFlow, MAX_CHART_POINTS);

    // Step 6: Build histogram
    self.postMessage({ type: 'progress', phase: 'Building error histogram...', percent: 75 });
    var errorHistogram = buildErrorHistogram(errorArr);

    // Step 7: Generate diagnostics
    self.postMessage({ type: 'progress', phase: 'Generating diagnostics...', percent: 85 });
    var diagnostics = generateDiagnostics(stats, transientEvents, errorArr, rpmArr, dutyArr);

    // Step 8: Build chart data (downsampled time series)
    self.postMessage({ type: 'progress', phase: 'Building chart data...', percent: 90 });
    var dsArrays = downsampleParallel([timeArr, pressArr, aimArr, errorArr], MAX_CHART_POINTS);
    var dsControl = controlArr ? downsampleArray(controlArr, MAX_CHART_POINTS) : null;

    // Build transient overlay traces
    var transientOverlay = buildTransientOverlayData(data, channels, sampleRate, transientEvents);

    // Build channel mapping for UI
    var channelMapping = {};
    var keys = Object.keys(CHANNEL_MAP);
    for (var k = 0; k < keys.length; k++) {
        channelMapping[keys[k]] = channels[keys[k]] !== -1;
    }

    // Step 8b: Compute pressure vs PW impact analysis
    // Using Bernoulli's principle: flow ∝ √pressure, so PW ∝ 1/√pressure
    // If pressure drops from aim to actual, PW would need to increase by factor √(aim/actual)
    var pressurePwImpact = null;
    if (dutyArr) {
        // Find operating points where pressure is significantly below aim
        var impactPoints = [];
        for (var i = 0; i < n; i++) {
            if (isNaN(pressArr[i]) || isNaN(aimArr[i]) || pressArr[i] <= 0 || aimArr[i] <= 0) continue;
            var error = pressArr[i] - aimArr[i];
            if (error < -0.05) { // pressure below aim by >5 bar (in dMPa, so 0.05)
                // PW multiplier needed: √(aim/actual)
                var pwMultiplier = Math.sqrt(aimArr[i] / pressArr[i]);
                impactPoints.push({
                    rpm: rpmArr[i],
                    pressBar: Math.round(pressArr[i] * 1000) / 10,
                    aimBar: Math.round(aimArr[i] * 1000) / 10,
                    pwIncreasePct: Math.round((pwMultiplier - 1) * 1000) / 10
                });
            }
        }

        if (impactPoints.length > 100) {
            // Summarize by RPM bins
            var rpmBins = {};
            for (var i = 0; i < impactPoints.length; i++) {
                var bin = Math.round(impactPoints[i].rpm / 500) * 500;
                if (!rpmBins[bin]) rpmBins[bin] = { count: 0, pwIncSum: 0, maxPwInc: 0 };
                rpmBins[bin].count++;
                rpmBins[bin].pwIncSum += impactPoints[i].pwIncreasePct;
                if (impactPoints[i].pwIncreasePct > rpmBins[bin].maxPwInc) {
                    rpmBins[bin].maxPwInc = impactPoints[i].pwIncreasePct;
                }
            }
            var summary = [];
            var binKeys = Object.keys(rpmBins).sort(function(a,b) { return a - b; });
            for (var b = 0; b < binKeys.length; b++) {
                var bin = rpmBins[binKeys[b]];
                summary.push({
                    rpm: parseInt(binKeys[b]),
                    samples: bin.count,
                    avgPwIncrease: Math.round(bin.pwIncSum / bin.count * 10) / 10,
                    maxPwIncrease: Math.round(bin.maxPwInc * 10) / 10
                });
            }
            pressurePwImpact = { totalUndershootSamples: impactPoints.length, byRpm: summary };
        }
    }

    // Step 9: Post result
    self.postMessage({ type: 'progress', phase: 'Complete', percent: 100 });
    self.postMessage({
        type: 'result',
        analysis: {
            channelMapping: channelMapping,
            channelWarnings: resolution.warnings,
            totalSamples: n,
            meanError: stats.meanError,
            meanAbsError: stats.meanAbsError,
            maxOvershoot: stats.maxOvershoot,
            maxUndershoot: stats.maxUndershoot,
            stdDevError: stats.stdDevError,
            pctWithinTolerance: stats.pctWithinTolerance,
            pctOvershoot: stats.pctOvershoot,
            pctUndershoot: stats.pctUndershoot,
            transientEvents: transientEvents,
            errorByRpm: downsampleScatter(errorVsRpm, 500),
            errorByDuty: errorVsDuty ? downsampleScatter(errorVsDuty, 500) : null,
            errorByFlow: errorVsFlow ? downsampleScatter(errorVsFlow, 500) : null,
            pressurePwImpact: pressurePwImpact,
            diagnostics: diagnostics
        },
        chartData: {
            time: dsArrays[0],
            pressure: dsArrays[1],
            aim: dsArrays[2],
            error: dsArrays[3],
            control: dsControl,
            errorVsRpm: errorVsRpm,
            errorVsDuty: errorVsDuty,
            errorVsFlow: errorVsFlow,
            errorHistogram: errorHistogram,
            transientEvents: transientOverlay
        }
    });
}

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

self.onmessage = function(event) {
    var msg = event.data;
    if (!msg) return;

    try {
        if (msg.type === 'analyze') {
            // CSV text input
            self.postMessage({ type: 'progress', phase: 'Parsing CSV...', percent: 5 });

            var lines = msg.logText.split(/\r?\n/);
            var headerRowIdx = detectHeaderRow(lines);
            var headerLine = lines[headerRowIdx];
            var columnNames = headerLine.split(',').map(function(s) {
                return s.trim().replace(/^"|"$/g, '');
            });

            var dataStart = findDataStart(lines, headerRowIdx);
            var numCols = columnNames.length;

            var data = parseDataRows(lines, dataStart, numCols, function(processed, total) {
                var pct = 5 + Math.round((processed / total) * 10);
                self.postMessage({ type: 'progress', phase: 'Parsing rows...', percent: pct });
            });

            if (data.length < 2) {
                self.postMessage({ type: 'error', message: 'Not enough data rows to analyze.' });
                return;
            }

            // Determine sample rate from time column
            var sampleRate = 1.0;
            if (data.length > 1) {
                var dt = data[1][0] - data[0][0];
                if (dt > 0) sampleRate = 1.0 / dt;
            }

            runAnalysis(columnNames, data, sampleRate);

        } else if (msg.type === 'analyze_ld') {
            // Binary .ld input
            self.postMessage({ type: 'progress', phase: 'Parsing .ld file...', percent: 5 });

            var result = parseLdFile(msg.buffer, function(processed, total) {
                var pct = 5 + Math.round((processed / total) * 10);
                self.postMessage({ type: 'progress', phase: 'Reading channels...', percent: pct });
            });

            var sampleRate = result.maxFreq || 1;
            runAnalysis(result.columnNames, result.data, sampleRate);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error during analysis.' });
    }
};
