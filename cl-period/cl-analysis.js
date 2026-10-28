/**
 * cl-period/cl-analysis.js — Closed-Loop Period from lambda step tests: how long after a fuelling step the lambda sensor starts to move,
 * against Fuel Closed Loop Period at the exhaust mass flow of the step.
 *
 *   clAnalyze(logs, tune) → { duration, lambdaHz, bankNames, events, sites, findings }
 *     logs: [lvOpenLog() result] (log-viewer/log-file.js) — steps from every log are pooled; uses the Log Health helpers
 *     tune: m1pkgClPeriod() result | null (the tune that ran the logs)
 *   event = { file (index into logs), t, source: 'aim' | 'cut', step (λ), flow (g/s), rpm, kpa, banks: [ms | null per bank], tableMs }
 *   site  = { flow, tableMs, n, nAim, nCut, medianMs, p10Ms, p90Ms, suggested, action, note, howTo: { rpm, kpa } | null }
 *   finding = { group, severity, title, detail, times, channels } (as Log Health)
 *
 * MoTeC's method (training 39/40/47): hold a steady point, step the mixture aim (e.g. 1.0 → 0.9 λ) and time from the step to the
 * lambda sensor starting to move; that is the Period at that exhaust mass flow. Aim steps are found by themselves in the log.
 * Overrun fuel cuts are natural steps too, but only clean ones count (lambda at aim before, cut ≥ 0.8 s, warm engine); the cut
 * state is logged at 10 Hz, so the true delay can be up to 100 ms longer than measured.
 */

var CL_AIM_STEP = 0.03;        // λ: smallest aim step
var CL_AIM_RISE_S = 0.25;      // the step must complete within this
var CL_HOLD_BEFORE_S = 1.0, CL_HOLD_AFTER_S = 1.5;
var CL_STEADY_RPM = 250, CL_STEADY_KPA = 8;
var CL_CUT_MIN_S = 0.8, CL_CUT_ONSET = 0.1, CL_CUT_AT_AIM = 0.08;
var CL_MIN_AIM = 3, CL_MIN_CUT = 4, CL_MAX_SPREAD_MS = 150, CL_MIN_CHANGE_MS = 100;

