/**
 * worker.js — Idle Behavior Analyzer Analysis Worker.
 * Performs all heavy CSV/.ld parsing and idle hang analysis off the main thread.
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
    rpm:                ['Engine Speed'],
    idle_aim:           ['Idle Aim', 'Idle Speed Aim'],
    // The pedal, not the throttle blade: with drive-by-wire the idle control opens the blade (~10 % at idle).
    tps:                ['Throttle Pedal', 'Throttle Pedal Sensor'],
    vehicle_speed:      ['Vehicle Speed'],
    post_start_mf:      ['Engine Post Start Idle Mass Flow'],
    map:                ['Inlet Manifold Pressure'],
    coolant_temp:       ['Coolant Temperature'],
    idle_mass_flow:     ['Idle Mass Flow'],
    idle_mass_flow_ff:  ['Idle Mass Flow Feed Forward'],
    clutch_pos:         ['Clutch Switch Position', 'Clutch Position'],
    spark_timing:       ['Ignition Timing', 'Spark Timing'],
    idle_spark_corr:    ['Idle Spark Correction', 'Idle Ignition Correction'],
    idle_air_corr:      ['Idle Air Correction', 'Idle Airflow Correction'],
};

var REQUIRED_CHANNELS = ['rpm', 'tps', 'idle_aim'];
var OPTIONAL_WARN_CHANNELS = ['clutch_pos', 'vehicle_speed', 'map', 'coolant_temp', 'idle_mass_flow', 'idle_mass_flow_ff', 'spark_timing'];

/** Return-to-idle and steady-idle settings (rpm relative to the logged Idle Aim). */
var IDLE_FROM_ABOVE = 500;      // the engine was this far above the aim within the last second
var IDLE_REACHED = 300;         // an event counts once rpm comes within this of the aim (else: a gear change)
var IDLE_SETTLE_BAND = 100;     // settled = within this of the aim …
var IDLE_SETTLE_HOLD = 2.0;     // … for this long (s)
var IDLE_HANG_RPM = 200;        // hang = more than this above the aim …
var IDLE_HANG_TIME = 3.0;       // … for longer than this (s)
var IDLE_PEDAL_OFF = 1.0;       // pedal at or below this (%) = off
var IDLE_STEADY_AFTER = 2.0;    // steady idle starts this long after the car stopped with the pedal off (s)

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
// Decel Event Detection
// ---------------------------------------------------------------------------

/**
 * Returns to idle: the pedal is off (and the clutch pressed, when it is logged), and the engine was more than
 * IDLE_FROM_ABOVE rpm above the Idle Aim within the last second. An event ends when the pedal opens, the clutch is
 * released, or rpm has stayed within IDLE_SETTLE_BAND of the aim for IDLE_SETTLE_HOLD s. Events whose rpm never came
 * within IDLE_REACHED of the aim (gear changes with the clutch in) are not returns to idle; they are counted in skipped.
 */
function detectDecelEvents(data, channels, sampleRate) {
    var rpmIdx = channels.rpm, tpsIdx = channels.tps, clutchIdx = channels.clutch_pos, idleAimIdx = channels.idle_aim;
    var lookbackSamples = Math.round(sampleRate * 1.0);
    var settleDurationSamples = Math.round(sampleRate * IDLE_SETTLE_HOLD);
    var events = [], skipped = 0, inEvent = false, eventStartIdx = 0, settleCounter = 0;

    function close(endIdx, reason, settled) {
        var evt = buildDecelEvent(data, eventStartIdx, endIdx, reason, channels, sampleRate, settled);
        if (evt.reachedIdle) events.push(evt); else skipped++;
    }
    for (var i = 0; i < data.length; i++) {
        var rpm = data[i][rpmIdx], tps = data[i][tpsIdx], idleAim = data[i][idleAimIdx];
        var clutch = clutchIdx !== -1 ? data[i][clutchIdx] : 1;
        if (isNaN(rpm) || isNaN(tps) || isNaN(idleAim) || isNaN(clutch) || idleAim <= 0) continue;
        if (!inEvent) {
            if (clutch > 0 && tps <= IDLE_PEDAL_OFF) {
                for (var j = Math.max(0, i - lookbackSamples); j <= i; j++) {
                    if (data[j][rpmIdx] > data[j][idleAimIdx] + IDLE_FROM_ABOVE) { inEvent = true; eventStartIdx = i; settleCounter = 0; break; }
                }
            }
        } else if (tps > IDLE_PEDAL_OFF) {
            close(i, 'throttle', false); inEvent = false;
        } else if (clutch < 1) {
            close(i, 'clutch', false); inEvent = false;
        } else if (Math.abs(rpm - idleAim) <= IDLE_SETTLE_BAND) {
            if (++settleCounter >= settleDurationSamples) { close(i, 'settled', true); inEvent = false; }
        } else {
            settleCounter = 0;
        }
    }
    if (inEvent) close(data.length - 1, 'end_of_data', false);
    events.skipped = skipped;
    return events;
}

