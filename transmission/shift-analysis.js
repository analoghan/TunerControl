/**
 * transmission/shift-analysis.js — Shift analysis for TurboLamik 8HP TCU logs (TunerPro RT .xdl / .csv).
 *
 * How the TCU logs a shift (checked on a V10.75 log): Gear Target changes when the shift is requested; the ratio
 * (Input RPM ÷ Output RPM) starts to move about 0.3–1 s later, once the oncoming clutch has filled and takes torque;
 * Gear changes only when the new ratio is reached. So a shift runs from the Gear Target change to the Gear change:
 *   delay        request → ratio starts moving (fill / torque phase)
 *   ratioChange  ratio moving → new gear's ratio reached (inertia phase; Time 1 Shift Time counts this part)
 *
 * tsaAnalyze(columnNames, rows, settings) → { summary, shifts, transitions, clutches, adaptation, findings, ratios, notes }
 *   rows: [[value per column]] with Time (s) first or in a "Time"/"Seconds" column; settings: bin settings (bin-reader.js
 *   readBinConfig().settings) or null. All durations come from timestamps, never from sample counts.
 * Per shift: { from, to, up, kind ('power' | 'light' | 'coast' | 'brake'), tReq, tMove, tSync, tEnd, delay, ratioChange, total,
 *   tcuShiftTime (ms), flare (rpm; upshift: input above the old gear's speed, downshift: above the new gear's), sag, bump (g;
 *   drop and rise of vehicle acceleration against the 0.5 s before the request), blip, tqCut, oil, tps, torque, rpm, speed, brake,
 *   program, upshiftMode, adaptCode, applying, releasing, trace }
 */

var TSA_CHANNELS = {
    time: ['time', 'seconds'],
    gear: ['gear'],
    target: ['gear target'],
    input: ['input rpm'],
    output: ['output rpm'],
    engine: ['engine rpm'],
    tps: ['tps'],
    torque: ['engine tq (nm)'],
    oil: ['oil temp (c)'],
    speed: ['vehicle speed (km/h)'],
    shiftTime: ['time 1 shift time'],
    brake: ['foot brake'],
    blip: ['blip status'],
    tqCut1: ['tq cut 1 flag'],
    tqCut2: ['tq cut 2 flag'],
    adapt: ['adaptation activation parameter'],
    program: ['program sw.'],
    upshiftMode: ['upshift mode'],
    lockupSlip: ['lockup slipt %', 'lockup slip %'],
    adaptA: ['clutch 1-a pres. adaptation'],
    adaptB: ['clutch 2-b pres. adaptation'],
    adaptE: ['clutch 3-e pres. adaptation'],
    adaptC: ['clutch 4-c pres. adaptation'],
    adaptD: ['clutch 5-d pres. adaptation']
};

/** ZF 8HP shift elements applied in each gear (three of five). */
var TSA_ELEMENTS = { 1: 'ABC', 2: 'ABE', 3: 'BCE', 4: 'BDE', 5: 'BCD', 6: 'CDE', 7: 'ACD', 8: 'ADE' };

/** Standard 8HP45/70/90 ratios, used for a gear the log doesn't hold long enough to measure (and no bin is loaded). */
var TSA_DEFAULT_RATIOS = { 1: 4.714, 2: 3.143, 3: 2.106, 4: 1.667, 5: 1.285, 6: 1.0, 7: 0.839, 8: 0.667 };

/** Shifts the TCU learns clutch adaptation on (TurboLamik manual, Adaptations): upshifts 3-4 D, 4-5 C, 5-6 E, 6-7 A; downshift 6-5 B. */
var TSA_ADAPT_SHIFTS = { '3-4': 'D', '4-5': 'C', '5-6': 'E', '6-7': 'A', '6-5': 'B' };

/**
 * Adaptation Activation Parameter codes (TurboLamik manual, Adaptations, May 2025; the manual warns the limits may change
 * between firmware versions). Code 10 in gears 3–7 with cold oil and 14 in 2nd in a V10.75 log agree with this list.
 */
