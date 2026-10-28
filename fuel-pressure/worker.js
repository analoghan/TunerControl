/**
 * worker.js — DI Fuel Pressure Deep Dive Analysis Worker.
 * Performs all heavy CSV/.ld parsing and fuel pressure analysis off the main thread.
 */

// MoTeC .ld logs are read by parseLdFile in lib/ld-parser.js, which the page loads before this worker.

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
    map:                ['Inlet Manifold Pressure'],
    inj_duty:           ['Fuel Injector Primary Duty Cycle'],
    fuel_flow:          ['Fuel Flow'],
    fuel_volume:        ['Fuel Volume Primary', 'Fuel Volume'],
    throttle_pedal:     ['Throttle Pedal'],
    low_press:          ['Fuel Pressure', 'Fuel Pressure Sensor'],   // low-side (lift pump) pressure, exact names only
    pump2:              ['Fuel Pump 2 State']
};

var REQUIRED_CHANNELS = ['fuel_press', 'fuel_press_aim', 'rpm'];
var OPTIONAL_WARN_CHANNELS = ['fuel_press_control', 'inj_duty', 'map'];

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
var MIN_RUNNING_RPM = 400;      // below this the engine is cranking or stopped
var PUMP_LIMIT_FRACTION = 0.9;
var GRID_MIN_SECONDS = 1;       // a tracking cell needs this much running data to be shown  // pump control at ≥ 90 % of its highest value in the log counts as "at its limit"

/**
 * Factor that converts a pressure channel to bar, from its unit. M1 logs rail pressure in MPa ("MPa", or "dMPa" —
 * the d marks a differential pressure, not a ×10 prefix). Without a recognised unit the size of the values decides:
 * a rail aim under 40 is MPa, over 1000 is kPa.
 * @returns {{ factor: number, unit: string, guessed: boolean }}
 */
