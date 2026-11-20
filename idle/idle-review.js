/**
 * idle/idle-review.js — Idle Behavior: pull-aways from a stop and idle feed forward by coolant temperature. Built on the
 * log-file.js / log-health helpers (lhContext, lhEpisodes, lhQuantile…), so it reads .ld and CSV logs the same way as Log Health.
 *
 *   irAnalyze(log, tune) → { duration, runningS, pullAways: [pullAway], ffRows: [ffRow], findings: [finding] }
 *     log:  lvOpenLog() result; tune: m1pkgIdle() | null
 *     finding = { group, severity: 'fail' | 'warn' | 'info' | 'ok', title, detail, times: [[t0, t1]], channels: [[name…] per pane] }
 *
 * Pull-aways (verified on the Nov 19 2026 log, V90): once the pedal moves, idle control turns off (Idle State Disabled) and
 * Throttle Aim = the larger of the idle feed forward opening (Idle Mass Flow Feed Forward × Idle Actuator Throttle Aim Maximum)
 * and Throttle Pedal (the Throttle Pedal Translation output). While the pedal is below that opening Throttle Aim State stays Idle:
 * the pedal adds no air and nothing holds engine speed, so a clutch take-up there pulls the engine down.
 *
 * Feed forward: with idle control on, Idle Mass Flow − Idle Mass Flow Feed Forward is what the controller adds (+) or takes
 * away (−); the logged feed forward already includes its compensations (post start, fan, A/C…).
 */

var IR_STOP_S = 1.0;         // stationary at least this long before a pull-away
var IR_PRE_S = 8;            // look this far back from the moment the car moves (clutch take-up starts before it registers speed)
var IR_POST_S = 4;           // … and this far after
var IR_MIN_FF_S = 20;        // seconds of steady idle a feed forward row needs for a suggestion
var IR_GROUP_ORDER = ['Pull-aways', 'Feed forward'];

function irAnalyze(log, tune) {
    var c = lhContext(log), findings = [];
    function add(group, severity, title, detail, times, channels) {
        findings.push({ group: group, severity: severity, title: title, detail: detail || '', times: (times || []).slice(0, 50), channels: channels || [] });
    }
    var out = { duration: c.n * c.dt, runningS: c.runningS, pullAways: [], ffRows: [], findings: findings };
    try { out.pullAways = irPullAways(c, tune, add); } catch (e) { add('Pull-aways', 'info', 'Pull-away review could not run', e.message); }
    try { out.ffRows = irFeedForward(c, tune, add, out.pullAways); } catch (e) { add('Feed forward', 'info', 'Feed forward review could not run', e.message); }
    findings.sort(function (a, b) { return LH_SEVERITY_ORDER[a.severity] - LH_SEVERITY_ORDER[b.severity]; });
    return out;
}

function irIdx(c, t) { return Math.max(0, Math.min(c.n - 1, Math.round(t / c.dt))); }

/** Throttle Pedal Translation output at a pedal sensor % and engine speed (linear, clamped). */
function irTranslate(tr, sensor, rpm) {
    var rows = tr.rows.map(function (row) { return lhInterp(tr.sensor, row, sensor); });
    return tr.rpm && tr.rpm.length > 1 ? lhInterp(tr.rpm, rows, rpm) : rows[0];
}

/** Pedal sensor % at which the translation output first reaches `out` (at `rpm`), or null. */
function irPedalFor(tr, out, rpm) {
    for (var s = 0; s <= 100; s += 0.5) if (irTranslate(tr, s, rpm) >= out) return s;
    return null;
}

var IR_PA_CHANNELS = [['Engine Speed', 'Idle Aim'], ['Throttle Aim', 'Throttle Pedal', 'Throttle Position'], ['Idle State', 'Throttle Aim State'],
                      ['Vehicle Speed'], ['Ignition Timing']];

