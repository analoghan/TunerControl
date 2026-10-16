/**
 * transient-fuel/worker.js — Transient Fuel Film Analyzer
 *
 * Detects throttle transient events (tip-in / tip-out) in MoTeC logs
 * and measures lambda excursions to diagnose fuel film calibration.
 *
 * Key metrics per event:
 *   - Lean spike (% leaner than where lambda settles afterwards) — fuel film primary too low
 *   - Rich overshoot (% richer than where lambda settles) — compensation too late/long or too large
 *   - Recovery time (ms from event start until lambda is back within 2%)
 *   Events overlapping overrun or a fuel cut are skipped.
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
    OVERRUN: 'engine overrun state',     // optional: non-zero during overrun fuel cut
    FUEL_CUT: 'fuel output cut count',   // optional: changes when a fuel cut happens (8-bit, wraps)
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
    var overrunIdx = colNames.indexOf(TRANSIENT_CHANNELS.OVERRUN);
    var cutIdx = colNames.indexOf(TRANSIENT_CHANNELS.FUEL_CUT);

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
            overrunState: overrunIdx >= 0 ? parseFloat(fields[overrunIdx]) : NaN,
            fuelCutCount: cutIdx >= 0 ? parseFloat(fields[cutIdx]) : NaN,
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
    var skippedFuelCut = 0;
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

            var excursion = totalMapChange >= minMapChange ? measureLambdaExcursion(samples, i, j, isTipIn, defaultTarget) : null;
            if (totalMapChange >= minMapChange && !excursion) skippedFuelCut++;
            if (excursion) {
                var target = !isNaN(samples[j].lambdaTarget) && samples[j].lambdaTarget > 0.5 ? samples[j].lambdaTarget : defaultTarget;

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
                    leanAfter: excursion.leanAfter,
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

    events.skippedFuelCut = skippedFuelCut;
    return events;
}

/** Lambda above this is a fuel cut / free-air reading, not combustion. */
var TF_CUT_LAMBDA = 1.5;
/** Seconds before an event checked for overrun / fuel cut (lambda still reads the cut afterwards). */
var TF_CUT_HOLDOFF_S = 1.0;
/** Seconds at the end of the window used as the settled lambda (the reference for the excursion). */
var TF_SETTLE_S = 0.5;
/** Seconds after the MAP change ends that lambda is followed. */
var TF_WINDOW_S = 1.5;
/** Lambda within this fraction of the baseline counts as recovered. */
var TF_SETTLED = 0.02;

function tfRatio(s, defaultTarget) {
    var target = !isNaN(s.lambdaTarget) && s.lambdaTarget > 0.5 ? s.lambdaTarget : defaultTarget;
    return !isNaN(s.lambda) && s.lambda > 0 ? s.lambda / target : NaN;
}

function tfCutAt(samples, k) {
    var s = samples[k], p = k > 0 ? samples[k - 1] : null;
    return (!isNaN(s.overrunState) && s.overrunState !== 0) ||
        (p && !isNaN(s.fuelCutCount) && !isNaN(p.fuelCutCount) && s.fuelCutCount !== p.fuelCutCount) ||   // 8-bit counter: may wrap
        (!isNaN(s.lambda) && s.lambda > TF_CUT_LAMBDA);
}

/**
 * Measures the lambda excursion of one transient, from its start until TF_WINDOW_S after MAP settles.
 * Lambda is used as measured / target (so a changing target, e.g. into boost, is accounted for) and compared
 * with where it settles at the end of the window — the steady-state error at the destination load is a VE
 * matter, not fuel film. Returns null when overrun or a fuel cut overlaps the event (its lambda is not
 * combustion).
 */
