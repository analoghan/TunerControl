/**
 * transmission/worker.js — Transmission Shift Analyzer Worker.
 * Parses TurboLamik TunerPro RT CSV logs and analyzes shift quality.
 */

// ---------------------------------------------------------------------------
// Channel Resolution
// ---------------------------------------------------------------------------

var CHANNEL_MAP = {
    time:           ['Time', 'Seconds'],
    engine_rpm:     ['Engine RPM'],
    input_rpm:      ['Input RPM'],
    output_rpm:     ['Output RPM'],
    gear:           ['Gear'],
    gear_target:    ['Gear Target'],
    slip_pct:       ['Slipt Gear Clutch %'],
    lockup_slip:    ['Lockup Slipt %'],
    lockup_pres:    ['Lockup Pres.'],
    oil_temp:       ['Oil Temp (C)'],
    engine_tq_nm:   ['Engine TQ (NM)'],
    gearbox_tq_nm:  ['Gearbox TQ (NM)'],
    tps:            ['TPS'],
    vehicle_speed:  ['Vehicle Speed (km/h)', 'Vehicle Speed (mph)'],
    shift_time:     ['Time 1 Shift Time'],
    foot_brake:     ['Foot brake'],
    clutch_a:       ['Clutch 1-A'],
    clutch_b:       ['Clutch 2-B'],
    clutch_e:       ['Clutch 3-E'],
    clutch_c:       ['Clutch 4-C'],
    clutch_d:       ['Clutch 5-D'],
    adapt_a:        ['Clutch 1-A Pres. Adaptation'],
    adapt_b:        ['Clutch 2-B Pres. Adaptation'],
    adapt_e:        ['Clutch 3-E Pres. Adaptation'],
    adapt_c:        ['Clutch 4-C Pres. Adaptation'],
    adapt_d:        ['Clutch 5-D Pres. Adaptation'],
    input_accel:    ['Input RPM ACCEL.'],
};

function resolveChannels(columnNames) {
    var nameToIdx = {};
    for (var i = 0; i < columnNames.length; i++) {
        var n = columnNames[i].trim().toLowerCase();
        if (!(n in nameToIdx)) nameToIdx[n] = i;
    }
    var resolved = {};
    var keys = Object.keys(CHANNEL_MAP);
    for (var k = 0; k < keys.length; k++) {
        var candidates = CHANNEL_MAP[keys[k]];
        resolved[keys[k]] = -1;
        for (var c = 0; c < candidates.length; c++) {
            var idx = nameToIdx[candidates[c].toLowerCase()];
            if (idx !== undefined) { resolved[keys[k]] = idx; break; }
        }
    }
    return resolved;
}

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
// Shift Event Detection
// ---------------------------------------------------------------------------

/**
 * Detects gear change events by watching the Gear channel for transitions.
 * Captures a window of data around each shift for analysis.
 */
