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
 *   Events overlapping a fuel cut are skipped: the overrun cut (Engine Overrun State Enabled), the injectors switched
 *   off without it (pulse width 0 — on an M1 usually Minimum Volume), a fuel cut count change or lambda reading air.
 *   - MAP transition zone (from → to kPa)
 *   Lifts: a tip-out followed within TF_LIFT_MAX_S by a reopening (a gear shift or a short lift) is one 'lift' event, not a
 *   tip-out and a tip-in — the reopening's lambda starts from the lift's, so judged alone it reads as "rich, then lean".
 *   Measured: rich during the lift (vs lambda before it) and lean after the reopening (vs where lambda settles).
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
    PW: 'fuel cylinder 1 primary output pulse width 1',   // optional: 0 while the injectors are switched off
    CL_B1: 'fuel closed loop control bank 1 trim',        // optional: closed-loop activity during events
    CL_B2: 'fuel closed loop control bank 2 trim',
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
    var pwIdx = colNames.indexOf(TRANSIENT_CHANNELS.PW);
    var cl1Idx = colNames.indexOf(TRANSIENT_CHANNELS.CL_B1), cl2Idx = colNames.indexOf(TRANSIENT_CHANNELS.CL_B2);

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
            pw: pwIdx >= 0 ? parseFloat(fields[pwIdx]) : NaN,
            clTrim: tfClTrim(cl1Idx >= 0 ? parseFloat(fields[cl1Idx]) : NaN, cl2Idx >= 0 ? parseFloat(fields[cl2Idx]) : NaN),
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

    var events = [], starts = [];   // starts: sample index of each event, for pairing lifts
    var skippedFuelCut = 0, skipped = [];
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
            var troughMap = mapAtStart, troughIdx = i;
            while (j < samples.length - 1) {
                if (isNaN(samples[j].map)) { j++; continue; }
                if (samples[j].map > peakMap) peakMap = samples[j].map;
                if (samples[j].map < troughMap) { troughMap = samples[j].map; troughIdx = j; }

                // MAP falling, then turning back up (a lift and reopening): the fall ends at the trough; the rise is the next event.
                if (mapAtStart - troughMap >= minMapChange / 2 && samples[j].map - troughMap >= TF_REVERSAL_KPA) { j = troughIdx; break; }

                // Check if MAP has stabilized: rate over the last TF_SETTLE_MAP_S near zero (logs hold 10 Hz MAP at 100 Hz, so this
                // spans two MAP readings)
                var jb = j;
                while (jb > i && samples[j].time - samples[jb].time < TF_SETTLE_MAP_S) jb--;
                var dtj = samples[j].time - samples[jb].time;
                if (dtj >= TF_SETTLE_MAP_S - 1e-6) {
                    var recentRate = Math.abs(samples[j].map - samples[jb].map) / dtj;
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

            var excursion = totalMapChange >= minMapChange ?
                measureLambdaExcursion(samples, i, j, isTipIn, defaultTarget, isTipIn ? null : Math.min(mapAtEnd, troughMap) + TF_REVERSAL_KPA) : null;
            if (totalMapChange >= minMapChange && !excursion) {
                skippedFuelCut++;
                skipped.push({ type: isTipIn ? 'tip-in' : 'tip-out', time: timeAtStart, endTime: samples[j].time,
                    rpm: !isNaN(s.rpm) ? Math.round(s.rpm) : null, mapFrom: Math.round(mapAtStart), mapTo: Math.round(mapAtEnd),
                    reason: tfCutReasonBetween(samples, timeAtStart - TF_CUT_HOLDOFF_S, samples[j].time + TF_WINDOW_S) });
            }
            if (excursion) {
                var target = !isNaN(samples[j].lambdaTarget) && samples[j].lambdaTarget > 0.5 ? samples[j].lambdaTarget : defaultTarget;
                // How far the closed-loop trim moved during the event (null when not logged).
                var clLo = Infinity, clHi = -Infinity;
                for (var q = i; q < samples.length && samples[q].time <= excursion.windowEnd; q++) {
                    if (!isNaN(samples[q].clTrim)) { clLo = Math.min(clLo, samples[q].clTrim); clHi = Math.max(clHi, samples[q].clTrim); }
                }

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
                    richBefore: excursion.richBefore,
                    leanAfter: excursion.leanAfter,
                    mapPeak: Math.round(isTipIn ? peakMap : troughMap),
                    recoveryTime: excursion.recoveryTime,
                    settled: excursion.settled,
                    peakError: excursion.peakError,
                    endTime: samples[j].time,
                    windowEnd: excursion.windowEnd,
                    baseline: excursion.baseline,
                    clRange: clHi >= clLo ? Math.round((clHi - clLo) * 10) / 10 : null,
                    nearIdle: !isNaN(s.rpm) && s.rpm < TF_NEAR_IDLE_RPM,
                });
                starts.push(i);

                lastEventEndIdx = j + 5;
            }

            i = j + 5; // skip past event
        } else {
            i++;
        }
    }

    var paired = tfPairLifts(samples, events, starts, minMapChange, defaultTarget, skipped);
    paired.skippedFuelCut = skipped.length;   // including lifts over a fuel cut
    paired.skipped = skipped;
    return paired;
}