function buildDecelEvent(data, startIdx, endIdx, endReason, channels, sampleRate, didSettle) {
    var rpmIdx = channels.rpm;
    var idleAimIdx = channels.idle_aim;
    var mapIdx = channels.map;
    var coolantIdx = channels.coolant_temp;
    var massFlowIdx = channels.idle_mass_flow;
    var massFlowFFIdx = channels.idle_mass_flow_ff;

    var startTime = data[startIdx][0]; // Time column is index 0
    var endTime = data[endIdx][0];
    var startRpm = data[startIdx][rpmIdx];
    var minRpm = Infinity;
    var rpmSum = 0;
    var rpmCount = 0;

    var rpmTrace = { time: [], values: [] };
    var idleAimTrace = idleAimIdx !== -1 ? { time: [], values: [] } : null;
    var mapTrace = mapIdx !== -1 ? { time: [], values: [] } : null;
    var massFlowTrace = massFlowIdx !== -1 ? { time: [], values: [] } : null;
    var massFlowFFTrace = massFlowFFIdx !== -1 ? { time: [], values: [] } : null;

    // Downsample for traces: max 500 points per event
    var totalSamples = endIdx - startIdx + 1;
    var step = Math.max(1, Math.floor(totalSamples / 500));

    for (var i = startIdx; i <= endIdx; i += step) {
        var rpm = data[i][rpmIdx];
        var t = data[i][0];

        if (!isNaN(rpm)) {
            if (rpm < minRpm) minRpm = rpm;
            rpmSum += rpm;
            rpmCount++;
        }

        rpmTrace.time.push(t);
        rpmTrace.values.push(rpm);

        if (idleAimTrace) {
            idleAimTrace.time.push(t);
            idleAimTrace.values.push(data[i][idleAimIdx]);
        }
        if (mapTrace) {
            mapTrace.time.push(t);
            mapTrace.values.push(data[i][mapIdx]);
        }
        if (massFlowTrace) {
            massFlowTrace.time.push(t);
            massFlowTrace.values.push(data[i][massFlowIdx]);
        }
        if (massFlowFFTrace) {
            massFlowFFTrace.time.push(t);
            massFlowFFTrace.values.push(data[i][massFlowFFIdx]);
        }
    }

    // Settle time: from the event start until rpm first comes within IDLE_SETTLE_BAND of the aim (at that moment).
    var settleTime = null, reachedIdle = false;
    for (var i = startIdx; i <= endIdx; i++) {
        var rpm = data[i][rpmIdx], aimNow = data[i][idleAimIdx];
        if (isNaN(rpm) || isNaN(aimNow)) continue;
        if (rpm - aimNow <= IDLE_REACHED) reachedIdle = true;
        if (settleTime === null && Math.abs(rpm - aimNow) <= IDLE_SETTLE_BAND) settleTime = data[i][0] - startTime;
    }

    // Get coolant temp at event start
    var coolantTemp = null;
    if (coolantIdx !== -1 && !isNaN(data[startIdx][coolantIdx])) {
        coolantTemp = data[startIdx][coolantIdx];
    }

    return {
        startTime: startTime,
        endTime: endTime,
        settleTime: settleTime,
        isHang: false, // classified later
        reachedIdle: reachedIdle,
        endReason: endReason,
        startRpm: startRpm,
        minRpm: minRpm === Infinity ? 0 : minRpm,
        avgRpmDuringEvent: rpmCount > 0 ? rpmSum / rpmCount : 0,
        coolantTemp: coolantTemp,
        rpmTrace: rpmTrace,
        idleAimTrace: idleAimTrace,
        mapTrace: mapTrace,
        massFlowTrace: massFlowTrace,
        massFlowFFTrace: massFlowFFTrace
    };
}

// ---------------------------------------------------------------------------
// Idle Hang Classification
// ---------------------------------------------------------------------------

/**
 * Classifies events as idle hang if RPM stays more than IDLE_HANG_RPM above
 * the Idle Aim for more than IDLE_HANG_TIME seconds.
 */