function measureLambdaExcursion(samples, startIdx, endIdx, isTipIn, defaultTarget) {
    var t0 = samples[startIdx].time, tEnd = samples[endIdx].time + TF_WINDOW_S, k;
    for (k = startIdx; k >= 0 && samples[k].time >= t0 - TF_CUT_HOLDOFF_S; k--) if (tfCutAt(samples, k)) return null;
    for (k = startIdx; k < samples.length && samples[k].time <= tEnd; k++) if (tfCutAt(samples, k)) return null;

    var raw = [];
    for (k = startIdx; k < samples.length && samples[k].time <= tEnd; k++) {
        var r = tfRatio(samples[k], defaultTarget);
        if (!isNaN(r)) raw.push({ t: samples[k].time, r: r });
    }
    var settled = raw.filter(function (p) { return p.t >= tEnd - TF_SETTLE_S; }).map(function (p) { return p.r; }).sort(function (a, b) { return a - b; });
    var base = settled.length ? settled[Math.floor(settled.length / 2)] : 1;
    var pts = raw.map(function (p) { return { t: p.t, r: p.r / base }; });
    if (!pts.length) return { leanSpike: 0, richOvershoot: 0, leanAfter: 0, recoveryTime: Math.round((tEnd - t0) * 1000), peakError: 0, baseline: base };

    var iMax = 0, iMin = 0;
    pts.forEach(function (p, i) { if (p.r > pts[iMax].r) iMax = i; if (p.r < pts[iMin].r) iMin = i; });
    var lean = Math.max(0, (pts[iMax].r - 1) * 100), rich, leanAfter = 0;
    if (isTipIn) {
        // Rich overshoot = going rich after the lean peak (compensation arriving late and staying too long).
        var minAfter = Infinity;
        for (k = iMax + 1; k < pts.length; k++) if (pts[k].r < minAfter) minAfter = pts[k].r;
        rich = minAfter < Infinity ? Math.max(0, (1 - minAfter) * 100) : 0;
    } else {
        rich = Math.max(0, (1 - pts[iMin].r) * 100);
        for (k = iMin + 1; k < pts.length; k++) leanAfter = Math.max(leanAfter, (pts[k].r - 1) * 100);
    }
    // Recovery: from the event start until lambda is back within TF_SETTLED after its largest deviation.
    var iDev = 0;
    pts.forEach(function (p, i) { if (Math.abs(p.r - 1) > Math.abs(pts[iDev].r - 1)) iDev = i; });
    var recovery = Math.abs(pts[iDev].r - 1) < TF_SETTLED ? 0 : null;
    for (k = iDev; recovery === null && k < pts.length; k++) {
        if (Math.abs(pts[k].r - 1) < TF_SETTLED) recovery = Math.round((pts[k].t - t0) * 1000);
    }
    function r1(v) { return Math.round(v * 10) / 10; }
    return {
        leanSpike: r1(isTipIn ? lean : 0),
        richOvershoot: r1(rich),
        leanAfter: r1(leanAfter),
        recoveryTime: recovery !== null ? recovery : Math.round((tEnd - t0) * 1000),
        peakError: r1(isTipIn ? lean : rich),
        baseline: base
    };
}

// ---------------------------------------------------------------------------
// Recommendations Generator
// ---------------------------------------------------------------------------

