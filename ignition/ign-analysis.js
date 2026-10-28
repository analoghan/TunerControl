/**
 * ignition/ign-analysis.js — Ignition Review: where every degree of the logged Ignition Timing comes from, where it leaves the
 * tune, and what the tune's ignition settings do with the fuel and air this log ran on.
 *
 *   igAnalyze(log, tune) → { duration, runningS, normalS, composition, blendPct, findings, states, cells, cylinders }
 *     log:  lvOpenLog() result (log-viewer/log-file.js); uses the Log Health helpers (log-health/health-checks.js)
 *     tune: m1pkgIgnition() result
 *   finding = { group, severity: 'fail' | 'warn' | 'info' | 'ok', title, detail, times: [[t0, t1]], channels: [[name…] per pane] }
 *
 * In the Normal state the M1 runs table + Ignition Timing Compensation (MoTeC training 50): table = Main blended toward the
 * Alternative Fuel table by the blend at Fuel Composition, at Engine Speed × Engine Load Normalised (= MAP in MAP load mode).
 * Other states (idle control, overrun, gear shift…) set timing themselves and are only counted.
 */

var IG_DEPART_DEG = 1.0;      // logged timing this far from table + compensation…
var IG_DEPART_S = 0.3;        // …for this long is a departure worth listing
var IG_CELL_S = 0.5;          // seconds of Normal running a grid cell needs to be shown
var IG_WEAK_INPUT = 3;        // a knock input whose median level is this many times lower than another's "reads low"
var IG_BOOST_KPA = 100;
var IG_STEADY_KPA = 5;        // departures only where load moved less than this over ±0.2 s (MAP is logged at 10 Hz, timing at 20 Hz)

