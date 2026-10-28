/**
 * knock/knock-calibration.js — Knock Threshold and per-cylinder Knock Gain suggestions from the knock levels in a log, by the
 * method of MoTeC's spark and knock training (M1 Training 52): with no knock, even out the cylinders with Knock Cylinder N Gain
 * (% per volt — the level scales with it), then set Knock Threshold at each engine speed about 10–30 % above the loudest
 * cylinder's no-knock level. Frequency comes first: levels (and so gains and threshold) only hold for the frequency they were
 * logged at.
 *
 * knockCalibrate(data, channels, opts) → {
 *   samples: { seconds, loadSeconds }, settings: { margin, percentile, loadKpa, minSeconds },
 *   gains: [{ cylinder, input, current, median, suggested, change }]   (change = suggested ÷ current − 1; null = keep)
 *   groups: [{ input, cylinders, median }], weakGroup: { input, ratio } | null,
 *   threshold: [{ rpm, current, seconds, loadSeconds, noise, loudest, suggested, action, note }],
 *   notes: [string]
 * }
 *   data: rows (column 0 = time) and channels: resolved indices, as the knock worker has them (resolveChannels)
 *   opts: { threshold: tune table { rpm, load, values } | %, gains: [%/V per cylinder] | null, inputs: [input name per cylinder] | null,
 *           frequencyOk: false when Knock Frequency A is far from the bore-based orders — measurements only, no suggestions,
 *           margin (1.25), percentile (0.995), loadKpa (90), minSeconds (2) }
 * Suggestions are withheld where the data can't support them: no gain changes inside a knock input that reads several times
 * quieter than another (hardware or frequency, not gain), a lower threshold only from ≥ 10 s at load, a higher one only from
 * ≥ 5 s and not when one cylinder stands far above the others (that may be real knock).
 */

var KCAL_MIN_RPM = 1000;          // below this the threshold table is rarely used and levels are idle noise
var KCAL_GAIN_RPM = 2000;         // gains are evened out from levels above this
var KCAL_GAIN_DEADBAND = 0.15;    // within ±15 % of the group: leave the gain (medians move that much between logs)
var KCAL_LOWER_S = 10;            // seconds at load needed before suggesting a lower (more sensitive) threshold
var KCAL_RAISE_S = 5;             // seconds needed before suggesting a higher threshold from part-load data
var KCAL_OUTLIER = 2.5;           // loudest cylinder this many times the next on its input: maybe real knock, not noise
var KCAL_WEAK_RATIO = 3;          // a knock input this many times quieter than the other is a hardware or frequency problem

function kcalQuantile(sorted, q) {
    if (!sorted.length) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 0.5)))];
}

function kcalMedian(list) {
    var s = list.slice().sort(function (a, b) { return a - b; });
    return s.length ? s[s.length >> 1] : NaN;
}