function classifyHangEvents(events, data, channels, sampleRate) {
    var rpmIdx = channels.rpm;
    var idleAimIdx = channels.idle_aim;
    var hangDurationThreshold = IDLE_HANG_TIME;
    var hangRpmThreshold = IDLE_HANG_RPM;

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];

        // Find the start and end sample indices from time
        var startSampleIdx = -1;
        var endSampleIdx = -1;
        for (var i = 0; i < data.length; i++) {
            if (startSampleIdx === -1 && data[i][0] >= evt.startTime) {
                startSampleIdx = i;
            }
            if (data[i][0] >= evt.endTime) {
                endSampleIdx = i;
                break;
            }
        }
        if (startSampleIdx === -1) startSampleIdx = 0;
        if (endSampleIdx === -1) endSampleIdx = data.length - 1;

        // Consecutive time more than IDLE_HANG_RPM above the aim (at each moment)
        var consecutiveAbove = 0;
        var maxConsecutiveAbove = 0;

        for (var i = startSampleIdx; i <= endSampleIdx; i++) {
            var rpm = data[i][rpmIdx];
            if (!isNaN(rpm) && rpm > data[i][idleAimIdx] + hangRpmThreshold) {
                consecutiveAbove++;
                if (consecutiveAbove > maxConsecutiveAbove) {
                    maxConsecutiveAbove = consecutiveAbove;
                }
            } else {
                consecutiveAbove = 0;
            }
        }

        var hangDurationSeconds = maxConsecutiveAbove / sampleRate;
        if (hangDurationSeconds > hangDurationThreshold) {
            evt.isHang = true;
        }
    }

    return events;
}

// ---------------------------------------------------------------------------
// Statistics Computation
// ---------------------------------------------------------------------------

function computeStatistics(events, channels) {
    var totalDecelEvents = events.length;
    var hangEvents = 0;
    var normalEvents = 0;
    var settleTimes = [];
    var hangRpms = [];

    var coolantCorrelation = {
        cold: { events: 0, hangs: 0 },
        warm: { events: 0, hangs: 0 },
        hot: { events: 0, hangs: 0 }
    };

    for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        if (evt.isHang) {
            hangEvents++;
            hangRpms.push(evt.avgRpmDuringEvent);
        } else {
            normalEvents++;
        }

        if (evt.settleTime !== null) {
            settleTimes.push(evt.settleTime);
        }

        // Coolant temp correlation
        if (evt.coolantTemp !== null) {
            if (evt.coolantTemp < 60) {
                coolantCorrelation.cold.events++;
                if (evt.isHang) coolantCorrelation.cold.hangs++;
            } else if (evt.coolantTemp <= 85) {
                coolantCorrelation.warm.events++;
                if (evt.isHang) coolantCorrelation.warm.hangs++;
            } else {
                coolantCorrelation.hot.events++;
                if (evt.isHang) coolantCorrelation.hot.hangs++;
            }
        }
    }

    var avgSettleTime = 0;
    var worstSettleTime = 0;
    if (settleTimes.length > 0) {
        var sum = 0;
        for (var i = 0; i < settleTimes.length; i++) {
            sum += settleTimes[i];
            if (settleTimes[i] > worstSettleTime) {
                worstSettleTime = settleTimes[i];
            }
        }
        avgSettleTime = sum / settleTimes.length;
    }

    var avgHangRpm = 0;
    if (hangRpms.length > 0) {
        var sum = 0;
        for (var i = 0; i < hangRpms.length; i++) {
            sum += hangRpms[i];
        }
        avgHangRpm = sum / hangRpms.length;
    }

    return {
        totalDecelEvents: totalDecelEvents,
        hangEvents: hangEvents,
        normalEvents: normalEvents,
        avgSettleTime: avgSettleTime,
        worstSettleTime: worstSettleTime,
        avgHangRpm: avgHangRpm,
        coolantTempCorrelation: coolantCorrelation,
        massFlowDiagnostics: computeMassFlowDiagnostics(events),
        decelRates: computeDecelRates(events),
        events: events
    };
}

/**
 * Compares mass flow vs feed forward during hang events vs normal events.
 * Returns diagnostic info about whether feed forward is too high.
 */