/** MAP has settled when it changed less than 20 % of the MAP rate threshold over this long (s). */
var TF_SETTLE_MAP_S = 0.2;
/** MAP rising this far (kPa) from its low during a falling event ends the event at the low. */
var TF_REVERSAL_KPA = 5;
/** A tip-in is the reopening of a lift when MAP was minMapChange higher at most this long before it began to rise. */
var TF_LIFT_MAX_S = 1.5;
/** Lambda lags the throttle: the lift's rich side is looked for until this long after the reopening. */
var TF_LIFT_TAIL_S = 0.2;
/** The reopening's lean side is looked for this long after it. */
var TF_REOPEN_S = 1.0;
/** A tip-out starting within this long after a tip-in makes both a blip. */
var TF_BLIP_S = 1.0;
/** Lambda more than this fraction off counts towards the rich / lean duration. */
var TF_LIFT_DEV = 0.05;

/**
 * The lift before the tip-in starting at sample i, or null: { k (last sample with MAP minMapChange above the reopening's start —
 * the lift is timed from there), kMax (the highest MAP in the TF_PRE_S before k), liftS (k → i) }.
 */
function tfFindLift(samples, i, minMapChange) {
    var t0 = samples[i].time, m0 = samples[i].map, ks = -1, k;
    for (k = i - 1; k >= 0 && samples[k].time >= t0 - TF_LIFT_MAX_S; k--) {
        if (samples[k].map >= m0 + minMapChange) { ks = k; break; }
    }
    if (ks < 0) return null;
    var kMax = ks;
    for (k = ks - 1; k >= 0 && samples[k].time >= samples[ks].time - TF_PRE_S; k--) if (samples[k].map > samples[kMax].map) kMax = k;
    return { k: ks, kMax: kMax, liftS: t0 - samples[ks].time };
}

/**
 * Replaces each tip-in that reopens a lift (and the lift's own tip-out) with one 'lift' event. A lift overlapping a fuel cut
 * is added to `skipped`. Returns the remaining events with `.lifts`.
 */
function tfPairLifts(samples, events, starts, minMapChange, defaultTarget, skipped) {
    var drop = {}, lifts = [], k;
    function r1(v) { return Math.round(v * 10) / 10; }
    events.forEach(function (e, n) {
        if (e.type !== 'tip-in') return;
        var i = starts[n], lift = tfFindLift(samples, i, minMapChange);
        if (!lift) return;
        var tLift = samples[lift.k].time, tTop = samples[lift.kMax].time, t0 = e.time;
        events.forEach(function (o, m) { if (o.type === 'tip-out' && o.time >= tTop - 0.2 && o.time < t0) drop[m] = true; });
        for (k = skipped.length - 1; k >= 0; k--) if (skipped[k].type === 'tip-out' && skipped[k].time >= tTop - 0.2 && skipped[k].time < t0) skipped.splice(k, 1);
        drop[n] = true;
        // The tip-in's own window was checked for cuts; check the lift before it.
        var cut = null;
        for (k = lift.k; k >= 0 && samples[k].time >= tLift - TF_CUT_HOLDOFF_S && !cut; k--) cut = tfCutReason(samples, k);
        for (k = lift.k; k < i && !cut; k++) cut = tfCutReason(samples, k);
        var mapLow = Infinity;
        for (k = lift.k; k <= i; k++) if (samples[k].map < mapLow) mapLow = samples[k].map;
        var base = { type: 'lift', time: tLift, reopenTime: t0, endTime: e.endTime, rpm: e.rpm, mapFrom: Math.round(samples[lift.kMax].map),
                     mapLow: Math.round(mapLow), mapTo: e.mapTo, liftS: Math.round(lift.liftS * 100) / 100 };
        if (cut) {
            skipped.push(Object.assign(base, { reason: tfCutReasonBetween(samples, tLift - TF_CUT_HOLDOFF_S, t0) || cut }));
            return;
        }
        // Rich during the lift, against lambda just before it.
        var pre = [];
        for (k = lift.k - 1; k >= 0 && samples[k].time >= tLift - TF_PRE_S; k--) {
            var pr = tfRatio(samples[k], defaultTarget);
            if (!isNaN(pr)) pre.push(pr);
        }
        pre.sort(function (a, b) { return a - b; });
        var preLevel = pre.length ? pre[Math.floor(pre.length / 2)] : 1;
        var rich = 0, richS = 0, lean = 0, leanS = 0, clLo = Infinity, clHi = -Infinity;
        for (k = lift.k; k < samples.length && samples[k].time <= e.windowEnd; k++) {
            var s = samples[k], r = tfRatio(s, defaultTarget), dt = k + 1 < samples.length ? samples[k + 1].time - s.time : 0;
            if (!isNaN(s.clTrim)) { clLo = Math.min(clLo, s.clTrim); clHi = Math.max(clHi, s.clTrim); }
            if (isNaN(r)) continue;
            if (s.time <= t0 + TF_LIFT_TAIL_S) {
                rich = Math.max(rich, (1 - r / preLevel) * 100);
                if (r / preLevel < 1 - TF_LIFT_DEV) richS += dt;
            }
            if (s.time >= t0 && s.time <= t0 + TF_REOPEN_S) {
                lean = Math.max(lean, (r / e.baseline - 1) * 100);
                if (r / e.baseline > 1 + TF_LIFT_DEV) leanS += dt;
            }
        }
        lifts.push(Object.assign(base, {
            richDuring: r1(rich), richS: Math.round(richS * 100) / 100, leanAfter: r1(lean), leanS: Math.round(leanS * 100) / 100,
            lambdaTarget: e.lambdaTarget, windowEnd: e.windowEnd, baseline: e.baseline, preLevel: preLevel,
            clRange: clHi >= clLo ? r1(clHi - clLo) : null, nearIdle: e.nearIdle
        }));
    });
    var out = events.filter(function (e, n) { return !drop[n]; });
    // A tip-in that MAP falls straight back from (a blip, e.g. a rev-match on a downshift): neither half is a film test on its own.
    out.forEach(function (e) {
        if (e.type !== 'tip-in') return;
        var back = out.concat(skipped).filter(function (o) { return o.type === 'tip-out' && o.time > e.time && o.time < e.time + TF_BLIP_S; });
        if (back.length) { e.blip = true; back.forEach(function (o) { o.blip = true; }); }
    });
    out.lifts = lifts;
    return out;
}