function generateRecommendations(events, settings) {
    var recs = [];
    var tipIns = events.filter(function (e) { return e.type === 'tip-in'; });
    var tipOuts = events.filter(function (e) { return e.type === 'tip-out'; });
    function avg(list, f) { return list.length ? list.reduce(function (a, e) { return a + f(e); }, 0) / list.length : 0; }

    // Tip-in error by destination MAP zone (20 kPa bands).
    var zones = {};
    tipIns.forEach(function (e) {
        var z = Math.floor(e.mapTo / 20) * 20;
        (zones[z] = zones[z] || []).push(e);
    });
    var leanZones = [], richZones = [];
    Object.keys(zones).forEach(function (z) {
        var list = zones[z], lean = avg(list, function (e) { return e.leanSpike; }), rich = avg(list, function (e) { return e.richOvershoot; });
        if (lean > 5 && rich <= 3) leanZones.push({ zone: +z, avg: lean, count: list.length });
        if (rich > 5 && lean <= 3) richZones.push({ zone: +z, avg: rich, count: list.length });
    });
    leanZones.sort(function (a, b) { return b.avg - a.avg; }).forEach(function (z) {
        recs.push({ severity: z.avg > 10 ? 'critical' : 'warning',
            text: 'Fuel Film Primary too low at ' + z.zone + '-' + (z.zone + 20) + ' kPa: tip-ins into this range run lean by ' + z.avg.toFixed(1) +
                '% on average (' + z.count + ' events) without going rich afterwards. Increase the fuel film primary values in this MAP range.' });
    });
    richZones.sort(function (a, b) { return b.avg - a.avg; }).forEach(function (z) {
        recs.push({ severity: 'warning',
            text: 'Fuel Film Primary too high at ' + z.zone + '-' + (z.zone + 20) + ' kPa: tip-ins into this range run rich by ' + z.avg.toFixed(1) +
                '% on average (' + z.count + ' events) without a lean spike first. Reduce the fuel film primary values in this MAP range.' });
    });

    var avgLean = avg(tipIns, function (e) { return e.leanSpike; });
    var avgRichTipIn = avg(tipIns, function (e) { return e.richOvershoot; });
    var avgRecovery = avg(tipIns, function (e) { return e.recoveryTime; });
    var tipOutRich = avg(tipOuts, function (e) { return e.richOvershoot; });
    var tipOutLean = avg(tipOuts, function (e) { return e.leanAfter || 0; });
    var mismatch = tipIns.length > 3 && avgLean > 3 && avgRichTipIn > 3;

    if (mismatch) {
        recs.unshift({ severity: avgLean > 8 && avgRichTipIn > 8 ? 'critical' : 'warning',
            text: 'TIMING MISMATCH: tip-ins run lean (' + avgLean.toFixed(1) + '%) and then rich (' + avgRichTipIn.toFixed(1) + '%). The amount of ' +
                'compensation is about right but it arrives too late and lasts too long, so raising the table or scale would make the rich side worse. ' +
                'Shorten the Increase time constants (Fast and Slow) and/or raise the Fast Percentage so more of the compensation is delivered at once. ' +
                'On a tip-in the film is growing, so only the Increase constants act; the Decrease constants act on tip-out.' });
    }
    if (tipOuts.length && tipOutRich > 5) {
        recs.push({ severity: 'warning',
            text: 'Rich on tip-out: ' + tipOutRich.toFixed(1) + '% on average. As the throttle closes, fuel leaving the port walls is not being taken ' +
                'out quickly enough. Shorten the Decrease time constants (Fast and Slow).' });
    }
    if (tipOuts.length && tipOutLean > 5) {
        recs.push({ severity: 'warning',
            text: 'Lean after tip-out: ' + tipOutLean.toFixed(1) + '% on average. The compensation removes fuel faster than the wall film actually ' +
                'releases it. Lengthen the Decrease time constants, or check that the fuel film primary values are not too high.' });
    }
    if (tipIns.length && avgRecovery > 500 && avgLean > 3) {
        recs.push({ severity: 'info',
            text: 'Slow recovery: lambda takes ' + Math.round(avgRecovery) + 'ms on average to settle within 2% after tip-ins. If the lean ' +
                'spikes last, the compensation is building too slowly — shorten the Slow Increase time constant.' });
    }

    // Suggested time constants: only change the ones the data points to.
    if (tipIns.length > 3) {
        var tc = settings.currentTimeConstants || {};
        var cur = { fastInc: tc.fastIncrease || 0.2, fastDec: tc.fastDecrease || 0.3, slowInc: tc.slowIncrease || 0.5,
                    slowDec: tc.slowDecrease || 0.3, fastPct: tc.fastPct || 30 };
        var sug = Object.assign({}, cur);
        if (mismatch) { sug.fastInc = cur.fastInc * 0.7; sug.slowInc = cur.slowInc * 0.7; sug.fastPct = Math.min(60, cur.fastPct + 10); }
        if (avgLean > 3 && avgRecovery > 800) sug.slowInc = Math.min(sug.slowInc, cur.slowInc * 0.5);
        else if (avgLean > 3 && avgRecovery > 500) sug.slowInc = Math.min(sug.slowInc, cur.slowInc * 0.7);
        if (tipOuts.length && tipOutRich > 5) { sug.fastDec = cur.fastDec * 0.7; sug.slowDec = cur.slowDec * 0.7; }
        else if (tipOuts.length && tipOutLean > 5) { sug.fastDec = cur.fastDec * 1.3; sug.slowDec = cur.slowDec * 1.3; }
        var names = { fastInc: 'Fast Increase', fastDec: 'Fast Decrease', slowInc: 'Slow Increase', slowDec: 'Slow Decrease', fastPct: 'Fast Percentage' };
        var changes = Object.keys(names).filter(function (k) { return Math.abs(sug[k] - cur[k]) > 1e-9; }).map(function (k) {
            return k === 'fastPct' ? names[k] + ': ' + cur[k] + '% → ' + sug[k] + '%'
                : names[k] + ': ' + cur[k] + 's → ' + Math.max(0.02, sug[k]).toFixed(2) + 's';
        });
        if (changes.length) {
            recs.push({ severity: 'info', text: 'Suggested time constants (current → suggested): ' + changes.join(', ') +
                '. Others unchanged. Apply changes in small steps and re-log to verify.' });
        }
    }

    if (recs.length === 0) {
        recs.push({ severity: 'good',
            text: 'Transient fueling looks well-calibrated. Lean spikes and rich overshoot are within acceptable limits across all MAP zones.' });
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
    var overrunIdx = colLower.indexOf('engine overrun state');
    var cutIdx = colLower.indexOf('fuel output cut count');

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
            overrunState: overrunIdx >= 0 ? row[overrunIdx] : NaN,
            fuelCutCount: cutIdx >= 0 ? row[cutIdx] : NaN,
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
    var minCoolant = typeof settings.minCoolant === 'number' && !isNaN(settings.minCoolant) ? settings.minCoolant : 60;
    var warmSamples = samples.filter(function(s) {
        return isNaN(s.coolant) || s.coolant > minCoolant;
    });

    var events = detectTransientEvents(warmSamples, settings);
    var recommendations = generateRecommendations(events, settings);

    var tipIns = events.filter(function(e) { return e.type === 'tip-in'; });
    var tipOuts = events.filter(function(e) { return e.type === 'tip-out'; });

    return {
        totalSamples: samples.length,
        warmSamples: warmSamples.length,
        totalEvents: events.length,
        skippedFuelCut: events.skippedFuelCut || 0,
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