function computeMassFlowDiagnostics(events) {
    var hangMfAvg = 0, hangMfCount = 0;
    var hangFfAvg = 0, hangFfCount = 0;
    var normalMfAvg = 0, normalMfCount = 0;
    var normalFfAvg = 0, normalFfCount = 0;

    for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        var mfTrace = evt.massFlowTrace;
        var ffTrace = evt.massFlowFFTrace;

        if (mfTrace && mfTrace.values.length > 0) {
            var mfSum = 0;
            for (var j = 0; j < mfTrace.values.length; j++) {
                var v = mfTrace.values[j];
                if (!isNaN(v)) mfSum += v;
            }
            var mfMean = mfSum / mfTrace.values.length;
            if (evt.isHang) { hangMfAvg += mfMean; hangMfCount++; }
            else { normalMfAvg += mfMean; normalMfCount++; }
        }

        if (ffTrace && ffTrace.values.length > 0) {
            var ffSum = 0;
            for (var j = 0; j < ffTrace.values.length; j++) {
                var v = ffTrace.values[j];
                if (!isNaN(v)) ffSum += v;
            }
            var ffMean = ffSum / ffTrace.values.length;
            if (evt.isHang) { hangFfAvg += ffMean; hangFfCount++; }
            else { normalFfAvg += ffMean; normalFfCount++; }
        }
    }

    var result = {
        hangMassFlow: hangMfCount > 0 ? Math.round((hangMfAvg / hangMfCount) * 10) / 10 : null,
        hangFeedForward: hangFfCount > 0 ? Math.round((hangFfAvg / hangFfCount) * 10) / 10 : null,
        normalMassFlow: normalMfCount > 0 ? Math.round((normalMfAvg / normalMfCount) * 10) / 10 : null,
        normalFeedForward: normalFfCount > 0 ? Math.round((normalFfAvg / normalFfCount) * 10) / 10 : null,
        diagnosis: null
    };

    // Idle Mass Flow and its feed forward are percentages (the M1 stores them as ratios). Actual below feed forward means
    // the controller is taking air away (feed forward too high, or air the model doesn't know about such as a leak);
    // above means it is adding air (feed forward too low).
    if (result.hangMassFlow !== null && result.hangFeedForward !== null) {
        var diff = result.hangMassFlow - result.hangFeedForward;
        if (diff < -1) {
            result.diagnosis = 'During idle hangs the controller is taking air away (Idle Mass Flow ' + result.hangMassFlow + ' % vs feed forward ' +
                result.hangFeedForward + ' %) and rpm still stays high: the feed forward gives too much air for these conditions, or there is ' +
                'air it doesn\'t know about (a leak, a sticking throttle).';
        } else if (diff > 1) {
            result.diagnosis = 'During idle hangs the controller is adding air (Idle Mass Flow ' + result.hangMassFlow + ' % vs feed forward ' +
                result.hangFeedForward + ' %), so the hang is not too much feed forward — look at the aim ramp and decel settings.';
        }
    }

    return result;
}

/**
 * Computes RPM decay rate (RPM/second) for each decel event.
 * Item 11: Decel dashpot rate visualization.
 */
function computeDecelRates(events) {
    var hangRates = [];
    var normalRates = [];

    for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        var trace = evt.rpmTrace;
        if (!trace || trace.time.length < 2) continue;

        // Compute decay rate from start RPM to minimum RPM over the event duration
        var duration = evt.endTime - evt.startTime;
        if (duration <= 0) continue;

        var rpmDrop = evt.startRpm - evt.minRpm;
        var rate = rpmDrop / duration; // RPM per second

        if (evt.isHang) {
            hangRates.push(Math.round(rate));
        } else {
            normalRates.push(Math.round(rate));
        }
    }

    // Compute averages
    var avgHangRate = 0, avgNormalRate = 0;
    if (hangRates.length > 0) {
        var sum = 0;
        for (var j = 0; j < hangRates.length; j++) sum += hangRates[j];
        avgHangRate = Math.round(sum / hangRates.length);
    }
    if (normalRates.length > 0) {
        var sum = 0;
        for (var j = 0; j < normalRates.length; j++) sum += normalRates[j];
        avgNormalRate = Math.round(sum / normalRates.length);
    }

    return {
        avgHangRate: avgHangRate,
        avgNormalRate: avgNormalRate,
        hangRates: hangRates,
        normalRates: normalRates
    };
}

// ---------------------------------------------------------------------------
// Build Full Timeline Data (downsampled for charting)
// ---------------------------------------------------------------------------

function buildChartData(data, channels, events) {
    var rpmIdx = channels.rpm;
    var idleAimIdx = channels.idle_aim;

    // Downsample full timeline to max 2000 points
    var totalRows = data.length;
    var step = Math.max(1, Math.floor(totalRows / 2000));

    var fullRpm = { time: [], values: [] };
    var fullIdleAim = idleAimIdx !== -1 ? { time: [], values: [] } : null;

    for (var i = 0; i < totalRows; i += step) {
        fullRpm.time.push(data[i][0]);
        fullRpm.values.push(data[i][rpmIdx]);

        if (fullIdleAim) {
            fullIdleAim.time.push(data[i][0]);
            fullIdleAim.values.push(data[i][idleAimIdx]);
        }
    }

    return {
        events: events,
        fullRpm: fullRpm,
        fullIdleAim: fullIdleAim
    };
}

