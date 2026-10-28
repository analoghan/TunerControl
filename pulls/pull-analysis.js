/**
 * pulls/pull-analysis.js — Pull Report: every full-throttle or boost pull in one or more logs, with what each system did during it —
 * lambda against aim per bank, knock against the threshold, timing, rail and low-side fuel pressure, injector duty, temperatures,
 * oil pressure, voltages and any limit or cut — and what to look at.
 *
 *   puAnalyze(logs, tune) → { pulls, findings }
 *     logs: [lvOpenLog() result] (log-viewer/log-file.js); uses the Log Health helpers (log-health/health-checks.js)
 *     tune: { tuneName, threshold } | null — threshold = m1pkgKnock().threshold (Knock Threshold by rpm)
 *   pull = { file, t0, t1, seconds, full (pedal ≥ 85 %), gear, rpm: [start, end], pedal, mapMax, metrics: {…}, flags: [{ severity, text }] }
 *   finding = { group, severity, title, detail, times, channels } (as Log Health; times only for single-log runs)
 *
 * A pull is ≥ 0.8 s with MAP ≥ 100 kPa or Throttle Pedal ≥ 85 %, above 1500 rpm, engine warm. Lambda is compared with the aim
 * 300 ms earlier (the lambda delay measured on this car); the first 0.5 s of a pull (tip-in) is left out of the lambda numbers.
 */

var PU_MAP_KPA = 100, PU_PEDAL_FULL = 85, PU_MIN_S = 0.8, PU_JOIN_S = 0.4, PU_MIN_RPM = 1500;
var PU_LAMBDA_DELAY_S = 0.3, PU_LAMBDA_SKIP_S = 0.5;
var PU_LEAN = 0.03, PU_LEAN_BAD = 0.05, PU_BANK_SPLIT = 0.03;
var PU_RAIL_UNDER_BAR = 10, PU_RAIL_UNDER_PCT = 10;
var PU_LOW_KPA = 250, PU_LOW_DROP = 50;
var PU_DUTY = 85, PU_IAT_HOT = 60, PU_VOLTS = 12.5;
var PU_OIL_PER_1000 = 69;   // kPa per 1000 rpm (the "10 psi per 1000 rpm" rule)