/** Knock Threshold (%) at an engine speed: a fixed % or the table's first load row, interpolated and clamped; Infinity when unknown. */
function kcalThresholdAt(thr, rpm) {
    if (typeof thr === 'number') return thr;
    if (!thr || !thr.rpm || !thr.values || !thr.values.length) return Infinity;
    var xs = thr.rpm, ys = thr.values[0];
    if (xs.length === 1 || !(rpm > xs[0])) return ys[0];
    for (var i = 1; i < xs.length; i++) if (rpm <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (rpm - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[ys.length - 1];
}

function knockCalibrate(data, channels, opts) {
    opts = opts || {};
    var margin = opts.margin > 1 ? opts.margin : 1.25, pct = opts.percentile > 0.5 ? opts.percentile : 0.995;
    var loadKpa = opts.loadKpa > 0 ? opts.loadKpa : 90, minS = opts.minSeconds > 0 ? opts.minSeconds : 2;
    var col = function (k) { return channels[k] !== undefined ? channels[k] : -1; };
    var rpmI = col('rpm'), mapI = col('map'), lnI = col('load_norm'), ovI = col('overrun'), ctI = col('coolant_temp');
    var cyls = [], trims = [];
    for (var cn = 1; cn <= 8; cn++) {
        if (col('knock_cyl_' + cn) >= 0) cyls.push(cn);
        if (col('knock_trim_' + cn) >= 0) trims.push(col('knock_trim_' + cn));
    }
    var out = { samples: { seconds: 0, loadSeconds: 0 }, settings: { margin: margin, percentile: pct, loadKpa: loadKpa, minSeconds: minS },
                gains: [], groups: [], weakGroup: null, threshold: [], notes: [] };
    if (!cyls.length || rpmI < 0 || data.length < 2) { out.notes.push('Needs Engine Speed and the cylinder Knock Level channels.'); return out; }

    var thr = opts.threshold, thrAt = function (rpm) { return kcalThresholdAt(thr, rpm); };
    var dt = (data[data.length - 1][0] - data[0][0]) / (data.length - 1) || 0.01;

    // Quiet samples: engine running and warm, not in an overrun cut, knock control not retarding, and no cylinder above the current
    // threshold within ±0.5 s (that may be real knock, which must not count as noise).
    var n = data.length, above = new Uint8Array(n), quiet = new Uint8Array(n);
    for (var r = 0; r < n; r++) {
        var row = data[r], t = thrAt(row[rpmI]);
        for (var c = 0; c < cyls.length; c++) if (row[col('knock_cyl_' + cyls[c])] > t) { above[r] = 1; break; }
    }
    var pad = Math.ceil(0.5 / dt), lastAbove = -Infinity, next = 2147483647;
    var nextAbove = new Int32Array(n);
    for (r = n - 1; r >= 0; r--) { if (above[r]) next = r; nextAbove[r] = next; }
    for (r = 0; r < n; r++) {
        row = data[r];
        if (above[r]) lastAbove = r;
        if (!(row[rpmI] >= KCAL_MIN_RPM)) continue;
        if (ovI >= 0 && row[ovI] === 2) continue;
        if (ctI >= 0 && row[ctI] < 60) continue;
        if (r - lastAbove <= pad || nextAbove[r] - r <= pad) continue;
        var retard = false;
        for (var k = 0; k < trims.length; k++) if (Math.abs(row[trims[k]]) > 0.05) { retard = true; break; }
        if (retard) continue;
        quiet[r] = 1;
    }
    var loadOf = function (row) { return lnI >= 0 && !isNaN(row[lnI]) ? row[lnI] : mapI >= 0 ? row[mapI] : NaN; };

    // --- Gains: even out the cylinders on each knock input ----------------------------------------------------------------
    var medians = {};
    cyls.forEach(function (cy) {
        var idx = col('knock_cyl_' + cy), all = [], loaded = [];
        for (var r2 = 0; r2 < n; r2 += 2) {
            if (!quiet[r2] || !(data[r2][rpmI] >= KCAL_GAIN_RPM)) continue;
            var v = data[r2][idx];
            if (isNaN(v)) continue;
            all.push(v);
            if (loadOf(data[r2]) >= loadKpa) loaded.push(v);
        }
        medians[cy] = loaded.length * 2 * dt >= 5 ? kcalMedian(loaded) : kcalMedian(all);
    });
    var inputs = opts.inputs || null, byInput = {};
    cyls.forEach(function (cy) { var g = inputs && inputs[cy - 1] || 'All cylinders'; (byInput[g] = byInput[g] || []).push(cy); });
    out.groups = Object.keys(byInput).map(function (g) {
        return { input: g, cylinders: byInput[g], median: kcalMedian(byInput[g].map(function (cy) { return medians[cy]; }).filter(function (v) { return !isNaN(v); })) };
    });
    if (out.groups.length >= 2) {
        var sorted = out.groups.slice().sort(function (a, b) { return b.median - a.median; }), quietest = sorted[sorted.length - 1];
        var ratio = sorted[0].median / Math.max(1e-6, quietest.median);
        if (ratio > KCAL_WEAK_RATIO) out.weakGroup = { input: quietest.input, ratio: ratio };
    }
    var factor = {}, freqOk = opts.frequencyOk !== false;
    cyls.forEach(function (cy) {
        var g = inputs && inputs[cy - 1] || 'All cylinders', grp = out.groups.filter(function (x) { return x.input === g; })[0];
        var cur = opts.gains && opts.gains[cy - 1] > 0 ? opts.gains[cy - 1] : null, m = medians[cy], f = 1;
        var weak = out.weakGroup && out.weakGroup.input === g;
        if (freqOk && !weak && m > 0 && grp.median > 0 && grp.cylinders.length > 1) f = Math.max(0.5, Math.min(2, grp.median / m));
        if (Math.abs(f - 1) < KCAL_GAIN_DEADBAND) f = 1;
        factor[cy] = f;
        out.gains.push({ cylinder: cy, input: inputs ? inputs[cy - 1] : null, current: cur, median: m,
                         suggested: f === 1 ? null : cur !== null ? Math.round(cur * f) : null, change: f === 1 ? null : f - 1 });
    });

    // --- Threshold: per engine speed site of the table --------------------------------------------------------------------
    var sites = thr && thr.rpm && thr.rpm.length ? thr.rpm.slice() : [1000, 2000, 3000, 4000, 5000, 6000, 7000];
    var edges = sites.map(function (s, i) { return i ? (sites[i - 1] + s) / 2 : -Infinity; }).concat([Infinity]);
    var bins = sites.map(function () { return { all: cyls.map(function () { return []; }), load: cyls.map(function () { return []; }), n: 0, nl: 0 }; });
    for (r = 0; r < n; r++) {
        if (!quiet[r]) continue;
        row = data[r];
        var b = 0;
        while (b < sites.length - 1 && row[rpmI] >= edges[b + 1]) b++;
        var atLoad = loadOf(row) >= loadKpa, bin = bins[b];
        bin.n++;
        if (atLoad) bin.nl++;
        for (c = 0; c < cyls.length; c++) {
            var lv = row[col('knock_cyl_' + cyls[c])] * factor[cyls[c]];
            if (isNaN(lv)) continue;
            bin.all[c].push(lv);
            if (atLoad) bin.load[c].push(lv);
        }
    }
    sites.forEach(function (s, i) {
        var bin = bins[i], seconds = bin.n * dt, loadSeconds = bin.nl * dt, useLoad = loadSeconds >= minS;
        var cur = thrAt(s);
        if (!isFinite(cur)) cur = null;
        var rowOut = { rpm: s, current: cur, seconds: seconds, loadSeconds: loadSeconds, noise: null, loudest: null, suggested: null, action: 'keep', note: '' };
        if (seconds < minS) { rowOut.note = 'Not enough data at this speed (' + seconds.toFixed(1) + ' s).'; out.threshold.push(rowOut); return; }
        var src = useLoad ? bin.load : bin.all, perCyl = [];
        src.forEach(function (list, ci) {
            if (list.length) perCyl.push({ cyl: cyls[ci], q: kcalQuantile(list.sort(function (a, b2) { return a - b2; }), pct) });
        });
        perCyl.sort(function (a, b2) { return b2.q - a.q; });
        var worst = perCyl.length ? perCyl[0].q : NaN;
        rowOut.noise = worst;
        rowOut.loudest = perCyl.length ? perCyl[0].cyl : null;
        // The loudest cylinder against the next one on the same knock input.
        var input = inputs ? inputs[rowOut.loudest - 1] : null;
        var peer = perCyl.filter(function (p, j) { return j > 0 && (!inputs || inputs[p.cyl - 1] === input); })[0];
        var outlier = peer && peer.q > 0 && worst / peer.q >= KCAL_OUTLIER;
        if (outlier) rowOut.note = 'Cylinder ' + rowOut.loudest + ' reads ' + (worst / peer.q).toFixed(1) + '× cylinder ' + peer.cyl + ' here — check for real knock on it before treating this as noise. ';
        var sug = Math.max(0.5, Math.round(worst * margin * 2) / 2), where = loadSeconds.toFixed(1) + ' s at ≥ ' + loadKpa + ' kPa';
        if (!freqOk) {
            rowOut.action = 'after frequency';
            rowOut.note += 'Measured at the current frequency only.';
        } else if (useLoad && loadSeconds >= KCAL_LOWER_S || useLoad && cur !== null && sug > cur && !outlier) {
            rowOut.suggested = sug;
            rowOut.action = cur === null ? 'set' : sug > cur ? 'raise' : sug < cur ? 'lower' : 'keep';
            rowOut.note += where + '.';
        } else if (!useLoad && cur !== null && sug > cur && seconds >= KCAL_RAISE_S && !outlier) {
            rowOut.suggested = sug;
            rowOut.action = 'raise';
            rowOut.note += 'Part-load noise already reaches the threshold — false knock.';
        } else if (cur !== null && sug < cur) {
            rowOut.note += 'Only ' + where + ' — log ≥ ' + KCAL_LOWER_S + ' s of pulls through this speed before lowering it.';
        } else if (cur !== null && sug > cur) {
            rowOut.note += 'Noise × margin is above the threshold, but on too little data' + (outlier ? ' and from one cylinder' : '') + ' to raise it.';
        } else {
            rowOut.note += 'Within the threshold.';
        }
        out.threshold.push(rowOut);
    });
    bins.forEach(function (bin) { out.samples.seconds += bin.n * dt; out.samples.loadSeconds += bin.nl * dt; });
    if (!freqOk) out.notes.push('Knock Frequency A is far from the bore-based orders, so gains and threshold aren\'t suggested: they only hold for ' +
        'the frequency the levels were logged at. Choose the frequency first (log with A–D swept across the orders), then recalibrate.');
    if (out.weakGroup) out.notes.push(out.weakGroup.input + ' reads ' + out.weakGroup.ratio.toFixed(1) + '× lower than the other input: no gain changes ' +
        'are suggested for its cylinders — check that sensor, its wiring and mounting torque, and the frequency, before raising gains to match.');
    if (!trims.length) out.notes.push('Ignition Cylinder Knock Trim isn\'t logged, so retard can\'t be excluded — log it.');
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { knockCalibrate: knockCalibrate, kcalThresholdAt: kcalThresholdAt };