// ---------------------------------------------------------------------------
// Steady idle
// ---------------------------------------------------------------------------

function idlePercentile(values, p) {
    if (!values.length) return null;
    var v = values.slice().sort(function (a, b) { return a - b; });
    return v[Math.min(v.length - 1, Math.floor(v.length * p))];
}

/**
 * Steady warm idle: car stopped (Vehicle Speed < 1 km/h when logged), pedal off, at least IDLE_STEADY_AFTER s into the stop,
 * no post-start idle air. Measured over time, not samples: rpm against the aim, and Idle Mass Flow against its feed forward.
 * Returns { seconds, rpmAboveAim: { p10, p50, p90 }, spread, massFlowMinusFF: { p10, p50, p90 }, coolant, map, ignition, diags }.
 */
/** Position on an axis: { i, f } with value = axis[i] + f × (axis[i+1] − axis[i]), clamped to the ends. */
function idleAxisPos(axis, v) {
    if (axis.length < 2 || v <= axis[0]) return { i: 0, f: 0 };
    for (var i = 0; i < axis.length - 1; i++) if (v <= axis[i + 1]) return { i: i, f: (v - axis[i]) / (axis[i + 1] - axis[i]) };
    return { i: axis.length - 2, f: 1 };
}

/** Bilinear value of table.values[y][x] at (x on table[xKey], y on table[yKey]), plus the corner weights. */
function idleTableAt(table, xKey, x, yKey, y) {
    var px = idleAxisPos(table[xKey], x), py = yKey ? idleAxisPos(table[yKey], y) : { i: 0, f: 0 };
    var rows = table.values, value = 0, corners = [];
    [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (c) {
        var w = (c[0] ? px.f : 1 - px.f) * (c[1] ? py.f : 1 - py.f), yi = Math.min(rows.length - 1, py.i + c[1]), xi = Math.min(rows[0].length - 1, px.i + c[0]);
        if (w <= 0) return;
        value += w * rows[yi][xi];
        corners.push({ x: xi, y: yi, w: w });
    });
    return { value: value, corners: corners };
}

/**
 * With the tune: the idle controller's integral (Idle Mass Flow − feed forward − pGain × (aim − rpm)) against its limits, the
 * Feed Forward Main cells the steady idle used (and how much of the logged feed forward comes from compensations), and the
 * logged Idle Aim against Idle Aim Main. Adds to out and returns diagnostics.
 */