function detectShiftEvents(data, ch, sampleRate) {
    var gearIdx = ch.gear;
    var timeIdx = ch.time;
    if (gearIdx === -1) return [];

    var events = [];
    var prevGear = NaN;
    var windowSamples = Math.round(sampleRate * 2); // 2 seconds around shift

    for (var i = 1; i < data.length; i++) {
        var gear = data[i][gearIdx];
        var prevG = data[i - 1][gearIdx];

        if (isNaN(gear) || isNaN(prevG)) continue;
        if (gear === prevG) continue;
        if (gear < 1 || gear > 8 || prevG < 1 || prevG > 8) continue;

        // Gear changed — record the event
        var startIdx = Math.max(0, i - windowSamples);
        var endIdx = Math.min(data.length - 1, i + windowSamples);

        var evt = {
            sampleIdx: i,
            time: timeIdx !== -1 ? data[i][timeIdx] : i / sampleRate,
            fromGear: prevG,
            toGear: gear,
            isUpshift: gear > prevG,
            isDownshift: gear < prevG,

            // Will be populated during analysis
            engineRpmAtShift: ch.engine_rpm !== -1 ? data[i][ch.engine_rpm] : null,
            inputRpmAtShift: ch.input_rpm !== -1 ? data[i][ch.input_rpm] : null,
            outputRpmAtShift: ch.output_rpm !== -1 ? data[i][ch.output_rpm] : null,
            tpsAtShift: ch.tps !== -1 ? data[i][ch.tps] : null,
            torqueAtShift: ch.engine_tq_nm !== -1 ? data[i][ch.engine_tq_nm] : null,
            oilTemp: ch.oil_temp !== -1 ? data[i][ch.oil_temp] : null,
            braking: ch.foot_brake !== -1 ? data[i][ch.foot_brake] > 0 : null,
            vehicleSpeed: ch.vehicle_speed !== -1 ? data[i][ch.vehicle_speed] : null,

            // Shift quality metrics (computed below)
            shiftTime: null,
            maxSlip: 0,
            slipDuration: 0,
            rpmFlare: 0,
            harshness: 0,
            clutchInvolved: null,
        };

        // Compute shift quality metrics from the window
        analyzeShiftWindow(evt, data, ch, startIdx, endIdx, i, sampleRate);

        events.push(evt);
    }

    return events;
}

/**
 * Analyzes the data window around a shift event to compute quality metrics.
 */
function analyzeShiftWindow(evt, data, ch, startIdx, endIdx, shiftIdx, sampleRate) {
    var inputRpmIdx = ch.input_rpm;
    var slipIdx = ch.slip_pct;
    var shiftTimeIdx = ch.shift_time;

    // Shift time from the TCU's own measurement
    if (shiftTimeIdx !== -1) {
        // Look for non-zero shift time value near the shift point
        for (var i = shiftIdx; i < Math.min(shiftIdx + 50, data.length); i++) {
            var st = data[i][shiftTimeIdx];
            if (!isNaN(st) && st > 0) {
                evt.shiftTime = st;
                break;
            }
        }
    }

    // Max clutch slip during shift window (narrower: 0.5s after shift)
    if (slipIdx !== -1) {
        var slipWindow = Math.round(sampleRate * 0.5);
        var maxSlip = 0;
        var slipStarted = false;
        var slipSamples = 0;

        for (var i = shiftIdx; i < Math.min(shiftIdx + slipWindow, data.length); i++) {
            var slip = Math.abs(data[i][slipIdx]);
            if (slip > 1) { // More than 1% slip
                slipStarted = true;
                slipSamples++;
                if (slip > maxSlip) maxSlip = slip;
            } else if (slipStarted) {
                break; // Slip ended
            }
        }
        evt.maxSlip = Math.round(maxSlip * 10) / 10;
        evt.slipDuration = Math.round((slipSamples / sampleRate) * 1000); // ms
    }

    // RPM flare detection (input RPM spike above expected)
    if (inputRpmIdx !== -1) {
        var rpmBefore = data[shiftIdx][inputRpmIdx];
        var maxRpm = rpmBefore;
        var flareWindow = Math.round(sampleRate * 0.8);

        for (var i = shiftIdx; i < Math.min(shiftIdx + flareWindow, data.length); i++) {
            var rpm = data[i][inputRpmIdx];
            if (!isNaN(rpm) && rpm > maxRpm) maxRpm = rpm;
        }
        evt.rpmFlare = Math.round(maxRpm - rpmBefore);
    }

    // Harshness score for downshifts
    // Based on: RPM change rate, torque spike, and whether braking
    if (evt.isDownshift && inputRpmIdx !== -1) {
        var rpmChangeRate = 0;
        var maxRate = 0;
        var prevRpm = data[shiftIdx][inputRpmIdx];

        for (var i = shiftIdx + 1; i < Math.min(shiftIdx + Math.round(sampleRate * 0.5), data.length); i++) {
            var rpm = data[i][inputRpmIdx];
            if (isNaN(rpm) || isNaN(prevRpm)) { prevRpm = rpm; continue; }
            var rate = Math.abs(rpm - prevRpm) * sampleRate; // RPM/second
            if (rate > maxRate) maxRate = rate;
            prevRpm = rpm;
        }

        // Harshness = RPM change rate normalized (higher = harsher)
        // Scale: 0-100 where >50 is concerning, >75 is harsh
        evt.harshness = Math.min(100, Math.round(maxRate / 100));
    }

    // Determine which clutch is involved in this shift
    evt.clutchInvolved = getClutchForShift(evt.fromGear, evt.toGear, evt.isUpshift);
}