function irPullAways(c, tune, add) {
    var g = 'Pull-aways', vs = c.base('Vehicle Speed'), rpm = c.base('Engine Speed');
    if (!vs || !rpm) { add(g, 'info', 'Pull-aways not reviewed', 'Vehicle Speed and Engine Speed are needed to find the pull-aways from a stop.'); return []; }
    var ped = c.base('Throttle Pedal'), pedS = c.base('Throttle Pedal Sensor'), ta = c.base('Throttle Aim'), tas = c.base('Throttle Aim State');
    var ist = c.base('Idle State'), ff = c.base('Idle Mass Flow Feed Forward'), aim = c.base('Idle Aim'), gear = c.base('Gear');
    var ign = c.base('Ignition Timing'), ect = c.base('Coolant Temperature');
    if (!ped || !ta || !ist) add(g, 'info', 'Throttle Pedal, Throttle Aim or Idle State not logged', 'Pull-aways are found, but whether the pedal moved the throttle can\'t be checked.');

    var stops = lhEpisodes(c, lhMask(c, function (k) { return vs[k] < 0.5; }), IR_STOP_S);
    var list = [], lastEnd = 0;
    stops.forEach(function (st) {
        var b = st[1], kb = irIdx(c, b);
        if (b >= c.time[c.n - 1] - 1 || c.nearHold(b, 3)) return;
        // Moving off: 1.5 km/h within 4 s. Parking-speed creeps count too — they are clutch take-ups all the same.
        var moved = false, top = 0;
        for (var k = kb; k < Math.min(c.n, kb + Math.round(6 / c.dt)); k++) {
            if (vs[k] >= 1.5 && c.time[k] - b <= 4) moved = true;
            if (vs[k] > top) top = vs[k];
        }
        if (!moved || rpm[Math.max(0, kb - 1)] < 300) return;
        var w0 = Math.max(st[0], b - IR_PRE_S, lastEnd), w1 = Math.min(c.time[c.n - 1], b + IR_POST_S), k0 = irIdx(c, w0), k1 = irIdx(c, w1);
        lastEnd = w1;
        if (c.holds.some(function (h) { return h[1] > w0 && h[0] < w1; })) return;
        // Take-up starts at the first pedal press (or idle control dropping out) in the window.
        var kp = k0;
        for (k = k0; k <= kb; k++) if ((ped && ped[k] > 0.5) || (ist && ist[k] === 0)) { kp = k; break; }
        var idleRpm = lhQuantile(Array.prototype.slice.call(rpm, k0, Math.max(k0 + 1, Math.min(kp, k0 + Math.round(1 / c.dt)))), 0.5);
        var minRpm = Infinity, kMin = kp, stalled = false, pedMax = 0, gears = {};
        for (k = kp; k <= k1; k++) {
            if (rpm[k] < minRpm) { minRpm = rpm[k]; kMin = k; }
            if (rpm[k] < 50) stalled = true;
            if (ped && ped[k] > pedMax) pedMax = ped[k];
        }
        for (k = kb; k <= k1; k++) if (gear && gear[k] > 0) gears[Math.round(gear[k])] = (gears[Math.round(gear[k])] || 0) + 1;
        var g1 = Object.keys(gears).sort(function (a, b2) { return gears[b2] - gears[a]; })[0];
        // Dead band: idle control off, pedal pressed, but the throttle is held at the idle feed forward opening.
        var dbMask = new Uint8Array(c.n), dbS = 0;
        if (ped && ta && ist) for (k = kp; k <= k1; k++) {
            var held = tas ? tas[k] === 1 : ta[k] - ped[k] > 0.5;
            if (ist[k] === 0 && ped[k] > 0.5 && held) { dbMask[k] = 1; dbS += c.dt; }
        }
        var thrMin = [], ffMin = [];     // throttle and idle opening in the 0.5 s before the lowest point
        for (k = Math.max(kp, kMin - Math.round(0.5 / c.dt)); k <= kMin; k++) {
            if (ta) thrMin.push(ta[k]);
            if (ff && tune && tune.throttleAimMax) ffMin.push(ff[k] * tune.throttleAimMax / 100);
        }
        var minInDb = false;     // the lowest point came in (or just after) the dead band
        for (k = Math.max(kp, kMin - Math.round(0.5 / c.dt)); k <= kMin; k++) if (dbMask[k]) minInDb = true;
        var dbEps = lhEpisodes(c, dbMask, 0.2, 0.2), dbDrop = 0, dbThrottle = [], dbSensor = 0, dbMin = Infinity;
        dbEps.forEach(function (e) {
            var a = irIdx(c, e[0]), z = irIdx(c, e[1] + 0.3), top = rpm[a];
            for (var j = a; j <= Math.min(z, c.n - 1); j++) {
                if (rpm[j] > top) top = rpm[j];
                dbDrop = Math.max(dbDrop, top - rpm[j]);
                if (rpm[j] < dbMin) dbMin = rpm[j];
                if (j < irIdx(c, e[1])) { dbThrottle.push(ta[j]); if (pedS && pedS[j] > dbSensor) dbSensor = pedS[j]; }
            }
        });
        // Idle control catching a falling engine: Idle State back on while below the aim.
        var rescues = 0;
        if (ist && aim) for (k = kp + 1; k <= k1; k++) if (ist[k] === 1 && ist[k - 1] === 0 && rpm[k] < aim[k] - 200) rescues++;
        var timing = [];
        if (ign) for (k = kp; k <= k1; k++) if (rpm[k] < 1500 && (!ist || ist[k] === 0)) timing.push(ign[k]);
        var pa = {
            t: b, from: w0, to: w1, takeUp: c.time[kp], coolant: ect ? ect[kb] : null, gear: g1 ? +g1 : null, topSpeed: top, creep: top < 8,
            idleRpm: idleRpm, minRpm: minRpm, minAt: c.time[kMin] - b, stalled: stalled, pedalMax: pedMax,
            ffThrottle: ff && tune && tune.throttleAimMax ? ff[kp] * tune.throttleAimMax / 100 : null,
            throttleAtMin: thrMin.length ? lhQuantile(thrMin, 0.5) : null, idleOpeningAtMin: ffMin.length ? lhQuantile(ffMin, 0.5) : null,
            deadBandS: dbS, minInDeadBand: minInDb, deadBandEps: dbEps, deadBandDrop: dbDrop, deadBandMin: dbEps.length ? dbMin : null,
            deadBandThrottle: dbThrottle.length ? lhQuantile(dbThrottle, 0.5) : null, deadBandSensor: dbEps.length && pedS ? dbSensor : null,
            rescues: rescues, timing: timing.length ? lhQuantile(timing, 0.5) : null, timingMin: timing.length ? Math.min.apply(null, timing) : null
        };
        pa.outcome = stalled ? 'stall' : minRpm < 500 ? 'near stall' : minRpm < Math.max(650, (idleRpm || 900) - 300) ? 'dip' : 'clean';
        list.push(pa);
    });

    if (!list.length) {
        add(g, 'info', 'No pull-aways from a stop', 'None found: stationary for at least ' + IR_STOP_S + ' s, then above 1.5 km/h within 4 s.');
        return list;
    }
    var bad = list.filter(function (p) { return p.outcome !== 'clean'; }), creeps = list.filter(function (p) { return p.creep; }).length;
    var stallsN = list.filter(function (p) { return p.outcome === 'stall'; }).length, nearN = list.filter(function (p) { return p.outcome === 'near stall'; }).length;
    add(g, stallsN || nearN ? 'warn' : bad.length ? 'info' : 'ok', list.length + ' pull-away' + (list.length > 1 ? 's' : '') + ' from a stop: ' +
        (bad.length ? [stallsN ? stallsN + ' stalled' : '', nearN ? nearN + ' nearly stalled (below 500 rpm)' : '',
                       bad.length - stallsN - nearN ? (bad.length - stallsN - nearN) + ' dipped' : ''].filter(Boolean).join(', ') : 'all clean'),
        'Each one is up to ' + IR_PRE_S + ' s before the car started to move (the clutch takes up before Vehicle Speed reads) and ' + IR_POST_S + ' s after' +
        (creeps ? '; ' + creeps + ' of them stayed under 8 km/h (parking or creeping)' : '') + '. ' +
        '"Dipped" = below 650 rpm or more than 300 rpm under the idle speed before it.',
        bad.map(function (p) { return [p.takeUp, p.to]; }), IR_PA_CHANNELS);

    // The pedal dead band.
    var withDb = list.filter(function (p) { return p.deadBandS >= 0.3; });
    if (withDb.length) {
        var hurt = withDb.filter(function (p) { return p.deadBandDrop >= 200 || (p.minInDeadBand && p.outcome !== 'clean'); });
        var thr = lhQuantile(withDb.map(function (p) { return p.deadBandThrottle; }).filter(function (v) { return v !== null; }), 0.5);
        var sens = withDb.map(function (p) { return p.deadBandSensor; }).filter(function (v) { return v !== null; });
        var detail = 'In ' + withDb.length + ' of ' + list.length + ' pull-aways (' + lhS(withDb.reduce(function (s, p) { return s + p.deadBandS; }, 0)) +
            ' in all) the pedal was pressed but Throttle Aim stayed at the idle feed forward opening (median ' + lhFmt(thr) + ' % throttle). ' +
            'With the pedal pressed idle control is off, and Throttle Aim is the larger of that opening and Throttle Pedal, so until the pedal passes it the pedal adds ' +
            'no air and nothing holds engine speed' + (hurt.length ? '; engine speed fell 200 rpm or more during it in ' + hurt.length + ' of them (worst ' +
            lhFmt(Math.max.apply(null, hurt.map(function (p) { return p.deadBandDrop; })), 0) + ' rpm, down to ' +
            lhFmt(Math.min.apply(null, hurt.map(function (p) { return p.deadBandMin; })), 0) + ' rpm)' : '') + '. ';
        var rescued = withDb.reduce(function (s, p) { return s + p.rescues; }, 0);
        if (rescued) detail += 'Idle control caught a falling engine ' + rescued + ' time' + (rescued > 1 ? 's' : '') + ' when the pedal was released. ';
        if (sens.length) detail += 'Pedal sensor travel inside the dead band: up to ' + lhFmt(Math.max.apply(null, sens), 1) + ' %. ';
        var tr = tune && tune.pedalTranslation;
        if (tr && thr) {
            var cut = irPedalFor(tr, thr, 1000), i10 = tr.sensor.indexOf(10), i20 = tr.sensor.indexOf(20), i30 = tr.sensor.indexOf(30);
            detail += 'Throttle Pedal Translation reaches ' + lhFmt(thr) + ' % at ' + (cut === null ? 'no pedal position' : lhFmt(cut, 1) + ' % pedal') + '. ';
            if (i10 >= 0 && i20 >= 0 && i30 >= 0) {
                var row = tr.rows[0], n10 = Math.max(row[i10], Math.ceil(thr + 0.5)), n20 = Math.max(row[i20], Math.round((n10 + row[i30]) / 2));
                if (row[i10] < thr) {
                    var nrow = row.slice(); nrow[i10] = n10; nrow[i20] = n20;
                    var ncut = irPedalFor({ sensor: tr.sensor, rpm: null, rows: [nrow] }, thr, 1000);
                    detail += 'Raising the 10 % pedal site from ' + lhFmt(row[i10]) + ' to about ' + lhFmt(n10, 0) + ' % (and 20 % from ' + lhFmt(row[i20]) + ' to about ' +
                        lhFmt(n20, 0) + ' %) shrinks that dead band' + (ncut !== null && cut !== null ? ' from ' + lhFmt(cut, 1) + ' % to ' + lhFmt(ncut, 1) + ' % of pedal travel' : '') + '. ';
                } else {
                    // The low end already passes the idle opening by the 10 % site: what is left is the travel below the opening, which a
                    // translation can only shorten by stepping the throttle at the first pedal movement.
                    detail += 'The translation already passes the idle opening before the 10 % pedal site, so what is left is the first ' +
                        (cut === null ? 'part' : lhFmt(cut, 1) + ' %') + ' of pedal travel. A steeper low end (e.g. the 10 % site from ' + lhFmt(row[i10]) + ' to ' +
                        lhFmt(row[i10] + 3, 0) + ' %) shortens it further, but the first pedal movement then jumps the throttle; how often it costs engine speed ' +
                        '(above) says whether that is worth it. ';
                }
            }
            detail += tr.rpm && /Engine Speed/.test(tr.yInput || '') ? (tr.rpm.length === 1 ? 'Its second axis is Engine Speed with one site: add sites (e.g. ' +
                'idle, 1500 and 2000 rpm) to keep the change near idle so light-throttle driving at higher rpm feels the same. ' : '') : '';
            detail += 'Trade-off: the same small pedal movement gives more air, so tip-in at low rpm gets sharper. ';
        }
        if (tune && tune.pedalThreshold !== null && tune.pedalThreshold < 0.5) detail += 'Idle Activate Throttle Pedal Threshold is ' + lhFmt(tune.pedalThreshold) +
            ' %, so any pedal movement turns idle control off; MoTeC\'s DBW idle training suggests about 1 %. ';
        if (!tune) detail += 'Choose the tune to see the pedal translation that sets this.';
        add(g, hurt.length ? 'warn' : 'info', 'Pedal pressed but the throttle held at the idle opening in ' + withDb.length + ' pull-away' + (withDb.length > 1 ? 's' : ''),
            detail, withDb.map(function (p) { return p.deadBandEps[0]; }), IR_PA_CHANNELS);
    } else if (ped && ta && ist) {
        add(g, 'ok', 'The pedal opened the throttle as soon as it moved', 'In no pull-away did Throttle Aim stay at the idle opening with the pedal pressed.');
    }

    // Dips with the pedal working: torque at take-up (timing, fuelling), not the dead band.
    var load = bad.filter(function (p) { return !p.minInDeadBand && !p.stalled; });
    if (load.length) {
        var tm = load.map(function (p) { return p.timing; }).filter(function (v) { return v !== null; });
        add(g, 'info', load.length + ' dip' + (load.length > 1 ? 's' : '') + ' with the pedal opening the throttle',
            'Engine speed fell to ' + load.map(function (p) {
                return lhFmt(p.minRpm, 0) + ' rpm at ' + lhAt(p.t + p.minAt) + (p.throttleAtMin !== null ? ' (throttle ' + lhFmt(p.throttleAtMin) + ' %' +
                    (p.idleOpeningAtMin !== null ? ', idle opening ' + lhFmt(p.idleOpeningAtMin) + ' %' : '') + ')' : '');
            }).join(', ') + ' while the throttle followed the pedal: the engine was short of torque for the clutch take-up. ' +
            (load.some(function (p) { return p.throttleAtMin !== null && p.idleOpeningAtMin !== null && p.throttleAtMin - p.idleOpeningAtMin < 2; }) ?
                'Where the throttle was within 2 % of the idle opening the pedal was barely past the dead band — the engine had about idle air for the take-up. ' : '') + (tm.length ? 'Ignition Timing under 1500 rpm with idle control off: median ' + lhFmt(lhQuantile(tm, 0.5)) +
            '° — compare with the timing table cells at 750–1250 rpm in the Ignition Review (at high ethanol content those come from Alternative Fuel Ignition Timing). ' : '') +
            'More throttle per pedal at low rpm helps here too.', load.map(function (p) { return [p.takeUp, p.to]; }), IR_PA_CHANNELS);
    }
    return list;
}