function idleTuneChecks(rows, c, tune, out, sampleRate) {
    var diags = [];
    function stats(v) {
        v = v.filter(function (n) { return !isNaN(n); });
        return v.length ? { p10: idlePercentile(v, 0.1), p50: idlePercentile(v, 0.5), p90: idlePercentile(v, 0.9) } : null;
    }
    var haveFlow = c.idle_mass_flow !== -1 && c.idle_mass_flow_ff !== -1;
    if (haveFlow && tune.pGain !== null) {
        var integral = rows.map(function (x) { return (x[c.idle_mass_flow] - x[c.idle_mass_flow_ff]) - tune.pGain * (x[c.idle_aim] - x[c.rpm]); });
        out.integral = stats(integral);
        var near = function (lim) { return lim === null ? 0 : integral.filter(function (v) { return Math.abs(v - lim) <= 0.2; }).length / integral.length; };
        out.integralAtMin = near(tune.integralMin);
        out.integralAtMax = near(tune.integralMax);
    }
    if (tune.feedForward && haveFlow) {
        var ff = tune.feedForward, cells = {}, main = [];
        rows.forEach(function (x) {
            var at = idleTableAt(ff, 'aim', x[c.idle_aim], ff.coolantAxis && c.coolant_temp !== -1 ? 'coolant' : null, x[c.coolant_temp]);
            main.push(at.value);
            at.corners.forEach(function (k) { var key = k.y + ',' + k.x; cells[key] = (cells[key] || 0) + k.w; });
        });
        out.ffMain = stats(main);
        out.ffCompensation = stats(rows.map(function (x, i) { return x[c.idle_mass_flow_ff] - main[i]; }));
        var change = out.massFlowMinusFF ? out.massFlowMinusFF.p50 : 0;
        out.ffCells = Object.keys(cells).map(function (k) {
            var yx = k.split(',').map(Number), value = ff.values[yx[0]][yx[1]];
            return { aim: ff.aim[yx[1]], coolant: ff.coolantAxis ? ff.coolant[yx[0]] : null, value: value, share: cells[k] / rows.length,
                     suggested: Math.round((value + change) * 10) / 10 };
        }).filter(function (k) { return k.share >= 0.1; }).sort(function (a, b) { return b.share - a.share; });
    }
    if (tune.aimMain && c.coolant_temp !== -1) {
        var am = tune.aimMain;
        out.aimVsTable = stats(rows.map(function (x) { return x[c.idle_aim] - idleTableAt({ coolant: am.coolant, values: [am.values] }, 'coolant', x[c.coolant_temp]).value; }));
    }

    var a = out.rpmAboveAim, name = tune.tuneName ? ' in ' + tune.tuneName : '';
    if (out.integral && tune.integralMin !== null && out.integralAtMin >= 0.5 && a.p50 > 0) {
        var cellText = out.ffCells && out.ffCells.length ? ' The steady idle used these Feed Forward Main cells: ' + out.ffCells.map(function (k) {
            return Math.round(k.aim) + ' rpm aim' + (k.coolant !== null ? ' / ' + k.coolant + ' °C' : '') + ' = ' + k.value.toFixed(1) + ' % (' +
                Math.round(k.share * 100) + ' % of the time) → about ' + k.suggested.toFixed(1) + ' %';
        }).join('; ') + '.' : '';
        var comp = out.ffCompensation && out.ffCompensation.p50 > 0.5 ? ' Of the ' + (out.ffMain.p50 + out.ffCompensation.p50).toFixed(1) + ' % feed forward in the log, ' +
            out.ffMain.p50.toFixed(1) + ' % is Feed Forward Main and ' + out.ffCompensation.p50.toFixed(1) + ' % comes from compensations (coolant fan, A/C and ' +
            'similar Idle Mass Flow Feed Forward tables) — if one of those is what is too high, lower that instead.' : '';
        diags.push({ severity: 'warning', covers: true, text: 'The idle integral is at its minimum of ' + tune.integralMin + ' %' + name + ' for ' +
            Math.round(out.integralAtMin * 100) + ' % of the steady idle time: the controller has taken away all the air it is allowed to, and idle still sits ' +
            a.p50.toFixed(0) + ' rpm above the aim. The feed forward is about ' + Math.abs(out.massFlowMinusFF.p50).toFixed(1) + ' % too high here (at least — ' +
            'with the integral free it may take more). Lower Feed Forward Main at these conditions, or allow a lower Integral Minimum.' + cellText + comp });
    } else if (out.integral && tune.integralMax !== null && out.integralAtMax >= 0.5 && a.p50 < 0) {
        diags.push({ severity: 'warning', covers: true, text: 'The idle integral is at its maximum of ' + tune.integralMax + ' %' + name + ' for ' +
            Math.round(out.integralAtMax * 100) + ' % of the steady idle time and idle still sits ' + (-a.p50).toFixed(0) + ' rpm below the aim: raise Feed Forward ' +
            'Main at these conditions, or allow a higher Integral Maximum.' });
    } else if (out.integral && Math.abs(a.p50) > 30) {
        diags.push({ severity: 'warning', covers: true, text: 'Idle sits ' + Math.abs(a.p50).toFixed(0) + ' rpm ' + (a.p50 > 0 ? 'above' : 'below') +
            ' the aim, but the idle integral is not at its limits (median ' + out.integral.p50.toFixed(1) + ' %, 10–90 %: ' + out.integral.p10.toFixed(1) +
            ' to ' + out.integral.p90.toFixed(1) + ' %; limits ' + tune.integralMin + ' to ' + tune.integralMax + ' %' + name + '), so the controller still ' +
            'has room. Look at what changes during the idle in the log — the aim, coolant fan or A/C switching (they change the feed forward), ' +
            'or ignition timing — before changing the feed forward.' + (out.ffCompensation && out.ffCompensation.p90 - out.ffCompensation.p10 > 1
                ? ' The feed forward compensations moved by ' + (out.ffCompensation.p90 - out.ffCompensation.p10).toFixed(1) + ' % during it.' : '') });
    } else if (out.integral) {
        diags.push({ severity: 'info', text: 'With the tune' + name + ': the idle integral sits at ' + out.integral.p50.toFixed(1) + ' % (10–90 %: ' +
            out.integral.p10.toFixed(1) + ' to ' + out.integral.p90.toFixed(1) + ' %), inside its limits (' + tune.integralMin + ' to ' + tune.integralMax + ' %).' });
    }
    if (out.aimVsTable && Math.abs(out.aimVsTable.p50) > 20) {
        diags.push({ severity: 'info', text: 'The logged Idle Aim is ' + Math.abs(out.aimVsTable.p50).toFixed(0) + ' rpm ' + (out.aimVsTable.p50 > 0 ? 'above' : 'below') +
            ' this tune\'s Idle Aim Main at the logged coolant temperature' + (out.aimVsTable.p50 > 0 ? ' — compensations (A/C, post start, a driver switch) raise it, or' : ' —') +
            ' the log was recorded with a different tune.' });
    }
    return diags;
}