var TSA_ADAPT_CODES = {
    0: 'conditions met (learning)', 1: 'torque too high (> 180 Nm)', 2: 'torque too low (< 55 Nm)', 4: 'throttle too low (< 2 %)',
    5: 'engine speed too high (> 3200 rpm)', 6: 'engine speed too low (< 1600 rpm)', 8: 'driven too short a time',
    9: 'sport mode (Upshift Mode not 0)', 10: 'oil too cold (< 55 °C)', 11: 'oil too hot (> 80 °C)', 12: 'limp mode', 13: 'active fault',
    14: 'gear below 3rd', 15: 'gear above 7th', 16: 'adaptation disabled in the program'
};

// Thresholds of this tool (not TurboLamik's): what counts as a flare, a bump, a slow start.
var TSA_LIMITS = {
    ratioMoved: 0.02,      // ratio more than 2 % from the old gear's = moving
    ratioSynced: 0.015,    // within 1.5 % of the new gear's ratio = synchronised
    minOutputRpm: 150,     // below this the ratio is too coarse to judge
    flareRpm: 100,         // input this far above the gear's speed for ≥ 0.1 s = a flare
    bumpG: 0.15,           // acceleration rising this much above the 0.5 s before the shift = a bump at the catch
    slowDelay: 0.8,        // request to ratio moving, s
    maxShift: 5,           // s from request; longer = the shift didn't complete
    minEvents: 2           // per transition before anything is said about it
};

function tsaNorm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function tsaResolve(columnNames) {
    var idx = {};
    columnNames.forEach(function (n, i) { var k = tsaNorm(n); if (!(k in idx)) idx[k] = i; });
    var ch = {};
    Object.keys(TSA_CHANNELS).forEach(function (key) {
        ch[key] = -1;
        TSA_CHANNELS[key].some(function (n) { if (n in idx) { ch[key] = idx[n]; return true; } return false; });
    });
    if (ch.time === -1) ch.time = 0;
    return ch;
}

/** Column arrays with one row per timestamp (the last one: TunerPro writes several rows with the same time). */
function tsaColumns(columnNames, rows) {
    var ch = tsaResolve(columnNames), keep = [];
    for (var i = 0; i < rows.length; i++) {
        var t = rows[i][ch.time];
        if (!isFinite(t)) continue;
        if (keep.length && rows[keep[keep.length - 1]][ch.time] === t) keep[keep.length - 1] = i;
        else if (!keep.length || t > rows[keep[keep.length - 1]][ch.time]) keep.push(i);
    }
    var cols = { n: keep.length, has: {} };
    Object.keys(ch).forEach(function (key) {
        var c = ch[key], a = new Float64Array(keep.length);
        for (var k = 0; k < keep.length; k++) a[k] = c >= 0 ? rows[keep[k]][c] : NaN;
        cols[key] = a;
        cols.has[key] = c >= 0;
    });
    return cols;
}

function tsaMedian(list) {
    var a = list.filter(function (v) { return v !== null && isFinite(v); }).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function tsaRound(v, d) { return v === null || !isFinite(v) ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d); }

function tsaValidGear(g) { return g >= 1 && g <= 8 && Math.round(g) === g; }

/** Index of the first sample at or after time t. */
function tsaAt(cols, t, from) {
    var i = from || 0;
    while (i < cols.n && cols.time[i] < t) i++;
    return i;
}

/**
 * Gear ratios: measured from the log (median Input ÷ Output while Gear = Gear Target, with ≥ 1 s of data), else the bin's
 * Gear Ratio table, else the standard 8HP ratios. { ratios: {gear: ratio}, source: {gear: 'log' | 'bin' | 'default'} }
 */
function tsaRatios(cols, settings) {
    var per = {}, t = cols.time;
    for (var i = 1; i < cols.n; i++) {
        var g = cols.gear[i];
        if (!tsaValidGear(g) || cols.target[i] !== g || !(cols.output[i] > 300) || !(cols.input[i] > 600)) continue;
        (per[g] = per[g] || { r: [], dt: 0 }).r.push(cols.input[i] / cols.output[i]);
        per[g].dt += t[i] - t[i - 1];
    }
    var ratios = {}, source = {}, bin = settings && settings.gearRatios;
    for (var gear = 1; gear <= 8; gear++) {
        if (per[gear] && per[gear].dt >= 1) { ratios[gear] = tsaRound(tsaMedian(per[gear].r), 3); source[gear] = 'log'; }
        else if (bin && bin[gear]) { ratios[gear] = bin[gear]; source[gear] = 'bin'; }
        else { ratios[gear] = TSA_DEFAULT_RATIOS[gear]; source[gear] = 'default'; }
    }
    return { ratios: ratios, source: source };
}