function clInterp(xs, ys, x) {
    if (xs.length === 1 || !(x > xs[0])) return ys[0];
    for (var i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[ys.length - 1];
}

/** Lambda value at time t from own-rate samples (held). */
function clAt(l, t) { return l.v[Math.min(l.v.length - 1, Math.max(0, Math.floor(t * l.freq)))]; }

/** Seconds after t0 until lambda first passes thr in direction dir (linear between samples), within maxS; null if never. */
function clCross(l, t0, thr, dir, maxS) {
    for (var i = Math.max(1, Math.ceil(t0 * l.freq)); i < l.v.length && i / l.freq <= t0 + maxS; i++) {
        if (dir > 0 ? l.v[i] >= thr : l.v[i] <= thr) {
            var a = l.v[i - 1], fr = l.v[i] !== a ? (thr - a) / (l.v[i] - a) : 1;
            return Math.max(0, (i - 1 + Math.min(1, Math.max(0, fr))) / l.freq - t0);
        }
    }
    return null;
}

function clRange(arr, k0, k1) {
    var lo = Infinity, hi = -Infinity;
    for (var k = Math.max(0, k0); k <= k1 && k < arr.length; k++) { if (arr[k] < lo) lo = arr[k]; if (arr[k] > hi) hi = arr[k]; }
    return hi - lo;
}

/** Steps in one log: { events, where: [{ rpm: [], kpa: [] } per Period site], lambdaHz, bankNames, missing, noFlow }. */
function clLogSteps(log, file, tune) {
    var c = lhContext(log), events = [];
    var sites = tune && tune.period ? tune.period.flow : [];
    var out = { events: events, where: sites.map(function () { return { rpm: [], kpa: [] }; }), lambdaHz: null, bankNames: [], missing: false, noFlow: false, duration: c.n * c.dt };
    var rpm = c.base('Engine Speed'), kpa = c.base('Inlet Manifold Pressure'), aim = c.base('Fuel Mixture Aim'), ov = c.base('Engine Overrun State');
    var lams = [c.native('Exhaust Lambda Bank 1'), c.native('Exhaust Lambda Bank 2')].filter(Boolean);
    if (!lams.length && c.native('Exhaust Lambda')) lams = [c.native('Exhaust Lambda')];
    if (!rpm || !aim || !lams.length) { out.missing = true; return out; }
    out.lambdaHz = lams[0].freq;
    out.bankNames = lams.map(function (l) { return l.name; });

    // Exhaust mass flow (g/s): logged, or air + fuel from Engine Load (mg per cylinder per cycle)
    var logged = c.base('Exhaust Mass Flow'), load = c.base('Engine Load'), stoich = c.base('Fuel Stoichiometric Ratio');
    var cyl = tune && tune.period ? tune.period.cylinders : 8;
    function flowAt(k) {
        if (logged) return logged[k];
        if (!load) return NaN;
        var air = load[k] * cyl * rpm[k] / 120 / 1000, afr = stoich ? stoich[k] * aim[k] : 14.7 * aim[k];
        return air * (1 + 1 / afr);
    }
    function tableAt(f) { return tune && tune.period && !isNaN(f) ? clInterp(tune.period.flow, tune.period.ms, f) : null; }

    var nB = Math.round(CL_HOLD_BEFORE_S / c.dt), nA = Math.round(CL_HOLD_AFTER_S / c.dt), nR = Math.round(CL_AIM_RISE_S / c.dt);

    // --- Aim steps ----------------------------------------------------------------------------------------------------
    for (var k = c.start + nB; k < c.n - nA - nR; k++) {
        if (Math.abs(aim[k] - aim[k - 1]) < 0.002 || !c.warmedUp[k]) continue;
        var before = aim[k - 1], after = aim[k + nR], step = after - before;
        if (Math.abs(step) < CL_AIM_STEP) continue;
        if (clRange(aim, k - nB, k - 1) > 0.01 || clRange(aim, k + nR, k + nR + nA) > 0.01) continue;
        if (clRange(rpm, k - nB, k + nA) > CL_STEADY_RPM || (kpa && clRange(kpa, k - nB, k + nA) > CL_STEADY_KPA)) continue;
        var cut = false;
        for (var j = k - nB; j <= k + nA; j++) if (ov && ov[j] === 2) cut = true;
        if (cut) continue;
        var t0 = c.time[k], dir = step > 0 ? 1 : -1;
        var banks = lams.map(function (l) {
            var base = clAt(l, t0 - 0.05), d = clCross(l, t0, base + dir * Math.max(0.01, 0.25 * Math.abs(step)), dir, 3);
            var moved = (clAt(l, t0 + 2) - base) * dir >= 0.5 * Math.abs(step);   // the sensor really followed the step
            return d !== null && moved ? Math.round(d * 1000) : null;
        });
        var f = flowAt(k - 1);
        events.push({ file: file, t: t0, source: 'aim', step: step, flow: f, rpm: rpm[k], kpa: kpa ? kpa[k] : null, banks: banks, tableMs: tableAt(f) });
        k += nR + nA;   // one event per step
    }

    // --- Clean overrun cuts -------------------------------------------------------------------------------------------
    if (ov) for (k = c.start + 50; k < c.n; k++) {
        if (!(ov[k] === 2 && ov[k - 1] !== 2 && rpm[k] > 1200 && c.warmedUp[k])) continue;
        var end = k;
        while (end < c.n && ov[end] === 2) end++;
        if ((end - k) * c.dt < CL_CUT_MIN_S) { k = end; continue; }
        var t1 = c.time[k], clean = true;
        var cb = lams.map(function (l) {
            var b0 = clAt(l, t1 - 0.05), bm = clAt(l, t1 - 0.5);
            if (!(Math.abs(b0 - aim[k - 1]) < CL_CUT_AT_AIM && Math.abs(bm - aim[k - 50]) < CL_CUT_AT_AIM)) clean = false;
            var d = clCross(l, t1, b0 + CL_CUT_ONSET, 1, 2);
            return d !== null ? Math.round(d * 1000) : null;
        });
        if (clean) {
            var f2 = flowAt(k - 10);
            events.push({ file: file, t: t1, source: 'cut', step: null, flow: f2, rpm: rpm[k], kpa: kpa ? kpa[k] : null, banks: cb, tableMs: tableAt(f2) });
        }
        k = end;
    }
    events.sort(function (a, b) { return a.t - b.t; });
    out.noFlow = !logged && !load;

    // Where the log ran at each site's flow (warm, fuelled) — to say where to hold for a step test
    for (k = c.start; k < c.n; k += 10) {
        if (!c.warmedUp[k] || (ov && ov[k] === 2)) continue;
        var fk = flowAt(k);
        if (isNaN(fk)) continue;
        for (var s = 0; s < sites.length; s++) if (Math.abs(fk - sites[s]) <= Math.max(2, 0.15 * sites[s])) { out.where[s].rpm.push(rpm[k]); if (kpa) out.where[s].kpa.push(kpa[k]); }
    }
    return out;
}

function clAnalyze(logs, tune) {
    var findings = [], events = [];
    function add(group, severity, title, detail, times, channels) {
        findings.push({ group: group, severity: severity, title: title, detail: detail || '', times: times || [], channels: channels || [] });
    }
    var per = logs.map(function (log, i) { return clLogSteps(log, i, tune); });
    var ok = per.filter(function (p) { return !p.missing; });
    var out = { duration: per.reduce(function (a, p) { return a + p.duration; }, 0), lambdaHz: ok.length ? Math.min.apply(null, ok.map(function (p) { return p.lambdaHz; })) : null,
        bankNames: ok.length ? ok[0].bankNames : [], events: events, sites: [], findings: findings };
    if (ok.length < per.length) add('Log', 'fail', (per.length - ok.length) + ' log' + (per.length - ok.length > 1 ? 's lack' : ' lacks') + ' Engine Speed, Fuel Mixture Aim or Exhaust Lambda',
        'Log Exhaust Lambda Bank 1 / 2 (as fast as possible), Fuel Mixture Aim, Engine Speed, Inlet Manifold Pressure, Engine Load, Fuel Stoichiometric Ratio and Engine Overrun State.');
    if (!ok.length) return out;
    ok.forEach(function (p) { Array.prototype.push.apply(events, p.events); });
    var lams = out.bankNames;
    var nAim = events.filter(function (e) { return e.source === 'aim'; }).length, nCut = events.length - nAim;
    if (out.lambdaHz < 20) add('Log', 'info', 'Lambda is logged at ' + out.lambdaHz + ' Hz: each step is timed to about ±' + Math.round(500 / out.lambdaHz) + ' ms',
        'Several steps per flow site average that out. For a step test, log Exhaust Lambda Bank 1 / 2 and Fuel Mixture Aim faster (50 Hz or more) if the logger allows.',
        [], [['Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Fuel Mixture Aim']]);
    if (ok.some(function (p) { return p.noFlow; })) add('Log', 'warn', 'No exhaust mass flow', 'Log Exhaust Mass Flow, or Engine Load and Fuel Stoichiometric Ratio, so steps can be placed on the Period table.');

    // --- Per Period site -----------------------------------------------------------------------------------------------
    if (tune && tune.period) {
        var sites = tune.period.flow;
        var groups = sites.map(function () { return []; });
        events.forEach(function (e) {
            if (isNaN(e.flow)) return;
            var best = 0;
            for (var i = 1; i < sites.length; i++) if (Math.abs(sites[i] - e.flow) < Math.abs(sites[best] - e.flow)) best = i;
            groups[best].push(e);
        });
        var where = sites.map(function (x, i) {
            return { rpm: [].concat.apply([], ok.map(function (p) { return p.where[i].rpm; })), kpa: [].concat.apply([], ok.map(function (p) { return p.where[i].kpa; })) };
        });
        out.sites = sites.map(function (flow, i) {
            var g = groups[i], ms = [];
            g.forEach(function (e) { e.banks.forEach(function (b) { if (b !== null) ms.push(b); }); });
            var a = g.filter(function (e) { return e.source === 'aim'; }).length, cu = g.length - a;
            var site = { flow: flow, tableMs: tune.period.ms[i], n: g.length, nAim: a, nCut: cu, medianMs: ms.length ? lhQuantile(ms, 0.5) : null,
                p10Ms: ms.length ? lhQuantile(ms, 0.1) : null, p90Ms: ms.length ? lhQuantile(ms, 0.9) : null, suggested: null, action: '', note: '',
                howTo: flow >= 5 && where[i].rpm.length >= 3 ? { rpm: Math.round(lhQuantile(where[i].rpm, 0.5) / 50) * 50, kpa: where[i].kpa.length ? Math.round(lhQuantile(where[i].kpa, 0.5)) : null } : null };
            if (!g.length) { site.action = 'no data'; site.note = 'No step near this flow.'; return site; }
            var spread = site.p90Ms - site.p10Ms, enough = a >= CL_MIN_AIM || cu >= CL_MIN_CUT;
            if (!enough) { site.action = 'more steps'; site.note = g.length + ' step' + (g.length > 1 ? 's' : '') + '; need ' + CL_MIN_AIM + ' aim steps or ' + CL_MIN_CUT + ' clean cuts.'; return site; }
            if (spread > CL_MAX_SPREAD_MS) { site.action = 'inconsistent'; site.note = 'Delays spread ' + Math.round(site.p10Ms) + '–' + Math.round(site.p90Ms) + ' ms; repeat the steps at a steadier point.'; return site; }
            // Cut delays are measured from the logged (10 Hz) state change: add half the logging interval. Round up to 50 ms — a
            // slightly long period is the safe side (too short makes the trim chase its own correction and oscillate).
            var est = site.medianMs + (a >= CL_MIN_AIM ? 0 : 50), sug = Math.ceil(est / 50) * 50;
            if (Math.abs(sug - site.tableMs) < CL_MIN_CHANGE_MS) { site.action = 'keep'; site.note = 'Within ' + CL_MIN_CHANGE_MS + ' ms of the table.'; return site; }
            site.suggested = sug;
            site.action = sug < site.tableMs ? 'shorter' : 'longer';
            site.note = 'Measured ' + Math.round(site.medianMs) + ' ms median from ' + (a >= CL_MIN_AIM ? a + ' aim steps' : cu + ' clean cuts (+50 ms for the 10 Hz cut state)') + '.';
            return site;
        });

        var changes = out.sites.filter(function (s) { return s.suggested !== null; });
        if (changes.length) {
            var worst = changes.reduce(function (m, s) { return Math.abs(s.tableMs - s.suggested) > Math.abs(m.tableMs - m.suggested) ? s : m; });
            add('Period', 'warn', 'Fuel Closed Loop Period is ' + (worst.suggested < worst.tableMs ? 'longer' : 'shorter') + ' than the measured delay at ' +
                changes.map(function (s) { return s.flow + ' g/s'; }).join(', ') + ': ' + Math.round(worst.tableMs) + ' ms in the table, ' + Math.round(worst.medianMs) + ' ms measured at ' + worst.flow + ' g/s',
                'Too long a Period makes the closed loop lazy — it waits for a response that has already arrived, so trims lag and lambda drifts off aim; too short makes it ' +
                'hyperactive and oscillate (MoTeC training 39). Set the Period first, then judge Fuel Closed Loop Control Trim Gain (training 40). Change only the measured ' +
                'sites and blend the rest; VE Table Tuning\'s "from the tune" lambda delay uses this table too.', [], [['Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Fuel Mixture Aim']]);
        } else if (out.sites.some(function (s) { return s.action === 'keep'; })) {
            add('Period', 'ok', 'Fuel Closed Loop Period matches the measured delay where steps were found', out.sites.filter(function (s) { return s.action === 'keep'; })
                .map(function (s) { return s.flow + ' g/s: ' + Math.round(s.tableMs) + ' ms table, ' + Math.round(s.medianMs) + ' ms measured'; }).join('; ') + '.');
        }
        var untested = out.sites.filter(function (s) { return s.action === 'no data' || s.action === 'more steps'; });
        if (untested.length) add('Step test', 'info', 'To measure the other sites, step the aim at a steady point near each flow',
            'Hold the point (cruise control or a steady throttle in one gear), change the Fuel Mixture Aim cell you are in by −0.1 λ, hold 3 s, put it back, hold 3 s; ' +
            'three times per site. ' + untested.map(function (s) {
                return s.flow + ' g/s' + (s.flow < 5 ? ' (below idle flow: carry the lowest measured site down)' : s.howTo ? ' ≈ ' + s.howTo.rpm + ' rpm × ' +
                    (s.howTo.kpa !== null ? s.howTo.kpa + ' kPa' : '?') : ' (not reached in these logs)');
            }).join('; ') + '. The trim reacts only after the Period, so the onset is measurable with closed loop on; MoTeC sets the trim limits to 0 for the test.');
    } else {
        add('Tune', 'info', 'Choose the tune that ran the log', 'The measured delays are compared with its Fuel Closed Loop Period.');
    }

    // --- Summary of what was measured ---------------------------------------------------------------------------------
    if (!events.length) add('Steps', 'info', 'No aim steps or clean overrun cuts found',
        'An aim step needs ≥ ' + CL_AIM_STEP + ' λ within ' + CL_AIM_RISE_S + ' s, held ' + CL_HOLD_BEFORE_S + ' s before and ' + CL_HOLD_AFTER_S + ' s after, at a steady ' +
        'point (rpm within ' + CL_STEADY_RPM + ', MAP within ' + CL_STEADY_KPA + ' kPa) with the engine warm. A clean cut has lambda at aim before it and lasts ≥ ' + CL_CUT_MIN_S + ' s.');
    else {
        var bankMed = lams.map(function (name, bi) { return lhQuantile(events.map(function (e) { return e.banks[bi]; }).filter(function (x) { return x !== null; }), 0.5); });
        add('Steps', 'info', nAim + ' aim step' + (nAim === 1 ? '' : 's') + ' and ' + nCut + ' clean overrun cut' + (nCut === 1 ? '' : 's') + ' timed',
            (logs.length > 1 ? 'From ' + logs.length + ' logs. ' : '') + 'Median delay ' + lams.map(function (name, bi) { return name.replace('Exhaust Lambda ', '') + ' ' + lhFmt(bankMed[bi], 0) + ' ms'; }).join(', ') + '. ' +
            (lams.length > 1 && Math.abs(bankMed[0] - bankMed[1]) > 100 ? 'The banks differ by more than 100 ms — different sensor positions or a slow sensor; the Period is one table for both. ' : ''),
            [], [lams.concat(['Fuel Mixture Aim']), ['Engine Overrun State']]);
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { clAnalyze: clAnalyze, clCross: clCross };
