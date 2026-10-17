/**
 * charge-cooling/cc-analysis.js — Charge cooling gain from lambda step tests (no DOM; used by app.js and the tests).
 *
 * The test (MoTeC M1 training 42a/47/103): closed loop off, at idle, step Fuel Mixture Aim richer (e.g. 1.00 → 0.90) and back.
 * If measured lambda follows the aim, Engine Charge Cooling Gain Primary is right. If the mixture stays LEANER than the new aim
 * on a rich step, the gain is too low → raise it; if it goes RICHER, the gain is too high → lower it. (With the corrections
 * zeroed the M1's charge temperature is the inlet air temperature minus the gain: 26.6 °C − 13 °C = 13.6 °C in the training.)
 * The training adjusts the gain about 2 °C at a time and repeats the step until lambda tracks within about 0.01.
 *
 * ccAnalyze(columnNames, rows, opts) → { steps, usable, rejected, verdict, ... }
 *   opts: { currentGain (°C, optional) }
 * A step is a change of the aim by at least CC_MIN_STEP between two stretches where it holds still for CC_HOLD s. Lambda is
 * compared before and after the step, so a VE error at the starting point cancels out:
 *   tracking = (λ after / λ before) ÷ (aim after / aim before) − 1     (+ = leaner than the aim change asked for)
 * A step is used only when closed loop is off (trims within CC_TRIM_OFF %), and engine speed and manifold pressure are steady.
 */

var CC_MIN_STEP = 0.03, CC_HOLD = 3, CC_SETTLE = 1.5, CC_BASE = 2, CC_TRIM_OFF = 0.5, CC_RPM_STEADY = 150, CC_MAP_STEADY = 5;
var CC_OK = 0.005, CC_GAIN_STEP = 2;

function ccFind(columnNames, candidates) {
    var lower = columnNames.map(function (n) { return String(n).toLowerCase().trim(); });
    for (var c = 0; c < candidates.length; c++) {
        var i = lower.indexOf(candidates[c].toLowerCase());
        if (i >= 0) return i;
    }
    return -1;
}

function ccMean(values) {
    var v = values.filter(function (x) { return !isNaN(x); });
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : NaN;
}

function ccRange(values) {
    var v = values.filter(function (x) { return !isNaN(x); });
    return v.length ? Math.max.apply(null, v) - Math.min.apply(null, v) : 0;
}