/** Vehicle acceleration (g) from Output RPM: slope over a centred 0.25 s, scaled by the logged km/h per output rpm. */
function tsaAccel(cols) {
    var acc = new Float64Array(cols.n).fill(NaN);
    if (!cols.has.output || !cols.has.speed) return { acc: acc, kmhPerRpm: null };
    var ratios = [];
    for (var i = 0; i < cols.n; i++) if (cols.output[i] > 300 && cols.speed[i] > 5) ratios.push(cols.speed[i] / cols.output[i]);
    var kmhPerRpm = tsaMedian(ratios);
    if (!kmhPerRpm) return { acc: acc, kmhPerRpm: null };
    var scale = kmhPerRpm / 3.6 / 9.81, half = 0.125, lo = 0, hi = 0, t = cols.time, o = cols.output;
    for (var k = 0; k < cols.n; k++) {
        while (t[lo] < t[k] - half) lo++;
        while (hi + 1 < cols.n && t[hi + 1] <= t[k] + half) hi++;
        var n = 0, st = 0, so = 0, stt = 0, sto = 0;
        for (var j = lo; j <= hi; j++) {
            if (!isFinite(o[j])) continue;
            var x = t[j] - t[k];
            n++; st += x; so += o[j]; stt += x * x; sto += x * o[j];
        }
        var den = n * stt - st * st;
        if (n >= 3 && den > 0) acc[k] = (n * sto - st * so) / den * scale;
    }
    return { acc: acc, kmhPerRpm: kmhPerRpm };
}

/** The highest value held for at least `hold` s between samples a and b (so one noisy sample is not a flare). */
function tsaHeldMax(cols, values, a, b, hold) {
    var best = null;
    for (var i = a; i <= b && i < cols.n; i++) {
        var low = values[i], j = i;
        if (!isFinite(low)) continue;
        while (j + 1 <= b && cols.time[j + 1] - cols.time[i] <= hold) { j++; if (isFinite(values[j]) && values[j] < low) low = values[j]; }
        if (cols.time[j] - cols.time[i] < hold * 0.6) continue;
        if (best === null || low > best) best = low;
    }
    return best;
}

function tsaClutches(from, to) {
    var a = TSA_ELEMENTS[from], b = TSA_ELEMENTS[to];
    if (!a || !b) return { applying: '', releasing: '' };
    return { applying: b.split('').filter(function (x) { return a.indexOf(x) < 0; }).join(''),
             releasing: a.split('').filter(function (x) { return b.indexOf(x) < 0; }).join('') };
}

/** Find shifts: Gear Target leaves the current gear → Gear arrives. Returns { shifts, cancelled, incomplete }. */
function tsaFindShifts(cols) {
    var shifts = [], pending = null, cancelled = 0, incomplete = 0, t = cols.time;
    function start(i) {
        var g = cols.gear[i], tg = cols.target[i];
        pending = tsaValidGear(g) && tsaValidGear(tg) && tg !== g ? { i0: i, from: g, requested: tg, retargeted: false } : null;
    }
    for (var i = 1; i < cols.n; i++) {
        var g = cols.gear[i], g0 = cols.gear[i - 1], tg = cols.target[i], tg0 = cols.target[i - 1];
        if (g !== g0) {
            if (pending && tsaValidGear(g) && pending.from === g0) {
                shifts.push({ i0: pending.i0, iEnd: i, from: g0, to: g, requested: pending.requested, retargeted: pending.retargeted, requestSeen: true });
            } else if (tsaValidGear(g) && tsaValidGear(g0)) {
                shifts.push({ i0: i, iEnd: i, from: g0, to: g, requested: g, retargeted: false, requestSeen: false });
            }
            pending = null;
            start(i);   // a multi-gear downshift goes on from here
            continue;
        }
        if (tg !== tg0) {
            if (pending && tg === g) { pending = null; cancelled++; }
            else if (pending && tsaValidGear(tg)) { pending.requested = tg; pending.retargeted = true; }
            else if (!pending) start(i);
        }
        if (pending && t[i] - t[pending.i0] > TSA_LIMITS.maxShift) { pending = null; incomplete++; }
    }
    return { shifts: shifts, cancelled: cancelled, incomplete: incomplete };
}