/**
 * Maps gear transitions to the clutch elements involved.
 * Based on ZF 8HP clutch engagement chart:
 * Gear 1: A+E, Gear 2: A+B, Gear 3: A+D, Gear 4: A+C
 * Gear 5: B+C, Gear 6: B+D, Gear 7: B+E, Gear 8: C+E
 *
 * Returns { releasing: clutch being released, applying: clutch being applied }
 */
function getClutchForShift(fromGear, toGear, isUpshift) {
    var clutchStates = {
        1: ['A', 'E'],
        2: ['A', 'B'],
        3: ['A', 'D'],
        4: ['A', 'C'],
        5: ['B', 'C'],
        6: ['B', 'D'],
        7: ['B', 'E'],
        8: ['C', 'E'],
    };

    var fromClutches = clutchStates[fromGear];
    var toClutches = clutchStates[toGear];
    if (!fromClutches || !toClutches) return null;

    // Find which clutch is released (in fromGear but not toGear)
    var releasing = null;
    for (var i = 0; i < fromClutches.length; i++) {
        if (toClutches.indexOf(fromClutches[i]) === -1) {
            releasing = fromClutches[i];
            break;
        }
    }

    // Find which clutch is applied (in toGear but not fromGear)
    var applying = null;
    for (var i = 0; i < toClutches.length; i++) {
        if (fromClutches.indexOf(toClutches[i]) === -1) {
            applying = toClutches[i];
            break;
        }
    }

    // For shift quality, the oncoming (applying) clutch determines the feel
    return applying;
}

// ---------------------------------------------------------------------------
// Per-Clutch Health Analysis
// ---------------------------------------------------------------------------

function computeClutchHealth(events, data, ch) {
    var clutches = { A: [], B: [], C: [], D: [], E: [] };

    for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        if (evt.clutchInvolved && clutches[evt.clutchInvolved]) {
            clutches[evt.clutchInvolved].push(evt);
        }
    }

    var result = {};
    var clutchKeys = Object.keys(clutches);
    for (var k = 0; k < clutchKeys.length; k++) {
        var key = clutchKeys[k];
        var evts = clutches[key];
        if (evts.length === 0) {
            result[key] = { totalShifts: 0, upshiftCount: 0, downshiftCount: 0, avgSlipUpshift: 0, maxSlipUpshift: 0, avgShiftTime: 0, avgHarshness: 0 };
            continue;
        }

        var upshiftSlipSum = 0, maxSlipUpshift = 0, upshiftCount = 0;
        var downshiftCount = 0;
        var shiftTimeSum = 0, shiftTimeCount = 0, harshnessSum = 0, harshnessCount = 0;

        for (var i = 0; i < evts.length; i++) {
            if (evts[i].isUpshift) {
                upshiftCount++;
                upshiftSlipSum += evts[i].maxSlip;
                if (evts[i].maxSlip > maxSlipUpshift) maxSlipUpshift = evts[i].maxSlip;
            } else {
                downshiftCount++;
                harshnessSum += evts[i].harshness;
                harshnessCount++;
            }
            if (evts[i].shiftTime !== null) { shiftTimeSum += evts[i].shiftTime; shiftTimeCount++; }
        }

        result[key] = {
            totalShifts: evts.length,
            upshiftCount: upshiftCount,
            downshiftCount: downshiftCount,
            avgSlipUpshift: upshiftCount > 0 ? Math.round(upshiftSlipSum / upshiftCount * 10) / 10 : 0,
            maxSlipUpshift: Math.round(maxSlipUpshift * 10) / 10,
            avgShiftTime: shiftTimeCount > 0 ? Math.round(shiftTimeSum / shiftTimeCount) : 0,
            avgHarshness: harshnessCount > 0 ? Math.round(harshnessSum / harshnessCount) : 0,
        };
    }

    return result;
}

