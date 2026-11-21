/**
 * knock/knock-profile.js — Knock noise profile: knock level per cylinder by engine speed and load, pooled over one or more logs,
 * and the cylinder-specific humps in it — a cylinder much louder than the others in one engine-speed band and quieter either side.
 * Each hump is checked for what separates mechanical noise from knock: present at light load (where knock is unlikely), the same in
 * every load band and gear (locked to engine speed), and whether it moves when the timing does between logs.
 * Runs on the log-health helpers (lhContext, lhQuantile…), in a worker (profile-worker.js) or Node.
 *
 *   kpAnalyze(logs, tune) → { logs: [{ duration, warmS }], cylinders, bins: [rpm], bands: [label], profile, humps, findings }
 *     logs: lvOpenLog() results; tune: m1pkgKnock() | null (Knock Threshold and the cylinder gains)
 *     profile[band][cyl][bin] = { v: p95 level (% of threshold with a tune, else logged %), s: seconds } | null; band 0 = all loads
 *     humps: [{ cyl, r0, r1, peak, level, others, ratio, nbRatio, bands: [{ label, ratio, s, pctThr }], gears: [{ gear, ratio, s }],
 *               perLog: [{ file, s, level, others, timing }], retardS, verdict: 'noise' | 'unclear', timingTest: {…} | null }]
 */

var KP_BIN = 100, KP_MIN_RPM = 1000, KP_MAX_RPM = 7000, KP_STEP_HZ = 20, KP_WARM_C = 60, KP_MIN_S = 1;
var KP_BANDS = [[0, 60, 'under 60 kPa'], [60, 95, '60–95 kPa'], [95, 140, '95–140 kPa'], [140, 1000, '140 kPa and over']];
var KP_HUMP_OTHERS = 1.8, KP_HUMP_NEIGHBOURS = 1.4, KP_BAND_RATIO = 1.5;

/** Knock Threshold (%) at rpm and MAP (Engine Load Normalised = MAP in MAP load mode; ratio sites are × 100). */
function kpThreshold(th, rpm, kpa) {
    if (!th) return null;
    var row = 0, f = 0, load = th.load;
    if (load && load.length > 1) {
        var l = load[load.length - 1] <= 5 ? load.map(function (x) { return x * 100; }) : load;
        if (kpa <= l[0]) row = 0; else if (kpa >= l[l.length - 1]) row = l.length - 1;
        else for (var j = 0; j < l.length - 1; j++) if (kpa < l[j + 1]) { row = j; f = (kpa - l[j]) / (l[j + 1] - l[j]); break; }
    }
    var a = lhInterp(th.rpm, th.values[row], rpm);
    return f > 0 ? a + (lhInterp(th.rpm, th.values[row + 1], rpm) - a) * f : a;
}

function kpMedian(a) { return a.length ? lhQuantile(a.slice(), 0.5) : null; }