function tsaMeasure(cols, s, ratios, accel) {
    var t = cols.time, up = s.to > s.from, rFrom = ratios[s.from], rTo = ratios[s.to];
    var tReq = t[s.i0], tEnd = t[s.iEnd], iAfter = tsaAt(cols, tEnd + 0.3, s.iEnd);
    if (iAfter >= cols.n) iAfter = cols.n - 1;
    var out = { from: s.from, to: s.to, up: up, requestSeen: s.requestSeen, retargeted: s.retargeted, tReq: tReq, tEnd: tEnd,
                tMove: null, tSync: null, delay: null, ratioChange: null, total: s.requestSeen ? tEnd - tReq : null, flare: null, sag: null, bump: null };
    var i0 = s.i0;
    function at(arr) { return cols.has[arr] ? cols[arr][i0] : null; }
    out.oil = at('oil'); out.tps = at('tps'); out.torque = at('torque'); out.rpm = at('engine'); out.speed = at('speed');
    out.brake = cols.has.brake ? cols.brake[i0] > 0 : null; out.program = at('program'); out.upshiftMode = at('upshiftMode');
    out.adaptCode = at('adapt'); out.lockupSlip = at('lockupSlip');
    var cl = tsaClutches(s.from, s.to);
    out.applying = cl.applying; out.releasing = cl.releasing;
    if (up) out.kind = out.tps >= 5 || out.torque > 30 ? 'power' : out.tps > 0 || out.torque > 0 ? 'light' : 'coast';
    else out.kind = out.brake ? 'brake' : out.tps > 20 ? 'power' : 'coast';
    // Time 1 Shift Time holds the last shift's value until it resets for the next one: use it only when it reset during this shift.
    var st = null, blip = false, cut = false, reset = cols.has.shiftTime && cols.shiftTime[i0] === 0;
    for (var k = i0; k <= iAfter; k++) {
        if (k <= s.iEnd && cols.has.shiftTime && isFinite(cols.shiftTime[k])) {
            if (k > 0 && cols.shiftTime[k] < cols.shiftTime[k - 1]) reset = true;
            if (reset) st = cols.shiftTime[k];
        }
        if (cols.has.blip && cols.blip[k] > 0) blip = true;
        if ((cols.has.tqCut1 && cols.tqCut1[k] > 0) || (cols.has.tqCut2 && cols.tqCut2[k] > 0)) cut = true;
    }
    out.tcuShiftTime = st; out.blip = cols.has.blip ? blip : null; out.tqCut = cols.has.tqCut1 || cols.has.tqCut2 ? cut : null;

    // Phases from the ratio. Needs enough output speed for the ratio to mean something.
    out.lowSpeed = !(cols.output[i0] >= TSA_LIMITS.minOutputRpm);
    if (!out.lowSpeed && rFrom && rTo) {
        var iMove = -1, iSync = -1;
        for (var m = i0; m <= iAfter; m++) {
            var r = cols.input[m] / cols.output[m];
            if (!isFinite(r)) continue;
            var moved = Math.abs(r / rFrom - 1) > TSA_LIMITS.ratioMoved;
            var next = m + 1 <= iAfter ? cols.input[m + 1] / cols.output[m + 1] : NaN;
            if (iMove < 0 && moved && (!isFinite(next) || Math.abs(next / rFrom - 1) > TSA_LIMITS.ratioMoved)) iMove = m;
            if (iMove >= 0 && iSync < 0 && Math.abs(r / rTo - 1) < TSA_LIMITS.ratioSynced) {
                // synchronised when it stays within the band for 0.1 s
                var ok = true;
                for (var q = m; q <= iAfter && t[q] - t[m] <= 0.1; q++) {
                    var rq = cols.input[q] / cols.output[q];
                    if (isFinite(rq) && Math.abs(rq / rTo - 1) >= TSA_LIMITS.ratioSynced) { ok = false; break; }
                }
                if (ok) iSync = m;
            }
        }
        if (iMove >= 0) { out.tMove = t[iMove]; if (s.requestSeen) out.delay = t[iMove] - tReq; }
        if (iMove >= 0 && iSync >= 0) { out.tSync = t[iSync]; out.ratioChange = t[iSync] - t[iMove]; }
        var flareTo = iSync >= 0 ? iSync : s.iEnd, excess = new Float64Array(cols.n).fill(NaN);
        var gearR = up ? rFrom : rTo, fStart = up ? i0 : (iMove >= 0 ? iMove : i0), fEnd = up ? flareTo : iAfter;
        for (var e = fStart; e <= fEnd; e++) excess[e] = cols.input[e] - cols.output[e] * gearR;
        var f = tsaHeldMax(cols, excess, fStart, fEnd, 0.1);
        out.flare = f === null ? null : Math.max(0, Math.round(f));
    }
    // Driveline feel: acceleration against the half second before the request.
    var iPre = tsaAt(cols, tReq - 0.5), pre = [];
    for (var p = iPre; p < i0; p++) pre.push(accel[p]);
    var base = tsaMedian(pre);
    if (base !== null) {
        var lo = null, hi = null, iFeelEnd = tsaAt(cols, (out.tSync !== null ? out.tSync : tEnd) + 0.3, i0);
        for (var a = i0; a <= iFeelEnd && a < cols.n; a++) {
            if (!isFinite(accel[a])) continue;
            if (lo === null || accel[a] < lo) lo = accel[a];
            if (hi === null || accel[a] > hi) hi = accel[a];
        }
        out.accelBefore = tsaRound(base, 3);
        out.sag = lo === null ? null : tsaRound(Math.max(0, base - lo), 3);
        out.bump = hi === null ? null : tsaRound(Math.max(0, hi - base), 3);
    }
    // A trace for the shift chart: 0.8 s either side, at most ~240 points.
    var iA = tsaAt(cols, tReq - 0.8), iB = tsaAt(cols, tEnd + 0.8, s.iEnd), step = Math.max(1, Math.ceil((iB - iA) / 240)), tr = { t: [], input: [], engine: [], output: [], acc: [] };
    for (var x = iA; x <= iB && x < cols.n; x += step) {
        tr.t.push(tsaRound(t[x] - tReq, 3)); tr.input.push(cols.input[x]); tr.engine.push(cols.has.engine ? cols.engine[x] : null);
        tr.output.push(cols.output[x]); tr.acc.push(tsaRound(accel[x], 3));
    }
    tr.rFrom = rFrom; tr.rTo = rTo;
    out.trace = tr;
    ['delay', 'ratioChange', 'total'].forEach(function (k) { out[k] = tsaRound(out[k], 2); });
    out.tcuShiftTime = tsaRound(out.tcuShiftTime, 0);
    return out;
}

