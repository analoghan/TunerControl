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
    var minMapChange = settings.minMapChange || 15; // kPa total
    var defaultTarget = settings.lambdaTarget || 1.0;

    var events = [];
    var i = 0;

    while (i < samples.length - 10) {
        var s = samples[i];
        var sNext = samples[i + 1];
        if (!sNext || isNaN(s.map) || isNaN(sNext.map)) { i++; continue; }

        var dt = sNext.time - s.time;
        if (dt <= 0) { i++; continue; }

        var mapRate = (sNext.map - s.map) / dt;

        // Detect tip-in (positive MAP rate) or tip-out (negative MAP rate)
        if (Math.abs(mapRate) >= mapRateThreshold) {
            var isTipIn = mapRate > 0;
            var eventStart = i;
            var mapAtStart = s.map;
            var timeAtStart = s.time;

            // Find the end of the transient (MAP rate drops below threshold)
            var j = i + 1;
            while (j < samples.length - 1) {
                var dtj = samples[j + 1].time - samples[j].time;
                if (dtj <= 0) { j++; continue; }
                var rate = (samples[j + 1].map - samples[j].map) / dtj;
                if (isTipIn && rate < mapRateThreshold * 0.3) break;
                if (!isTipIn && rate > -mapRateThreshold * 0.3) break;
                j++;
            }

            var mapAtEnd = samples[j].map;
            var totalMapChange = Math.abs(mapAtEnd - mapAtStart);

            if (totalMapChange >= minMapChange) {
                // Measure lambda excursion in the window after the transient
                var target = !isNaN(samples[j].lambdaTarget) && samples[j].lambdaTarget > 0.5 ? samples[j].lambdaTarget : defaultTarget;
                var excursion = measureLambdaExcursion(samples, j, target, isTipIn);

                events.push({
                    type: isTipIn ? 'tip-in' : 'tip-out',
                    time: timeAtStart,
                    rpm: !isNaN(s.rpm) ? Math.round(s.rpm) : 0,
                    mapFrom: Math.round(mapAtStart),
                    mapTo: Math.round(mapAtEnd),
                    mapChange: Math.round(totalMapChange),
                    mapRate: Math.round(Math.abs(mapRate)),
                    lambdaTarget: target,
                    leanSpike: excursion.leanSpike,
                    richOvershoot: excursion.richOvershoot,
                    recoveryTime: excursion.recoveryTime,
                    peakError: excursion.peakError,
                });
            }

            i = j + 10; // skip past this event
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

function generateRecommendations(events) {
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

    // Suggested time constant values based on measured behavior
    if (tipIns.length > 3) {
        var suggestedFastIncrease, suggestedFastDecrease, suggestedSlowIncrease, suggestedSlowDecrease;

        // Fast increase: should be quick enough to catch the initial lean spike
        // If avg lean spike duration is short, fast needs to be very quick
        suggestedFastIncrease = 0.1; // always aggressive

        // Fast decrease: if rich overshoot is present, decrease faster
        suggestedFastDecrease = avgRichTipIn > 5 ? 0.1 : 0.2;

        // Slow increase: based on recovery time
        suggestedSlowIncrease = avgRecovery > 800 ? 0.3 : avgRecovery > 500 ? 0.5 : 0.8;

        // Slow decrease: based on tip-out rich
        var tipOutRich = tipOuts.length > 0 ? tipOuts.reduce(function(a,e){return a+e.richOvershoot;},0)/tipOuts.length : 0;
        suggestedSlowDecrease = tipOutRich > 5 ? 0.1 : 0.3;

        recs.push({
            severity: 'info',
            text: 'Suggested time constants based on this log: Fast Increase = ' + suggestedFastIncrease + 's, Fast Decrease = ' + suggestedFastDecrease + 's, Slow Increase = ' + suggestedSlowIncrease + 's, Slow Decrease = ' + suggestedSlowDecrease + 's. Fast Percentage = ' + (avgRichTipIn > 8 ? '15' : avgRichTipIn > 3 ? '25' : '35') + '%. These are starting points — fine-tune by re-logging after each change.'
        });
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
    var recommendations = generateRecommendations(events);

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