/** Lambda above this is a fuel cut / free-air reading, not combustion. */
var TF_CUT_LAMBDA = 1.5;
/** Engine Overrun State value for the overrun fuel cut (0 Disabled, 1 Retard Ignition, 2 Enabled, 3 Advance Ignition). */
var TF_OVERRUN_ENABLED = 2;
/** Below this engine speed the lambda sensor is too slow to read film effects (MoTeC: calibrate film at 1500-2000 rpm). */
var TF_NEAR_IDLE_RPM = 1300;
/** A closed-loop trim moving more than this (%) during an event means closed loop was correcting it. */
var TF_CL_ACTIVE_PCT = 2;
/** Seconds before an event checked for overrun / fuel cut (lambda still reads the cut afterwards). */
var TF_CUT_HOLDOFF_S = 1.0;
/** Seconds at the end of the window used as the settled lambda (the reference for the excursion). */
var TF_SETTLE_S = 0.5;
/** Seconds before an event used as the level lambda starts from. */
var TF_PRE_S = 0.5;
/** Seconds after the MAP change ends that lambda is followed. */
var TF_WINDOW_S = 1.5;
/** Lambda within this fraction of the baseline counts as recovered. */
var TF_SETTLED = 0.02;

function tfRatio(s, defaultTarget) {
    var target = !isNaN(s.lambdaTarget) && s.lambdaTarget > 0.5 ? s.lambdaTarget : defaultTarget;
    return !isNaN(s.lambda) && s.lambda > 0 ? s.lambda / target : NaN;
}

/** Mean of the closed-loop trims that are logged (NaN when neither is). */
function tfClTrim(a, b) {
    if (!isNaN(a) && !isNaN(b)) return (a + b) / 2;
    return !isNaN(a) ? a : b;
}

/**
 * Why sample k is a fuel cut, or null: 'overrun' (Engine Overrun State Enabled — Retard/Advance Ignition only move the
 * timing), 'injection-off' (pulse width 0 with the engine running and no overrun cut — on an M1 usually Minimum Volume),
 * 'cut-count' (Fuel Output Cut Count changed) or 'air' (lambda reading air).
 */
function tfCutReason(samples, k) {
    var s = samples[k], p = k > 0 ? samples[k - 1] : null;
    if (!isNaN(s.overrunState) && Math.round(s.overrunState) === TF_OVERRUN_ENABLED) return 'overrun';
    if (!isNaN(s.pw) && s.pw <= 0.05 && !(s.rpm < 400)) return 'injection-off';
    if (p && !isNaN(s.fuelCutCount) && !isNaN(p.fuelCutCount) && s.fuelCutCount !== p.fuelCutCount) return 'cut-count';   // 8-bit counter: may wrap
    if (!isNaN(s.lambda) && s.lambda > TF_CUT_LAMBDA) return 'air';
    return null;
}

function tfCutAt(samples, k) { return tfCutReason(samples, k) !== null; }

/** The strongest cut reason between times t0 and t1 (overrun > injection-off > cut-count > air), or null. */
function tfCutReasonBetween(samples, t0, t1) {
    var rank = { overrun: 4, 'injection-off': 3, 'cut-count': 2, air: 1 }, best = null;
    for (var k = 0; k < samples.length; k++) {
        if (samples[k].time < t0) continue;
        if (samples[k].time > t1) break;
        var r = tfCutReason(samples, k);
        if (r && (!best || rank[r] > rank[best])) best = r;
    }
    return best;
}

/**
 * Measures the lambda excursion of one transient, from its start until TF_WINDOW_S after MAP settles.
 * Lambda is used as measured / target (so a changing target, e.g. into boost, is accounted for) and compared
 * with where it settles at the end of the window — the steady-state error at the destination load is a VE
 * matter, not fuel film. Returns null when overrun or a fuel cut overlaps the event (its lambda is not
 * combustion).
 */