function tsaRange(list) {
    var a = list.filter(function (v) { return v !== null && isFinite(v); });
    return a.length ? [Math.min.apply(null, a), Math.max.apply(null, a)] : null;
}

/** Medians per transition ("2-3"), in gear order. */
function tsaTransitions(shifts) {
    var by = {};
    shifts.forEach(function (s) { (by[s.from + '-' + s.to] = by[s.from + '-' + s.to] || []).push(s); });
    return Object.keys(by).sort(function (a, b) {
        var pa = a.split('-').map(Number), pb = b.split('-').map(Number), ua = pa[1] > pa[0], ub = pb[1] > pb[0];
        return ua !== ub ? (ua ? -1 : 1) : ua ? pa[0] - pb[0] : pb[0] - pa[0];
    }).map(function (k) {
        var l = by[k], med = function (f) { return tsaMedian(l.map(function (s) { return s[f]; })); };
        return { key: k, from: l[0].from, to: l[0].to, up: l[0].up, count: l.length, applying: l[0].applying, releasing: l[0].releasing,
                 delay: tsaRound(med('delay'), 2), ratioChange: tsaRound(med('ratioChange'), 2), total: tsaRound(med('total'), 2),
                 tcuShiftTime: tsaRound(med('tcuShiftTime'), 0), flare: tsaRound(med('flare'), 0),
                 flareMax: tsaRange(l.map(function (s) { return s.flare; })), sag: tsaRound(med('sag'), 3), bump: tsaRound(med('bump'), 3),
                 oil: tsaRange(l.map(function (s) { return s.oil; })), blips: l.filter(function (s) { return s.blip; }).length,
                 kinds: l.reduce(function (o, s) { o[s.kind] = (o[s.kind] || 0) + 1; return o; }, {}) };
    });
}