function kpAnalyze(logs, tune) {
    var findings = [], g = 'Profile';
    function add(group, severity, title, detail, times, channels, file) {
        findings.push({ group: group, severity: severity, title: title, detail: detail || '', times: times || [], channels: channels || [], file: file === undefined ? null : file });
    }
    var th = tune && tune.threshold || null, nBins = Math.floor((KP_MAX_RPM - KP_MIN_RPM) / KP_BIN), bins = [];
    for (var b = 0; b < nBins; b++) bins.push(KP_MIN_RPM + b * KP_BIN);

    // Samples, pooled over logs: per sample its bin, band, gear, file, timing and per-cylinder level.
    var S = { bin: [], band: [], gear: [], file: [], timing: [], t: [], lv: [], trim: [] }, nCyl = 0, out = { logs: [], cylinders: 0, bins: bins,
        bands: ['all loads'].concat(KP_BANDS.map(function (x) { return x[2]; })), profile: [], humps: [], findings: findings };
    logs.forEach(function (log, fi) {
        var c = lhContext(log), rpm = c.base('Engine Speed'), map = c.base('Inlet Manifold Pressure'), ect = c.base('Coolant Temperature');
        var gear = c.base('Gear'), ign = c.base('Ignition Timing'), K = [], T = [];
        for (var k = 1; k <= 8; k++) {
            var ch = c.base('Ignition Cylinder ' + k + ' Knock Level');
            if (!ch) break;
            K.push(ch);
            T.push(c.base('Ignition Cylinder ' + k + ' Trim Knock') || c.base('Ignition Cylinder ' + k + ' Knock Trim'));
        }
        var info = { duration: c.n * c.dt, warmS: 0 };
        out.logs.push(info);
        if (!rpm || !map || !K.length) return;
        nCyl = Math.max(nCyl, K.length);
        var step = Math.max(1, Math.round(1 / (KP_STEP_HZ * c.dt)));
        for (k = c.start; k < c.n; k += step) {
            if (!c.settled[k] || (ect && ect[k] < KP_WARM_C) || rpm[k] < KP_MIN_RPM || rpm[k] >= KP_MAX_RPM) continue;
            var bi = Math.floor((rpm[k] - KP_MIN_RPM) / KP_BIN), band = -1;
            for (var j = 0; j < KP_BANDS.length; j++) if (map[k] >= KP_BANDS[j][0] && map[k] < KP_BANDS[j][1]) { band = j; break; }
            if (band < 0) continue;
            var thr = kpThreshold(th, rpm[k], map[k]), lv = [], tr = [];
            for (j = 0; j < K.length; j++) { lv.push(thr ? K[j][k] / thr * 100 : K[j][k]); tr.push(T[j] ? Math.abs(T[j][k]) : 0); }
            S.bin.push(bi); S.band.push(band); S.gear.push(gear ? Math.round(gear[k]) : null); S.file.push(fi); S.timing.push(ign ? ign[k] : NaN);
            S.t.push(k * c.dt); S.lv.push(lv); S.trim.push(tr);
            info.warmS += step * c.dt;
        }
    });
    out.cylinders = nCyl;
    var dtS = 1 / KP_STEP_HZ, unit = th ? '% of Knock Threshold' : '% (logged level; choose the tune to compare with the threshold)';
    if (!S.bin.length || !nCyl) {
        add(g, 'info', 'No warm running with knock levels to profile', 'Needs Engine Speed, Inlet Manifold Pressure and the Ignition Cylinder N Knock Level ' +
            'channels, with coolant at ' + KP_WARM_C + ' °C or more.');
        return out;
    }

    // Profile: p95 per band × cylinder × bin (band 0 = all loads).
    var idxByBin = bins.map(function () { return []; });
    S.bin.forEach(function (bi, i) { idxByBin[bi].push(i); });
    for (var bandI = 0; bandI <= KP_BANDS.length; bandI++) {
        var perCyl = [];
        for (var cy = 0; cy < nCyl; cy++) {
            perCyl.push(bins.map(function (r, bi) {
                var v = [];
                idxByBin[bi].forEach(function (i) { if (!bandI || S.band[i] === bandI - 1) v.push(S.lv[i][cy]); });
                return v.length * dtS >= KP_MIN_S ? { v: lhQuantile(v, 0.95), s: v.length * dtS } : null;
            }));
        }
        out.profile.push(perCyl);
    }

    var totalS = S.bin.length * dtS;
    add(g, 'ok', 'Knock level profiled over ' + lhS(totalS) + ' of warm running in ' + logs.length + ' log' + (logs.length > 1 ? 's' : ''),
        'Each cell is the 95th percentile of the cylinder\'s knock level (' + unit + ') in a ' + KP_BIN + ' rpm band, from samples at ' + KP_STEP_HZ +
        ' Hz with coolant at ' + KP_WARM_C + ' °C or more; a cell needs ' + KP_MIN_S + ' s. A hump is a cylinder at least ' + KP_HUMP_OTHERS +
        '× the other cylinders\' median in a band and ' + KP_HUMP_NEIGHBOURS + '× its own level 400–800 rpm either side.' +
        (tune && tune.gains ? ' Cylinder gains in this tune: ' + tune.gains.map(function (x, i) { return (i + 1) + ': ' + lhFmt(x, 0); }).join(', ') +
            ' — levels are after the gain, so a gain change between the logs moves them.' : ''));

    // Humps from the all-loads profile.
    var all = out.profile[0];
    for (cy = 0; cy < nCyl; cy++) {
        var cand = bins.map(function (r, bi) {
            var cell = all[cy][bi];
            if (!cell) return null;
            var others = [];
            for (var o = 0; o < nCyl; o++) if (o !== cy && all[o][bi]) others.push(all[o][bi].v);
            var nb = [];
            bins.forEach(function (r2, b2) { var d = Math.abs(b2 - bi) * KP_BIN; if (d >= 400 && d <= 800 && all[cy][b2]) nb.push(all[cy][b2].v); });
            var om = kpMedian(others), nm = kpMedian(nb);
            if (!om || !nm) return null;
            return cell.v / om >= KP_HUMP_OTHERS && cell.v / nm >= KP_HUMP_NEIGHBOURS ? { bi: bi, ratio: cell.v / om, nb: cell.v / nm, v: cell.v, others: om } : null;
        });
        for (var bi0 = 0; bi0 < nBins; bi0++) {
            if (!cand[bi0]) continue;
            var grp = [cand[bi0]], last = bi0;
            for (var b2 = bi0 + 1; b2 < nBins && b2 - last <= 2; b2++) if (cand[b2]) { grp.push(cand[b2]); last = b2; }
            bi0 = last;
            var lo = grp[0].bi, hi = last, s = 0;
            for (b2 = lo; b2 <= hi; b2++) if (all[cy][b2]) s += all[cy][b2].s;
            if (s < 2) continue;
            out.humps.push(kpHump(cy, lo, hi, grp));
        }
    }

    function kpHump(cyl, lo, hi, grp) {
        var peak = grp.reduce(function (a, x) { return x.ratio > a.ratio ? x : a; });
        var inH = function (i) { return S.bin[i] >= lo && S.bin[i] <= hi; };
        function ratioOf(filter) {
            var mine = [], oth = [];
            for (var i = 0; i < S.bin.length; i++) if (inH(i) && filter(i)) {
                mine.push(S.lv[i][cyl]);
                for (var o = 0; o < nCyl; o++) if (o !== cyl) oth.push(S.lv[i][o]);
            }
            if (mine.length * dtS < KP_MIN_S) return null;
            var m = lhQuantile(mine.slice(), 0.95), om = lhQuantile(oth, 0.95);
            return { level: m, others: om, ratio: om > 0 ? m / om : null, s: mine.length * dtS, p99: lhQuantile(mine, 0.99) };
        }
        var h = { cyl: cyl + 1, r0: bins[lo], r1: bins[hi] + KP_BIN, peak: bins[peak.bi] + KP_BIN / 2, level: peak.v, others: peak.others, ratio: peak.ratio,
                  nbRatio: peak.nb, bands: [], gears: [], perLog: [], retardS: 0, verdict: 'unclear', timingTest: null };
        KP_BANDS.forEach(function (bd, j) {
            var r = ratioOf(function (i) { return S.band[i] === j; });
            if (r) h.bands.push({ label: bd[2], ratio: r.ratio, s: r.s, level: r.level, others: r.others, pctThr: th ? r.p99 : null,
                timing: kpMedian(S.timing.filter(function (x, i) { return inH(i) && S.band[i] === j && !isNaN(x); })) });
        });
        var gears = {};
        S.gear.forEach(function (gv, i) { if (inH(i) && gv !== null && gv > 0) gears[gv] = 1; });
        Object.keys(gears).map(Number).sort().forEach(function (gv) {
            var r = ratioOf(function (i) { return S.gear[i] === gv; });
            if (r) h.gears.push({ gear: gv, ratio: r.ratio, s: r.s });
        });
        logs.forEach(function (l, fi) {
            var r = ratioOf(function (i) { return S.file[i] === fi; });
            if (r) h.perLog.push({ file: fi, s: r.s, level: r.level, others: r.others, ratio: r.ratio,
                timing: kpMedian(S.timing.filter(function (x, i) { return inH(i) && S.file[i] === fi && !isNaN(x); })) });
        });
        for (var i = 0; i < S.bin.length; i++) if (inH(i) && S.trim[i][cyl] > 0.5) h.retardS += dtS;
        var light = h.bands.filter(function (x) { return x.label === KP_BANDS[0][2] && x.ratio >= KP_BAND_RATIO; }).length > 0;
        var nBandsLoud = h.bands.filter(function (x) { return x.ratio >= KP_BAND_RATIO; }).length;
        var nGearsLoud = h.gears.filter(function (x) { return x.ratio >= KP_BAND_RATIO; }).length;
        h.light = light; h.bandsLoud = nBandsLoud; h.gearsLoud = nGearsLoud;
        h.locked = nBandsLoud >= 2 || nGearsLoud >= 2;
        // Timing between logs: the pair of logs (≥ 2 s each) furthest apart in timing at the hump.
        var pl = h.perLog.filter(function (x) { return x.s >= 2 && x.timing !== null; }), best = null;
        for (var a = 0; a < pl.length; a++) for (var bb = 0; bb < pl.length; bb++) {
            var d = pl[a].timing - pl[bb].timing;
            if (d >= 2 && (!best || d > best.d)) best = { d: d, more: pl[a], less: pl[bb] };
        }
        if (best) {
            var ch = best.less.level / best.more.level - 1;
            h.timingTest = { less: best.less, more: best.more, degrees: best.d, change: ch, result: ch <= -0.3 ? 'fell' : ch > -0.2 ? 'same' : 'small' };
        }
        // Noise: follows engine speed (several load bands or gears) and either shows at light load or didn't drop with less timing;
        // a level that fell with timing behaves like knock whatever the pattern.
        var tr0 = h.timingTest && h.timingTest.result;
        h.verdict = tr0 === 'fell' ? 'unclear' : h.locked && (light || tr0 === 'same') ? 'noise' : 'unclear';
        return h;
    }

    // Findings per hump.
    out.humps.forEach(function (h) {
        var hg = 'Cylinder ' + h.cyl + ' at ' + h.r0 + '–' + h.r1 + ' rpm';
        var parts = ['Cylinder ' + h.cyl + ' reads ' + lhFmt(h.ratio, 1) + '× the other cylinders\' median at ' + Math.round(h.peak) + ' rpm (' + lhFmt(h.level, 0) +
            ' vs ' + lhFmt(h.others, 0) + (th ? ' % of threshold' : ' %') + ', 95th percentile) and ' + lhFmt(h.nbRatio, 1) + '× its own level 400–800 rpm either side.'];
        parts.push('By load: ' + h.bands.map(function (x) {
            return x.label + ' ' + lhFmt(x.ratio, 1) + '× (' + lhS(x.s) + (x.timing !== null ? ', ' + lhFmt(x.timing, 1) + '° timing' : '') + ')';
        }).join('; ') + '.');
        if (h.gears.length) parts.push('By gear: ' + h.gears.map(function (x) { return 'gear ' + x.gear + ' ' + lhFmt(x.ratio, 1) + '× (' + lhS(x.s) + ')'; }).join(', ') + '.');
        parts.push((h.light ? 'It is there at light load, where knock is unlikely' : 'At light load it is not clearly louder (under ' + KP_BAND_RATIO + '×)') + '; ' +
            (h.locked ? 'it is louder ' + (h.bandsLoud >= 2 ? 'in ' + h.bandsLoud + ' load bands' : '') + (h.bandsLoud >= 2 && h.gearsLoud >= 2 ? ' and ' : '') +
                (h.gearsLoud >= 2 ? 'in ' + h.gearsLoud + ' gears' : '') + ', so it follows engine speed rather than load or road speed.' :
                'only one load band or gear has it, so it isn\'t shown to follow engine speed.'));
        var tt = h.timingTest;
        if (tt) {
            parts.push('Timing test between logs: with ' + lhFmt(tt.degrees, 1) + '° less timing at the hump (' + lhFmt(tt.less.timing, 1) + '° vs ' + lhFmt(tt.more.timing, 1) +
                '°, ' + lhS(tt.less.s) + ' and ' + lhS(tt.more.s) + ' of data) cylinder ' + h.cyl + ' read ' + lhFmt(tt.less.level, 0) + ' vs ' + lhFmt(tt.more.level, 0) +
                ' (' + (tt.change >= 0 ? '+' : '') + lhFmt(tt.change * 100, 0) + ' %): ' + (tt.result === 'fell' ? 'it fell with timing, as knock does.' : tt.result === 'same' ?
                'it did not fall — knock would normally drop with that much less timing, noise doesn\'t.' : 'a small drop; not conclusive.') +
                ' (Engine-wide timing changed between these logs, so other cylinders moved too.)');
        } else if (h.perLog.length > 1) {
            parts.push('The logs ran within 2° of each other at the hump, so they don\'t test timing.');
        }
        parts.push(h.verdict === 'noise' ? 'Together that is the pattern of a mechanical noise (a resonance, a valvetrain or accessory event, a loose bracket or heat ' +
            'shield near that cylinder\'s sensor) rather than knock.' : 'Treat it as possible knock until a timing test shows it doesn\'t respond.');
        if (h.retardS > 0) parts.push('Knock control retarded cylinder ' + h.cyl + ' for ' + lhS(h.retardS) + ' in this band.');
        var worst = h.bands.reduce(function (a, x) { return x.pctThr !== null && (!a || x.pctThr > a.pctThr) ? x : a; }, null);
        if (worst && worst.pctThr !== null) parts.push('Loudest (99th percentile): ' + lhFmt(worst.pctThr, 0) + ' % of threshold at ' + worst.label + '.');
        // What to do.
        if (h.verdict === 'noise') {
            var others99 = h.bands.map(function (x) { return x.others; }).filter(function (v) { return v !== null; });
            var near = (worst && worst.pctThr >= 80) || h.retardS > 0;
            parts.push('Options: (1) prove it with a cylinder-only test — Ignition Cylinder ' + h.cyl + ' Trim about −4° at ' + h.r0 + '–' + h.r1 + ' rpm — and load the ' +
                'before and after logs together here; a hump that doesn\'t move is noise. ' + (near ? '(2) ' + (th ? 'Raise Knock Threshold only around ' + Math.round(h.peak) +
                ' rpm (sites ' + (h.r0 - 200) + ' / ' + Math.round(h.peak) + ' / ' + (h.r1 + 200) + ' if the table has none there) so the hump stays below it; ' +
                'the threshold is shared by all cylinders, so the others lose that much margin there (they read about ' + lhFmt(kpMedian(others99), 0) +
                ' % of threshold in this band). ' : 'Raise Knock Threshold only around the hump; the threshold is shared by all cylinders. ') +
                '(3) Narrow the knock window at that engine speed so it misses the noise event. ' : '(2) It stays well under the threshold in these logs, so it costs ' +
                'nothing yet: leave the threshold alone and recheck with boost data at this engine speed. ') + '(' + (near ? 4 : 3) + ') Look for the mechanical source: ' +
                'sensor torque and seat, brackets and heat shields near it.');
        }
        var sev = h.verdict === 'noise' ? (worst && worst.pctThr >= 80 || h.retardS > 0 ? 'warn' : 'info') : 'warn';
        var bestLog = h.perLog.reduce(function (a, x) { return !a || x.s > a.s ? x : a; }, null);
        var times = [];
        if (bestLog) {
            var t0 = null, prev = -1;
            for (var i = 0; i < S.bin.length; i++) {
                if (S.file[i] !== bestLog.file || S.bin[i] < (h.r0 - KP_MIN_RPM) / KP_BIN || S.bin[i] > (h.r1 - KP_MIN_RPM) / KP_BIN - 1) continue;
                if (t0 === null || S.t[i] - prev > 0.5) { if (t0 !== null && prev - t0 >= 0.3) times.push([t0, prev]); t0 = S.t[i]; }
                prev = S.t[i];
            }
            if (t0 !== null && prev - t0 >= 0.3) times.push([t0, prev]);
            times = times.sort(function (a, b) { return (b[1] - b[0]) - (a[1] - a[0]); }).slice(0, 20).sort(function (a, b) { return a[0] - b[0]; });
        }
        // The quietest other cylinder at the peak, to plot next to the loud one.
        var pb = Math.floor((h.peak - KP_MIN_RPM) / KP_BIN), quiet = -1;
        for (var o = 0; o < nCyl; o++) if (o !== h.cyl - 1 && all[o][pb] && (quiet < 0 || all[o][pb].v < all[quiet][pb].v)) quiet = o;
        if (quiet < 0) quiet = h.cyl === 1 ? 1 : 0;
        add('Humps', sev, hg + ': ' + (h.verdict === 'noise' ? 'louder than the others' + [h.light ? 'at light load too' : '', h.gearsLoud >= 2 ? 'in ' + h.gearsLoud + ' gears' : '',
                h.timingTest && h.timingTest.result === 'same' ? 'not lower with less timing' : ''].filter(Boolean).map(function (x, i, l) {
                    return (i === 0 ? ' ' : i === l.length - 1 ? ' and ' : ', ') + x; }).join('') + ' — most likely noise' : 'louder than the others — check for knock'),
            parts.join(' '), times, [['Engine Speed'], ['Ignition Cylinder ' + h.cyl + ' Knock Level', 'Ignition Cylinder ' + (quiet + 1) + ' Knock Level'],
                ['Inlet Manifold Pressure'], ['Ignition Timing']], bestLog ? bestLog.file : null);
    });
    if (!out.humps.length) add('Humps', 'ok', 'No cylinder-specific hump', 'No cylinder reads ' + KP_HUMP_OTHERS + '× the others in an engine-speed band where it is quieter ' +
        'either side.');
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { kpAnalyze: kpAnalyze, kpThreshold: kpThreshold };