function measureLambdaExcursion(samples, startIdx, endIdx, isTipIn, defaultTarget, reopenMap) {
    var t0 = samples[startIdx].time, tEnd = samples[endIdx].time + TF_WINDOW_S, k;
    for (k = startIdx; k >= 0 && samples[k].time >= t0 - TF_CUT_HOLDOFF_S; k--) if (tfCutAt(samples, k)) return null;
    for (k = startIdx; k < samples.length && samples[k].time <= tEnd; k++) if (tfCutAt(samples, k)) return null;

    var raw = [];
    for (k = startIdx; k < samples.length && samples[k].time <= tEnd; k++) {
        var r = tfRatio(samples[k], defaultTarget);
        if (!isNaN(r)) raw.push({ t: samples[k].time, r: r, map: samples[k].map });
    }
    var settled = raw.filter(function (p) { return p.t >= tEnd - TF_SETTLE_S; }).map(function (p) { return p.r; }).sort(function (a, b) { return a - b; });
    var base = settled.length ? settled[Math.floor(settled.length / 2)] : 1;
    var pts = raw.map(function (p) { return { t: p.t, r: p.r / base, map: p.map }; });

    // Where lambda was just before the event, relative to where it settles. A spike or dip only counts beyond both
    // levels, so a steady difference between the start and end loads (a VE matter) is not mistaken for one.
    var pre = [];
    for (k = startIdx - 1; k >= 0 && samples[k].time >= t0 - TF_PRE_S; k--) {
        var pr = tfRatio(samples[k], defaultTarget);
        if (!isNaN(pr)) pre.push(pr / base);
    }
    pre.sort(function (a, b) { return a - b; });
    var preLevel = pre.length ? pre[Math.floor(pre.length / 2)] : 1;
    var hi = Math.max(preLevel, 1), lo = Math.min(preLevel, 1);
    if (!pts.length) {
        return { leanSpike: 0, richOvershoot: 0, richBefore: 0, leanAfter: 0, recoveryTime: Math.round((tEnd - t0) * 1000), settled: false, peakError: 0,
                 baseline: base, windowEnd: tEnd };
    }

    var iMax = 0, iMin = 0;
    pts.forEach(function (p, i) { if (p.r > pts[iMax].r) iMax = i; if (p.r < pts[iMin].r) iMin = i; });
    var lean = Math.max(0, (pts[iMax].r / hi - 1) * 100), rich, leanAfter = 0, richBefore = 0;
    if (isTipIn) {
        // Rich before the lean peak: the compensation came in too strongly at first (or MAP overshot), so the
        // lean spike that follows is not a shortage of fuel film.
        for (k = 0; k < iMax; k++) richBefore = Math.max(richBefore, (1 - pts[k].r / lo) * 100);
        // Rich overshoot = going rich after the lean peak (compensation arriving late and staying too long).
        var minAfter = Infinity;
        for (k = iMax + 1; k < pts.length; k++) if (pts[k].r < minAfter) minAfter = pts[k].r;
        rich = minAfter < Infinity ? Math.max(0, (1 - minAfter) * 100) : 0;
    } else {
        rich = Math.max(0, (1 - pts[iMin].r / lo) * 100);
        // Lean after the tip-out, until the throttle opens again (MAP back up TF_REVERSAL_KPA from its low): that lean is the
        // reopening's, not the tip-out's.
        for (k = iMin + 1; k < pts.length; k++) {
            if (reopenMap !== null && reopenMap !== undefined && pts[k].map > reopenMap) break;
            leanAfter = Math.max(leanAfter, (pts[k].r - 1) * 100);
        }
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
        richBefore: r1(richBefore),
        leanAfter: r1(leanAfter),
        recoveryTime: recovery !== null ? recovery : Math.round((tEnd - t0) * 1000),   // not settled: the window length
        settled: recovery !== null,
        peakError: r1(isTipIn ? lean : rich),
        baseline: base,
        windowEnd: tEnd
    };
}

// ---------------------------------------------------------------------------
// Recommendations Generator
// ---------------------------------------------------------------------------

/** A tip-in that went rich (> TF_RICH_FIRST %) before its lean peak. */
var TF_RICH_FIRST = 3;
/** MAP rising this far past where it settles counts as an overshoot. */
var TF_MAP_OVERSHOOT_KPA = 5;

function isRichFirst(e) { return e.type === 'tip-in' && (e.richBefore || 0) > TF_RICH_FIRST; }
function mapOvershoot(e) { return e.mapPeak !== undefined ? Math.max(0, e.mapPeak - e.mapTo) : 0; }

/** Fewest tip-ins into a 20 kPa zone (and into a Fuel Film table site) the film amount is judged from. */
var TF_MIN_ZONE_EVENTS = 3;
/** Fewest lifts (above idle) the lift advice is given from. */
var TF_LIFT_MIN_EVENTS = 3;
/** Median rich during the lift and lean after the reopening (%) above which the lift advice is given. */
var TF_LIFT_ERR = 5;

function tfMedian(v) { v = v.slice().sort(function (a, b) { return a - b; }); return v.length ? v[Math.floor(v.length / 2)] : 0; }

/**
 * Advice from the lifts (gear shifts and short lifts): { recs, slowDec (suggested Slow Decrease s, or undefined) }. Rich during the
 * lift and lean after reopening both point at the Decrease constants: the model takes the film out more slowly than the wall film
 * really leaves, so the lift runs rich, and at the reopening the model still holds film that has gone, so it adds too little.
 */