/** Per oncoming (applying) element. */
function tsaClutchSummary(shifts) {
    var by = {};
    'ABCDE'.split('').forEach(function (c) { by[c] = { element: c, ups: [], downs: [] }; });
    shifts.forEach(function (s) { s.applying.split('').forEach(function (c) { if (by[c]) (s.up ? by[c].ups : by[c].downs).push(s); }); });
    var usedFor = {};
    for (var g = 1; g < 8; g++) {
        var u = tsaClutches(g, g + 1), d = tsaClutches(g + 1, g);
        (usedFor[u.applying] = usedFor[u.applying] || []).push(g + '→' + (g + 1));
        (usedFor[d.applying] = usedFor[d.applying] || []).push((g + 1) + '→' + g);
    }
    return 'ABCDE'.split('').map(function (c) {
        var x = by[c], all = x.ups.concat(x.downs);
        return { element: c, appliesOn: usedFor[c] || [], upshifts: x.ups.length, downshifts: x.downs.length,
                 flare: tsaRound(tsaMedian(all.map(function (s) { return s.flare; })), 0), bump: tsaRound(tsaMedian(all.map(function (s) { return s.bump; })), 3),
                 ratioChange: tsaRound(tsaMedian(all.map(function (s) { return s.ratioChange; })), 2) };
    });
}

/** Adaptation: time per Adaptation Activation Parameter code while in gears 3–7, the shifts that could learn, and the logged adaptation values. */
function tsaAdaptation(cols, shifts) {
    var res = { codes: [], learnShifts: [], channels: [] };
    if (cols.has.adapt) {
        var time = {}, total = 0;
        for (var i = 1; i < cols.n; i++) {
            if (!(cols.gear[i] >= 3 && cols.gear[i] <= 7)) continue;
            var dt = cols.time[i] - cols.time[i - 1], c = cols.adapt[i];
            if (!(dt > 0) || dt > 1 || !isFinite(c)) continue;
            time[c] = (time[c] || 0) + dt; total += dt;
        }
        res.codes = Object.keys(time).map(Number).sort(function (a, b) { return time[b] - time[a]; }).map(function (c) {
            return { code: c, meaning: TSA_ADAPT_CODES[c] || 'not in the manual’s list', seconds: tsaRound(time[c], 1), share: total ? tsaRound(time[c] / total, 3) : 0 };
        });
        res.secondsInGears3to7 = tsaRound(total, 1);
    }
    shifts.forEach(function (s) {
        var key = s.from + '-' + s.to;
        if (TSA_ADAPT_SHIFTS[key]) res.learnShifts.push({ key: key, element: TSA_ADAPT_SHIFTS[key], tReq: s.tReq, code: s.adaptCode, oil: s.oil });
    });
    [['adaptA', 'A'], ['adaptB', 'B'], ['adaptE', 'E'], ['adaptC', 'C'], ['adaptD', 'D']].forEach(function (p) {
        if (!cols.has[p[0]]) return;
        var a = cols[p[0]], first = null, last = null, lo = null, hi = null;
        for (var k = 0; k < cols.n; k++) {
            if (!isFinite(a[k])) continue;
            if (first === null) first = a[k];
            last = a[k];
            lo = lo === null ? a[k] : Math.min(lo, a[k]); hi = hi === null ? a[k] : Math.max(hi, a[k]);
        }
        res.channels.push({ element: p[1], first: first, last: last, min: lo, max: hi });
    });
    return res;
}