function ccAnalyze(columnNames, rows, opts) {
    opts = opts || {};
    var ix = {
        time: ccFind(columnNames, ['Time']), aim: ccFind(columnNames, ['Fuel Mixture Aim']),
        b1: ccFind(columnNames, ['Exhaust Lambda Bank 1']), b2: ccFind(columnNames, ['Exhaust Lambda Bank 2']), avg: ccFind(columnNames, ['Exhaust Lambda']),
        t1: ccFind(columnNames, ['Fuel Closed Loop Control Bank 1 Trim']), t2: ccFind(columnNames, ['Fuel Closed Loop Control Bank 2 Trim']),
        rpm: ccFind(columnNames, ['Engine Speed']), map: ccFind(columnNames, ['Inlet Manifold Pressure']),
        iat: ccFind(columnNames, ['Inlet Air Temperature', 'Airbox Temperature']), coolant: ccFind(columnNames, ['Coolant Temperature'])
    };
    if (ix.time === -1) throw new Error('Time channel not found.');
    if (ix.aim === -1) throw new Error('Fuel Mixture Aim channel not found — it is needed to find the steps of the test.');
    if (ix.b1 === -1 && ix.b2 === -1 && ix.avg === -1) throw new Error('No lambda channel found (Exhaust Lambda, or Bank 1 / Bank 2).');

    function lambdaAt(r) {
        var ok = function (v) { return v >= 0.6 && v <= 1.6; };   // 0 / 10 = sensor not ready
        var a = ix.b1 >= 0 ? r[ix.b1] : NaN, b = ix.b2 >= 0 ? r[ix.b2] : NaN;
        if (ok(a) && ok(b)) return (a + b) / 2;
        if (ok(a)) return a;
        if (ok(b)) return b;
        return ix.avg >= 0 && ok(r[ix.avg]) ? r[ix.avg] : NaN;
    }
    var t = function (i) { return rows[i][ix.time]; };

    // Stretches where the aim holds still (within 0.005) for at least CC_HOLD s.
    var holds = [], s = 0;
    for (var i = 1; i <= rows.length; i++) {
        var end = i === rows.length || isNaN(rows[i][ix.aim]) || Math.abs(rows[i][ix.aim] - rows[s][ix.aim]) > 0.005;
        if (!end) continue;
        if (!isNaN(rows[s][ix.aim]) && rows[s][ix.aim] > 0.5 && t(i - 1) - t(s) >= CC_HOLD) holds.push({ start: s, end: i - 1, aim: rows[s][ix.aim] });
        s = i;
    }

    function window(from, to) {
        var idx = [];
        for (var k = from; k <= to; k++) idx.push(k);
        var pick = function (col) { return col >= 0 ? idx.map(function (k) { return rows[k][col]; }) : []; };
        var trims = pick(ix.t1).concat(pick(ix.t2)).filter(function (v) { return !isNaN(v); });
        var lam = idx.map(function (k) { return lambdaAt(rows[k]); }).filter(function (v) { return !isNaN(v); });
        return { lambda: ccMean(lam), lambdaSeconds: lam.length * (t(to) - t(from)) / Math.max(1, idx.length - 1), aim: ccMean(pick(ix.aim)),
                 maxTrim: trims.length ? Math.max.apply(null, trims.map(Math.abs)) : null,
                 rpmRange: ccRange(pick(ix.rpm)), mapRange: ccRange(pick(ix.map)), rpm: ccMean(pick(ix.rpm)), map: ccMean(pick(ix.map)),
                 iat: ccMean(pick(ix.iat)), coolant: ccMean(pick(ix.coolant)) };
    }
    function indexAt(time, from, to) { for (var k = from; k <= to; k++) if (t(k) >= time) return k; return to; }

    var steps = [];
    for (var h = 1; h < holds.length; h++) {
        var a = holds[h - 1], b = holds[h];
        // A step: the aim moves by CC_MIN_STEP or more within 2 s (a slow drift is not a test step).
        if (Math.abs(b.aim - a.aim) < CC_MIN_STEP || t(b.start) - t(a.end) > 2) continue;
        var base = window(indexAt(t(a.end) - CC_BASE, a.start, a.end), a.end);
        var after = window(indexAt(t(b.start) + CC_SETTLE, b.start, b.end), b.end);
        var step = { time: t(b.start), from: a.aim, to: b.aim, rich: b.aim < a.aim, duration: t(b.end) - t(b.start), base: base, after: after };
        var why = [];
        if (base.lambdaSeconds < 1 || after.lambdaSeconds < 1) why.push('less than 1 s of valid lambda');
        var trim = Math.max(base.maxTrim || 0, after.maxTrim || 0);
        if (base.maxTrim !== null && trim > CC_TRIM_OFF) why.push('closed loop active (trims up to ' + trim.toFixed(1) + ' %)');
        if (ix.rpm >= 0 && Math.max(base.rpmRange, after.rpmRange) > CC_RPM_STEADY) why.push('engine speed not steady (moved ' + Math.round(Math.max(base.rpmRange, after.rpmRange)) + ' rpm)');
        if (ix.map >= 0 && Math.max(base.mapRange, after.mapRange) > CC_MAP_STEADY) why.push('manifold pressure not steady (moved ' + Math.max(base.mapRange, after.mapRange).toFixed(0) + ' kPa)');
        if (!why.length) {
            step.tracking = (after.lambda / base.lambda) / (after.aim / base.aim) - 1;
            // > 0: the gain is too low (rich step stays lean, or lean step goes rich).
            step.gainSignal = step.rich ? step.tracking : -step.tracking;
            step.baseError = base.lambda / base.aim - 1;
        }
        step.rejected = why;
        steps.push(step);
    }
    var usable = steps.filter(function (x) { return !x.rejected.length; });
    var result = { steps: steps, usable: usable.length, rejected: steps.length - usable.length, currentGain: opts.currentGain > 0 ? opts.currentGain : null,
                   trimsLogged: ix.t1 >= 0 || ix.t2 >= 0 };
    if (usable.length) {
        var signals = usable.map(function (x) { return x.gainSignal; }).sort(function (p, q) { return p - q; });
        result.signal = signals[Math.floor(signals.length / 2)];
        result.direction = result.signal > CC_OK ? 'raise' : result.signal < -CC_OK ? 'lower' : 'ok';
        result.consistent = signals.every(function (v) { return Math.abs(v) <= CC_OK; }) || signals.every(function (v) { return v > CC_OK; }) ||
            signals.every(function (v) { return v < -CC_OK; });
        result.iat = ccMean(usable.map(function (x) { return x.after.iat; }));
        result.baseError = ccMean(usable.map(function (x) { return x.baseError; }));
        if (result.currentGain !== null && result.direction !== 'ok') {
            result.nextGain = result.currentGain + (result.direction === 'raise' ? CC_GAIN_STEP : -CC_GAIN_STEP);
        }
    }
    return result;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { ccAnalyze: ccAnalyze };