function tfLiftAdvice(lifts, tc) {
    var out = { recs: [] };
    var used = lifts.filter(function (e) { return !e.nearIdle; });
    if (!used.length) return out;
    var rich = tfMedian(used.map(function (e) { return e.richDuring; })), lean = tfMedian(used.map(function (e) { return e.leanAfter; }));
    var liftS = tfMedian(used.map(function (e) { return e.liftS; })), leanS = tfMedian(used.map(function (e) { return e.leanS; }));
    var withCl = used.filter(function (e) { return e.clRange !== null && e.clRange !== undefined; });
    var cl = withCl.length ? tfMedian(withCl.map(function (e) { return e.clRange; })) : null;
    var both = used.filter(function (e) { return e.richDuring > TF_LIFT_ERR && e.leanAfter > TF_LIFT_ERR; }).length;
    var facts = used.length + ' lift' + (used.length === 1 ? '' : 's') + ' and reopenings (gear shifts or short lifts, median ' + liftS.toFixed(2) +
        ' s from MAP falling to the reopening): median ' + rich.toFixed(1) + '% rich during the lift and ' + lean.toFixed(1) + '% lean for ' +
        leanS.toFixed(2) + ' s after reopening' + (cl !== null ? '; the closed-loop trim moved a median ' + cl.toFixed(1) + '% per lift' : '') + '.';
    if (used.length < TF_LIFT_MIN_EVENTS) {
        out.recs.push({ severity: 'info', text: facts + ' Too few to judge the Decrease time constants from (need ' + TF_LIFT_MIN_EVENTS + ').' });
        return out;
    }
    var sd = typeof tc.slowDecrease === 'number' ? tc.slowDecrease : null;
    function released(t) { return Math.round((1 - Math.exp(-liftS / t)) * 100); }
    if (rich > TF_LIFT_ERR && lean > TF_LIFT_ERR) {
        var text = 'RICH DURING THE LIFT, LEAN AFTER REOPENING: ' + facts + ' ' + both + ' of ' + used.length + ' lifts show both. ' +
            'This is the film model releasing fuel more slowly than the wall film really leaves (on direct injection the film is on the piston and ' +
            'cylinder wall): fuel comes off faster than the model takes it out, so the lift runs rich; at the reopening the model still holds ' +
            'film that has already gone, so it adds too little and the engine runs lean. The Decrease time constants set this (they act whenever ' +
            'the film shrinks). ';
        if (sd !== null) {
            var sug = Math.max(0.1, Math.round(sd * (sd > 1 ? 0.4 : 0.7) * 20) / 20);
            out.slowDec = sug;
            text += 'With Slow Decrease ' + sd + ' s the model releases only ' + released(sd) + '% of the slow film in a ' + liftS.toFixed(2) + ' s lift. ' +
                'Suggested: Fuel Film Primary Slow Decrease Time Constant ' + sd + ' s → ' + sug + ' s (' + released(sug) + '% released), one step, ' +
                'leaving the film table and the Increase constants alone. Then re-log the same kind of shifts: both sides should shrink together. ' +
                'Trade-off: a shorter Decrease also empties the model faster on long lifts (coasting, then back on), which can turn lean on that ' +
                'reopening — watch the lifts longer than about 2 s.';
        } else {
            text += 'Shorten the Slow Decrease time constant in a step and re-log the same kind of shifts.';
        }
        if (cl !== null && cl > TF_CL_ACTIVE_PCT) text += ' Closed loop was moving during the lifts, so confirm with closed loop off.';
        out.recs.push({ severity: rich > 10 || lean > 10 ? 'critical' : 'warning', text: text });
    } else if (rich > TF_LIFT_ERR) {
        out.recs.push({ severity: 'warning', text: 'Rich during lifts: ' + facts + ' The film comes off the walls faster than the model takes it ' +
            'out, without a lean reopening after it. Shorten the Decrease time constants in a small step' +
            (sd !== null ? ' (Slow Decrease ' + sd + ' s releases ' + released(sd) + '% of the slow film in a ' + liftS.toFixed(2) + ' s lift)' : '') + '.' });
    } else if (lean > TF_LIFT_ERR) {
        out.recs.push({ severity: 'warning', text: 'Lean after reopening: ' + facts + ' The lift itself is not rich, so the film model is not ' +
            'holding on too long. Either the film at the reopened load is too low (check the plain tip-ins into that load: lean there too → ' +
            'raise Fuel Film Primary Main), or the Decrease constants empty the model faster than the wall film really leaves (plain tip-ins ' +
            'fine → lengthen the Decrease time constants).' });
    } else {
        out.recs.push({ severity: 'good', text: 'Lifts and reopenings look good: ' + facts });
    }
    return out;
}