function computeSteadyIdle(data, channels, sampleRate, tune) {
    var c = channels, after = Math.round(sampleRate * IDLE_STEADY_AFTER), run = 0, rows = [];
    for (var i = 0; i < data.length; i++) {
        var x = data[i], ok = x[c.rpm] > 400 && x[c.tps] <= IDLE_PEDAL_OFF && x[c.idle_aim] > 0 &&
            (c.vehicle_speed === -1 || x[c.vehicle_speed] < 1) && (c.post_start_mf === -1 || !(x[c.post_start_mf] > 0));
        run = ok ? run + 1 : 0;
        if (run > after) rows.push(x);
    }
    var out = { seconds: rows.length / sampleRate, diags: [] };
    if (out.seconds < 5) {
        out.diags.push({ severity: 'info', text: 'Only ' + out.seconds.toFixed(1) + ' s of steady idle (stopped, pedal off, ' + IDLE_STEADY_AFTER +
            ' s into the stop' + (c.vehicle_speed === -1 ? '' : ', Vehicle Speed below 1 km/h') + ') — at least 5 s are needed to judge the idle.' });
        return out;
    }
    function stats(fn) {
        var v = rows.map(fn).filter(function (n) { return !isNaN(n); });
        return v.length ? { p10: idlePercentile(v, 0.1), p50: idlePercentile(v, 0.5), p90: idlePercentile(v, 0.9) } : null;
    }
    out.rpmAboveAim = stats(function (x) { return x[c.rpm] - x[c.idle_aim]; });
    out.rpm = stats(function (x) { return x[c.rpm]; });
    out.aim = stats(function (x) { return x[c.idle_aim]; });
    out.spread = out.rpm.p90 - out.rpm.p10;
    if (c.idle_mass_flow !== -1 && c.idle_mass_flow_ff !== -1) out.massFlowMinusFF = stats(function (x) { return x[c.idle_mass_flow] - x[c.idle_mass_flow_ff]; });
    if (c.coolant_temp !== -1) out.coolant = stats(function (x) { return x[c.coolant_temp]; });
    if (c.map !== -1) out.map = stats(function (x) { return x[c.map]; });
    if (c.spark_timing !== -1) out.ignition = stats(function (x) { return x[c.spark_timing]; });

    var tuneDiags = tune ? idleTuneChecks(rows, c, tune, out, sampleRate) : [];
    var covered = tuneDiags.some(function (d) { return d.covers; });
    var a = out.rpmAboveAim, m = out.massFlowMinusFF, secs = out.seconds.toFixed(0) + ' s of steady idle';
    var where = out.coolant ? ' (coolant ' + out.coolant.p50.toFixed(0) + ' °C)' : '';
    if (covered) {
        // the tune-based message says it more precisely
    } else if (a.p50 > 30 && m && m.p50 < -1) {
        out.diags.push({ severity: 'warning', text: 'Idle sits ' + a.p50.toFixed(0) + ' rpm above the aim (10–90 %: ' + a.p10.toFixed(0) + ' to ' +
            a.p90.toFixed(0) + ' rpm) while the controller takes ' + (-m.p50).toFixed(1) + ' % of air away from the feed forward' + where + ', over ' + secs +
            '. The feed forward gives more air than this idle needs and the controller isn\'t taking enough away; if it keeps taking ' +
            'the same amount away, its integral is probably at the Idle Mass Flow Integral Minimum. Lower Idle Mass Flow Feed Forward Main at these conditions by about ' + (-m.p50).toFixed(1) +
            ' % (or more), or allow a lower Integral Minimum, then check again.' });
    } else if (a.p50 < -30 && m && m.p50 > 1) {
        out.diags.push({ severity: 'warning', text: 'Idle sits ' + (-a.p50).toFixed(0) + ' rpm below the aim while the controller adds ' + m.p50.toFixed(1) +
            ' % of air to the feed forward' + where + ', over ' + secs + '. The feed forward is too low (or the integral is at its maximum): raise Idle ' +
            'Mass Flow Feed Forward Main at these conditions by about ' + m.p50.toFixed(1) + ' %.' });
    } else if (Math.abs(a.p50) <= 30) {
        out.diags.push({ severity: 'good', text: 'Idle holds the aim (median ' + (a.p50 >= 0 ? '+' : '') + a.p50.toFixed(0) + ' rpm, 10–90 %: ' + a.p10.toFixed(0) +
            ' to ' + a.p90.toFixed(0) + ' rpm) over ' + secs + where + (m ? ', with the controller ' + (m.p50 >= 0 ? 'adding ' : 'taking away ') +
            Math.abs(m.p50).toFixed(1) + ' % of air.' : '.') });
    } else {
        out.diags.push({ severity: 'info', text: 'Idle is ' + (a.p50 > 0 ? 'above' : 'below') + ' the aim by a median of ' + Math.abs(a.p50).toFixed(0) +
            ' rpm over ' + secs + where + '.' + (m ? ' Idle Mass Flow is ' + (m.p50 >= 0 ? '+' : '') + m.p50.toFixed(1) + ' % from the feed forward.' : '') });
    }
    out.diags = tuneDiags.map(function (d) { return { severity: d.severity, text: d.text }; }).concat(out.diags);
    if (out.spread > 100) {
        out.diags.push({ severity: 'warning', text: 'Idle rpm moves over ' + out.spread.toFixed(0) + ' rpm (10–90 %) at steady idle — look for hunting ' +
            '(idle gains), misfire or a sticking throttle.' });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Main Analysis Pipeline
// ---------------------------------------------------------------------------

function runAnalysis(columnNames, data, sampleRate, tune) {
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
            message: 'Required channels missing: Engine Speed, Throttle Pedal and Idle Aim are needed for the idle analysis.'
        });
        return;
    }

    // Post warnings for missing optional channels
    for (var w = 0; w < warnings.length; w++) {
        self.postMessage({ type: 'warning', message: warnings[w] });
    }

    // Step 2: Detect decel events
    self.postMessage({ type: 'progress', phase: 'Detecting decel events...', percent: 30 });
    var events = detectDecelEvents(data, channels, sampleRate);

    // Step 3: Classify hang events
    self.postMessage({ type: 'progress', phase: 'Classifying idle hang events...', percent: 60 });
    events = classifyHangEvents(events, data, channels, sampleRate);

    // Step 4: Compute statistics
    self.postMessage({ type: 'progress', phase: 'Computing statistics...', percent: 80 });
    var analysis = computeStatistics(events, channels);

    // Step 5: Steady idle (rpm against aim, airflow against feed forward)
    self.postMessage({ type: 'progress', phase: 'Analyzing steady idle...', percent: 85 });
    analysis.steadyIdle = computeSteadyIdle(data, channels, sampleRate, tune || null);
    analysis.skippedEvents = events.skipped || 0;

    // Step 6: Build chart data
    self.postMessage({ type: 'progress', phase: 'Building chart data...', percent: 90 });
    var chartData = buildChartData(data, channels, events);

    // Build channel mapping for UI
    var channelMapping = {};
    var keys = Object.keys(CHANNEL_MAP);
    for (var k = 0; k < keys.length; k++) {
        channelMapping[keys[k]] = channels[keys[k]] !== -1;
    }
    analysis.channelMapping = channelMapping;
    analysis.channelWarnings = warnings;

    // Step 6: Post result
    self.postMessage({ type: 'progress', phase: 'Complete', percent: 100 });
    self.postMessage({
        type: 'result',
        analysis: analysis,
        chartData: chartData
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
                var pct = 5 + Math.round((processed / total) * 20);
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

            runAnalysis(columnNames, data, sampleRate, msg.tune);

        } else if (msg.type === 'analyze_ld') {
            // Binary .ld input
            self.postMessage({ type: 'progress', phase: 'Parsing .ld file...', percent: 5 });

            var result = parseLdFile(msg.buffer, function(processed, total) {
                var pct = 5 + Math.round((processed / total) * 20);
                self.postMessage({ type: 'progress', phase: 'Reading channels...', percent: pct });
            });

            var sampleRate = result.maxFreq || 1;
            runAnalysis(result.columnNames, result.data, sampleRate, msg.tune);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error during analysis.' });
    }
};
