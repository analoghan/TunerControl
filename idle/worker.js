/**
 * worker.js — Idle Behavior Analyzer Analysis Worker.
 * Performs all heavy CSV/.ld parsing and idle hang analysis off the main thread.
 */

// ---------------------------------------------------------------------------
// MoTeC .ld Binary Parser
// ---------------------------------------------------------------------------

/**
 * Maps .ld dot-separated channel names to the CSV-style names used in CHANNEL_MAP.
 */
var LD_NAME_MAP = {
    'Engine.Speed':                'Engine Speed',
    'Idle.Aim':                    'Idle Aim',
    'Idle.Speed.Aim':              'Idle Speed Aim',
    'Throttle.Pedal':              'Throttle Pedal',
    'Throttle.Position':           'Throttle Position',
    'Inlet.Manifold.Pressure':     'Inlet Manifold Pressure',
    'Coolant.Temperature':         'Coolant Temperature',
    'Idle.Mass.Flow':              'Idle Mass Flow',
    'Idle.Mass.Flow.Feed Forward':  'Idle Mass Flow Feed Forward',
    'Clutch.Switch.Position':      'Clutch Switch Position',
    'Clutch.Position':             'Clutch Position'
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
    rpm:                ['Engine Speed'],
    idle_aim:           ['Idle Aim', 'Idle Speed Aim'],
    tps:                ['Throttle Pedal', 'Throttle Position'],
    map:                ['Inlet Manifold Pressure'],
    coolant_temp:       ['Coolant Temperature'],
    idle_mass_flow:     ['Idle Mass Flow'],
    idle_mass_flow_ff:  ['Idle Mass Flow Feed Forward'],
    clutch_pos:         ['Clutch Switch Position', 'Clutch Position']
};

var REQUIRED_CHANNELS = ['rpm', 'tps', 'clutch_pos'];
var OPTIONAL_WARN_CHANNELS = ['idle_aim', 'map', 'coolant_temp', 'idle_mass_flow', 'idle_mass_flow_ff'];

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
 * Detects deceleration events from parsed log data.
 * A decel event starts when:
 *   - Clutch position > 50% (pedal pressed)
 *   - Throttle position < 1%
 *   - RPM was above 1500 within the last 1 second
 * A decel event ends when:
 *   - RPM settles within 100 RPM of idle_aim for 2+ consecutive seconds, OR
 *   - Throttle opens above 1%, OR
 *   - Clutch released (value drops below 50%)
 */