function generateRecommendations(events, settings) {
    var recs = [];
    var allTipIns = events.filter(function (e) { return e.type === 'tip-in'; });
    var allTipOuts = events.filter(function (e) { return e.type === 'tip-out'; });
    // Events near idle are reported but left out of the advice: the lambda sensor is too slow there to read film effects.
    var tipIns = allTipIns.filter(function (e) { return !e.nearIdle && !e.blip; });
    var tipOuts = allTipOuts.filter(function (e) { return !e.nearIdle && !e.blip; });
    function avg(list, f) { return list.length ? list.reduce(function (a, e) { return a + f(e); }, 0) / list.length : 0; }
    function median(list) { var v = list.slice().sort(function (a, b) { return a - b; }); return v.length ? v[Math.floor(v.length / 2)] : 0; }
    var tune = settings.tuneFilm || null;

    // Injection cuts without the overrun cut (Minimum Volume): these events are skipped, but they are the off-throttle
    // "lean spikes" and the film decrease often causes them.
    var offCuts = (events.skipped || []).filter(function (e) { return e.reason === 'injection-off'; });
    if (offCuts.length >= 3) {
        var rpms = offCuts.map(function (e) { return e.rpm; }).filter(function (v) { return v !== null; });
        recs.push({ severity: 'warning',
            text: 'INJECTORS SWITCHED OFF on ' + offCuts.length + ' transients (mostly tip-outs' + (rpms.length ? ', around ' + median(rpms) + ' rpm' : '') +
                ') without the overrun fuel cut: the injector pulse width went to 0, so lambda read air. On an M1 this is Fuel Injector ' +
                'Primary Minimum Volume' + (tune && tune.minVolume ? ' (' + tune.minVolume + ' µl, hysteresis ' + tune.minVolumeHysteresis + ' µl)' : '') +
                ': when any cylinder\'s request falls below it, all injectors stop until every cylinder is above Minimum Volume + Hysteresis. ' +
                'The film model takes fuel out as MAP falls, which can push the request below the minimum — longer Decrease time constants ' +
                'spread that over more cycles; set Minimum Volume from the injector data and raise the Hysteresis to stop on/off cycling. ' +
                'These events are left out of the analysis (Skipped).' });
    }

    // Closed loop working during the events makes the bounce partly the lambda control's own.
    var withCl = allTipIns.concat(allTipOuts).filter(function (e) { return e.clRange !== null && e.clRange !== undefined; });
    var clActive = withCl.filter(function (e) { return e.clRange > TF_CL_ACTIVE_PCT; });
    if (withCl.length >= 5 && clActive.length >= withCl.length / 3) {
        recs.push({ severity: 'info',
            text: 'Closed loop was correcting during ' + clActive.length + ' of ' + withCl.length + ' events (trim moved more than ' + TF_CL_ACTIVE_PCT +
                '%). Part of a rich-then-lean bounce can be the lambda control chasing the transient, and it hides the film error. ' +
                'MoTeC calibrates the fuel film with closed loop disabled — log the film tests with Fuel Closed Loop Mode off.' });
    }

    var blips = allTipIns.filter(function (e) { return e.blip && !e.nearIdle; });
    if (blips.length) {
        recs.push({ severity: 'info',
            text: blips.length + ' tip-in' + (blips.length === 1 ? '' : 's') + ' above idle fell straight back within ' + TF_BLIP_S + ' s (throttle blips, ' +
                'e.g. rev-matching): the tip-in and its tip-out are left out of the advice, as neither is a film test on its own.' });
    }
    var nearIdle = allTipIns.concat(allTipOuts).filter(function (e) { return e.nearIdle; });
    if (nearIdle.length) {
        recs.push({ severity: 'info',
            text: nearIdle.length + ' events start below ' + TF_NEAR_IDLE_RPM + ' rpm and are left out of the advice and table corrections: near idle ' +
                'the lambda sensor responds too slowly to read film effects (MoTeC calibrates the film at a steady 1500-2000 rpm).' });
    }

    // Tune settings against the firmware's typical ranges.
    var tcIn = settings.currentTimeConstants || {}, tc = {};
    Object.keys(tcIn).forEach(function (k) { tc[k] = typeof tcIn[k] === 'number' ? +tcIn[k].toFixed(3) : tcIn[k]; });
    var clMostly = withCl.length >= 5 && clActive.length >= withCl.length / 2;
    var outOfRange = [];
    [['Fast Increase', tc.fastIncrease, 0.1, 1], ['Fast Decrease', tc.fastDecrease, 0.1, 1],
     ['Slow Increase', tc.slowIncrease, 0.5, 3], ['Slow Decrease', tc.slowDecrease, 0.5, 3]].forEach(function (c) {
        if (typeof c[1] === 'number' && (c[1] < c[2] - 1e-9 || c[1] > c[3] + 1e-9)) outOfRange.push(c[0] + ' ' + c[1] + ' s (typical ' + c[2] + '–' + c[3] + ' s)');
    });
    if (outOfRange.length) {
        recs.push({ severity: 'info',
            text: 'Time constants outside the firmware\'s typical range at a 2000 rpm reference: ' + outOfRange.join(', ') +
                '. Shorter constants put more of the compensation into the first cycles, which makes a rich-then-lean bounce more likely.' });
    }
    if (typeof tc.slowDecrease === 'number' && typeof tc.fastDecrease === 'number' && tc.slowDecrease < tc.fastDecrease) {
        recs.push({ severity: 'info',
            text: 'Slow Decrease (' + tc.slowDecrease + ' s) is shorter than Fast Decrease (' + tc.fastDecrease + ' s), so on tip-out the "slow" part ' +
                'of the film leaves first. Make the slow constants the longer ones.' });
    }
    if (tune && tune.refSpeedRpm && tune.speedTrimAtRefPct !== null && Math.abs(tune.speedTrimAtRefPct) > 1) {
        recs.push({ severity: 'info',
            text: 'Reference Engine Speed is ' + tune.refSpeedRpm + ' rpm but Trim Engine Speed is ' + (tune.speedTrimAtRefPct > 0 ? '+' : '') +
                tune.speedTrimAtRefPct.toFixed(1) + '% there. Main is calibrated at the reference speed, where the speed trim should be 0 (100 %); ' +
                'make the reference speed the one you test at and zero the trim there.' });
    }

    var tcLift = settings.currentTimeConstants || {};
    var liftAdvice = tfLiftAdvice(events.lifts || [], tcLift);
    recs = recs.concat(liftAdvice.recs);

    // Tip-ins that go rich before their lean peak: the lean spike follows too much fuel up front (or a MAP
    // overshoot), so they say nothing about the film being too low and are left out of the zone and table advice.
    var richFirst = tipIns.filter(isRichFirst);
    var overshoot = richFirst.filter(function (e) { return mapOvershoot(e) >= TF_MAP_OVERSHOOT_KPA; });
    if (richFirst.length >= 2) {
        var rfRich = avg(richFirst, function (e) { return e.richBefore; }), rfLean = avg(richFirst, function (e) { return e.leanSpike; });
        recs.push({ severity: 'warning',
            text: 'RICH, THEN LEAN on ' + richFirst.length + ' of ' + tipIns.length + ' tip-ins: lambda first goes rich (' + rfRich.toFixed(1) +
                '% on average) and only then lean (' + rfLean.toFixed(1) + '%). The lean spike follows too much fuel up front, so it is not a ' +
                'shortage of fuel film; these events are left out of the "too low" advice and the table corrections. ' +
                (overshoot.length ? 'In ' + overshoot.length + ' of them MAP overshoots its final value by ' +
                    avg(overshoot, mapOvershoot).toFixed(0) + ' kPa on average: the film model adds fuel for the peak and takes it back as MAP ' +
                    'falls, so look at the throttle (or boost) overshoot first. ' : '') +
                'If MAP does not overshoot, the first part of the compensation is too strong: lower the Fast Percentage or lengthen the ' +
                'Fast Increase time constant.' });
    }

    // Tip-in error by destination MAP zone (20 kPa bands).
    var zones = {};
    tipIns.filter(function (e) { return !isRichFirst(e); }).forEach(function (e) {
        var z = Math.floor(e.mapTo / 20) * 20;
        (zones[z] = zones[z] || []).push(e);
    });
    var leanZones = [], richZones = [];
    Object.keys(zones).forEach(function (z) {
        var list = zones[z], lean = avg(list, function (e) { return e.leanSpike; }), rich = avg(list, function (e) { return e.richOvershoot; });
        if (list.length < TF_MIN_ZONE_EVENTS) return;   // one or two events are not enough to change the table
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
    var unsettled = tipIns.filter(function (e) { return e.settled === false; }).length;
    var tipOutRich = avg(tipOuts, function (e) { return e.richOvershoot; });
    var tipOutLean = avg(tipOuts, function (e) { return e.leanAfter || 0; });
    var mismatch = tipIns.length > 3 && avgLean > 5 && avgRichTipIn > 5;
    var enoughOuts = tipOuts.length >= TF_MIN_ZONE_EVENTS, nOuts = ' (' + tipOuts.length + ' tip-outs above idle)';
    // Mostly rich-then-lean without MAP overshoot: the up-front compensation is too strong.
    var tooStrongFirst = !mismatch && tipIns.length > 3 && richFirst.length - overshoot.length >= tipIns.length / 2;

    if (mismatch) {
        recs.unshift({ severity: avgLean > 8 && avgRichTipIn > 8 ? 'critical' : 'warning',
            text: 'TIMING MISMATCH: tip-ins run lean (' + avgLean.toFixed(1) + '%) and then rich (' + avgRichTipIn.toFixed(1) + '%). The amount of ' +
                'compensation is about right but it arrives too late and lasts too long, so raising the table or scale would make the rich side worse. ' +
                (clMostly ? 'Closed loop was correcting during most events, so part of this may be the lambda control — confirm with closed loop off first. ' : '') +
                'Shorten the Increase time constants (Fast and Slow) and/or raise the Fast Percentage so more of the compensation is delivered at once. ' +
                'On a tip-in the film is growing, so only the Increase constants act; the Decrease constants act on tip-out.' });
    }
    if (enoughOuts && tipOutRich > 5) {
        recs.push({ severity: 'warning',
            text: 'Rich on tip-out: ' + tipOutRich.toFixed(1) + '% on average' + nOuts + '. As the throttle closes, fuel coming off the walls (piston and ' +
                'cylinder on direct injection, ports on port injection) is not being taken out quickly enough. Shorten the Decrease time ' +
                'constants (Fast and Slow), or check the Main values between the starting and ending MAP.' });
    }
    if (enoughOuts && tipOutLean > 5) {
        recs.push({ severity: 'warning',
            text: 'Lean after tip-out: ' + tipOutLean.toFixed(1) + '% on average' + nOuts + '. The compensation removes fuel faster than the wall film actually ' +
                'releases it. Lengthen the Decrease time constants, or check that the fuel film primary values are not too high.' +
                (liftAdvice.slowDec !== undefined ? ' The lifts point the other way (shorten Slow Decrease); they are the more direct test of the ' +
                    'Decrease constants, so make that change first and see whether this lean remains.' : '') });
    }
    if (tipIns.length && avgRecovery > 500 && avgLean > 3) {
        recs.push({ severity: 'info',
            text: 'Slow recovery: lambda takes ' + Math.round(avgRecovery) + 'ms on average to settle within 2% after tip-ins' +
                (unsettled ? ' (' + unsettled + ' of ' + tipIns.length + ' never settled and are counted at the window length)' : '') + '. ' +
                (clMostly ? 'Closed loop was correcting during most events, so this is largely the lambda control settling — judge recovery with closed loop off.'
                    : 'If the lean spikes last, the compensation is building too slowly — shorten the Slow Increase time constant.') });
    }

    // Suggested time constants: only change the ones the data points to.
    // Not while closed loop was correcting most events: the lambda trace is then partly the lambda control's.
    if (tipIns.length > 3 && !clMostly) {
        var cur = { fastInc: tc.fastIncrease || 0.2, fastDec: tc.fastDecrease || 0.3, slowInc: tc.slowIncrease || 0.5,
                    slowDec: tc.slowDecrease || 0.3, fastPct: tc.fastPct || 30 };
        var sug = Object.assign({}, cur);
        if (mismatch) { sug.fastInc = cur.fastInc * 0.7; sug.slowInc = cur.slowInc * 0.7; sug.fastPct = Math.min(60, cur.fastPct + 10); }
        if (tooStrongFirst) { sug.fastInc = cur.fastInc * 1.3; sug.fastPct = Math.max(0, cur.fastPct - 10); }
        if (!clMostly && avgLean > 3 && avgRecovery > 800) sug.slowInc = Math.min(sug.slowInc, cur.slowInc * 0.5);
        else if (!clMostly && avgLean > 3 && avgRecovery > 500) sug.slowInc = Math.min(sug.slowInc, cur.slowInc * 0.7);
        // The lifts judge the Decrease constants more directly than plain tip-outs: their suggestion stands on its own.
        if (liftAdvice.slowDec !== undefined) { /* see the lift advice */ }
        else if (enoughOuts && tipOutRich > 5) { sug.fastDec = cur.fastDec * 0.7; sug.slowDec = cur.slowDec * 0.7; }
        else if (enoughOuts && tipOutLean > 5) { sug.fastDec = cur.fastDec * 1.3; sug.slowDec = cur.slowDec * 1.3; }
        // Never suggest shortening a constant that is already at or below the firmware's typical minimum.
        var minimum = { fastInc: 0.1, fastDec: 0.1, slowInc: 0.5, slowDec: 0.5 };
        Object.keys(minimum).forEach(function (k) { if (sug[k] < cur[k] && cur[k] <= minimum[k] + 1e-9) sug[k] = cur[k]; });
        var names = { fastInc: 'Fast Increase', fastDec: 'Fast Decrease', slowInc: 'Slow Increase', slowDec: 'Slow Decrease', fastPct: 'Fast Percentage' };
        var changes = Object.keys(names).filter(function (k) { return Math.abs(sug[k] - cur[k]) > 1e-9; }).map(function (k) {
            return k === 'fastPct' ? names[k] + ': ' + +cur[k].toFixed(1) + '% → ' + +sug[k].toFixed(1) + '%'
                : names[k] + ': ' + cur[k] + 's → ' + Math.max(0.02, sug[k]).toFixed(2) + 's';
        });
        if (changes.length) {
            recs.push({ severity: 'info', text: 'Suggested time constants (current → suggested): ' + changes.join(', ') +
                '. Others unchanged. Apply changes in small steps and re-log to verify.' });
        }
    }

    if (recs.every(function (r) { return r.severity === "good"; })) {
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
 * Uses parseLdFile from lib/ld-parser.js (loaded by the page before this file).
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
    var pwIdx = colLower.indexOf(TRANSIENT_CHANNELS.PW);
    var cl1Idx = colLower.indexOf(TRANSIENT_CHANNELS.CL_B1), cl2Idx = colLower.indexOf(TRANSIENT_CHANNELS.CL_B2);

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
            pw: pwIdx >= 0 ? row[pwIdx] : NaN,
            clTrim: tfClTrim(cl1Idx >= 0 ? row[cl1Idx] : NaN, cl2Idx >= 0 ? row[cl2Idx] : NaN),
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
        totalEvents: events.length + (events.lifts || []).length,
        skippedFuelCut: events.skippedFuelCut || 0,
        skipped: events.skipped || [],
        skippedByReason: (events.skipped || []).reduce(function (acc, e) { var r = e.reason || 'other'; acc[r] = (acc[r] || 0) + 1; return acc; }, {}),
        nearIdleEvents: events.filter(function (e) { return e.nearIdle; }).length,
        unsettledTipIns: tipIns.filter(function(e) { return e.settled === false; }).length,
        richFirstTipIns: tipIns.filter(isRichFirst).length,
        tipInCount: tipIns.length,
        tipOutCount: tipOuts.length,
        avgLeanSpike: tipIns.length > 0 ? tipIns.reduce(function(a, e) { return a + e.leanSpike; }, 0) / tipIns.length : 0,
        avgRichOvershoot: tipIns.length > 0 ? tipIns.reduce(function(a, e) { return a + e.richOvershoot; }, 0) / tipIns.length : 0,
        avgRecoveryTime: tipIns.length > 0 ? tipIns.reduce(function(a, e) { return a + e.recoveryTime; }, 0) / tipIns.length : 0,
        tipIns: tipIns.sort(function(a, b) { return b.leanSpike - a.leanSpike; }),
        tipOuts: tipOuts.sort(function(a, b) { return b.richOvershoot - a.richOvershoot; }),
        lifts: (events.lifts || []).slice().sort(function (a, b) { return a.time - b.time; }),
        liftCount: (events.lifts || []).length,
        liftRichMedian: tfMedian((events.lifts || []).filter(function (e) { return !e.nearIdle; }).map(function (e) { return e.richDuring; })),
        liftLeanMedian: tfMedian((events.lifts || []).filter(function (e) { return !e.nearIdle; }).map(function (e) { return e.leanAfter; })),
        recommendations: recommendations,
    };
}
