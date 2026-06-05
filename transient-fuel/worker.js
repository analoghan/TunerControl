/**
 * transient-fuel/worker.js — Transient Fuel Film Analyzer
 *
 * Detects throttle transient events (tip-in / tip-out) in MoTeC logs
 * and measures lambda excursions to diagnose fuel film calibration.
 *
 * Key metrics per event:
 *   - Lean spike depth (% below target) — fuel film primary too low
 *   - Rich overshoot (% above target) — time constants too aggressive
 *   - Recovery time (ms to return within 2% of target)
 *   - MAP transition zone (from → to kPa)
 */

// ---------------------------------------------------------------------------
// Channel names for MoTeC CSV/LD logs
// ---------------------------------------------------------------------------

var TRANSIENT_CHANNELS = {
    TIME: 'time',
    RPM: 'engine speed',
    MAP: 'inlet manifold pressure',
    LAMBDA_B1: 'exhaust lambda bank 1',
    LAMBDA_B2: 'exhaust lambda bank 2',
    LAMBDA_AVG: 'exhaust lambda',
    LAMBDA_TARGET: 'fuel mixture aim',
    TPS: 'throttle position',
    COOLANT: 'coolant temperature',
};

// ---------------------------------------------------------------------------
// Log Parser (simplified — handles MoTeC CSV format)
// ---------------------------------------------------------------------------