function tsaFindings(shifts, transitions, adaptation, settings, summary) {
    var out = [], L = TSA_LIMITS;
    var win = settings && settings.adaptOil ? settings.adaptOil : { min: 55, max: 80, source: 'manual' };
    // Oil temperature: the context for everything else.
    if (summary.oilAtShifts && summary.oilAtShifts[1] < win.min) {
        out.push({ severity: 'warning', title: 'Every shift was made with cold oil',
            text: 'Oil was ' + summary.oilAtShifts[0] + '–' + summary.oilAtShifts[1] + ' °C at the ' + shifts.length + ' shifts, below the ' + win.min + '–' + win.max +
                ' °C adaptation window' + (win.source === 'bin' ? ' set in the bin (Oil Temp MIN / Max)' : '') + '. The TCU adds its cold corrections ' +
                '(Corr. Temp. Gear UP / DOWN, Corr. Temp. Pulse Time) here, so these shifts show cold behaviour.',
            action: 'Judge shift quality, and change base shift tables, from a log with the oil at working temperature. TurboLamik’s guide puts problems that only happen cold in the temperature tables, not the base pulse.' });
    }
    // Adaptation.
    var learn = adaptation.learnShifts, learned = learn.filter(function (x) { return x.code === 0; }).length;
    if (learn.length) {
        var why = {};
        learn.forEach(function (x) { if (x.code !== 0 && x.code !== null) why[x.code] = (why[x.code] || 0) + 1; });
        var reasons = Object.keys(why).sort(function (a, b) { return why[b] - why[a]; }).map(function (c) { return why[c] + '× code ' + c + ' (' + (TSA_ADAPT_CODES[c] || '?') + ')'; });
        out.push({ severity: learned ? 'info' : 'warning', title: learned + ' of ' + learn.length + ' learning shifts could adapt',
            text: 'Adaptation learns on 3→4 (D), 4→5 (C), 5→6 (E), 6→7 (A) and 6→5 (B). ' + (reasons.length ? 'At the others the Adaptation Activation Parameter said: ' + reasons.join(', ') + '.' : ''),
            action: learned === learn.length ? '' : 'For learning: oil ' + win.min + '–' + win.max + ' °C, Program 1, 1600–3200 rpm, 55–180 Nm, light steady throttle through those shifts, about 20 times (TurboLamik manual).' });
    }
    // Flare and bumps per transition, only where repeated.
    transitions.forEach(function (tr) {
        // Braking shifts are left out: the brake pedal moves the acceleration more than the shift does.
        var list = shifts.filter(function (s) { return s.from === tr.from && s.to === tr.to && s.kind !== 'brake'; });
        if (list.length < L.minEvents) return;
        var flares = list.filter(function (s) { return s.flare !== null && s.flare >= L.flareRpm; });
        if (flares.length >= L.minEvents && flares.length * 2 >= list.length) {
            out.push({ severity: 'warning', title: tr.from + '→' + tr.to + ': flare in ' + flares.length + ' of ' + list.length + ' shifts',
                text: 'Input speed rose ' + tsaMedian(flares.map(function (s) { return s.flare; })) + ' rpm (median; up to ' + Math.max.apply(null, flares.map(function (s) { return s.flare; })) +
                    ') above ' + (tr.up ? 'the old gear’s' : 'the new gear’s') + ' speed for at least 0.1 s. Oncoming element ' + tr.applying + ', released ' + tr.releasing + '.',
                action: 'TurboLamik’s shift-quality guide: too little pressure or too short a pulse lets it slip and flare. Look at Pulse Correction ' + (tr.up ? 'UP' : 'DOWN') +
                    ', Time Correction ' + (tr.up ? 'UP' : 'DOWN') + ' with Slow Ram ' + (tr.up ? 'UP' : 'DOWN') + ', and the ' + tr.from + '-' + tr.to + ' Correction Start / End tables. Check the torque the TCU sees first.' });
        }
        var bumps = list.filter(function (s) { return s.bump !== null && s.bump >= L.bumpG; });
        if (bumps.length >= L.minEvents && bumps.length * 2 >= list.length) {
            out.push({ severity: 'warning', title: tr.from + '→' + tr.to + ': bump at the catch in ' + bumps.length + ' of ' + list.length + ' shifts',
                text: 'Acceleration rose ' + tsaRound(tsaMedian(bumps.map(function (s) { return s.bump; })), 2) + ' g (median) above the half second before the shift.',
                action: 'TurboLamik’s guide: too much pressure gives a bang. Flare versus bang is Time Correction ' + (tr.up ? 'UP' : 'DOWN') + ' plus Slow Ram ' + (tr.up ? 'UP' : 'DOWN') +
                    '; overall too harsh is Pulse Correction ' + (tr.up ? 'UP' : 'DOWN') + '.' });
        }
        var slow = list.filter(function (s) { return s.delay !== null && s.delay > L.slowDelay; });
        if (tr.up && slow.length >= L.minEvents && slow.length * 2 >= list.length) {
            out.push({ severity: 'info', title: tr.from + '→' + tr.to + ': slow to start',
                text: 'The ratio started moving ' + tsaRound(tsaMedian(slow.map(function (s) { return s.delay; })), 2) + ' s (median) after the request in ' + slow.length + ' of ' + list.length + ' shifts.',
                action: 'This is the fill / torque phase before the ratio moves. TurboLamik’s guide doesn’t give a target for it; compare with warm-oil shifts before changing anything.' });
        }
    });
    // Blip.
    var downs = shifts.filter(function (s) { return !s.up; });
    if (downs.length && settings && settings.blip && settings.blip.minRpm) {
        var minRpm = Math.min.apply(null, settings.blip.minRpm.filter(function (v) { return v !== null; }));
        var below = downs.filter(function (s) { return s.rpm !== null && s.rpm < minRpm; }).length, blips = downs.filter(function (s) { return s.blip; }).length;
        out.push({ severity: 'info', title: 'Blip on ' + blips + ' of ' + downs.length + ' downshifts',
            text: below + ' of the downshifts started below the lowest Min RPM for blip (' + minRpm + ' rpm), where the TCU doesn’t ask for one' +
                (settings.blip.maxTps !== null ? '; it also doesn’t above ' + settings.blip.maxTps + ' % TPS or ' + settings.blip.maxTq + ' Nm' : '') + '.',
            action: '' });
    }
    if (!out.length) out.push({ severity: 'healthy', title: 'Nothing stands out', text: 'No transition showed a repeated flare, bump or slow start.', action: '' });
    return out;
}