/** Interpolation position of x on axis: { i: lower site, f: 0…1 toward the next }, clamped at the ends. */
function irWeights(axis, x) {
    if (x <= axis[0] || axis.length < 2) return { i: 0, f: 0 };
    for (var i = 0; i < axis.length - 1; i++) if (x < axis[i + 1]) return { i: i, f: (x - axis[i]) / (axis[i + 1] - axis[i]) };
    return { i: axis.length - 1, f: 0 };
}

/** Weighted median of field `key` over samples { w, … } (NaN values skipped). */
function irWMedian(samples, key) {
    var s = samples.filter(function (x) { return !isNaN(x[key]); }).sort(function (a, b) { return a[key] - b[key]; });
    var tot = s.reduce(function (t, x) { return t + x.w; }, 0), acc = 0;
    for (var i = 0; i < s.length; i++) { acc += s[i].w; if (acc >= tot / 2) return s[i][key]; }
    return NaN;
}

/** Idle Mass Flow − Feed Forward during steady idle, by coolant temperature (Feed Forward Main rows when the tune is chosen). */
function irFeedForward(c, tune, add, pullAways) {
    var g = 'Feed forward', rpm = c.base('Engine Speed'), mf = c.base('Idle Mass Flow'), ff = c.base('Idle Mass Flow Feed Forward');
    var ist = c.base('Idle State'), aim = c.base('Idle Aim'), ect = c.base('Coolant Temperature'), ped = c.base('Throttle Pedal'), vs = c.base('Vehicle Speed');
    var ps = c.base('Engine Post Start Idle Mass Flow Feed Forward') || c.base('Engine Post Start Idle Mass Flow'), cs = c.base('Clutch State');
    if (!rpm || !mf || !ff || !ist || !aim || !ect) {
        add(g, 'info', 'Feed forward not reviewed', 'Needs Idle Mass Flow, Idle Mass Flow Feed Forward, Idle State, Idle Aim and Coolant Temperature.');
        return [];
    }
    var tff = tune && tune.feedForward && tune.feedForward.coolantAxis ? tune.feedForward : null;
    var sites = tff ? tff.coolant : null, bins = {}, since = -1;
    function put(key, w, k) {
        if (w < 0.01) return;
        var b = bins[key] || (bins[key] = { s: [], w: 0 });
        b.w += w * 5 * c.dt;
        b.s.push({ w: w, d: mf[k] - ff[k], ff: ff[k], err: rpm[k] - aim[k], ect: ect[k], aim: aim[k], ps: ps ? ps[k] : NaN });
    }
    for (var k = c.start; k < c.n; k += 5) {
        // Unloaded: stationary, or rolling with the clutch pedal down (Clutch State 2 = Disengaged).
        var on = c.running[k] && ist[k] === 1 && (!ped || ped[k] <= 0.5) && (!vs || vs[k] < 2 || (cs && cs[k] === 2));
        if (!on) { since = -1; continue; }
        if (since < 0) since = c.time[k];
        if (c.time[k] - since < 3 || Math.abs(rpm[k] - aim[k]) > 100 || c.nearHold(c.time[k], 5)) continue;
        if (sites) {     // the ECU interpolates between coolant rows: share each sample between the two by its weight
            var w = irWeights(sites, ect[k]);
            put(w.i, 1 - w.f, k);
            if (w.f > 0) put(w.i + 1, w.f, k);
        } else put(Math.floor(ect[k] / 10) * 10, 1, k);
    }
    var rows = Object.keys(bins).map(Number).sort(function (a, b2) { return a - b2; }).map(function (key) {
        var b = bins[key], secs = b.w, d = irWMedian(b.s, 'd');
        var row = { coolant: sites ? sites[key] : key, label: sites ? sites[key] + ' °C row' : key + '–' + (key + 10) + ' °C', seconds: secs,
            coolantMedian: irWMedian(b.s, 'ect'), delta: d, ff: irWMedian(b.s, 'ff'), rpmErr: irWMedian(b.s, 'err'),
            postStart: ps ? irWMedian(b.s, 'ps') : null, cells: [] };
        if (tff) {     // the Idle Aim columns this row's idle used, with current → suggested values
            var used = {}, tot = 0;
            b.s.forEach(function (x) {
                var wa = irWeights(tff.aim, x.aim);
                used[wa.i] = (used[wa.i] || 0) + x.w * (1 - wa.f);
                if (wa.f > 0) used[wa.i + 1] = (used[wa.i + 1] || 0) + x.w * wa.f;
                tot += x.w;
            });
            Object.keys(used).map(Number).sort(function (a, b2) { return a - b2; }).forEach(function (j) {
                if (used[j] / tot < 0.1) return;
                var cur = tff.values[key][j];
                row.cells.push({ aim: tff.aim[j], share: used[j] / tot, value: cur, suggested: Math.round((cur + d) * 10) / 10 });
            });
        }
        row.suggest = secs >= IR_MIN_FF_S && Math.abs(d) >= 1.5;
        return row;
    });
    if (!rows.length) { add(g, 'info', 'No steady idle with idle control on', 'Feed forward can\'t be compared.'); return rows; }
    var sug = rows.filter(function (r) { return r.suggest; });
    var lowering = sug.filter(function (r) { return r.delta < 0; }), dbFound = (pullAways || []).some(function (p) { return p.deadBandS >= 0.3 && p.deadBandDrop >= 200; });
    var detail = rows.map(function (r) {
        return r.label + (sites ? ' (median coolant ' + lhFmt(r.coolantMedian, 0) + ' °C)' : '') + ': ' + (r.delta >= 0 ? '+' : '') + lhFmt(r.delta) + ' % over ' + lhS(r.seconds) + (r.postStart > 0.5 ? ' (post start adding ' + lhFmt(r.postStart) + ' %)' : '');
    }).join('; ') + '. Idle Mass Flow − Feed Forward with idle control on, the pedal released, stationary or the clutch disengaged, and within 100 rpm of Idle Aim, skipping the first 3 s of each idle. ' +
        'Each sample counts toward the two coolant rows the ECU interpolates between, by its weight. ' +
        '+ = the controller adds air because the feed forward is short; − = it takes air away. A row needs ' + IR_MIN_FF_S + ' s and a gap of 1.5 % or more before a change is suggested.';
    if (rows.some(function (r) { return r.postStart > 0.5; })) detail += ' Where Engine Post Start Idle Mass Flow Feed Forward was still adding air, part of the gap may belong in that table instead (it fades out over the first minute or so).';
    if (lowering.length) detail += ' Lowering feed forward also lowers the throttle opening the engine has when idle control turns off at a pull-away' +
        (dbFound ? ' — and this log shows pull-aways where that opening was all the air the engine got, so fix the pedal dead band first.' : '.');
    if (!tff) detail += tune ? ' Feed Forward Main has no coolant axis, so rows are 10 °C bands.' : ' Choose the tune to see the Feed Forward Main cells and suggested values.';
    add(g, sug.some(function (r) { return Math.abs(r.delta) >= 3; }) ? 'warn' : sug.length ? 'info' : 'ok',
        sug.length ? 'Idle feed forward off by ' + sug.map(function (r) { return (r.delta >= 0 ? '+' : '') + lhFmt(r.delta) + ' % at ' + r.label.replace(' row', ''); }).join(', ')
            : 'Idle feed forward within 1.5 % where there is enough data', detail, [], [['Idle Mass Flow', 'Idle Mass Flow Feed Forward'], ['Engine Speed', 'Idle Aim'], ['Coolant Temperature']]);
    return rows;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { irAnalyze: irAnalyze, irTranslate: irTranslate, irPedalFor: irPedalFor };