// ---------------------------------------------------------------------------
// Diagnostics Generation
// ---------------------------------------------------------------------------

function generateDiagnostics(events, clutchHealth) {
    var diagnostics = [];

    // Find harsh downshifts
    var harshDownshifts = events.filter(function(e) { return e.isDownshift && e.harshness > 50; });
    var harsh32 = events.filter(function(e) { return e.isDownshift && e.fromGear === 3 && e.toGear === 2 && e.harshness > 40; });

    if (harsh32.length > 0) {
        var avgHarsh = 0;
        for (var i = 0; i < harsh32.length; i++) avgHarsh += harsh32[i].harshness;
        avgHarsh = Math.round(avgHarsh / harsh32.length);
        diagnostics.push({
            severity: 'critical',
            text: '3→2 downshift harshness detected: ' + harsh32.length + ' events with avg harshness score ' + avgHarsh + '/100. The B clutch (oncoming) is engaging too aggressively during decel, causing engine braking shudder. Gear 3 holds A+D, Gear 2 holds A+B — the shift releases D and applies B.',
            action: 'In TunerPro, reduce the B clutch fill pressure for downshift engagement. Look at "Cor. Pres. Open Clutch" and the B clutch adaptation values. Also verify the downshift blip is matching RPM correctly — insufficient blip causes the B clutch to absorb the speed difference harshly.'
        });
    }

    if (harshDownshifts.length > 3 && harsh32.length === 0) {
        diagnostics.push({
            severity: 'warning',
            text: harshDownshifts.length + ' harsh downshift events detected across multiple gear transitions.',
            action: 'Review clutch fill pressures for downshift transitions. Consider increasing the overlap time to allow smoother clutch-to-clutch handoff.'
        });
    }

    // High slip on upshifts (only flag upshifts — slip during downshifts is normal/expected)
    var highSlipUpshifts = events.filter(function(e) { return e.isUpshift && e.maxSlip > 15 && e.tpsAtShift > 30; });
    if (highSlipUpshifts.length > 0) {
        var avgSlip = 0;
        for (var i = 0; i < highSlipUpshifts.length; i++) avgSlip += highSlipUpshifts[i].maxSlip;
        avgSlip = Math.round(avgSlip / highSlipUpshifts.length);
        diagnostics.push({
            severity: 'warning',
            text: highSlipUpshifts.length + ' upshifts under power show excessive clutch slip (avg ' + avgSlip + '%). This generates heat and accelerates clutch wear.',
            action: 'Increase clutch fill pressure for the affected upshift transitions. Check that adaptation has converged — if adaptation values are still changing, allow more adaptation cycles.'
        });
    }

    // Per-clutch issues (only flag slip on upshifts — downshift slip is expected)
    var clutchKeys = Object.keys(clutchHealth);
    for (var k = 0; k < clutchKeys.length; k++) {
        var key = clutchKeys[k];
        var health = clutchHealth[key];
        if (health.totalShifts > 0 && health.maxSlipUpshift > 25) {
            diagnostics.push({
                severity: 'warning',
                text: 'Clutch ' + key + ' shows peak upshift slip of ' + health.maxSlipUpshift + '% across ' + health.upshiftCount + ' upshifts. This clutch may need pressure adjustment.',
                action: 'Check Clutch ' + key + ' pressure adaptation value in TunerPro. If adaptation is at its limit, manually increase the base pressure for this clutch.'
            });
        }
    }

    // Healthy state
    if (diagnostics.length === 0) {
        diagnostics.push({
            severity: 'healthy',
            text: 'No significant shift quality issues detected. All shifts within normal parameters.',
            action: 'Continue monitoring. Log under different conditions (cold, hot, high torque) to verify consistency.'
        });
    }

    return diagnostics;
}