function igInterp(xs, ys, x) {
    if (xs.length === 1 || !(x > xs[0])) return ys[0];
    for (var i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[ys.length - 1];
}

/** Table value at axis inputs (a, b); a 1-D table ignores b. */
function igLookup(t, a, b) {
    if (t.axes.length < 2) return igInterp(t.axes[0].values, t.v[0], a);
    var ys = t.axes[1].values, col = [];
    for (var j = 0; j < ys.length; j++) col.push(igInterp(t.axes[0].values, t.v[j], a));
    return igInterp(ys, col, b);
}

/** Base-rate log values for a table axis input (M1 name), or null. Load Normalised is MAP in MAP load mode. */
function igInput(c, input, loadIsMap) {
    if (input === 'Engine.Speed.Reference.Engine Speed') return c.base('Engine Speed');
    if (input === 'Engine.Load.Normalised.Value') return c.base('Engine Load Normalised') || (loadIsMap ? c.base('Inlet Manifold Pressure') : null);
    return c.base(input.replace(/\.Value$/, '').replace(/\./g, ' '));
}

function igNearest(sites, v) {
    var best = 0;
    for (var i = 1; i < sites.length; i++) if (Math.abs(sites[i] - v) < Math.abs(sites[best] - v)) best = i;
    return best;
}

function igAnalyze(log, tune) {
    var c = lhContext(log), findings = [];
    function add(group, severity, title, detail, times, channels) {
        findings.push({ group: group, severity: severity, title: title, detail: detail || '', times: times || [], channels: channels || [] });
    }
    var out = { duration: c.n * c.dt, runningS: c.runningS, normalS: 0, composition: null, blendPct: null, findings: findings, states: [], cells: [], cylinders: [] };
    var rpm = c.base('Engine Speed'), ign = c.base('Ignition Timing'), comp = c.base('Ignition Timing Compensation'), state = c.base('Ignition Timing State');
    if (!rpm || !ign) {
        add('Log', 'fail', 'The log has no Engine Speed or Ignition Timing', 'Log Ignition Timing, Ignition Timing Compensation and Ignition Timing State.');
        return out;
    }
    if (!state) add('Log', 'warn', 'Ignition Timing State is not logged', 'Without it idle control, overrun and gear-shift timing can\'t be told from the table; every running sample is treated as Normal.');
    if (!comp) add('Log', 'warn', 'Ignition Timing Compensation is not logged', 'The table alone is compared with Ignition Timing; any compensation shows up as a departure.');

    // --- States -------------------------------------------------------------------------------------------------------
    var STATE_NAMES = { 0: 'Normal', 1: 'Cranking', 2: 'Check Timing', 3: 'Limit Advance', 4: 'Limit Retard', 5: 'Idle', 6: 'Engine Overrun',
        7: 'Ignition Timing Control', 8: 'Gear Shift', 9: 'Anti Lag', 10: 'Traction Control', 11: 'Transmission A4E', 12: 'Exhaust Flame' };
    var normal = lhMask(c, function (k) { return c.running[k] && (!state || state[k] === 0); });
    out.normalS = lhCount(normal) * c.dt;
    if (state) {
        var codes = {};
        for (var k = c.start; k < c.n; k++) if (c.running[k]) codes[state[k]] = 1;
        out.states = Object.keys(codes).map(Number).sort(function (a, b) { return a - b; }).map(function (code) {
            var m = lhMask(c, function (k) { return c.running[k] && state[k] === code; }), eps = lhEpisodes(c, m, 0.1, 0.2);
            return { code: code, name: STATE_NAMES[code] || 'State ' + code, seconds: lhCount(m) * c.dt, episodes: eps.length,
                timing: lhQuantile(lhPick(ign, m, 5), 0.5) };
        });
        var limits = out.states.filter(function (s) { return s.code === 3 || s.code === 4 || s.code === 2; });
        limits.forEach(function (s) {
            add('Timing', 'warn', 'Ignition Timing State ' + s.name + ' for ' + lhS(s.seconds), s.code === 2 ? 'Check Timing locks timing for a timing-light check — never on the road.'
                : 'Timing reached Ignition Timing Limit ' + (s.code === 3 ? 'Advance' : 'Retard') + '; the table or a compensation asks for more than the limit allows.',
                lhEpisodes(c, lhMask(c, function (k) { return c.running[k] && state[k] === s.code; }), 0.1, 0.2), [['Ignition Timing', 'Ignition Timing State']]);
        });
    }
    if (!tune || !tune.main) {
        add('Tune', 'info', 'Choose the tune that ran the log', 'The table, flex blend, compensations and cylinder trims all come from the tune.');
        return out;
    }

    // --- Table + compensation model ----------------------------------------------------------------------------------
    var load = igInput(c, 'Engine.Load.Normalised.Value', tune.loadIsMap), fc = c.base('Fuel Composition');
    if (!load) {
        add('Log', 'fail', 'No load channel for the ignition table', 'Log Engine Load Normalised' + (tune.loadIsMap ? ' or Inlet Manifold Pressure' : '') + '.');
        return out;
    }
    var useAlt = tune.alt && tune.blend && fc;
    var table = new Float64Array(c.n), mainV = new Float64Array(c.n), altV = new Float64Array(c.n), blendV = new Float64Array(c.n), diff = new Float64Array(c.n);
    for (k = c.start; k < c.n; k++) {
        if (!c.running[k]) continue;
        var m0 = igLookup(tune.main, rpm[k], load[k]), b = useAlt ? igInterp(tune.blend.x, tune.blend.y, fc[k]) / 100 : 0;
        var a0 = useAlt ? igLookup(tune.alt, rpm[k], load[k]) : m0;
        mainV[k] = m0; altV[k] = a0; blendV[k] = b;
        table[k] = m0 + (a0 - m0) * b;
        diff[k] = ign[k] - table[k] - (comp ? comp[k] : 0);
    }
    if (fc) {
        out.composition = lhQuantile(lhPick(fc, c.running, 10), 0.5);
        out.blendPct = useAlt ? igInterp(tune.blend.x, tune.blend.y, out.composition) : null;
    }
    var nd = lhPick(diff, normal, 5), med = lhQuantile(nd, 0.5), absP90 = lhQuantile(nd.map(Math.abs), 0.9);
    if (nd.length) {
        var fits = Math.abs(med) < 0.3 && absP90 < 1;
        add('Timing', fits ? 'ok' : 'warn', fits ? 'Ignition Timing follows the tune: median ' + lhFmt(med, 2) + '°, 90 % within ' + lhFmt(absP90, 2) + '°'
            : 'Ignition Timing doesn\'t follow this tune: median ' + lhFmt(med, 2) + '° off, 90 % within ' + lhFmt(absP90, 2) + '°',
            'Logged Ignition Timing against ' + (useAlt ? 'Main blended toward Alternative Fuel Ignition Timing' : 'Ignition Timing Main') +
            (comp ? ' + Ignition Timing Compensation' : '') + ', over ' + lhS(out.normalS) + ' in the Normal state' +
            (tune.loadIsMap && !c.base('Engine Load Normalised') ? ' (load = MAP, Load Normalised Mode is Inlet Manifold Pressure)' : '') + '. ' +
            (fits ? 'Every degree in Normal running is accounted for.' : 'Either a different tune ran the log, or something this review doesn\'t model sets timing.'),
            [], [['Ignition Timing'], ['Ignition Timing Compensation']]);
    }

    // Departures: Normal state at a steady load, ≥ 1° off for ≥ 0.3 s — knock control, a limit, or something not modelled
    var w = Math.round(0.2 / c.dt);
    function steady(k) { var a = load[Math.max(0, k - w)], b = load[Math.min(c.n - 1, k + w)]; return Math.abs(b - a) < IG_STEADY_KPA && Math.abs(load[k] - a) < IG_STEADY_KPA; }
    var below = lhMask(c, function (k) { return normal[k] && diff[k] <= -IG_DEPART_DEG && steady(k); });
    var above = lhMask(c, function (k) { return normal[k] && diff[k] >= IG_DEPART_DEG && steady(k); });
    [[below, 'below', 'Knock control (Ignition Cylinder N Knock Trim), a torque reduction or a limit pulls timing the table doesn\'t; '],
     [above, 'above', 'Something adds timing the table and compensation don\'t explain; ']].forEach(function (d) {
        var eps = lhEpisodes(c, d[0], IG_DEPART_S, 0.2);
        if (!eps.length) return;
        var worst = 0, at = null;
        eps.forEach(function (e) {
            for (var k = Math.round(e[0] / c.dt); k < Math.round(e[1] / c.dt) && k < c.n; k++) if (d[0][k] && Math.abs(diff[k]) > Math.abs(worst)) { worst = diff[k]; at = k; }
        });
        var knockTrim = c.has('Ignition Cylinder 1 Knock Trim');
        add('Timing', 'warn', 'Timing ' + d[1] + ' the tune by ≥ ' + IG_DEPART_DEG + '°: ' + lhEpisodeText(eps),
            d[2] + 'up to ' + lhFmt(Math.abs(worst)) + '° at ' + lhAt(c.time[at]) + ' (' + Math.round(rpm[at]) + ' rpm, ' + Math.round(load[at]) + ' kPa).' +
            (d[1] === 'below' && !knockTrim ? ' Log Ignition Cylinder 1–8 Knock Trim to tell knock control from the rest.' : ''),
            eps, [['Ignition Timing'], ['Ignition Timing Compensation', 'Ignition Timing State']]);
    });
    if (!c.has('Ignition Cylinder 1 Knock Trim')) add('Log', 'info', 'Knock trims are not logged',
        'Log Ignition Cylinder 1–8 Knock Trim (20 Hz) so retard from knock control shows per cylinder.');

    // --- Compensation ------------------------------------------------------------------------------------------------
    var boost = lhMask(c, function (k) { return normal[k] && load[k] >= IG_BOOST_KPA; }), cruise = lhMask(c, function (k) { return normal[k] && load[k] < 80; });
    var modelled = [], unmodelled = [];
    tune.compensations.forEach(function (t) {
        var ins = t.axes.map(function (a) { return igInput(c, a.input, tune.loadIsMap); });
        if (ins.some(function (x) { return !x; })) { unmodelled.push(t.name); return; }
        var v = new Float64Array(c.n);
        for (var k = c.start; k < c.n; k++) if (c.running[k]) v[k] = igLookup(t, ins[0][k], ins[1] ? ins[1][k] : 0);
        modelled.push({ name: t.name, v: v, inputs: t.axes.map(function (a) { return a.input; }) });
    });
    if (comp) {
        var cc = lhPick(comp, cruise, 5), cb = lhPick(comp, boost, 5), cAll = lhPick(comp, normal, 5);
        var sum = new Float64Array(c.n);
        modelled.forEach(function (mc) { for (var k = 0; k < c.n; k++) sum[k] += mc.v[k]; });
        var res = [];
        for (k = c.start; k < c.n; k += 5) if (normal[k]) res.push(comp[k] - sum[k]);
        var resMed = lhQuantile(res, 0.5), resP90 = lhQuantile(res.map(Math.abs), 0.9);
        var parts = modelled.map(function (mc) {
            var vb = lhPick(mc.v, boost, 5), va = lhPick(mc.v, normal, 5);
            return mc.name.replace(/\.(Ignition Timing.*)$/, '').replace(/\./g, ' ') + ' ' + lhFmt(lhQuantile(va, 0.5)) + '° median' +
                (vb.length ? ', ' + lhFmt(lhQuantile(vb, 0.5)) + '° under boost' : '');
        });
        if (cAll.length) {
            var explained = res.length && Math.abs(resMed) < 0.2 && resP90 < 0.5;
            add('Compensation', explained ? 'ok' : 'warn', 'Ignition Timing Compensation: median ' + lhFmt(lhQuantile(cAll, 0.5)) + '°' +
                (cc.length ? ', cruise ' + lhFmt(lhQuantile(cc, 0.5)) + '°' : '') + (cb.length ? ', boost ' + lhFmt(lhQuantile(cb, 0.5)) + '° (worst ' + lhFmt(lhQuantile(cb, 0)) + '°)' : ''),
                (parts.length ? 'From the tune: ' + parts.join('; ') + '. ' : 'No compensation table in the tune is non-zero. ') +
                (explained ? 'That accounts for the logged compensation (median ' + lhFmt(resMed, 2) + '° left).'
                    : 'The logged compensation differs from these tables by a median ' + lhFmt(resMed, 2) + '° (90 % within ' + lhFmt(resP90, 2) + '°)' +
                      (unmodelled.length ? '; not modelled (input not logged): ' + unmodelled.join(', ') : '') + '.'),
                [], [['Ignition Timing Compensation'], ['Inlet Air Temperature', 'Coolant Temperature']]);
        }
        var iat = c.base('Inlet Air Temperature'), iatComp = modelled.filter(function (mc) { return /^Inlet\.Air\.Temperature/.test(mc.name); })[0];
        if (iat && iatComp && cb.length) {
            var ib = lhPick(iat, boost, 5);
            add('Compensation', 'info', 'Under boost, inlet air temperature ' + lhFmt(lhQuantile(ib, 0.1), 0) + '–' + lhFmt(lhQuantile(ib, 0.9), 0) + ' °C took ' +
                lhFmt(-lhQuantile(lhPick(iatComp.v, boost, 5), 0.5)) + '° out (' + lhS(lhCount(boost) * c.dt) + ' ≥ ' + IG_BOOST_KPA + ' kPa)',
                'The IAT compensation table depends on air temperature only, so it removes the same timing at cruise as in boost. Hot air raises knock risk ' +
                'mostly at high load; a load axis on the table (MoTeC training 50) would keep cruise timing and still protect boost.',
                lhEpisodes(c, boost, 0.3, 0.5), [['Ignition Timing Compensation'], ['Inlet Air Temperature', 'Inlet Manifold Pressure']]);
        }
    }

    // --- Flex: Main vs Alternative ----------------------------------------------------------------------------------
    if (useAlt) {
        var bp = out.blendPct, dB = [], dP = [];
        for (k = c.start; k < c.n; k += 5) {
            if (!normal[k]) continue;
            (load[k] >= IG_BOOST_KPA ? dB : dP).push(altV[k] - mainV[k]);
        }
        var full = null;
        for (var i = 0; i < tune.blend.y.length; i++) if (tune.blend.y[i] >= 100) { full = tune.blend.x[i]; break; }
        add('Flex fuel', 'info', 'At ' + lhFmt(out.composition) + ' % composition the timing is ' + lhFmt(bp, 0) + ' % Alternative Fuel Ignition Timing',
            'Alternative Fuel Ignition Timing Blend' + (full !== null ? ' reaches 100 % at ' + lhFmt(full, 0) + ' % composition' : '') +
            '. Where this log ran, Alternative − Main = ' + (dP.length ? lhFmt(lhQuantile(dP, 0.5)) + '° median at part load' : '') +
            (dB.length ? (dP.length ? ', ' : '') + lhFmt(lhQuantile(dB, 0.5)) + '° under boost' : '') + '.', [], [['Ignition Timing'], ['Fuel Composition']]);
        // Over the whole boost region of the tables (≥ 2000 rpm), not just where this log went: rows where Alternative runs less advance
        var less = [], same = [];
        tune.main.axes[1].values.forEach(function (y, j) {
            if (y < IG_BOOST_KPA || j >= tune.alt.v.length) return;
            var d = [];
            tune.main.axes[0].values.forEach(function (x, ix) { if (x >= 2000) d.push(tune.alt.v[j][ix] - tune.main.v[j][ix]); });
            var md = lhQuantile(d, 0.5);
            (md < -0.25 ? less : same).push({ kpa: y, med: md, min: lhQuantile(d, 0) });
        });
        if (less.length && full !== null && full <= 70) {
            var meds = less.map(function (r) { return r.med; });
            add('Flex fuel', 'warn', 'Alternative Fuel Ignition Timing has less advance than Main at ' + less.map(function (r) { return r.kpa; }).join(', ') + ' kPa: median ' +
                lhFmt(Math.max.apply(null, meds)) + ' to ' + lhFmt(Math.min.apply(null, meds)) + '° per row (≥ 2000 rpm)' + (same.length ? '; same or more at the other boost rows' : ''),
                'Ethanol cools the charge and resists knock: MoTeC training 67 runs the petrol timing on ethanol first, then typically 6–8° more at the same ' +
                'boost once fuelling is verified, with the knock sensors watching. Less advance than petrol is safe but leaves torque. Raise it only with ' +
                'knock detection you trust on every cylinder.', [], []);
        }
    }
    if (tune.slice && tune.slice.differ) add('Tune', 'info', 'Ignition Timing Main slices differ; slice ' + tune.slice.label + ' was modelled',
        tune.slice.switched ? 'The Main Switch is wired: log Driver Ignition Timing Main Switch so the right slice is used.' : 'The Main Switch has no input, so the Default mapping (' + tune.slice.label + ') runs.');

    // --- Cylinder trims vs knock inputs ------------------------------------------------------------------------------
    var inputs = tune.knock && tune.knock.inputs, levels = {};
    var hiMask = lhMask(c, function (k) { return c.running[k] && rpm[k] > 1500; });
    tune.cylinderTrims.forEach(function (t, i) {
        var cyl = i + 1, retard = 0, adv = 0, atLoad = null;   // atLoad: the first load row with any retard
        if (t) t.v.forEach(function (row, j) {
            row.forEach(function (x) { if (x < 0 && atLoad === null && t.axes.length > 1) atLoad = t.axes[1].values[j]; if (x < retard) retard = x; if (x > adv) adv = x; });
        });
        var lv = c.base('Ignition Cylinder ' + cyl + ' Knock Level'), medLv = lv ? lhQuantile(lhPick(lv, hiMask, 5), 0.5) : null;
        var input = inputs ? inputs[i] : null;
        if (input && medLv !== null) (levels[input] = levels[input] || []).push(medLv);
        out.cylinders.push({ cylinder: cyl, input: input, retard: retard, advance: adv, retardFrom: atLoad, knockMedian: medLv });
    });
    var inputMed = Object.keys(levels).map(function (n) { return { input: n, med: lhQuantile(levels[n], 0.5) }; }).sort(function (a, b) { return b.med - a.med; });
    if (inputMed.length >= 2) {
        var loud = inputMed[0], quiet = inputMed[inputMed.length - 1], ratio = loud.med / Math.max(1e-6, quiet.med);
        var trimmed = out.cylinders.filter(function (x) { return x.retard < 0; });
        var onLoud = trimmed.filter(function (x) { return x.input === loud.input; }).length, onQuiet = trimmed.filter(function (x) { return x.input === quiet.input; }).length;
        if (ratio >= IG_WEAK_INPUT && onLoud && !onQuiet) {
            var qc = out.cylinders.filter(function (x) { return x.input === quiet.input; }).map(function (x) { return x.cylinder; });
            add('Cylinder trims', 'warn', 'Retard trims only on ' + loud.input + ' cylinders (' + trimmed.map(function (x) { return x.cylinder + ': ' + lhFmt(x.retard) + '°'; }).join(', ') +
                '); cylinders ' + qc.join('/') + ' have none and ' + quiet.input + ' reads ' + lhFmt(ratio, 1) + '× lower',
                'Median knock level above 1500 rpm: ' + loud.input + ' ' + lhFmt(loud.med, 2) + ' %, ' + quiet.input + ' ' + lhFmt(quiet.med, 2) + ' %. If the trims were set ' +
                'from knock seen on the louder input, cylinders ' + qc.join('/') + ' may need the same and their sensor can\'t show it. Until that input reads like the other, ' +
                'treat ' + qc.join('/') + ' as unprotected: no added timing or boost.', [], [qc.slice(0, 2).map(function (n) { return 'Ignition Cylinder ' + n + ' Knock Level'; })]);
        }
    }

    // --- Grid: Normal running by Main table site ---------------------------------------------------------------------
    var xs = tune.main.axes[0].values, ys = tune.main.axes[1].values, bins = {};
    var thr = tune.knock && tune.knock.threshold, knockCh = [];
    for (var cy = 1; cy <= 8; cy++) { var kl = c.base('Ignition Cylinder ' + cy + ' Knock Level'); if (kl) knockCh.push(kl); }
    for (k = c.start; k < c.n; k++) {
        if (!normal[k]) continue;
        var key = igNearest(xs, rpm[k]) + ',' + igNearest(ys, load[k]), bin = bins[key] || (bins[key] = { n: 0, ign: [], table: [], comp: [], alt: [], knock: [] });
        bin.n++;
        if (k % 5) continue;
        bin.ign.push(ign[k]); bin.table.push(table[k]); bin.comp.push(comp ? comp[k] : 0); bin.alt.push(altV[k] - mainV[k]);
        if (knockCh.length && thr) {
            var loudest = 0;
            for (cy = 0; cy < knockCh.length; cy++) if (knockCh[cy][k] > loudest) loudest = knockCh[cy][k];
            bin.knock.push(loudest / igThreshold(thr, rpm[k]) * 100);
        }
    }
    out.cells = Object.keys(bins).filter(function (key) { return bins[key].n * c.dt >= IG_CELL_S; }).map(function (key) {
        var p = key.split(','), bn = bins[key];
        return { rpm: xs[+p[0]], kpa: ys[+p[1]], seconds: bn.n * c.dt, timing: lhQuantile(bn.ign, 0.5), table: lhQuantile(bn.table, 0.5), comp: lhQuantile(bn.comp, 0.5),
            altMinusMain: lhQuantile(bn.alt, 0.5), knockPct: bn.knock.length ? lhQuantile(bn.knock, 0.99) : null };
    }).sort(function (a, b) { return b.kpa - a.kpa || a.rpm - b.rpm; });
    var near = out.cells.filter(function (x) { return x.knockPct !== null && x.knockPct >= 80; });
    if (near.length) add('Knock margin', 'warn', 'Knock level reaches ' + Math.round(Math.max.apply(null, near.map(function (x) { return x.knockPct; }))) + ' % of the threshold in ' +
        near.length + ' cell' + (near.length > 1 ? 's' : ''), near.map(function (x) { return x.rpm + ' rpm × ' + x.kpa + ' kPa (' + lhS(x.seconds) + ', ' + Math.round(x.knockPct) + ' %)'; }).join(', ') +
        '. The loudest cylinder\'s 99th percentile against Knock Threshold. No room for more timing there until the Knock Analyzer says the level is noise.', [], []);
    return out;
}

function igThreshold(thr, rpm) {
    if (!thr || !thr.rpm || !thr.values || !thr.values.length) return Infinity;
    return igInterp(thr.rpm, thr.values[0], rpm);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { igAnalyze: igAnalyze, igLookup: igLookup };