function parseTransientLog(text, onProgress) {
    // Strip null bytes and BOM
    text = text.replace(/\0/g, '').replace(/^\uFEFF/, '');
    // Split on any line ending style (\r\n, \n, or bare \r)
    var lines = text.split(/\r?\n/);

    // Find header row — look for "Time" as first field (handles quotes, whitespace)
    var headerIdx = -1;
    var scanLimit = Math.min(50, lines.length);
    for (var i = 0; i < scanLimit; i++) {
        var firstField = lines[i].split(',')[0].trim().replace(/^"|"$/g, '');
        if (firstField === 'Time') { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Could not find "Time" header in first 50 rows. Ensure this is a MoTeC M1 CSV log export (not a VE table or map file).');

    // Parse column names (handle quoted fields)
    var colNames = lines[headerIdx].split(',').map(function(s) {
        return s.trim().replace(/^"|"$/g, '').toLowerCase();
    });

    // Resolve channels
    var timeIdx = colNames.indexOf(TRANSIENT_CHANNELS.TIME);
    var rpmIdx = colNames.indexOf(TRANSIENT_CHANNELS.RPM);
    var mapIdx = colNames.indexOf(TRANSIENT_CHANNELS.MAP);
    var lb1Idx = colNames.indexOf(TRANSIENT_CHANNELS.LAMBDA_B1);
    var lb2Idx = colNames.indexOf(TRANSIENT_CHANNELS.LAMBDA_B2);
    var lavgIdx = colNames.indexOf(TRANSIENT_CHANNELS.LAMBDA_AVG);
    var ltIdx = colNames.indexOf(TRANSIENT_CHANNELS.LAMBDA_TARGET);
    var tpsIdx = colNames.indexOf(TRANSIENT_CHANNELS.TPS);
    var coolIdx = colNames.indexOf(TRANSIENT_CHANNELS.COOLANT);

    if (timeIdx === -1) throw new Error('Channel "Time" not found.');
    if (mapIdx === -1) throw new Error('Channel "Inlet Manifold Pressure" not found.');
    if (lb1Idx === -1 && lb2Idx === -1 && lavgIdx === -1) throw new Error('No lambda channel found.');

    // Skip units row
    var dataStart = headerIdx + 2;

    // Parse data
    var samples = [];
    var totalLines = lines.length - dataStart;
    for (var i = dataStart; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;
        var fields = line.split(',').map(function(f) { return f.trim().replace(/^"|"$/g, ''); });

        var time = parseFloat(fields[timeIdx]);
        var map = parseFloat(fields[mapIdx]);
        if (isNaN(time) || isNaN(map)) continue;

        var lb1 = lb1Idx >= 0 ? parseFloat(fields[lb1Idx]) : NaN;
        var lb2 = lb2Idx >= 0 ? parseFloat(fields[lb2Idx]) : NaN;
        var lavg = lavgIdx >= 0 ? parseFloat(fields[lavgIdx]) : NaN;
        var lambda;
        if (!isNaN(lb1) && !isNaN(lb2) && lb1 > 0 && lb2 > 0) lambda = (lb1 + lb2) / 2;
        else if (!isNaN(lb1) && lb1 > 0) lambda = lb1;
        else if (!isNaN(lb2) && lb2 > 0) lambda = lb2;
        else lambda = lavg;

        samples.push({
            time: time,
            map: map,
            lambda: lambda,
            lambdaTarget: ltIdx >= 0 ? parseFloat(fields[ltIdx]) : NaN,
            rpm: rpmIdx >= 0 ? parseFloat(fields[rpmIdx]) : NaN,
            tps: tpsIdx >= 0 ? parseFloat(fields[tpsIdx]) : NaN,
            coolant: coolIdx >= 0 ? parseFloat(fields[coolIdx]) : NaN,
        });

        if ((i - dataStart) % 5000 === 0 && onProgress) {
            onProgress(i - dataStart, totalLines);
        }
    }
    return samples;
}

// ---------------------------------------------------------------------------
// Transient Event Detection
// ---------------------------------------------------------------------------

function detectTransientEvents(samples, settings) {
    var mapRateThreshold = settings.mapRateThreshold || 200; // kPa/s
    var minMapChange = settings.minMapChange || 20; // kPa total
    var mapWindowMs = (settings.mapWindow || 500) / 1000; // convert ms to seconds
    var defaultTarget = settings.lambdaTarget || 1.0;

    var events = [];
    var i = 0;
    var lastEventEndIdx = -20; // prevent overlapping detections

    while (i < samples.length - 10) {
        if (i <= lastEventEndIdx) { i++; continue; }

        var s = samples[i];
        if (isNaN(s.map)) { i++; continue; }

        // Method 1: Rate-based detection (catches fast transients)
        var rateTriggered = false;
        if (i < samples.length - 1) {
            var sNext = samples[i + 1];
            var dt = sNext.time - s.time;
            if (dt > 0 && !isNaN(sNext.map)) {
                var mapRate = (sNext.map - s.map) / dt;
                if (Math.abs(mapRate) >= mapRateThreshold) rateTriggered = true;
            }
        }

        // Method 2: Window-based detection (catches slower but significant transients)
        var windowTriggered = false;
        if (!rateTriggered) {
            // Look ahead within the window to see total MAP change
            for (var w = i + 1; w < samples.length; w++) {
                if (samples[w].time - s.time > mapWindowMs) break;
                if (isNaN(samples[w].map)) continue;
                var totalChange = Math.abs(samples[w].map - s.map);
                if (totalChange >= minMapChange) {
                    windowTriggered = true;
                    break;
                }
            }
        }

        if (rateTriggered || windowTriggered) {
            var mapAtStart = s.map;
            var timeAtStart = s.time;
            var isTipIn = false;

            // Find the end of the transient (MAP stabilizes or direction reverses)
            var j = i + 1;
            var peakMap = mapAtStart;
            var troughMap = mapAtStart;
            while (j < samples.length - 1) {
                if (isNaN(samples[j].map)) { j++; continue; }
                if (samples[j].map > peakMap) peakMap = samples[j].map;
                if (samples[j].map < troughMap) troughMap = samples[j].map;

                // Check if MAP has stabilized (rate drops to near zero)
                var dtj = samples[j].time - samples[Math.max(j - 3, i)].time;
                if (dtj > 0.1) { // need at least 100ms of data
                    var recentRate = Math.abs(samples[j].map - samples[Math.max(j - 3, i)].map) / dtj;
                    if (recentRate < mapRateThreshold * 0.2 && (samples[j].time - timeAtStart) > 0.1) break;
                }
                // Time limit: don't look more than 2s ahead
                if (samples[j].time - timeAtStart > 2.0) break;
                j++;
            }

            var mapAtEnd = samples[j].map;
            var totalMapChange = Math.abs(mapAtEnd - mapAtStart);
            isTipIn = mapAtEnd > mapAtStart;

            // Also check peak-to-start (in case MAP overshot then returned)
            var maxChange = Math.max(peakMap - mapAtStart, mapAtStart - troughMap);
            if (maxChange > totalMapChange) totalMapChange = maxChange;

            if (totalMapChange >= minMapChange) {
                var target = !isNaN(samples[j].lambdaTarget) && samples[j].lambdaTarget > 0.5 ? samples[j].lambdaTarget : defaultTarget;
                var excursion = measureLambdaExcursion(samples, j, target, isTipIn);

                events.push({
                    type: isTipIn ? 'tip-in' : 'tip-out',
                    time: timeAtStart,
                    rpm: !isNaN(s.rpm) ? Math.round(s.rpm) : 0,
                    mapFrom: Math.round(mapAtStart),
                    mapTo: Math.round(mapAtEnd),
                    mapChange: Math.round(totalMapChange),
                    mapRate: Math.round(totalMapChange / Math.max(samples[j].time - timeAtStart, 0.01)),
                    lambdaTarget: target,
                    leanSpike: excursion.leanSpike,
                    richOvershoot: excursion.richOvershoot,
                    recoveryTime: excursion.recoveryTime,
                    peakError: excursion.peakError,
                });

                lastEventEndIdx = j + 5;
            }

            i = j + 5; // skip past event
        } else {
            i++;
        }
    }

    return events;
}

function measureLambdaExcursion(samples, transientEndIdx, target, isTipIn) {
    // Look at lambda for 1.5 seconds after the transient ends
    var windowMs = 1500;
    var startTime = samples[transientEndIdx].time;
    var endTime = startTime + windowMs / 1000;

    var minLambda = Infinity;
    var maxLambda = -Infinity;
    var recoveryTime = null;
    var settled = false;

    for (var k = transientEndIdx; k < samples.length; k++) {
        if (samples[k].time > endTime) break;
        var lam = samples[k].lambda;
        if (isNaN(lam) || lam <= 0) continue;

        if (lam < minLambda) minLambda = lam;
        if (lam > maxLambda) maxLambda = lam;

        // Check if lambda has recovered (within 2% of target)
        if (!settled && Math.abs(lam - target) / target < 0.02) {
            recoveryTime = Math.round((samples[k].time - startTime) * 1000);
            settled = true;
        }
    }

    // Lean spike: how far below target (as % error)
    var leanSpike = target > 0 && minLambda < Infinity ? Math.max(0, ((minLambda - target) / target) * 100) : 0;
    // For tip-in, lean spike is positive lambda (leaner than target)
    if (isTipIn) {
        leanSpike = minLambda < Infinity ? Math.max(0, ((minLambda - target) / target) * -100) : 0;
        // Actually: lean = lambda > target for tip-in... no.
        // Lean spike on tip-in: lambda goes ABOVE target momentarily (not enough fuel)
        leanSpike = maxLambda > target ? ((maxLambda - target) / target) * 100 : 0;
    }

    // Rich overshoot: how far above target (as % error) — for tip-in, lambda goes below target after initial lean
    var richOvershoot = 0;
    if (isTipIn && minLambda < target) {
        richOvershoot = ((target - minLambda) / target) * 100;
    }
    if (!isTipIn && minLambda < target) {
        // Tip-out: engine goes rich (lambda drops below target)
        richOvershoot = ((target - minLambda) / target) * 100;
    }

    var peakError = isTipIn ? leanSpike : richOvershoot;

    return {
        leanSpike: Math.round(leanSpike * 10) / 10,
        richOvershoot: Math.round(richOvershoot * 10) / 10,
        recoveryTime: recoveryTime || (windowMs),
        peakError: Math.round(peakError * 10) / 10,
    };
}

// ---------------------------------------------------------------------------
// Recommendations Generator
// ---------------------------------------------------------------------------

function generateRecommendations(events, settings) {
    var recs = [];
    var tipIns = events.filter(function(e) { return e.type === 'tip-in'; });
    var tipOuts = events.filter(function(e) { return e.type === 'tip-out'; });

    // Analyze tip-in lean spikes by MAP zone
    var leanByZone = {};
    tipIns.forEach(function(e) {
        var zone = Math.floor(e.mapTo / 20) * 20; // group by 20 kPa bands
        if (!leanByZone[zone]) leanByZone[zone] = [];
        leanByZone[zone].push(e.leanSpike);
    });

    var severeZones = [];
    Object.keys(leanByZone).forEach(function(zone) {
        var spikes = leanByZone[zone];
        var avg = spikes.reduce(function(a, b) { return a + b; }, 0) / spikes.length;
        if (avg > 5) severeZones.push({ zone: parseInt(zone), avg: avg, count: spikes.length });
    });

    if (severeZones.length > 0) {
        severeZones.sort(function(a, b) { return b.avg - a.avg; });
        severeZones.forEach(function(z) {
            var severity = z.avg > 10 ? 'critical' : 'warning';
            recs.push({
                severity: severity,
                text: 'Fuel Film Primary too low at ' + z.zone + '-' + (z.zone + 20) + ' kPa: avg lean spike ' + z.avg.toFixed(1) + '% across ' + z.count + ' events. Increase fuel film primary values in this MAP range.'
            });
        });
    }

    // Analyze rich overshoot
    var avgRichTipIn = 0;
    if (tipIns.length > 0) {
        avgRichTipIn = tipIns.reduce(function(a, e) { return a + e.richOvershoot; }, 0) / tipIns.length;
    }
    if (avgRichTipIn > 5) {
        recs.push({
            severity: 'warning',
            text: 'Rich overshoot after tip-in: avg ' + avgRichTipIn.toFixed(1) + '%. After the initial lean spike corrects, fueling goes too rich before settling. This means the fuel film compensation is being applied too aggressively or held too long. Suggested fix: reduce the Fast Decrease Time Constant (controls how quickly the initial burst of compensation is removed).'
        });
    }

    // Analyze tip-out rich
    if (tipOuts.length > 0) {
        var avgRichTipOut = tipOuts.reduce(function(a, e) { return a + e.richOvershoot; }, 0) / tipOuts.length;
        if (avgRichTipOut > 5) {
            recs.push({
                severity: 'warning',
                text: 'Rich on tip-out: avg ' + avgRichTipOut.toFixed(1) + '%. When throttle closes, the engine goes rich because fuel film is evaporating off the walls but the compensation is not removing fuel quickly enough. Suggested fix: reduce the Slow Decrease Time Constant (controls how quickly the sustained compensation is removed when MAP drops).'
            });
        }
    }

    // Recovery time analysis
    var avgRecovery = 0;
    if (tipIns.length > 0) {
        avgRecovery = tipIns.reduce(function(a, e) { return a + e.recoveryTime; }, 0) / tipIns.length;
    }
    if (avgRecovery > 500) {
        recs.push({
            severity: 'info',
            text: 'Slow lambda recovery: averaging ' + Math.round(avgRecovery) + 'ms to settle within 2% of target after throttle transients. This means the fuel film model is taking too long to reach the correct compensation level. Suggested fix: reduce the Slow Increase Time Constant (controls how quickly the sustained compensation ramps up to its full value after a tip-in).'
        });
    }

    // Suggested time constant values based on measured behavior AND current values
    if (tipIns.length > 3) {
        var tc = settings.currentTimeConstants || {};
        var curFastInc = tc.fastIncrease || 0.2;
        var curFastDec = tc.fastDecrease || 0.3;
        var curSlowInc = tc.slowIncrease || 0.5;
        var curSlowDec = tc.slowDecrease || 0.3;
        var curFastPct = tc.fastPct || 30;

        var tipOutRich = tipOuts.length > 0 ? tipOuts.reduce(function(a,e){return a+e.richOvershoot;},0)/tipOuts.length : 0;

        var sugFastIncrease = Math.max(0.05, curFastInc * 0.5);
        var sugFastDecrease = avgRichTipIn > 5 ? Math.max(0.05, curFastDec * 0.5) : curFastDec;
        var sugSlowIncrease = avgRecovery > 800 ? Math.max(0.1, curSlowInc * 0.5) : avgRecovery > 500 ? Math.max(0.1, curSlowInc * 0.7) : curSlowInc;
        var sugSlowDecrease = tipOutRich > 5 ? Math.max(0.05, curSlowDec * 0.5) : curSlowDec;
        var sugFastPct = avgRichTipIn > 8 ? Math.max(10, curFastPct - 10) : avgRichTipIn > 3 ? curFastPct : Math.min(50, curFastPct + 5);

        var tcText = 'Suggested time constants (current → suggested): ';
        tcText += 'Fast Increase: ' + curFastInc + 's → ' + sugFastIncrease.toFixed(2) + 's, ';
        tcText += 'Fast Decrease: ' + curFastDec + 's → ' + sugFastDecrease.toFixed(2) + 's, ';
        tcText += 'Slow Increase: ' + curSlowInc + 's → ' + sugSlowIncrease.toFixed(2) + 's, ';
        tcText += 'Slow Decrease: ' + curSlowDec + 's → ' + sugSlowDecrease.toFixed(2) + 's, ';
        tcText += 'Fast Percentage: ' + curFastPct + '% → ' + sugFastPct + '%. ';
        tcText += 'Apply changes incrementally and re-log to verify.';

        recs.push({ severity: 'info', text: tcText });
    }

    // Detect timing mismatch pattern: both lean spikes AND rich overshoot are significant
    // This indicates the compensation magnitude may be correct but the timing (time constants)
    // don't match the actual fuel film dynamics. Increasing scale/table values makes BOTH worse.
    if (tipIns.length > 3) {
        var avgLeanSpike = tipIns.reduce(function(a, e) { return a + e.leanSpike; }, 0) / tipIns.length;
        if (avgLeanSpike > 3 && avgRichTipIn > 3) {
            // Both directions are off — this is a timing problem, not a magnitude problem
            var severity = (avgLeanSpike > 8 && avgRichTipIn > 8) ? 'critical' : 'warning';
            recs.unshift({
                severity: severity,
                text: 'TIMING MISMATCH DETECTED: Both lean spikes (' + avgLeanSpike.toFixed(1) + '%) AND rich overshoot (' + avgRichTipIn.toFixed(1) + '%) are present on tip-in events. This pattern means the fuel film compensation is arriving too late and then hanging too long — increasing the table values or scale will make BOTH directions worse. Do NOT increase the primary table or scale. Instead: (1) Reduce the Slow Increase Time Constant so compensation arrives sooner and catches the lean spike earlier. (2) Reduce the Slow Decrease Time Constant so compensation is removed faster, preventing the rich overshoot. (3) For DI engines, time constants should be very short (0.1–0.2s) since fuel film effects are much faster than port injection.'
            });
        }
    }

    // Good state
    if (recs.length === 0) {
        recs.push({
            severity: 'good',
            text: 'Transient fueling looks well-calibrated. Lean spikes and rich overshoot are within acceptable limits across all MAP zones.'
        });
    }

    return recs;
}

// ---------------------------------------------------------------------------
// Main Analysis Function
// ---------------------------------------------------------------------------

function analyzeTransients(logText, settings) {
    var samples = parseTransientLog(logText, null);

    if (samples.length < 100) {
        throw new Error('Not enough data in log (' + samples.length + ' samples). Need at least 100.');
    }

    return analyzeTransientSamples(samples, settings);
}

/**
 * Analyze transients from a .ld binary file.
 * Uses parseLdFile from the knock worker (included via script tag).
 */
function analyzeTransientsLd(buffer, settings) {
    // parseLdFile returns { columnNames, data, maxFreq }
    var parsed = parseLdFile(buffer, null);
    var columnNames = parsed.columnNames;
    var data = parsed.data;

    // Resolve channel indices (lowercase match)
    var colLower = columnNames.map(function(n) { return n.toLowerCase(); });
    var timeIdx = colLower.indexOf('time');
    var mapIdx = colLower.indexOf('inlet manifold pressure');
    var lb1Idx = colLower.indexOf('exhaust lambda bank 1');
    var lb2Idx = colLower.indexOf('exhaust lambda bank 2');
    var lavgIdx = colLower.indexOf('exhaust lambda');
    var ltIdx = colLower.indexOf('fuel mixture aim');
    var rpmIdx = colLower.indexOf('engine speed');
    var tpsIdx = colLower.indexOf('throttle position');
    var coolIdx = colLower.indexOf('coolant temperature');

    if (timeIdx === -1) throw new Error('.ld file: "Time" channel not found.');
    if (mapIdx === -1) throw new Error('.ld file: "Inlet Manifold Pressure" channel not found.');
    if (lb1Idx === -1 && lb2Idx === -1 && lavgIdx === -1) throw new Error('.ld file: No lambda channel found.');

    // Convert row-based data to sample objects
    var samples = [];
    for (var i = 0; i < data.length; i++) {
        var row = data[i];
        var time = row[timeIdx];
        var map = row[mapIdx];
        if (isNaN(time) || isNaN(map)) continue;

        var lb1 = lb1Idx >= 0 ? row[lb1Idx] : NaN;
        var lb2 = lb2Idx >= 0 ? row[lb2Idx] : NaN;
        var lavg = lavgIdx >= 0 ? row[lavgIdx] : NaN;
        var lambda;
        if (!isNaN(lb1) && !isNaN(lb2) && lb1 > 0 && lb2 > 0) lambda = (lb1 + lb2) / 2;
        else if (!isNaN(lb1) && lb1 > 0) lambda = lb1;
        else if (!isNaN(lb2) && lb2 > 0) lambda = lb2;
        else lambda = lavg;

        samples.push({
            time: time,
            map: map,
            lambda: lambda,
            lambdaTarget: ltIdx >= 0 ? row[ltIdx] : NaN,
            rpm: rpmIdx >= 0 ? row[rpmIdx] : NaN,
            tps: tpsIdx >= 0 ? row[tpsIdx] : NaN,
            coolant: coolIdx >= 0 ? row[coolIdx] : NaN,
        });
    }

    if (samples.length < 100) {
        throw new Error('Not enough valid data in .ld file (' + samples.length + ' samples).');
    }

    return analyzeTransientSamples(samples, settings);
}

/**
 * Common analysis pipeline for both CSV and .ld parsed samples.
 */
function analyzeTransientSamples(samples, settings) {

    // Filter: only warm engine
    var warmSamples = samples.filter(function(s) {
        return isNaN(s.coolant) || s.coolant > 60;
    });

    var events = detectTransientEvents(warmSamples, settings);
    var recommendations = generateRecommendations(events, settings);

    var tipIns = events.filter(function(e) { return e.type === 'tip-in'; });
    var tipOuts = events.filter(function(e) { return e.type === 'tip-out'; });

    return {
        totalSamples: samples.length,
        warmSamples: warmSamples.length,
        totalEvents: events.length,
        tipInCount: tipIns.length,
        tipOutCount: tipOuts.length,
        avgLeanSpike: tipIns.length > 0 ? tipIns.reduce(function(a, e) { return a + e.leanSpike; }, 0) / tipIns.length : 0,
        avgRichOvershoot: tipIns.length > 0 ? tipIns.reduce(function(a, e) { return a + e.richOvershoot; }, 0) / tipIns.length : 0,
        avgRecoveryTime: tipIns.length > 0 ? tipIns.reduce(function(a, e) { return a + e.recoveryTime; }, 0) / tipIns.length : 0,
        tipIns: tipIns.sort(function(a, b) { return b.leanSpike - a.leanSpike; }),
        tipOuts: tipOuts.sort(function(a, b) { return b.richOvershoot - a.richOvershoot; }),
        recommendations: recommendations,
    };
}