function detectDecelEvents(data, channels, sampleRate) {
    var rpmIdx = channels.rpm;
    var tpsIdx = channels.tps;
    var clutchIdx = channels.clutch_pos;
    var idleAimIdx = channels.idle_aim;
    var mapIdx = channels.map;
    var coolantIdx = channels.coolant_temp;
    var massFlowIdx = channels.idle_mass_flow;
    var massFlowFFIdx = channels.idle_mass_flow_ff;

    if (rpmIdx === -1 || tpsIdx === -1 || clutchIdx === -1) {
        return [];
    }

    var lookbackSamples = Math.round(sampleRate * 1.0);
    var settleDurationSamples = Math.round(sampleRate * 2.0);
    var settleThreshold = 100; // RPM within idle_aim

    var events = [];
    var inEvent = false;
    var eventStartIdx = 0;
    var settleCounter = 0;

    for (var i = 0; i < data.length; i++) {
        var rpm = data[i][rpmIdx];
        var tps = data[i][tpsIdx];
        var clutch = data[i][clutchIdx];
        var idleAim = idleAimIdx !== -1 ? data[i][idleAimIdx] : 750;

        if (isNaN(rpm) || isNaN(tps) || isNaN(clutch)) continue;

        if (!inEvent) {
            // Check if decel event should start
            // Clutch position is 1 (pressed) or 0 (released)
            if (clutch > 0 && tps < 1) {
                // Check if RPM was above 1500 within the last 1 second
                var wasHighRpm = false;
                var startCheck = Math.max(0, i - lookbackSamples);
                for (var j = startCheck; j <= i; j++) {
                    if (data[j][rpmIdx] > 1500) {
                        wasHighRpm = true;
                        break;
                    }
                }
                if (wasHighRpm) {
                    inEvent = true;
                    eventStartIdx = i;
                    settleCounter = 0;
                }
            }
        } else {
            // Check if event should end
            var shouldEnd = false;
            var endReason = '';

            // Throttle opened
            if (tps >= 1) {
                shouldEnd = true;
                endReason = 'throttle';
            }
            // Clutch released (value drops to 0)
            else if (clutch < 1) {
                shouldEnd = true;
                endReason = 'clutch';
            }
            // RPM settled
            else if (Math.abs(rpm - idleAim) <= settleThreshold) {
                settleCounter++;
                if (settleCounter >= settleDurationSamples) {
                    shouldEnd = true;
                    endReason = 'settled';
                }
            } else {
                settleCounter = 0;
            }

            if (shouldEnd) {
                var endIdx = i;
                events.push(buildDecelEvent(
                    data, eventStartIdx, endIdx, endReason,
                    channels, sampleRate, settleCounter >= settleDurationSamples
                ));
                inEvent = false;
                settleCounter = 0;
            }
        }
    }

    // If still in event at end of data, close it
    if (inEvent) {
        events.push(buildDecelEvent(
            data, eventStartIdx, data.length - 1, 'end_of_data',
            channels, sampleRate, false
        ));
    }

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

    // Compute settle time: time from event start until RPM first reaches idle_aim range
    var settleTime = null;
    var idleAimVal = idleAimIdx !== -1 ? data[startIdx][idleAimIdx] : 750;
    for (var i = startIdx; i <= endIdx; i++) {
        var rpm = data[i][rpmIdx];
        if (!isNaN(rpm) && Math.abs(rpm - idleAimVal) <= 100) {
            settleTime = data[i][0] - startTime;
            break;
        }
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
 * Classifies events as idle hang if RPM stays more than 200 RPM above
 * idle_aim (or 900 RPM if idle_aim unavailable) for more than 3 seconds.
 */
function classifyHangEvents(events, data, channels, sampleRate) {
    var rpmIdx = channels.rpm;
    var idleAimIdx = channels.idle_aim;
    var hangDurationThreshold = 3.0; // seconds
    var hangRpmThreshold = 200; // RPM above idle aim

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        var idleTarget = 900; // default if idle_aim unavailable

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

        // Determine idle target from idle_aim at event start
        if (idleAimIdx !== -1 && !isNaN(data[startSampleIdx][idleAimIdx])) {
            idleTarget = data[startSampleIdx][idleAimIdx];
        }

        // Count consecutive time above threshold
        var hangThresholdRpm = idleTarget + hangRpmThreshold;
        var consecutiveAbove = 0;
        var maxConsecutiveAbove = 0;

        for (var i = startSampleIdx; i <= endSampleIdx; i++) {
            var rpm = data[i][rpmIdx];
            if (!isNaN(rpm) && rpm > hangThresholdRpm) {
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
        events: events
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
            message: 'Required channels missing (rpm, tps, clutch_pos). Cannot perform idle analysis.'
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

    // Step 5: Build chart data
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

            runAnalysis(columnNames, data, sampleRate);

        } else if (msg.type === 'analyze_ld') {
            // Binary .ld input
            self.postMessage({ type: 'progress', phase: 'Parsing .ld file...', percent: 5 });

            var result = parseLdFile(msg.buffer, function(processed, total) {
                var pct = 5 + Math.round((processed / total) * 20);
                self.postMessage({ type: 'progress', phase: 'Reading channels...', percent: pct });
            });

            var sampleRate = result.maxFreq || 1;
            runAnalysis(result.columnNames, result.data, sampleRate);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error during analysis.' });
    }
};
