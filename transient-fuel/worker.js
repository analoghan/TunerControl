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
    var lines = text.split('\n').map(function(l) { return l.replace(/\r$/, ''); });

    // Find header row (first field = "Time", case-sensitive, handles quotes)
    var headerIdx = -1;
    for (var i = 0; i < Math.min(25, lines.length); i++) {
        var firstField = lines[i].split(',')[0].trim().replace(/^"|"$/g, '');
        if (firstField === 'Time') { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Could not find "Time" header in first 25 rows. Ensure this is a MoTeC M1 CSV or .ld export.');

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
                text: 'Fuel Film Primary too low at ' + z.zone + '-' + (z.zone + 20) + ' kPa: avg lean spike ' + z.avg.toFixed(1) + '% across ' + z.count + ' events. Increase fuel film primary values in this MAP range by approximately ' + Math.round(z.avg * 3) + '-' + Math.round(z.avg * 5) + '%.'
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
            text: 'Rich overshoot after tip-in: avg ' + avgRichTipIn.toFixed(1) + '%. The fast time constant decrease value may be too slow — fuel film compensation is hanging too long. Try reducing the fast decrease time constant (e.g., from 0.5 to 0.2).'
        });
    }

    // Analyze tip-out rich
    if (tipOuts.length > 0) {
        var avgRichTipOut = tipOuts.reduce(function(a, e) { return a + e.richOvershoot; }, 0) / tipOuts.length;
        if (avgRichTipOut > 5) {
            recs.push({
                severity: 'warning',
                text: 'Rich condition on tip-out: avg ' + avgRichTipOut.toFixed(1) + '%. The slow time constant decrease value may be too high — fuel film is not being removed quickly enough when throttle closes. Try reducing the slow decrease time constant.'
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
            text: 'Average recovery time: ' + Math.round(avgRecovery) + 'ms. Lambda takes over 500ms to settle after transients. Consider adjusting the slow time constant increase value to allow fuel film to build more quickly.'
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