function pressureToBar(unit, sampleValues) {
    var u = String(unit || '').trim().replace(/^d(?=[a-zA-Z])/, '').toLowerCase();
    if (u === 'mpa') return { factor: 10, unit: 'MPa', guessed: false };
    if (u === 'kpa' || u === 'kpa g' || u === 'kpa a') return { factor: 0.01, unit: 'kPa', guessed: false };
    if (u === 'bar') return { factor: 1, unit: 'bar', guessed: false };
    if (u === 'psi' || u === 'psig') return { factor: 0.0689476, unit: 'psi', guessed: false };
    if (u === 'pa') return { factor: 1e-5, unit: 'Pa', guessed: false };
    var vals = (sampleValues || []).filter(function (v) { return v > 0 && isFinite(v); }).sort(function (a, b) { return a - b; });
    var p95 = vals.length ? vals[Math.floor(vals.length * 0.95)] : 0;
    if (p95 > 0 && p95 < 40) return { factor: 10, unit: 'MPa', guessed: true };
    if (p95 > 1000) return { factor: 0.01, unit: 'kPa', guessed: true };
    return { factor: 1, unit: 'bar', guessed: true };
}

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

    var valid = 0;
    for (var i = 0; i < n; i++) {
        var e = errorArr[i];
        if (isNaN(e)) continue;
        valid++;
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

    if (valid === 0) {
        return {
            meanError: 0, meanAbsError: 0, maxOvershoot: 0, maxUndershoot: 0,
            stdDevError: 0, pctWithinTolerance: 0, pctOvershoot: 0, pctUndershoot: 0,
            worstOvershootRpm: 0, worstUndershootRpm: 0, validSamples: 0
        };
    }
    var meanError = sumError / valid;
    var meanAbsError = sumAbsError / valid;

    // Standard deviation
    var sumSqDiff = 0;
    for (var i = 0; i < n; i++) {
        if (isNaN(errorArr[i])) continue;
        var diff = errorArr[i] - meanError;
        sumSqDiff += diff * diff;
    }
    var stdDevError = Math.sqrt(sumSqDiff / valid);
    n = valid;

    return {
        validSamples: valid,
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

/**
 * Aim steps: the aim changes by TRANSIENT_THRESHOLD bar or more within TRANSIENT_WINDOW; then follows the
 * pressure until it is within TOLERANCE_BAR of the new aim (or 5 s pass). Arrays are in bar; samples where the
 * engine is not running (NaN error) are skipped.
 */
function detectTransientEvents(timeArr, pressArr, aimArr, errorArr, sampleRate) {
    var n = timeArr.length, events = [];
    var windowSamples = Math.max(1, Math.round(TRANSIENT_WINDOW * sampleRate));
    var i = 0;
    while (i < n - windowSamples) {
        var aimStart = aimArr[i], aimEnd = aimArr[i + windowSamples];
        if (isNaN(errorArr[i]) || isNaN(errorArr[i + windowSamples]) || Math.abs(aimEnd - aimStart) < TRANSIENT_THRESHOLD) { i++; continue; }

        var aimChange = aimEnd - aimStart, startTime = timeArr[i], maxError = 0, settled = false, settleTime = 0;
        var endIdx = i + windowSamples;
        for (var j = i + windowSamples; j < n; j++) {
            if (isNaN(errorArr[j])) continue;
            if (Math.abs(errorArr[j]) > Math.abs(maxError)) maxError = errorArr[j];
            if (Math.abs(pressArr[j] - aimArr[j]) <= TOLERANCE_BAR) {
                settled = true;
                settleTime = timeArr[j] - timeArr[i + windowSamples];
                endIdx = j;
                break;
            }
            if (timeArr[j] - startTime > 5.0) {
                settleTime = timeArr[j] - timeArr[i + windowSamples];
                endIdx = j;
                break;
            }
        }
        events.push({ startTime: startTime, endTime: timeArr[endIdx], aimChange: Math.abs(aimChange), aimFrom: aimStart, aimTo: aimEnd,
                      maxError: maxError, settleTime: Math.max(0, settleTime), settled: settled, direction: aimChange > 0 ? 'up' : 'down' });
        i = endIdx + 1;
    }
    return events;
}

// ---------------------------------------------------------------------------
// Build Transient Overlay Chart Data
// ---------------------------------------------------------------------------

function buildTransientOverlayData(timeArr, errorArr, sampleRate, transientEvents) {
    var overlayTraces = [];

    for (var e = 0; e < transientEvents.length; e++) {
        var evt = transientEvents[e];
        // Find the sample index where the aim change completes (t=0 for overlay)
        var t0Idx = -1;
        for (var i = 0; i < timeArr.length; i++) {
            if (timeArr[i] >= evt.startTime + TRANSIENT_WINDOW) {
                t0Idx = i;
                break;
            }
        }
        if (t0Idx === -1) continue;

        // Collect 1 second before and up to 3 seconds after t=0
        var preSamples = Math.round(1.0 * sampleRate);
        var postSamples = Math.round(3.0 * sampleRate);
        var startIdx = Math.max(0, t0Idx - preSamples);
        var endIdx = Math.min(timeArr.length - 1, t0Idx + postSamples);

        var trace = { time: [], error: [], direction: evt.direction };
        var t0Time = timeArr[t0Idx];

        var step = Math.max(1, Math.floor((endIdx - startIdx) / 200));
        for (var i = startIdx; i <= endIdx; i += step) {
            if (isNaN(errorArr[i])) continue;
            trace.time.push(timeArr[i] - t0Time);
            trace.error.push(errorArr[i]);
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

/**
 * Rail pressure tracking by engine speed (500 rpm) × MAP (20 kPa): mean error, share within tolerance, samples.
 * Only cells with at least GRID_MIN_SECONDS of running data are reported (rail pressure is often logged at 10 Hz,
 * so a handful of base-rate samples is only one or two real readings).
 */
function buildErrorGrid(errorArr, rpmArr, mapArr, sampleRate) {
    if (!mapArr) return null;
    var minSamples = Math.max(20, Math.round((sampleRate || 100) * GRID_MIN_SECONDS));
    var cells = {};
    for (var i = 0; i < errorArr.length; i++) {
        var e = errorArr[i];
        if (isNaN(e) || isNaN(rpmArr[i]) || isNaN(mapArr[i])) continue;
        var key = Math.floor(rpmArr[i] / 500) + ',' + Math.floor(mapArr[i] / 20);
        var c = cells[key] || (cells[key] = { n: 0, sum: 0, within: 0, min: 0 });
        c.n++; c.sum += e;
        if (Math.abs(e) <= TOLERANCE_BAR) c.within++;
        if (e < c.min) c.min = e;
    }
    var rpmBins = {}, mapBins = {}, out = {};
    Object.keys(cells).forEach(function (k) {
        var c = cells[k];
        if (c.n < minSamples) return;
        var r = +k.split(',')[0], m = +k.split(',')[1];
        rpmBins[r] = 1; mapBins[m] = 1;
        out[k] = { samples: c.n, seconds: Math.round(c.n / (sampleRate || 100) * 10) / 10, meanError: Math.round(c.sum / c.n * 100) / 100, pctWithin: Math.round(c.within / c.n * 1000) / 10,
                   worstUnder: Math.round(c.min * 10) / 10 };
    });
    var rpms = Object.keys(rpmBins).map(Number).sort(function (x, y) { return x - y; });
    var maps = Object.keys(mapBins).map(Number).sort(function (x, y) { return x - y; });
    if (!rpms.length) return null;
    return {
        rpmLabels: rpms.map(function (r) { return (r * 500) + '–' + ((r + 1) * 500); }),
        mapLabels: maps.map(function (m) { return (m * 20) + '–' + ((m + 1) * 20); }),
        cells: maps.map(function (m) { return rpms.map(function (r) { return out[r + ',' + m] || null; }); })
    };
}

/**
 * Is the pump at its limit when pressure falls short? Uses the pump control output (% of its range): the highest
 * value in the log is taken as the limit, and samples at ≥ PUMP_LIMIT_FRACTION of it count as "at the limit".
 */
function analyzePumpLimit(controlArr, errorArr) {
    if (!controlArr) return null;
    var max = -Infinity, running = 0;
    for (var i = 0; i < controlArr.length; i++) {
        if (isNaN(errorArr[i]) || isNaN(controlArr[i])) continue;
        running++;
        if (controlArr[i] > max) max = controlArr[i];
    }
    if (!running || !(max > 0)) return null;
    var limit = max * PUMP_LIMIT_FRACTION, atLimit = 0, under = 0, underAtLimit = 0;
    for (i = 0; i < controlArr.length; i++) {
        if (isNaN(errorArr[i]) || isNaN(controlArr[i])) continue;
        var high = controlArr[i] >= limit;
        if (high) atLimit++;
        if (errorArr[i] < -TOLERANCE_BAR) { under++; if (high) underAtLimit++; }
    }
    return { maxControl: Math.round(max * 10) / 10, pctAtLimit: Math.round(atLimit / running * 1000) / 10,
             undershootSamples: under, pctUndershootAtLimit: under ? Math.round(underAtLimit / under * 1000) / 10 : 0,
             likelyLimited: under >= Math.max(20, running * 0.01) && underAtLimit / under >= 0.5 };
}

// ---------------------------------------------------------------------------
// Rail pressure control advice (needs the tune's aim table and gains)
// ---------------------------------------------------------------------------

/** Aim slope (bar/s) above which the aim counts as rising or falling. */
var RAIL_SLOPE_BAR_S = 10;
/** Pump control at or below this (%) means the pump is delivering (almost) nothing. */
var RAIL_PUMP_OFF_PCT = 1;
/** A class of error needs this many separate episodes, and this much time, before gains are suggested. */
var RAIL_MIN_EPISODES = 3, RAIL_MIN_SECONDS = 1;
/** Neighbouring aim cells differing by more than this (bar) are a steep step. */
var RAIL_STEEP_BAR = 40;
/** For control advice an error counts when it is beyond the larger of TOLERANCE_BAR and this share of the aim … */
var RAIL_BAND_PCT = 5;
/** … for at least this long (s): shorter excursions are pump-stroke ripple or one stray 10 Hz reading. */
var RAIL_MIN_EPISODE_S = 0.3;
/** … and a kind of error must take up at least this share (%) of the time spent in its situation (aim steady / rising / falling). */
var RAIL_MIN_SHARE_PCT = 10;
var RAIL_CONTEXT = { bleed: 'running', fallLag: 'falling', riseOver: 'rising', riseLag: 'rising', oscillation: 'steady', steadyHigh: 'steady', steadyLow: 'steady' };

var RAIL_CLASSES = {
    bleed:        'Above aim, pump already off',
    riseOver:     'Overshoot while the aim rises',
    riseLag:      'Lagging a rising aim',
    oscillation:  'Oscillating around a steady aim',
    steadyHigh:   'Steady above aim',
    steadyLow:    'Steady below aim',
    fallLag:      'Above a falling aim (pump still delivering)'
};

/** Index of the nearest site. */
function railNearest(sites, v) {
    var best = 0;
    for (var i = 1; i < sites.length; i++) if (Math.abs(sites[i] - v) < Math.abs(sites[best] - v)) best = i;
    return best;
}

/** Bilinear lookup of the aim table (bar) at engine speed and fuel volume per cycle, clamped at the edges. */
function railAimAt(aim, rpm, vol) {
    function w(sites, v) {
        if (v <= sites[0]) return [[0, 1]];
        for (var i = 1; i < sites.length; i++) {
            if (v <= sites[i]) { var f = (v - sites[i - 1]) / ((sites[i] - sites[i - 1]) || 1); return [[i - 1, 1 - f], [i, f]]; }
        }
        return [[sites.length - 1, 1]];
    }
    var out = 0;
    w(aim.rpm, rpm).forEach(function (r) { w(aim.volume, vol).forEach(function (v) { out += r[1] * v[1] * aim.values[r[0]][v[0]]; }); });
    return out;
}

/**
 * The logged fuel volume is per cylinder (or per cycle); the aim table uses volume per engine cycle. Finds the
 * multiplier (1–12) that best reproduces the logged aim from the table, and how closely it does.
 */
function railVolumeFactor(aim, rpmArr, volArr, aimArr, errorArr) {
    var best = null, step = Math.max(1, Math.floor(rpmArr.length / 4000));
    [1, 2, 3, 4, 5, 6, 8, 10, 12].forEach(function (f) {
        var diffs = [];
        for (var i = 0; i < rpmArr.length; i += step) {
            if (isNaN(errorArr[i]) || isNaN(volArr[i])) continue;
            diffs.push(Math.abs(railAimAt(aim, rpmArr[i], volArr[i] * f) - aimArr[i]));
        }
        if (!diffs.length) return;
        diffs.sort(function (a, b) { return a - b; });
        var med = diffs[diffs.length >> 1];
        if (!best || med < best.medianDiff) best = { factor: f, medianDiff: med };
    });
    return best;
}

/**
 * Classifies every running sample that is outside ±TOLERANCE_BAR by what the aim and pump were doing, maps the
 * error onto the aim table's own cells, and turns the result into advice on the gains and the table.
 *
 * @param {Object} a - arrays { time, rpm, press, aim, error, control, volume } (bar, %, µl); error NaN when not running
 * @param {Object} rail - from m1pkgRail
 * @returns {Object} { volumeFactor, aimMatch, classes: {key: {seconds, episodes, label}}, cells, steep, advice: [{severity, text}] }
 */
function analyzeRailControl(a, rail, sampleRate) {
    var n = a.time.length, dt = 1 / (sampleRate || 100), look = Math.max(1, Math.round(0.5 * (sampleRate || 100)));
    var res = { volumeFactor: null, aimMatch: null, classes: {}, cells: null, steep: [], advice: [], gains: null, runningSeconds: 0 };
    Object.keys(RAIL_CLASSES).forEach(function (k) { res.classes[k] = { label: RAIL_CLASSES[k], seconds: 0, episodes: 0, meanEpisode: 0 }; });
    if (rail) res.gains = { p: rail.pGainPctPerBar, i: rail.iGainPctPerBarS, margin: rail.margin };

    // Per-sample class, for errors beyond the band.
    var band = function (i) { return Math.max(TOLERANCE_BAR, a.aim[i] * RAIL_BAND_PCT / 100); };
    var cls = new Array(n), lastSteadyOut = [];   // recent steady-aim excursions { t, sign } for oscillation
    var context = { steady: 0, rising: 0, falling: 0, running: 0 };   // running time in each aim situation (s)
    for (var i = 0; i < n; i++) {
        var e = a.error[i];
        cls[i] = null;
        if (isNaN(e)) continue;
        res.runningSeconds += dt;
        var j = Math.max(0, i - look), slope = (a.aim[i] - a.aim[j]) / ((a.time[i] - a.time[j]) || 1);
        context[slope > RAIL_SLOPE_BAR_S ? 'rising' : slope < -RAIL_SLOPE_BAR_S ? 'falling' : 'steady'] += dt;
        context.running += dt;
        if (Math.abs(e) <= band(i)) continue;
        var ctl = a.control ? a.control[i] : NaN;
        var c;
        if (e > 0 && ctl <= RAIL_PUMP_OFF_PCT) c = 'bleed';
        else if (slope > RAIL_SLOPE_BAR_S) c = e > 0 ? 'riseOver' : 'riseLag';
        else if (slope < -RAIL_SLOPE_BAR_S) c = e > 0 ? 'fallLag' : 'riseLag';
        else {
            // Steady aim: oscillating when the excursions have swung to the other side of the band at least twice in 2 s.
            var sign = e > 0 ? 1 : -1;
            if (!lastSteadyOut.length || lastSteadyOut[lastSteadyOut.length - 1].sign !== sign) lastSteadyOut.push({ t: a.time[i], sign: sign });
            while (lastSteadyOut.length && a.time[i] - lastSteadyOut[0].t > 2) lastSteadyOut.shift();
            c = lastSteadyOut.length >= 3 ? 'oscillation' : e > 0 ? 'steadyHigh' : 'steadyLow';
        }
        cls[i] = c;
    }
    // Episodes: runs of one class (gaps up to one 10 Hz reading joined); shorter than RAIL_MIN_EPISODE_S are dropped.
    var gap = Math.round(0.1 * (sampleRate || 100)), start = -1, end = -1, cur = null;
    function close() {
        if (cur && (end - start + 1) * dt >= RAIL_MIN_EPISODE_S - 1e-9) {
            res.classes[cur].episodes++;
            res.classes[cur].seconds += (end - start + 1) * dt;
        } else if (cur) {
            for (var q = start; q <= end; q++) if (cls[q] === cur) cls[q] = null;   // too brief: not counted in the cells either
        }
        cur = null;
    }
    for (i = 0; i <= n; i++) {
        var ci = i < n ? cls[i] : null;
        if (ci && ci === cur) { end = i; continue; }
        if (!ci && cur && i - end <= gap && i < n) continue;
        close();
        if (ci) { cur = ci; start = end = i; }
    }
    close();
    Object.keys(res.classes).forEach(function (k) {
        var c = res.classes[k], ctxS = context[RAIL_CONTEXT[k]];
        c.share = ctxS > 0 ? Math.round(c.seconds / ctxS * 1000) / 10 : 0;
        c.context = RAIL_CONTEXT[k];
        c.seconds = Math.round(c.seconds * 10) / 10;
        c.meanEpisode = c.episodes ? Math.round(c.seconds / c.episodes * 100) / 100 : 0;
    });
    res.context = { steady: Math.round(context.steady), rising: Math.round(context.rising * 10) / 10, falling: Math.round(context.falling * 10) / 10 };
    res.runningSeconds = Math.round(res.runningSeconds);

    // Map errors onto the aim table's cells (nearest site), when the tune and a fuel volume channel are there.
    if (rail && rail.aim && a.volume) {
        var vf = railVolumeFactor(rail.aim, a.rpm, a.volume, a.aim, a.error);
        if (vf) {
            res.volumeFactor = vf.factor;
            res.aimMatch = Math.round(vf.medianDiff * 10) / 10;
            var R = rail.aim.rpm.length, V = rail.aim.volume.length, acc = [];
            for (var r = 0; r < R; r++) { acc.push([]); for (var v = 0; v < V; v++) acc[r].push({ n: 0, sum: 0, within: 0, cls: {} }); }
            for (i = 0; i < n; i++) {
                if (isNaN(a.error[i]) || isNaN(a.volume[i])) continue;
                var cell = acc[railNearest(rail.aim.rpm, a.rpm[i])][railNearest(rail.aim.volume, a.volume[i] * vf.factor)];
                cell.n++; cell.sum += a.error[i];
                if (Math.abs(a.error[i]) <= TOLERANCE_BAR) cell.within++;
                else if (cls[i]) cell.cls[cls[i]] = (cell.cls[cls[i]] || 0) + 1;
            }
            var minN = Math.max(20, Math.round((sampleRate || 100) * GRID_MIN_SECONDS));
            res.cells = acc.map(function (row) {
                return row.map(function (c) {
                    if (c.n < minN) return c.n ? { seconds: Math.round(c.n * dt * 10) / 10, thin: true } : null;
                    var top = null;
                    Object.keys(c.cls).forEach(function (k) { if (!top || c.cls[k] > c.cls[top]) top = k; });
                    return { seconds: Math.round(c.n * dt * 10) / 10, meanError: Math.round(c.sum / c.n * 10) / 10,
                             pctWithin: Math.round(c.within / c.n * 1000) / 10, main: top };
                });
            });

            // Steep steps in the aim table next to cells the engine used: the rail must move fast there.
            for (r = 0; r < R; r++) {
                for (v = 0; v < V - 1; v++) {
                    var used = res.cells[r][v] || res.cells[r][v + 1];
                    var step = rail.aim.values[r][v + 1] - rail.aim.values[r][v];
                    if (used && Math.abs(step) > RAIL_STEEP_BAR) {
                        res.steep.push({ rpm: rail.aim.rpm[r], from: rail.aim.volume[v], to: rail.aim.volume[v + 1],
                                         aimFrom: rail.aim.values[r][v], aimTo: rail.aim.values[r][v + 1] });
                    }
                }
            }
        }
    }

    // Advice.
    function enough(k) {
        var c = res.classes[k];
        return c.episodes >= RAIL_MIN_EPISODES && c.seconds >= RAIL_MIN_SECONDS && c.share >= RAIL_MIN_SHARE_PCT;
    }
    function desc(k) {
        var c = res.classes[k];
        return c.seconds + ' s in ' + c.episodes + ' episodes, ' + c.share + '% of the time ' +
            (c.context === 'running' ? 'the engine ran' : 'the aim was ' + c.context);
    }
    var gainText = rail && rail.pGainPctPerBar !== null ? ' (now ' + rail.pGainPctPerBar + ' %/bar)' : '';
    var iText = rail && rail.iGainPctPerBarS !== null ? ' (now ' + rail.iGainPctPerBarS + ' %/(bar·s))' : '';
    var suggestedP = 1, suggestedI = 1;

    var ff = rail && rail.displacement ? ' If gain changes do not help, check Pump Displacement (' + rail.displacement + ' cc): M1 uses it to ' +
        'work out how much of each pump stroke to deliver, so a value smaller than the real pump makes it deliver too much.' : '';
    if (enough('oscillation')) {
        suggestedP = 0.75;
        res.advice.push({ severity: 'warning', text: 'The rail oscillates around a steady aim (' + desc('oscillation') + '). Reduce the Proportional ' +
            'Gain to about 0.75× its value' + gainText + '; if it still oscillates slowly, reduce the Integral Gain too.' });
    } else if (enough('riseOver') && enough('riseLag')) {
        suggestedP = 1.15; suggestedI = 0.85;
        res.advice.push({ severity: 'warning', text: 'As the aim rises, pressure both lags (' + desc('riseLag') + ') and overshoots (' + desc('riseOver') +
            '). A late response followed by an overshoot usually means the integral builds up while the pressure lags, then carries it ' +
            'past the aim. Change one thing at a time: first reduce the Integral Gain to about 0.85×' + iText + ' and re-log; if it still lags, ' +
            'raise the Proportional Gain to about 1.15×' + gainText + '.' + ff });
    } else if (enough('riseOver')) {
        var longOver = res.classes.riseOver.meanEpisode > 0.5;
        if (longOver) suggestedI = 0.8; else suggestedP = 0.85;
        res.advice.push({ severity: 'warning', text: 'Pressure overshoots while the aim rises (' + desc('riseOver') + ', ' +
            res.classes.riseOver.meanEpisode + ' s each on average). ' + (longOver
                ? 'Long overshoots point at the integral winding up during the rise: reduce the Integral Gain to about 0.8×' + iText + '.'
                : 'Short overshoots point at too much proportional action: reduce the Proportional Gain to about 0.85×' + gainText + '.') + ff });
    } else if (enough('riseLag')) {
        suggestedP = 1.2;
        res.advice.push({ severity: 'info', text: 'Pressure lags a rising aim (' + desc('riseLag') + '). If the pump control was not near its ' +
            'maximum then, raise the Proportional Gain to about 1.2×' + gainText + '.' });
    }
    if (enough('steadyLow') || enough('steadyHigh')) {
        var k2 = res.classes.steadyLow.seconds >= res.classes.steadyHigh.seconds ? 'steadyLow' : 'steadyHigh';
        suggestedI = Math.max(suggestedI, 1.25);
        res.advice.push({ severity: 'info', text: 'Pressure stays ' + (k2 === 'steadyLow' ? 'below' : 'above') + ' a steady aim (' + desc(k2) +
            '): the integral is slow to remove the offset. Raise the Integral Gain to about 1.25×' + iText + '.' });
    }
    if (res.classes.bleed.seconds > 0) {
        res.advice.push({ severity: 'info', text: res.classes.bleed.seconds + ' s above aim with the pump already off (' +
            res.classes.bleed.episodes + ' episodes): the aim fell faster than injection can bleed the rail down. Gains cannot change this. ' +
            'It is mostly harmless because M1 calculates injector flow from the measured rail pressure; if it matters, make the aim fall ' +
            'more gradually where these happen' + (res.steep.length ? ' (see the steep steps below)' : '') + '.' });
    }
    if (res.steep.length) {
        res.advice.push({ severity: 'info', text: 'Steep steps in Fuel Pressure Direct Aim where the engine ran: ' + res.steep.slice(0, 6).map(function (st) {
            return st.rpm + ' rpm, ' + st.from + '→' + st.to + ' µl: ' + st.aimFrom + '→' + st.aimTo + ' bar';
        }).join('; ') + '. A step this large asks the rail to move by tens of bar as the load changes slightly; spreading it over ' +
            'more sites makes the aim easier to follow.' });
    }
    var anyGainAdvice = ['oscillation', 'riseOver', 'riseLag', 'steadyLow', 'steadyHigh'].some(enough);
    if (!anyGainAdvice) {
        res.advice.unshift({ severity: 'good', text: 'No gain change suggested: no kind of control error is common enough. Each needs ' +
            RAIL_MIN_EPISODES + ' or more episodes of at least ' + RAIL_MIN_EPISODE_S + ' s beyond the larger of ' + TOLERANCE_BAR + ' bar and ' +
            RAIL_BAND_PCT + '% of the aim, and at least ' + RAIL_MIN_SHARE_PCT + '% of the time spent in that situation (aim steady ' +
            res.context.steady + ' s, rising ' + res.context.rising + ' s, falling ' + res.context.falling + ' s in this log). ' +
            'To tune the high-load response, log several pulls — and rail pressure at 50–100 Hz if you can.' });
    }
    // Say plainly when the log has (almost) no time at high rail pressure: the advice above is then about light load only.
    if (res.cells && rail && rail.aim) {
        var highSeconds = 0, highAim = 100;
        res.cells.forEach(function (row, r) {
            row.forEach(function (c, v) { if (c && rail.aim.values[r][v] >= highAim) highSeconds += c.seconds; });
        });
        if (highSeconds < 10) {
            res.advice.push({ severity: 'info', text: 'Only ' + (Math.round(highSeconds * 10) / 10) + ' s of this log is in aim table cells of ' + highAim +
                ' bar or more, so it says little about high-load (boost) control; the advice above mostly reflects light load and transitions. ' +
                'Log several full pulls to judge the high-load response.' });
        }
    }
    res.suggested = { p: suggestedP, i: suggestedI };
    return res;
}

// ---------------------------------------------------------------------------
// Low-side (lift pump) pressure: the high-pressure pump's supply. A sagging feed starves the HPFP and shows up as rail undershoot.
// ---------------------------------------------------------------------------

var LOW_MIN_KPA = 250;                 // below this (gauge) the feed is too low for the HPFP
var LOW_DROOP_KPA = 50;                // droop from the light-load median worth reporting
var LOW_FLOW_BINS = [0, 500, 1000, 1500, 2000, 3000];   // Fuel Flow, ml/min
var LOW_START_S = 3;                   // after each start the pumps are still priming

/**
 * a = { time, rpm, low (kPa), flow (ml/min) | null, pump2 | null, error (rail − aim, bar) }
 * → { base, min, bins: [{ from, to, seconds, median, p2, pump2Pct }], droop, droopFlow, below: { episodes, seconds, first },
 *     pump2: { seconds, onFlow, minBeforeOn } | null, railLinked: % | null, advice: [{ severity: 'warning' | 'good', text }] } | null
 */
function analyzeLowSide(a, sampleRate) {
    var n = a.low.length, ok = new Array(n), since = -1;
    for (var i = 0; i < n; i++) {
        var run = a.rpm[i] >= MIN_RUNNING_RPM && !isNaN(a.low[i]);
        if (!run) { since = -1; ok[i] = false; continue; }
        if (since < 0) since = a.time[i];
        ok[i] = a.time[i] - since >= LOW_START_S;
    }
    function q(arr, p) { if (!arr.length) return NaN; var s2 = arr.slice().sort(function (x, y) { return x - y; }); return s2[Math.min(s2.length - 1, Math.floor(p * (s2.length - 1) + 0.5))]; }
    var all = [], flows = [];
    for (i = 0; i < n; i++) if (ok[i]) { all.push(a.low[i]); if (a.flow && !isNaN(a.flow[i])) flows.push(a.flow[i]); }
    if (all.length < sampleRate * 10) return null;
    var light = [], flowMid = flows.length ? q(flows, 0.5) : null;
    for (i = 0; i < n; i++) if (ok[i] && (!a.flow || a.flow[i] <= flowMid)) light.push(a.low[i]);
    var r1 = function (v) { return Math.round(v); };
    var out = { base: r1(q(light, 0.5)), min: r1(q(all, 0.005)), bins: [], droop: null, droopFlow: null, below: { episodes: 0, seconds: 0, first: null },
                pump2: null, railLinked: null, advice: [] };

    if (a.flow) LOW_FLOW_BINS.forEach(function (from, b) {
        var to = b + 1 < LOW_FLOW_BINS.length ? LOW_FLOW_BINS[b + 1] : Infinity, v = [], on = 0;
        for (var k = 0; k < n; k++) if (ok[k] && a.flow[k] >= from && a.flow[k] < to) { v.push(a.low[k]); if (a.pump2 && a.pump2[k] > 0) on++; }
        if (v.length / sampleRate < 1) return;
        out.bins.push({ from: from, to: to === Infinity ? null : to, seconds: Math.round(v.length / sampleRate * 10) / 10, median: r1(q(v, 0.5)), p2: r1(q(v, 0.02)),
                        pump2Pct: a.pump2 ? Math.round(on / v.length * 100) : null });
    });
    if (out.bins.length >= 2) {   // droop needs flow above the lightest bin
        var top = out.bins[out.bins.length - 1];
        out.droop = out.base - top.median;
        out.droopFlow = top.from;
    }

    // Stretches below the minimum (≥ 0.3 s)
    var start = -1;
    for (i = 0; i <= n; i++) {
        var low = i < n && ok[i] && a.low[i] < LOW_MIN_KPA;
        if (low && start < 0) start = i;
        if (!low && start >= 0) {
            var dur = (i - start) / sampleRate;
            if (dur >= 0.3) { out.below.episodes++; out.below.seconds += dur; if (out.below.first === null) out.below.first = a.time[start]; }
            start = -1;
        }
    }
    out.below.seconds = Math.round(out.below.seconds * 10) / 10;

    // Second pump: how long on, the fuel flow when it switches on, and the lowest feed in the second before it does
    if (a.pump2) {
        var onS = 0, onFlows = [], before = [], w = Math.round(sampleRate);
        for (i = 1; i < n; i++) {
            if (ok[i] && a.pump2[i] > 0) onS++;
            if (a.pump2[i] > 0 && !(a.pump2[i - 1] > 0) && ok[i]) {
                if (a.flow) onFlows.push(a.flow[i]);
                var lo = Infinity;
                for (var j = Math.max(0, i - w); j < i; j++) if (ok[j] && a.low[j] < lo) lo = a.low[j];
                if (lo < Infinity) before.push(lo);
            }
        }
        if (onS || onFlows.length) out.pump2 = { seconds: Math.round(onS / sampleRate * 10) / 10, switchOns: before.length,
            onFlow: onFlows.length ? r1(q(onFlows, 0.5)) : null, minBeforeOn: before.length ? r1(Math.min.apply(null, before)) : null };
    }

    // Rail undershoot while the feed sagged
    var under = 0, underSag = 0;
    for (i = 0; i < n; i++) {
        if (!ok[i] || !(a.error[i] < -TOLERANCE_BAR)) continue;
        under++;
        if (a.low[i] < out.base - LOW_DROOP_KPA) underSag++;
    }
    if (under >= sampleRate) out.railLinked = Math.round(underSag / under * 100);

    if (out.below.episodes) out.advice.push({ severity: 'warning', text: 'Low-side fuel pressure fell below ' + LOW_MIN_KPA + ' kPa ' + out.below.episodes + ' time' +
        (out.below.episodes > 1 ? 's' : '') + ' (' + out.below.seconds + ' s, first at ' + out.below.first.toFixed(1) + ' s) with the engine running. The HPFP needs a ' +
        'steady feed; check the lift pump, its supply voltage, the filter and the regulator.' });
    if (out.droop !== null && out.droop >= LOW_DROOP_KPA) out.advice.push({ severity: 'warning', text: 'The feed drops ' + out.droop + ' kPa from ' + out.base +
        ' kPa at light load to ' + (out.base - out.droop) + ' kPa above ' + out.droopFlow + ' ml/min of fuel flow. A return-style regulator should hold it within a few kPa: ' +
        'the lift pump or its wiring is near its limit there.' });
    else if (out.droop !== null) out.advice.push({ severity: 'good', text: 'The feed holds ' + (out.droop <= 0 ? 'at or above' : 'within ' + out.droop + ' kPa of') +
        ' its light-load ' + out.base + ' kPa up to the highest fuel flow in this log (' + out.droopFlow + '+ ml/min).' });
    if (out.railLinked !== null && out.railLinked >= 30) out.advice.push({ severity: 'warning', text: out.railLinked + '% of the rail undershoot came while the feed was ' +
        LOW_DROOP_KPA + '+ kPa below normal: fix the supply before touching rail control.' });
    if (out.pump2 && out.pump2.minBeforeOn !== null && out.pump2.minBeforeOn < out.base - LOW_DROOP_KPA) out.advice.push({ severity: 'warning', text: 'The feed had already dropped to ' +
        out.pump2.minBeforeOn + ' kPa before Fuel Pump 2 switched on (median ' + (out.pump2.onFlow !== null ? out.pump2.onFlow + ' ml/min' : '?') + '): bring the second pump in earlier.' });
    return out;
}

function runAnalysis(columnNames, data, sampleRate, units, rail) {
    // Step 1: Resolve channels
    self.postMessage({ type: 'progress', phase: 'Resolving channels...', percent: 10 });
    var resolution = resolveChannels(columnNames);
    var channels = resolution.resolved;
    var warnings = resolution.warnings;

    var missingRequired = REQUIRED_CHANNELS.some(function (k) { return channels[k] === -1; });
    if (missingRequired) {
        self.postMessage({
            type: 'error',
            message: 'Required channels missing (Fuel Pressure Direct Bank 1, its Aim, and Engine Speed). Cannot perform fuel pressure analysis.'
        });
        return;
    }
    for (var w = 0; w < warnings.length; w++) self.postMessage({ type: 'warning', message: warnings[w] });

    // Step 2: Extract arrays, converting rail pressure and aim to bar
    self.postMessage({ type: 'progress', phase: 'Extracting channel data...', percent: 20 });
    var n = data.length;
    var col = function (idx) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = data[i][idx]; return a; };
    var pressIdx = channels.fuel_press, aimIdx = channels.fuel_press_aim, rpmIdx = channels.rpm;
    var rawAim = col(aimIdx), rawPress = col(pressIdx);
    var aimUnit = pressureToBar(units && units[aimIdx], rawAim);
    var pressUnit = pressureToBar(units && units[pressIdx], rawPress);
    if (aimUnit.guessed || pressUnit.guessed) {
        self.postMessage({ type: 'warning', message: 'Rail pressure units are not in the log; treated as ' + pressUnit.unit +
            ' from the size of the values. Check the pressures shown look right.' });
    }

    var timeArr = col(0), rpmArr = col(rpmIdx);
    var pressArr = rawPress.map(function (v) { return v * pressUnit.factor; });
    var aimArr = rawAim.map(function (v) { return v * aimUnit.factor; });
    var controlArr = channels.fuel_press_control !== -1 ? col(channels.fuel_press_control) : null;
    var dutyArr = channels.inj_duty !== -1 ? col(channels.inj_duty) : null;
    var flowArr = channels.fuel_flow !== -1 ? col(channels.fuel_flow) : null;
    var mapArr = channels.map !== -1 ? col(channels.map) : null;

    // Error only while the engine runs and the system has an aim (engine off / cranking says nothing about control).
    var errorArr = new Array(n), running = 0;
    for (var i = 0; i < n; i++) {
        var ok = rpmArr[i] >= MIN_RUNNING_RPM && aimArr[i] > 0 && !isNaN(pressArr[i]);
        errorArr[i] = ok ? pressArr[i] - aimArr[i] : NaN;
        if (ok) running++;
    }

    // Step 3: Error statistics
    self.postMessage({ type: 'progress', phase: 'Computing error statistics...', percent: 40 });
    var stats = computeErrorStats(errorArr, pressArr, aimArr, rpmArr, data, channels, sampleRate);

    // Step 4: Transient events
    self.postMessage({ type: 'progress', phase: 'Detecting transient events...', percent: 55 });
    var transientEvents = detectTransientEvents(timeArr, pressArr, aimArr, errorArr, sampleRate);

    // Step 5: Scatter data
    self.postMessage({ type: 'progress', phase: 'Building correlation data...', percent: 65 });
    var errorVsRpm = [], errorVsDuty = dutyArr ? [] : null, errorVsFlow = flowArr ? [] : null;
    for (i = 0; i < n; i++) {
        if (isNaN(errorArr[i]) || isNaN(rpmArr[i])) continue;
        errorVsRpm.push({ x: rpmArr[i], y: errorArr[i] });
        if (errorVsDuty && !isNaN(dutyArr[i])) errorVsDuty.push({ x: dutyArr[i], y: errorArr[i] });
        if (errorVsFlow && !isNaN(flowArr[i])) errorVsFlow.push({ x: flowArr[i], y: errorArr[i] });
    }
    errorVsRpm = downsampleScatter(errorVsRpm, MAX_CHART_POINTS);
    if (errorVsDuty) errorVsDuty = downsampleScatter(errorVsDuty, MAX_CHART_POINTS);
    if (errorVsFlow) errorVsFlow = downsampleScatter(errorVsFlow, MAX_CHART_POINTS);

    // Step 6: Histogram, grid, pump
    self.postMessage({ type: 'progress', phase: 'Building error histogram...', percent: 75 });
    var errorHistogram = buildErrorHistogram(errorArr);
    var errorGrid = buildErrorGrid(errorArr, rpmArr, mapArr, sampleRate);
    var pump = analyzePumpLimit(controlArr, errorArr);
    var volArr = channels.fuel_volume !== -1 ? col(channels.fuel_volume) : null;
    var railControl = analyzeRailControl({ time: timeArr, rpm: rpmArr, press: pressArr, aim: aimArr, error: errorArr,
                                           control: controlArr, volume: volArr }, rail || null, sampleRate);

    var lowSide = null;
    if (channels.low_press !== -1) {
        var lowUnit = String(units && units[channels.low_press] || 'kPa').toLowerCase();
        var lowF = /^bar/.test(lowUnit) ? 100 : /psi/.test(lowUnit) ? 6.895 : /^mpa/.test(lowUnit) ? 1000 : 1;
        lowSide = analyzeLowSide({ time: timeArr, rpm: rpmArr, low: col(channels.low_press).map(function (v) { return v * lowF; }), flow: flowArr,
                                   pump2: channels.pump2 !== -1 ? col(channels.pump2) : null, error: errorArr }, sampleRate);
    }

    // Step 7: Diagnostics
    self.postMessage({ type: 'progress', phase: 'Generating diagnostics...', percent: 85 });
    var diagnostics = generateDiagnostics(stats, transientEvents, errorArr, rpmArr, dutyArr);
    if (pump && pump.likelyLimited) {
        diagnostics.push('Pump at its limit: in ' + pump.pctUndershootAtLimit + '% of the samples more than ' + TOLERANCE_BAR +
            ' bar below aim, the pump control was at 90% or more of its highest value in this log (' + pump.maxControl +
            '%). The pump cannot keep up there; check its capacity and the low-pressure supply before raising the aim.');
    } else if (pump && stats.pctUndershoot > 1) {
        diagnostics.push('Undershoot is not at the pump\'s limit (control was below 90% of its maximum in most undershoot samples), so ' +
            'it is more likely control response than capacity: look at the pump control gains and feed-forward.');
    }
    // Overshoot right after the aim falls is expected: a DI rail only loses pressure as fuel is injected (or through a
    // relief valve), so on a lift-off it stays high until injection brings it down.
    var over = 0, overAfterDrop = 0, lookback = Math.max(1, Math.round(sampleRate));
    for (i = 0; i < n; i++) {
        if (!(errorArr[i] > TOLERANCE_BAR)) continue;
        over++;
        var prevAim = -Infinity;
        for (var k = Math.max(0, i - lookback); k < i; k++) if (aimArr[k] > prevAim) prevAim = aimArr[k];
        if (prevAim - aimArr[i] >= 5) overAfterDrop++;
    }
    if (over > 20 && overAfterDrop / over >= 0.5) {
        diagnostics.push(Math.round(overAfterDrop / over * 100) + '% of the overshoot comes within a second of the aim falling (e.g. ' +
            'lifting off). That is expected: the rail only loses pressure as fuel is injected, so it lags a falling aim. ' +
            'Overshoot while the aim is steady or rising is the part to tune.');
    }
    if (running < n * 0.95) {
        diagnostics.push('Statistics use the ' + running.toLocaleString() + ' samples with the engine running and a rail pressure aim (' +
            Math.round(running / n * 100) + '% of the log).');
    }

    // Step 8: Chart data (downsampled time series)
    self.postMessage({ type: 'progress', phase: 'Building chart data...', percent: 90 });
    var dsArrays = downsampleParallel([timeArr, pressArr, aimArr, errorArr], MAX_CHART_POINTS);
    var dsControl = controlArr ? downsampleArray(controlArr, MAX_CHART_POINTS) : null;
    var transientOverlay = buildTransientOverlayData(timeArr, errorArr, sampleRate, transientEvents);

    var channelMapping = {};
    Object.keys(CHANNEL_MAP).forEach(function (k) { channelMapping[k] = channels[k] !== -1; });

    // Step 8b: injector pulse width impact of low pressure. Flow ∝ √pressure, so to deliver the same fuel at a lower
    // pressure the pulse width must grow by √(aim/actual). Counted where pressure is more than 5 bar below aim.
    var pressurePwImpact = null;
    if (dutyArr) {
        var impactPoints = [];
        for (i = 0; i < n; i++) {
            if (isNaN(errorArr[i]) || pressArr[i] <= 0 || errorArr[i] >= -5) continue;
            var pwMultiplier = Math.sqrt(aimArr[i] / pressArr[i]);
            impactPoints.push({ rpm: rpmArr[i], pressBar: Math.round(pressArr[i] * 10) / 10, aimBar: Math.round(aimArr[i] * 10) / 10,
                                pwIncreasePct: Math.round((pwMultiplier - 1) * 1000) / 10 });
        }
        if (impactPoints.length > 100) {
            var rpmBins = {};
            impactPoints.forEach(function (pt) {
                var bin = Math.round(pt.rpm / 500) * 500;
                var b = rpmBins[bin] || (rpmBins[bin] = { count: 0, pwIncSum: 0, maxPwInc: 0 });
                b.count++; b.pwIncSum += pt.pwIncreasePct;
                if (pt.pwIncreasePct > b.maxPwInc) b.maxPwInc = pt.pwIncreasePct;
            });
            var summary = Object.keys(rpmBins).sort(function (x, y) { return x - y; }).map(function (k) {
                var b = rpmBins[k];
                return { rpm: parseInt(k, 10), samples: b.count, avgPwIncrease: Math.round(b.pwIncSum / b.count * 10) / 10,
                         maxPwIncrease: Math.round(b.maxPwInc * 10) / 10 };
            });
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
            runningSamples: running,
            pressureUnit: pressUnit.unit,
            meanError: stats.meanError,
            meanAbsError: stats.meanAbsError,
            maxOvershoot: stats.maxOvershoot,
            maxUndershoot: stats.maxUndershoot,
            stdDevError: stats.stdDevError,
            pctWithinTolerance: stats.pctWithinTolerance,
            pctOvershoot: stats.pctOvershoot,
            pctUndershoot: stats.pctUndershoot,
            worstOvershootRpm: stats.worstOvershootRpm,
            worstUndershootRpm: stats.worstUndershootRpm,
            transientEvents: transientEvents,
            errorByRpm: downsampleScatter(errorVsRpm, 500),
            errorByDuty: errorVsDuty ? downsampleScatter(errorVsDuty, 500) : null,
            errorByFlow: errorVsFlow ? downsampleScatter(errorVsFlow, 500) : null,
            errorGrid: errorGrid,
            pump: pump,
            railControl: railControl,
            lowSide: lowSide,
            tuneName: rail ? rail.tuneName : null,
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

if (typeof self !== 'undefined') self.onmessage = function(event) {
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

            var unitsRow = (lines[headerRowIdx + 1] || '').split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
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

            runAnalysis(columnNames, data, sampleRate, unitsRow, msg.rail);

        } else if (msg.type === 'analyze_ld') {
            // Binary .ld input
            self.postMessage({ type: 'progress', phase: 'Parsing .ld file...', percent: 5 });

            var result = parseLdFile(msg.buffer, function(processed, total) {
                var pct = 5 + Math.round((processed / total) * 10);
                self.postMessage({ type: 'progress', phase: 'Reading channels...', percent: pct });
            });

            var sampleRate = result.maxFreq || 1;
            runAnalysis(result.columnNames, result.data, sampleRate, result.units, msg.rail);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error during analysis.' });
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pressureToBar: pressureToBar, computeErrorStats: computeErrorStats, detectTransientEvents: detectTransientEvents,
        buildErrorGrid: buildErrorGrid, analyzeRailControl: analyzeRailControl, railAimAt: railAimAt, analyzePumpLimit: analyzePumpLimit, analyzeLowSide: analyzeLowSide, generateDiagnostics: generateDiagnostics, runAnalysis: runAnalysis,
        resolveChannels: resolveChannels, parseLdFile: parseLdFile };
}