// ---------------------------------------------------------------------------
// Main Analysis Pipeline
// ---------------------------------------------------------------------------

function runAnalysis(columnNames, data) {
    self.postMessage({ type: 'progress', phase: 'Resolving channels...', percent: 10 });
    var ch = resolveChannels(columnNames);

    // Determine sample rate from time column
    var sampleRate = 30; // default ~30Hz for TurboLamik
    var timeIdx = ch.time;
    if (timeIdx !== -1 && data.length > 10) {
        var dt = data[10][timeIdx] - data[0][timeIdx];
        if (dt > 0) sampleRate = 10 / dt;
    }

    // Check required channels
    if (ch.gear === -1) {
        self.postMessage({ type: 'error', message: 'Required channel "Gear" not found. Cannot analyze shifts.' });
        return;
    }

    self.postMessage({ type: 'progress', phase: 'Detecting shift events...', percent: 30 });
    var events = detectShiftEvents(data, ch, sampleRate);

    self.postMessage({ type: 'progress', phase: 'Analyzing clutch health...', percent: 60 });
    var clutchHealth = computeClutchHealth(events, data, ch);

    self.postMessage({ type: 'progress', phase: 'Generating diagnostics...', percent: 80 });
    var diagnostics = generateDiagnostics(events, clutchHealth);

    // Build summary
    var upshifts = events.filter(function(e) { return e.isUpshift; });
    var downshifts = events.filter(function(e) { return e.isDownshift; });
    var avgShiftTime = 0;
    var stCount = 0;
    for (var i = 0; i < events.length; i++) {
        if (events[i].shiftTime !== null) { avgShiftTime += events[i].shiftTime; stCount++; }
    }

    var summary = {
        totalShifts: events.length,
        upshifts: upshifts.length,
        downshifts: downshifts.length,
        avgShiftTime: stCount > 0 ? Math.round(avgShiftTime / stCount) : 0,
        logDuration: data.length > 0 && timeIdx !== -1 ? Math.round(data[data.length - 1][timeIdx]) : 0,
        oilTemp: ch.oil_temp !== -1 ? Math.round(data[Math.floor(data.length / 2)][ch.oil_temp]) : null,
    };

    self.postMessage({ type: 'progress', phase: 'Complete', percent: 100 });
    self.postMessage({
        type: 'result',
        summary: summary,
        events: events,
        clutchHealth: clutchHealth,
        diagnostics: diagnostics,
    });
}

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

self.onmessage = function(event) {
    var msg = event.data;
    if (!msg) return;

    if (msg.type === 'analyze') {
        // CSV text analysis (original path)
        try {
            self.postMessage({ type: 'progress', phase: 'Parsing CSV...', percent: 5 });
            var result = parseTunerProCsv(msg.logText, function(done, total) {
                self.postMessage({ type: 'progress', phase: 'Parsing rows...', percent: 5 + Math.round(done / total * 20) });
            });

            if (result.data.length < 10) {
                self.postMessage({ type: 'error', message: 'Not enough data rows to analyze.' });
                return;
            }

            runAnalysis(result.columnNames, result.data);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || 'Unknown error during analysis.' });
        }
    } else if (msg.type === 'analyzeXdl') {
        // XDL binary + ADX definition analysis
        try {
            self.postMessage({ type: 'progress', phase: 'Parsing ADX channel definitions...', percent: 5 });
            var adxDef = parseAdx(msg.adxText);

            self.postMessage({ type: 'progress', phase: 'Parsing XDL binary log...', percent: 10 });
            var result = parseXdl(msg.xdlBuffer, adxDef, function(done, total) {
                var pct = 10 + Math.round(done / total * 15);
                self.postMessage({ type: 'progress', phase: 'Parsing XDL records...', percent: pct });
            });

            if (result.data.length < 10) {
                self.postMessage({ type: 'error', message: 'Not enough data records in XDL file.' });
                return;
            }

            runAnalysis(result.columnNames, result.data);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || 'Unknown error during XDL analysis.' });
        }
    }
};