function tsaAnalyze(columnNames, rows, settings) {
    var cols = tsaColumns(columnNames, rows), notes = [];
    if (!cols.has.gear) throw new Error('Required channel "Gear" not found.');
    if (!cols.has.target) notes.push('No Gear Target channel: shifts are timed from the Gear change only, so the delay before the ratio moves isn’t measured.');
    if (!cols.has.input || !cols.has.output) notes.push('No Input / Output RPM: the shift phases, flare and feel can’t be measured.');
    var r = tsaRatios(cols, settings), accel = tsaAccel(cols);
    if (!accel.kmhPerRpm) notes.push('No vehicle speed: acceleration (sag and bump) isn’t worked out.');
    var found = tsaFindShifts(cols);
    var shifts = found.shifts.map(function (s) { return tsaMeasure(cols, s, r.ratios, accel.acc); });
    var oil = shifts.map(function (s) { return s.oil; }), gearsSeen = {};
    for (var i = 0; i < cols.n; i++) if (tsaValidGear(cols.gear[i])) gearsSeen[cols.gear[i]] = true;
    var summary = {
        shifts: shifts.length, upshifts: shifts.filter(function (s) { return s.up; }).length, downshifts: shifts.filter(function (s) { return !s.up; }).length,
        cancelled: found.cancelled, incomplete: found.incomplete, duration: cols.n ? tsaRound(cols.time[cols.n - 1] - cols.time[0], 1) : 0,
        oilAtShifts: tsaRange(oil), oilLog: tsaRange(Array.prototype.slice.call(cols.oil)), gearsUsed: Object.keys(gearsSeen).map(Number),
        kmhPerRpm: accel.kmhPerRpm, lowSpeed: shifts.filter(function (s) { return s.lowSpeed; }).length
    };
    var transitions = tsaTransitions(shifts), adaptation = tsaAdaptation(cols, shifts);
    return { summary: summary, shifts: shifts, transitions: transitions, clutches: tsaClutchSummary(shifts), adaptation: adaptation,
             findings: tsaFindings(shifts, transitions, adaptation, settings, summary), ratios: r, notes: notes, limits: TSA_LIMITS };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { tsaAnalyze: tsaAnalyze, tsaClutches: tsaClutches, tsaColumns: tsaColumns, tsaFindShifts: tsaFindShifts, TSA_ADAPT_CODES: TSA_ADAPT_CODES };
}