function puInterp(xs, ys, x) {
    if (xs.length === 1 || !(x > xs[0])) return ys[0];
    for (var i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[ys.length - 1];
}

/** Values of a base-rate channel over [k0, k1). */
function puSlice(arr, k0, k1) { var out = []; for (var k = k0; k < k1; k++) if (!isNaN(arr[k])) out.push(arr[k]); return out; }
function puMax(a) { return a.length ? Math.max.apply(null, a) : null; }
function puMin(a) { return a.length ? Math.min.apply(null, a) : null; }

/** Lowest value held for at least `holdS` (min over windows of the window max), so one noisy sample doesn't count. */
function puSustainedMin(arr, k0, k1, n) {
    var best = Infinity;
    for (var k = k0; k + n <= k1; k++) {
        var hi = -Infinity;
        for (var j = k; j < k + n; j++) if (arr[j] > hi) hi = arr[j];
        if (hi < best) best = hi;
    }
    return best === Infinity ? null : best;
}
function puSustainedMax(arr, k0, k1, n) {
    var best = -Infinity;
    for (var k = k0; k + n <= k1; k++) {
        var lo = Infinity;
        for (var j = k; j < k + n; j++) if (arr[j] < lo) lo = arr[j];
        if (lo > best) best = lo;
    }
    return best === -Infinity ? null : best;
}

function puLogPulls(log, file, tune) {
    var c = lhContext(log), pulls = [];
    var rpm = c.base('Engine Speed'), map = c.base('Inlet Manifold Pressure'), pedal = c.base('Throttle Pedal');
    if (!rpm || (!map && !pedal)) return { pulls: pulls, missing: true };
    var mask = lhMask(c, function (k) { return c.warmedUp[k] && rpm[k] >= PU_MIN_RPM && ((map && map[k] >= PU_MAP_KPA) || (pedal && pedal[k] >= PU_PEDAL_FULL)); });
    var eps = lhEpisodes(c, mask, PU_MIN_S, PU_JOIN_S);
    var g = function (n) { return c.base(n); };
    var ch = {
        tps: g('Throttle Position'), gear: g('Gear'), aim: g('Fuel Mixture Aim'), l1: g('Exhaust Lambda Bank 1'), l2: g('Exhaust Lambda Bank 2'),
        trim1: g('Fuel Closed Loop Control Bank 1 Trim'), trim2: g('Fuel Closed Loop Control Bank 2 Trim'),
        ign: g('Ignition Timing'), ignState: g('Ignition Timing State'), iat: g('Inlet Air Temperature'), charge: g('Engine Charge Temperature'),
        coolant: g('Coolant Temperature'), rail: g('Fuel Pressure Direct Bank 1') || g('Fuel Pressure Direct'), railAim: g('Fuel Pressure Direct Bank 1 Aim') || g('Fuel Pressure Direct Aim'),
        railCtl: g('Fuel Pressure Direct Bank 1 Control'), low: g('Fuel Pressure'), pump2: g('Fuel Pump 2 State'), duty: g('Fuel Injector Primary Duty Cycle'),
        pw: g('Fuel Cylinder 1 Primary Output Pulse Width 1'), flow: g('Fuel Flow'), batt: g('ECU Battery Voltage'), injV: g('ECU Injector Supply Voltage'),
        oilP: g('Engine Oil Pressure'), oilT: g('Engine Oil Temperature'), thrLim: g('Throttle Limit State'), spdLim: g('Engine Speed Limit State'),
        ignCut: g('Ignition Cut'), cutCount: g('Fuel Output Cut Count'), overrun: g('Engine Overrun State')
    };
    var knock = [], ktrim = [];
    for (var cy = 1; cy <= 8; cy++) { knock.push(g('Ignition Cylinder ' + cy + ' Knock Level')); ktrim.push(g('Ignition Cylinder ' + cy + ' Knock Trim')); }
    var lagN = Math.round(PU_LAMBDA_DELAY_S / c.dt), holdN = Math.max(1, Math.round(0.2 / c.dt)), preN = Math.round(1 / c.dt);

    eps.forEach(function (e) {
        var k0 = Math.round(e[0] / c.dt), k1 = Math.min(c.n, Math.round(e[1] / c.dt)), m = {}, flags = [];
        function flag(sev, text, size) { flags.push({ severity: sev, text: text, size: size || 0 }); }   // size: how bad, to pick the worst across pulls
        var pd = pedal ? puMax(puSlice(pedal, k0, k1)) : null;
        var gears = ch.gear ? puSlice(ch.gear, k0, k1).filter(function (x) { return x > 0; }) : [];
        var pull = { file: file, t0: e[0], t1: e[1], seconds: e[1] - e[0], full: pd !== null && pd >= PU_PEDAL_FULL, gear: gears.length ? lhQuantile(gears, 0.5) : null,
            rpm: [Math.round(rpm[k0]), Math.round(rpm[k1 - 1])], rpmMax: Math.round(puMax(puSlice(rpm, k0, k1))), pedal: pd, mapMax: map ? puMax(puSlice(map, k0, k1)) : null,
            metrics: m, flags: flags };
        if (ch.tps) m.throttleMax = puMax(puSlice(ch.tps, k0, k1));

        // Lambda against the aim 300 ms earlier, past the tip-in
        var kl = Math.min(k1, k0 + Math.round(PU_LAMBDA_SKIP_S / c.dt));
        if (ch.aim && (ch.l1 || ch.l2) && k1 - kl >= holdN) {
            m.aim = lhQuantile(puSlice(ch.aim, kl, k1), 0.5);
            var dev = [ch.l1, ch.l2].map(function (l) {
                if (!l) return null;
                var d = new Float64Array(k1);
                for (var k = kl; k < k1; k++) d[k] = l[k] - ch.aim[Math.max(0, k - lagN)];
                return { median: lhQuantile(puSlice(l, kl, k1), 0.5), lean: puSustainedMax(d, kl, k1, holdN) };
            });
            m.lambda = dev;
            dev.forEach(function (d, b) {
                if (!d || d.lean === null) return;
                if (d.lean > PU_LEAN) flag(d.lean > PU_LEAN_BAD ? 'fail' : 'warn', 'Bank ' + (b + 1) + ' ran up to ' + d.lean.toFixed(3) + ' λ leaner than aim (held 0.2 s; aim ' +
                    m.aim.toFixed(3) + ')', d.lean);
            });
            if (dev[0] && dev[1] && Math.abs(dev[0].median - dev[1].median) > PU_BANK_SPLIT) flag('warn', 'Banks differ by ' + Math.abs(dev[0].median - dev[1].median).toFixed(3) +
                ' λ (bank 1 ' + dev[0].median.toFixed(3) + ', bank 2 ' + dev[1].median.toFixed(3) + ')');
        }
        if (ch.trim1) {
            m.trims = [lhQuantile(puSlice(ch.trim1, kl, k1), 0.5), ch.trim2 ? lhQuantile(puSlice(ch.trim2, kl, k1), 0.5) : null];
            var tr = m.trims.filter(function (x) { return x !== null && !isNaN(x); });
            if (tr.length && Math.abs(lhQuantile(tr, 0.5)) >= 5) flag('info', 'Closed-loop trims ' + tr.map(function (x) { return (x > 0 ? '+' : '') + x.toFixed(1) + ' %'; }).join(' / ') +
                ': the fuel model is ' + (tr[0] < 0 ? 'rich' : 'lean') + ' here (VE Table Tuning)');
        }

        // Knock against the threshold at the pull's rpm
        var thr = tune && tune.threshold;
        m.knock = knock.map(function (kv, i) {
            if (!kv) return null;
            var peak = puSustainedMax(kv, k0, k1, Math.max(1, Math.round(0.05 / c.dt))), at = k0;
            for (var k = k0; k < k1; k++) if (kv[k] > kv[at]) at = k;
            var t = thr ? puInterp(thr.rpm, thr.values[0], rpm[at]) : null;
            return { cylinder: i + 1, peak: peak, pctOfThreshold: t ? peak / t * 100 : null };
        }).filter(Boolean);
        var over = m.knock.filter(function (x) { return x.pctOfThreshold !== null && x.pctOfThreshold >= 100; });
        var close = m.knock.filter(function (x) { return x.pctOfThreshold !== null && x.pctOfThreshold >= 80 && x.pctOfThreshold < 100; });
        var kMax = Math.max.apply(null, m.knock.map(function (x) { return x.pctOfThreshold || 0; }).concat([0]));
        if (over.length) flag('fail', 'Knock above the threshold on cylinder ' + over.map(function (x) { return x.cylinder + ' (' + Math.round(x.pctOfThreshold) + ' %)'; }).join(', '), kMax);
        else if (close.length) flag('warn', 'Knock level near the threshold on cylinder ' + close.map(function (x) { return x.cylinder + ' (' + Math.round(x.pctOfThreshold) + ' %)'; }).join(', '), kMax);
        var trims = ktrim.map(function (kt, i) { return kt ? { cylinder: i + 1, min: puMin(puSlice(kt, k0, k1)) } : null; }).filter(Boolean);
        if (trims.length) {
            m.knockTrim = trims;
            var pulled = trims.filter(function (x) { return x.min < -0.1; });
            if (pulled.length) flag('fail', 'Knock control pulled timing: ' + pulled.map(function (x) { return 'cyl ' + x.cylinder + ' ' + x.min.toFixed(1) + '°'; }).join(', '));
        }

        // Timing and states
        if (ch.ign) { var ig = puSlice(ch.ign, k0, k1); m.timing = { min: puMin(ig), median: lhQuantile(ig, 0.5) }; }
        if (ch.ignState) {
            var odd = 0;
            for (var k = k0; k < k1; k++) if (ch.ignState[k] !== 0) odd++;
            if (odd * c.dt >= 0.2) flag('info', 'Ignition Timing State was not Normal for ' + (odd * c.dt).toFixed(1) + ' s (code ' + ch.ignState[k0 + Math.floor((k1 - k0) / 2)] + ' mid-pull)');
        }

        // Temperatures
        if (ch.iat) {
            m.iat = { start: ch.iat[k0], end: ch.iat[k1 - 1], max: puMax(puSlice(ch.iat, k0, k1)) };
            if (m.iat.max >= PU_IAT_HOT) flag('warn', 'Inlet air reached ' + m.iat.max.toFixed(0) + ' °C (+' + (m.iat.max - m.iat.start).toFixed(0) + ' °C in the pull): heat-soaked charge, more knock risk', m.iat.max);
        }
        if (ch.charge) m.chargeMax = puMax(puSlice(ch.charge, k0, k1));
        if (ch.coolant) m.coolantMax = puMax(puSlice(ch.coolant, k0, k1));

        // Fuel supply: rail against aim, low side against the second before the pull
        if (ch.rail && ch.railAim) {
            var err = new Float64Array(k1), aims = puSlice(ch.railAim, k0, k1);
            for (k = k0; k < k1; k++) err[k] = (ch.rail[k] - ch.railAim[k]) * 10;   // MPa → bar
            var under = puSustainedMin(err, k0, k1, holdN), aimMax = puMax(aims) * 10;
            m.rail = { aimMax: aimMax, min: puMin(puSlice(ch.rail, k0, k1)) * 10, worstUnder: under, controlMax: ch.railCtl ? puMax(puSlice(ch.railCtl, k0, k1)) : null };
            if (under !== null && -under > Math.max(PU_RAIL_UNDER_BAR, aimMax * PU_RAIL_UNDER_PCT / 100)) flag('warn', 'Rail pressure ' + (-under).toFixed(0) + ' bar under aim (held 0.2 s; aim up to ' +
                aimMax.toFixed(0) + ' bar' + (m.rail.controlMax !== null ? ', pump control up to ' + m.rail.controlMax.toFixed(0) + ' %' : '') + ')', -under);
        }
        if (ch.low) {
            var before = lhQuantile(puSlice(ch.low, Math.max(0, k0 - preN), k0), 0.5), lmin = puSustainedMin(ch.low, k0, k1, holdN);
            m.low = { before: before, min: lmin, pump2: ch.pump2 ? puMax(puSlice(ch.pump2, k0, k1)) > 0 : null };
            if (lmin !== null && lmin < PU_LOW_KPA) flag('fail', 'Low-side fuel pressure fell to ' + lmin.toFixed(0) + ' kPa', -lmin);
            else if (lmin !== null && before - lmin >= PU_LOW_DROP) flag('warn', 'Low-side fuel pressure dropped ' + (before - lmin).toFixed(0) + ' kPa (' + before.toFixed(0) + ' → ' + lmin.toFixed(0) + ' kPa)', before - lmin);
        }
        if (ch.duty) {
            m.dutyMax = puMax(puSlice(ch.duty, k0, k1));
            if (m.dutyMax >= PU_DUTY) flag('warn', 'Injector duty reached ' + m.dutyMax.toFixed(0) + ' % of the injection window', m.dutyMax);
        }
        if (ch.pw) m.pwMax = puMax(puSlice(ch.pw, k0, k1));
        if (ch.flow) m.flowMax = puMax(puSlice(ch.flow, k0, k1));

        // Electrical and oil
        if (ch.batt) { m.battMin = puSustainedMin(ch.batt, k0, k1, holdN); if (m.battMin !== null && m.battMin < PU_VOLTS) flag('warn', 'Battery voltage fell to ' + m.battMin.toFixed(1) + ' V', -m.battMin); }
        if (ch.injV) m.injVMin = puSustainedMin(ch.injV, k0, k1, holdN);
        if (ch.oilP) {
            var worstOil = null;
            for (k = k0; k + holdN <= k1; k++) {
                var hiOil = -Infinity;
                for (var j = k; j < k + holdN; j++) if (ch.oilP[j] > hiOil) hiOil = ch.oilP[j];
                var need = rpm[k] / 1000 * PU_OIL_PER_1000;
                if (worstOil === null || hiOil - need < worstOil.margin) worstOil = { kpa: hiOil, rpm: rpm[k], margin: hiOil - need };
            }
            if (worstOil) {
                m.oil = { min: puMin(puSlice(ch.oilP, k0, k1)), worst: worstOil };
                if (worstOil.margin < 0) flag('fail', 'Oil pressure ' + worstOil.kpa.toFixed(0) + ' kPa at ' + Math.round(worstOil.rpm) + ' rpm — under 10 psi per 1000 rpm');
            }
        }
        if (ch.oilT) m.oilTempMax = puMax(puSlice(ch.oilT, k0, k1));

        // Limits and cuts
        [[ch.thrLim, 'Throttle Limit State'], [ch.spdLim, 'Engine Speed Limit State']].forEach(function (x) {
            if (!x[0]) return;
            var on = 0;
            for (var k = k0; k < k1; k++) if (x[0][k] !== 0) on++;
            if (on * c.dt >= 0.1) flag('warn', x[1] + ' active for ' + (on * c.dt).toFixed(1) + ' s');
        });
        if (ch.ignCut && puMax(puSlice(ch.ignCut, k0, k1)) > 0) flag('warn', 'Ignition Cut up to ' + puMax(puSlice(ch.ignCut, k0, k1)).toFixed(0) + ' %');
        if (ch.cutCount) {
            var cc = puSlice(ch.cutCount, k0, k1);
            if (cc.length && puMax(cc) !== puMin(cc) && !(ch.overrun && puMax(puSlice(ch.overrun, k0, k1)) === 2)) flag('warn', 'Fuel Output Cut Count changed during the pull: a fuel cut');
        }
        if (!pull.full) flag('info', 'Boost at ' + (pd !== null ? pd.toFixed(0) + ' %' : 'part') + ' pedal, not a full-throttle pull');
        pulls.push(pull);
    });
    return { pulls: pulls, missing: false, lambdaHz: (c.native('Exhaust Lambda Bank 1') || {}).freq || null, dutyHz: (c.native('Fuel Injector Primary Duty Cycle') || {}).freq || null,
             knockTrims: ktrim.some(Boolean) };
}

function puAnalyze(logs, tune) {
    var findings = [], pulls = [];
    function add(group, severity, title, detail, times, channels) {
        findings.push({ group: group, severity: severity, title: title, detail: detail || '', times: times || [], channels: channels || [] });
    }
    var per = logs.map(function (l, i) { return puLogPulls(l, i, tune); });
    per.forEach(function (p) { Array.prototype.push.apply(pulls, p.pulls); });
    var missing = per.filter(function (p) { return p.missing; }).length;
    if (missing) add('Log', 'fail', missing + ' log' + (missing > 1 ? 's lack' : ' lacks') + ' Engine Speed and MAP / Throttle Pedal', 'Pulls are found from MAP or pedal.');
    var full = pulls.filter(function (p) { return p.full; });
    if (!pulls.length) {
        add('Pulls', 'info', 'No full-throttle or boost pull found', 'A pull is ≥ ' + PU_MIN_S + ' s with MAP ≥ ' + PU_MAP_KPA + ' kPa or Throttle Pedal ≥ ' + PU_PEDAL_FULL +
            ' %, above ' + PU_MIN_RPM + ' rpm, with the engine warm.');
        return { pulls: pulls, findings: findings };
    }
    var longest = pulls.reduce(function (a, p) { return p.seconds > a.seconds ? p : a; });
    add('Pulls', full.length ? 'ok' : 'info', pulls.length + ' pull' + (pulls.length > 1 ? 's' : '') + ' (' + full.length + ' at full throttle), longest ' + longest.seconds.toFixed(1) + ' s, up to ' +
        Math.max.apply(null, pulls.map(function (p) { return p.rpmMax; })) + ' rpm and ' + Math.round(Math.max.apply(null, pulls.map(function (p) { return p.mapMax || 0; }))) + ' kPa',
        full.length ? '' : 'None at full throttle: these are part-pedal boost events, so they say nothing about the top of the tables. For a real pull: warm engine, 3rd gear, ' +
            'from about 2500 rpm to the shift point, pedal to the floor, on a closed road or a dyno.');

    // Worst of each kind across pulls
    var sev = { fail: 0, warn: 1, info: 2, ok: 3 };
    var kinds = {};
    pulls.forEach(function (p, i) { p.flags.forEach(function (f) {
        if (f.severity === 'info') return;
        var key = f.text.replace(/[\d.−-]+/g, '#').slice(0, 40);
        (kinds[key] = kinds[key] || []).push({ p: p, i: i, f: f });
    }); });
    Object.keys(kinds).forEach(function (key) {
        var list = kinds[key], worst = list.reduce(function (a, x) {
            return sev[x.f.severity] < sev[a.f.severity] || (sev[x.f.severity] === sev[a.f.severity] && x.f.size > a.f.size) ? x : a;
        });
        var inPulls = list.map(function (x) { return x.i; }).filter(function (v, j, arr) { return arr.indexOf(v) === j; }).length;
        add('Across pulls', worst.f.severity, worst.f.text + (inPulls > 1 ? ' — in ' + inPulls + ' of ' + pulls.length + ' pulls' : ''),
            'Worst in pull ' + (worst.i + 1) + ' (' + worst.p.rpm[0] + '–' + worst.p.rpmMax + ' rpm, ' + Math.round(worst.p.mapMax || 0) + ' kPa).');
    });
    if (!Object.keys(kinds).length) add('Across pulls', 'ok', 'Nothing flagged in any pull', 'Lambda within ' + PU_LEAN + ' λ of aim, knock under 80 % of the threshold, rail and ' +
        'low-side pressure held, duty under ' + PU_DUTY + ' %, no limits or cuts.');

    if (!per.some(function (p) { return p.knockTrims; })) add('Log', 'info', 'Knock trims are not logged', 'Log Ignition Cylinder 1–8 Knock Trim (20 Hz) to see retard per cylinder in each pull.');
    var slowDuty = per.filter(function (p) { return p.dutyHz && p.dutyHz < 5; });
    if (slowDuty.length) add('Log', 'info', 'Injector duty is logged at ' + slowDuty[0].dutyHz + ' Hz', 'A few-second pull gets only a few duty samples: log Fuel Injector Primary Duty Cycle at 10–20 Hz.');
    var slowLam = per.filter(function (p) { return p.lambdaHz && p.lambdaHz < 20; });
    if (slowLam.length) add('Log', 'info', 'Lambda is logged at ' + slowLam[0].lambdaHz + ' Hz', 'Fine for whole-pull numbers; 50 Hz shows short lean spikes and the tip-in.');
    return { pulls: pulls, findings: findings };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { puAnalyze: puAnalyze };
