/**
 * log-health/health-checks.js — Log Health: looks for readings that can't be right, so sensor faults, wrong sensor setups and
 * substituted values are caught before anything is tuned from the log.
 *
 *   lhAnalyze(log, opts) → { duration, runningS, findings: [finding], counts: { fail, warn, info, ok } }
 *     log:  lvOpenLog() result (log-viewer/log-file.js; needs lib/ld-parser.js)
 *     opts: { tune: m1pkgHealth() | null, enums: m1pkgChannelEnums() | null }
 *   finding = { group, severity: 'fail' | 'warn' | 'info' | 'ok', title, detail, times: [[t0, t1]], channels: [[name…] per pane] }
 *
 * Every check says what it measured and over how much data; episodes are stretches with a minimum duration, never single
 * samples (most channels are logged at 1–20 Hz and held). The first LH_SKIP_S of a log (ECU start, zeros) is ignored.
 */

var LH_SKIP_S = 1.5;
var LH_SEVERITY_ORDER = { fail: 0, warn: 1, info: 2, ok: 3 };

// ---------------------------------------------------------------------------------------------------------------------
// Log access
// ---------------------------------------------------------------------------------------------------------------------

/** Channel index by full name; a log name cut short (M1 keeps 32 characters) matches as a prefix. -1 if missing. */
function lhFind(log, name) {
    var i = lvFind(log, name);
    if (i >= 0) return i;
    var want = name.toLowerCase();
    for (i = 0; i < log.channels.length; i++) {
        var n = log.channels[i].name.toLowerCase();
        if (n.length >= 24 && want.indexOf(n) === 0 && want.length > n.length) return i;
    }
    return -1;
}

function lhContext(log) {
    var cache = {}, time = lvBaseTime(log), dt = 1 / log.baseFreq;
    var c = {
        log: log, time: time, dt: dt, n: time.length,
        has: function (name) { return lhFind(log, name) >= 0; },
        name: function (name) { var i = lhFind(log, name); return i >= 0 ? log.channels[i].name : null; },
        /** Base-rate (held) values, or null. */
        base: function (name) {
            if (!(name in cache)) { var i = lhFind(log, name); cache[name] = i >= 0 ? lvAtBase(log, i) : null; }
            return cache[name];
        },
        /** Own-rate values { v, freq }, or null. */
        native: function (name) {
            var i = lhFind(log, name);
            return i >= 0 ? { v: lvChannel(log, i), freq: log.channels[i].freq || log.baseFreq, name: log.channels[i].name } : null;
        }
    };
    c.start = Math.min(c.n, Math.ceil(LH_SKIP_S / dt));
    var rpm = c.base('Engine Speed');
    c.running = new Uint8Array(c.n);
    c.stopped = new Uint8Array(c.n);
    if (rpm) for (var k = c.start; k < c.n; k++) { c.running[k] = rpm[k] > 400 ? 1 : 0; c.stopped[k] = rpm[k] < 50 ? 1 : 0; }
    c.runningS = lhCount(c.running) * dt;

    // Holds: Engine Speed (logged fast) exactly unchanged while running is impossible — the logger stopped (a log can join two
    // key cycles). The data just around a hold, and the first seconds after any start, aren't steady running.
    c.holds = [];
    var nat = c.native('Engine Speed');
    if (nat && nat.freq >= 50) {
        var s0 = -1;
        for (k = Math.ceil(LH_SKIP_S * nat.freq) + 1; k <= nat.v.length; k++) {
            var same = k < nat.v.length && nat.v[k] === nat.v[k - 1] && nat.v[k] > 400;
            if (same && s0 < 0) s0 = k - 1;
            if (!same && s0 >= 0) { if ((k - s0) / nat.freq >= 0.4) c.holds.push([s0 / nat.freq, k / nat.freq]); s0 = -1; }
        }
    }
    c.settled = new Uint8Array(c.n);     // running ≥ 5 s since it started, not within 5 s after a hold
    c.warmedUp = new Uint8Array(c.n);    // running ≥ 30 s since it started (lambda sensors heated)
    var since = -1, hi = 0;
    for (k = c.start; k < c.n; k++) {
        if (!c.running[k]) { since = -1; continue; }
        if (since < 0) since = c.time[k];
        while (hi < c.holds.length && c.holds[hi][1] + 5 < c.time[k]) hi++;
        var nearHold = hi < c.holds.length && c.time[k] >= c.holds[hi][0] - 1 && c.time[k] <= c.holds[hi][1] + 5;
        if (nearHold) since = c.holds[hi][1];
        c.settled[k] = !nearHold && c.time[k] - since >= 5 ? 1 : 0;
        c.warmedUp[k] = !nearHold && c.time[k] - since >= 30 ? 1 : 0;
    }
    c.nearHold = function (t, margin) {
        return c.holds.some(function (h) { return t >= h[0] - (margin || 2) && t <= h[1] + (margin || 2); });
    };
    return c;
}

function lhCount(mask) { var s = 0; for (var k = 0; k < mask.length; k++) s += mask[k]; return s; }

/** Stretches where mask is set for at least minS, joining gaps shorter than joinS: [[t0, t1]]. */
function lhEpisodes(c, mask, minS, joinS) {
    var out = [], t0 = -1, last = -1;
    joinS = joinS || 0;
    for (var k = 0; k <= c.n; k++) {
        var on = k < c.n && mask[k];
        if (on) {
            if (t0 >= 0 && c.time[k] - last > joinS + c.dt * 1.5) { if (last - t0 + c.dt >= minS) out.push([t0, last + c.dt]); t0 = -1; }
            if (t0 < 0) t0 = c.time[k];
            last = c.time[k];
        }
    }
    if (t0 >= 0 && last - t0 + c.dt >= minS) out.push([t0, last + c.dt]);
    return out;
}

function lhTotal(eps) { return eps.reduce(function (s, e) { return s + e[1] - e[0]; }, 0); }

function lhQuantile(values, q) {
    if (!values.length) return NaN;
    var s = Array.prototype.slice.call(values).sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))];
}

/** Values of a base-rate array where mask is set (every `step` samples). */
function lhPick(arr, mask, step) {
    var out = [];
    for (var k = 0; k < arr.length; k += step || 1) if (mask[k] && !isNaN(arr[k])) out.push(arr[k]);
    return out;
}

function lhMask(c, fn) {
    var m = new Uint8Array(c.n);
    for (var k = c.start; k < c.n; k++) m[k] = fn(k) ? 1 : 0;
    return m;
}

function lhFmt(v, d) { return v === null || v === undefined || isNaN(v) ? '—' : Number(v).toFixed(d === undefined ? 1 : d); }
function lhS(s) { return s < 10 ? s.toFixed(1) + ' s' : Math.round(s) + ' s'; }
function lhAt(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
function lhEpisodeText(eps) {
    if (!eps.length) return '';
    return eps.length + ' episode' + (eps.length > 1 ? 's' : '') + ', ' + lhS(lhTotal(eps)) + ' in all, first at ' + lhAt(eps[0][0]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------------

function lhAnalyze(log, opts) {
    opts = opts || {};
    var c = lhContext(log), findings = [];
    function add(group, severity, title, detail, times, channels) {
        findings.push({ group: group, severity: severity, title: title, detail: detail || '', times: (times || []).slice(0, 50),
                        channels: channels || [] });
    }
    var checks = [lhCheckLogIntegrity, lhCheckDiagnostics, lhCheckSubstitutes, lhCheckStuck, lhCheckPressures, lhCheckTemperatures, lhCheckLambda,
                  lhCheckFuelModel, lhCheckFuelSupply, lhCheckThrottle, lhCheckElectrical, lhCheckKnockInputs, lhCheckSpeeds, lhCheckEcu];
    checks.forEach(function (fn) {
        try { fn(c, add, opts); } catch (e) { add('Checks', 'info', fn.name.replace(/^lhCheck/, '') + ' check could not run', e.message); }
    });
    if (!c.has('Engine Speed')) add('Log', 'warn', 'No Engine Speed channel', 'Running / stopped can\'t be told apart, so most checks are skipped.');
    findings.sort(function (a, b) { return LH_SEVERITY_ORDER[a.severity] - LH_SEVERITY_ORDER[b.severity]; });
    var counts = { fail: 0, warn: 0, info: 0, ok: 0 };
    findings.forEach(function (f) { counts[f.severity]++; });
    return { duration: c.n * c.dt, runningS: c.runningS, findings: findings, counts: counts };
}

/** Holds (the logger stopped), what changed across them, and engine stops / restarts while logging. */
function lhCheckLogIntegrity(c, add) {
    var temps = ['Coolant Temperature', 'Engine Oil Temperature', 'Airbox Temperature', 'Fuel Temperature'].filter(c.has);
    c.holds.forEach(function (h) {
        var jumps = [];
        temps.forEach(function (n) {
            var v = c.base(n), a = v[Math.max(0, Math.floor(h[0] / c.dt) - 1)], b = v[Math.min(c.n - 1, Math.ceil((h[1] + 1) / c.dt))];
            if (Math.abs(b - a) >= 3) jumps.push(n + ' ' + lhFmt(a) + ' → ' + lhFmt(b) + ' °C');
        });
        var after = Math.min(c.n - 1, Math.ceil((h[1] + 0.3) / c.dt)), rpm = c.base('Engine Speed');
        var restart = false;
        for (var k = Math.ceil(h[1] / c.dt); k < Math.min(c.n, after + Math.ceil(3 / c.dt)); k++) if (rpm[k] < 400) { restart = true; break; }
        add('Log', jumps.length || restart ? 'warn' : 'info', 'Logged values held for ' + lhS(h[1] - h[0]) + ' at ' + lhAt(h[0]),
            'Every channel, Engine Speed included, stayed exactly unchanged — the logger wasn\'t recording. ' +
            (jumps.length ? 'Afterwards: ' + jumps.join(', ') + ', so the log joins two key cycles with the engine off in between (not logged); treat the parts as separate drives. '
                : restart ? 'Right after it the engine was at cranking speed and restarted, so the engine was switched off (or stalled) and restarted while the log continued. '
                : 'Nothing jumped, so it was a short logging pause. ') +
            'Readings across the hold are left out of the other checks.', [[h[0], h[1]]], [['Engine Speed'], temps]);
    });
    // Engine stops while logging (not at a hold): running → below 400 rpm → running again.
    var stops = lhEpisodes(c, lhMask(c, function (k) { return !c.running[k]; }), 0.2);
    var rpm = c.base('Engine Speed');
    stops.forEach(function (st) {
        if (st[0] <= LH_SKIP_S + 0.1 || st[1] >= c.time[c.n - 1] || c.nearHold(st[0], 1)) return;
        var low = Infinity;
        for (var k = Math.floor(st[0] / c.dt); k < Math.min(c.n, Math.ceil(st[1] / c.dt)); k++) if (rpm[k] < low) low = rpm[k];
        var stalled = low < 50;
        add('Log', stalled ? 'info' : 'warn', stalled ? 'Engine stopped at ' + lhAt(st[0]) + ' and ran again after ' + lhS(st[1] - st[0])
            : 'Engine nearly stalled at ' + lhAt(st[0]) + ' (down to ' + lhFmt(low, 0) + ' rpm)',
            stalled ? 'A stall or a deliberate restart while logging. The first seconds after each start are left out of the steady-running checks.'
                : 'Engine speed fell below 400 rpm for ' + lhS(st[1] - st[0]) + ' and recovered without a restart — look at idle control and fuelling ' +
                  '(lean on the way down?) around it.',
            [[st[0] - 5, st[1] + 5]], [['Engine Speed', 'Idle Aim'], ['Inlet Manifold Pressure'], ['Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Fuel Mixture Aim'], ['Throttle Pedal']]);
    });
}

/** Enum of a logged channel (from the tune's firmware), matched by name; a cut-short log name matches the shortest full name. */
function lhEnumFor(enums, name) {
    if (!enums) return null;
    if (enums[name]) return enums[name];
    var best = null, want = name.toLowerCase();
    Object.keys(enums).forEach(function (k) {
        if (k.toLowerCase().indexOf(want) === 0 && (!best || k.length < best.length)) best = k;
    });
    return best && name.length >= 24 ? enums[best] : null;
}

/** M1 diagnostic channels: every value other than OK / Not in Use, with its name and severity from the firmware. */
function lhCheckDiagnostics(c, add, opts) {
    var ok = [], notInUse = [];
    c.log.channels.forEach(function (ch) {
        if (!/diag|diagnos/i.test(ch.name) && !/ D$/.test(ch.name)) return;
        if (ch.unit && ch.unit.trim()) return;
        var nat = c.native(ch.name), en = lhEnumFor(opts.enums, ch.name), skip = Math.ceil(LH_SKIP_S * nat.freq);
        var counts = {}, firstAt = {}, eps = {}, prev = null;
        for (var k = skip; k < nat.v.length; k++) {
            var v = Math.round(nat.v[k]);
            if (isNaN(v)) continue;
            counts[v] = (counts[v] || 0) + 1;
            if (!(v in firstAt)) firstAt[v] = k / nat.freq;
            if (v !== prev) { (eps[v] = eps[v] || []).push([k / nat.freq, (k + 1) / nat.freq]); }
            else eps[v][eps[v].length - 1][1] = (k + 1) / nat.freq;
            prev = v;
        }
        var values = Object.keys(counts).map(Number);
        if (!values.length) return;
        var bad = values.filter(function (v) {
            if (en && en[v]) return !(en[v].name === 'OK' || en[v].name === 'Not in Use' || (!en[v].tag && v >= 0 && v <= 1));
            return v !== 0 && v !== 1;
        });
        if (!bad.length) {
            if (values.length === 1 && values[0] === 0) notInUse.push(ch.name); else ok.push(ch.name);
            return;
        }
        bad.forEach(function (v) {
            var e = en && en[v], tag = e && e.tag, label = e ? e.name : 'code ' + v + (en ? '' : ' (choose the tune for the name)');
            var sev = tag === 'fault' ? 'fail' : tag === 'warning' ? 'warn' : tag === 'information' ? 'info' : e ? 'info' : 'warn';
            if (/Engine Overrun|Fuel Cut|Cut Request|Engine Speed Limit|Disabled/i.test(label) && sev !== 'fail') sev = 'info';
            var secs = counts[v] / nat.freq, list = eps[v] || [];
            add('ECU diagnostics', sev, ch.name + ': ' + label,
                lhS(secs) + ' in ' + list.length + ' stretch' + (list.length > 1 ? 'es' : '') + ', first at ' + lhAt(firstAt[v]) +
                (tag ? ' (firmware: ' + tag + ')' : '') + '.', list, [[ch.name], ['Engine Speed']]);
        });
    });
    add('ECU diagnostics', 'ok', ok.length + ' diagnostic channels read OK throughout',
        (opts.enums ? '' : 'Without a tune, 0 = Not in Use and 1 = OK; other codes are reported by number. ') +
        (notInUse.length ? 'Not in use for the whole log: ' + notInUse.join(', ') + '.' : ''));
}

/**
 * "X Sensor" (the sensor reading) against "X" (the value the ECU uses): when they differ the ECU has replaced the reading —
 * a sensor diagnostic made it fall back to an estimate or default.
 */
function lhCheckSubstitutes(c, add) {
    var pairs = 0;
    c.log.channels.forEach(function (ch) {
        var m = ch.name.match(/^(.*) Sens(o|or)?$/);
        // Pedal and throttle positions are the sensor reading scaled with dead bands and clamps, so they differ by design.
        if (!m || /Diagnos|Pedal|Throttle/i.test(ch.name)) return;
        var used = c.base(m[1]), raw = c.base(ch.name);
        if (!used || !raw) return;
        pairs++;
        var mags = lhPick(raw, c.running, 10).map(Math.abs);
        // A filtered value lags the reading while it moves; a substitute differs by more, for longer.
        var tol = Math.max(1.0, 0.05 * (lhQuantile(mags, 0.5) || 0));
        var eps = lhEpisodes(c, lhMask(c, function (k) { return c.running[k] && Math.abs(used[k] - raw[k]) > tol; }), 2.0, 0.3);
        if (eps.length) {
            add('Substituted values', 'warn', m[1] + ' differs from its sensor reading',
                lhEpisodeText(eps) + '. The ECU used a different value than ' + ch.name + ' (tolerance ' + lhFmt(tol, 1) + ' ' + (ch.unit || '') +
                ') — usually a sensor diagnostic making it fall back to an estimate or default. Check the sensor and its diagnostic channel.',
                eps, [[m[1], ch.name]]);
        }
    });
    if (pairs) add('Substituted values', 'ok', pairs + ' sensor readings checked against the values the ECU used', '');
}

/** Sensors that never move while the engine runs: a stuck, disconnected or defaulted sensor. */
function lhCheckStuck(c, add) {
    if (c.runningS < 60) return;
    var stuck = [];
    c.log.channels.forEach(function (ch) {
        var isSensor = /Sensor$|Temperature$|Exhaust Lambda|Pressure$|Pressure Direct Bank \d$|Battery Voltage$|Knock Level$/.test(ch.name) &&
            !/Aim|Limit|Default|Estimate|Warning/.test(ch.name);
        if (!isSensor) return;
        var v = lhPick(c.base(ch.name), c.running, 5);
        if (v.length < 20) return;
        var lo = Infinity, hi = -Infinity;
        v.forEach(function (x) { if (x < lo) lo = x; if (x > hi) hi = x; });
        if (hi - lo < 1e-6) stuck.push(ch.name + ' = ' + lhFmt(lo, 2) + (ch.unit ? ' ' + ch.unit : ''));
    });
    if (stuck.length) add('Stuck sensors', 'warn', stuck.length + ' sensor channel' + (stuck.length > 1 ? 's' : '') + ' never changed while running',
        stuck.join('; ') + ' — over ' + lhS(c.runningS) + ' of running. A real sensor always moves a little: stuck, unplugged, or a fixed default.',
        [], [stuck.map(function (s) { return s.split(' = ')[0]; })]);
}

/** MAP / ambient / airbox / oil pressure plausibility. */
function lhCheckPressures(c, add) {
    var map = c.base('Inlet Manifold Pressure'), amb = c.base('Ambient Pressure'), box = c.base('Airbox Pressure Sensor') || c.base('Airbox Pressure');
    var g = 'Pressure sensors';
    // Key on, engine off: MAP, airbox and ambient all read barometric pressure.
    var koeo = lhEpisodes(c, c.stopped, 2.0);
    if (koeo.length && map) {
        var m = lhMask(c, function (k) { return c.stopped[k]; });
        var pm = lhQuantile(lhPick(map, m), 0.5), pa = amb ? lhQuantile(lhPick(amb, m), 0.5) : NaN, pb = box ? lhQuantile(lhPick(box, m), 0.5) : NaN;
        var parts = ['MAP ' + lhFmt(pm) + ' kPa'];
        if (amb) parts.push('Ambient ' + lhFmt(pa) + ' kPa');
        if (box) parts.push('Airbox ' + lhFmt(pb) + ' kPa');
        var spread = Math.max.apply(null, [pm, pa, pb].filter(function (x) { return !isNaN(x); })) -
                     Math.min.apply(null, [pm, pa, pb].filter(function (x) { return !isNaN(x); }));
        var bad = pm < 70 || pm > 108 || spread > 2.5;
        add(g, bad ? 'fail' : 'ok', 'Key on, engine off: ' + parts.join(', '),
            lhS(lhTotal(koeo)) + ' stopped. ' + (bad ? 'All of these should read the same barometric pressure (70–108 kPa, within ~2 kPa) — ' +
                'a gap is a translation (offset / slope) error in the sensor that disagrees. Compare with a weather-station barometer for your altitude.'
                : 'They agree and are plausible for barometric pressure.'), koeo.slice(0, 5), [['Inlet Manifold Pressure', 'Ambient Pressure', 'Airbox Pressure Sensor'], ['Engine Speed']]);
    } else if (map) {
        add(g, 'info', 'No key-on engine-off data', 'Logging started with the engine running, so MAP can\'t be checked against barometric pressure. ' +
            'Log 5 s with the key on before starting to get that check.');
    }
    if (amb && c.runningS > 10) {
        var a = lhPick(amb, c.running, 10), med = lhQuantile(a, 0.5), lo = lhQuantile(a, 0.02), hi = lhQuantile(a, 0.98);
        if (med < 70 || med > 108) add(g, 'fail', 'Ambient Pressure reads ' + lhFmt(med) + ' kPa', 'Barometric pressure is 70–108 kPa anywhere you can drive. ' +
            'The ambient sensor, its translation or its resource is wrong; the fuel model and MAP estimate use it.', [], [['Ambient Pressure', 'Inlet Manifold Pressure']]);
        else if (hi - lo > 6) add(g, 'info', 'Ambient Pressure varied ' + lhFmt(hi - lo) + ' kPa', 'Fine for a drive with a large altitude change; otherwise a noisy sensor.', [], [['Ambient Pressure']]);
    }
    if (map && c.runningS > 10) {
        var mr = lhPick(map, c.running, 5), floor = lhQuantile(mr, 0.005), min = Math.min.apply(null, mr);
        var low = lhEpisodes(c, lhMask(c, function (k) { return c.running[k] && map[k] < 8; }), 0.3);
        if (min <= 0) add(g, 'fail', 'MAP reads ' + lhFmt(min) + ' kPa while running', 'Absolute pressure can\'t be zero or negative: the MAP translation offset is wrong. ' +
            'The fuel model then injects almost nothing on decel. ' + lhEpisodeText(low) + '.', low, [['Inlet Manifold Pressure', 'Airbox Pressure Sensor'], ['Throttle Position'], ['Engine Speed']]);
        else if (low.length) add(g, 'warn', 'MAP below 8 kPa while running', lhEpisodeText(low) + ' (lowest ' + lhFmt(min) + ' kPa). Deeper than an engine pulls on decel — ' +
            'check the translation offset (key-on reading vs barometer, and a second point from a vacuum pump).', low, [['Inlet Manifold Pressure', 'Airbox Pressure Sensor'], ['Throttle Position']]);
        else add(g, 'ok', 'MAP plausible while running', 'Lowest ' + lhFmt(floor) + ' kPa (0.5th percentile), highest ' + lhFmt(Math.max.apply(null, mr)) + ' kPa.');
    }
    // Throttle is upstream of the supercharger: at light load MAP ≈ airbox pressure (bypass open).
    if (map && box && c.runningS > 30) {
        var thr = c.base('Throttle Position');
        var cruise = lhMask(c, function (k) { return c.running[k] && map[k] > 25 && map[k] < 75 && (!thr || thr[k] > 1); });
        var d = [];
        for (var k = 0; k < c.n; k += 5) if (cruise[k]) d.push(map[k] - box[k]);
        if (d.length > 100) {
            var md = lhQuantile(d, 0.5);
            add(g, Math.abs(md) > 8 ? 'warn' : 'ok', 'MAP vs Airbox Pressure at part load: ' + (md >= 0 ? '+' : '') + lhFmt(md) + ' kPa (median)',
                lhS(d.length * 5 * c.dt) + ' at 25–75 kPa. ' + (Math.abs(md) > 8 ? 'With the supercharger bypass open the two should read within a few kPa; a steady gap ' +
                    'points at one of the two translations.' : 'They agree.'), [], [['Inlet Manifold Pressure', 'Airbox Pressure Sensor'], ['Throttle Position']]);
        }
    }
    var oil = c.base('Engine Oil Pressure'), rpm = c.base('Engine Speed'), ct = c.base('Coolant Temperature');
    if (oil && rpm) {
        if (koeo.length) {
            var po = lhQuantile(lhPick(oil, c.stopped), 0.5);
            if (po > 30) add(g, 'warn', 'Engine Oil Pressure reads ' + lhFmt(po, 0) + ' kPa with the engine stopped', 'A gauge sensor reads ~0 with the engine off: offset error.',
                koeo.slice(0, 3), [['Engine Oil Pressure'], ['Engine Speed']]);
        }
        var lowOil = lhEpisodes(c, lhMask(c, function (k) { return c.running[k] && rpm[k] > 2000 && (!ct || ct[k] > 60) && oil[k] < 140; }), 0.5);
        if (lowOil.length) add(g, 'fail', 'Low oil pressure above 2000 rpm', lhEpisodeText(lowOil) + ' below 140 kPa (20 psi) on a warm engine. Check the gauge reading before driving.',
            lowOil, [['Engine Oil Pressure'], ['Engine Speed']]);
    }
}

/** Temperatures: range, sudden jumps, cold-soak agreement, overheating. */
function lhCheckTemperatures(c, add) {
    var g = 'Temperatures';
    var names = ['Coolant Temperature', 'Engine Oil Temperature', 'Inlet Air Temperature', 'Airbox Temperature', 'Fuel Temperature',
                 'Transmission Temperature', 'Engine Oil Temperature Sensor'].filter(c.has);
    names.forEach(function (name) {
        var nat = c.native(name), skip = Math.ceil(LH_SKIP_S * nat.freq), bad = [], jumps = 0, firstJump = null;
        for (var k = skip; k < nat.v.length; k++) {
            var v = nat.v[k];
            if (v < -35 || v > 145) bad.push(k / nat.freq);
            if (k > skip) {
                var rate = Math.abs(v - nat.v[k - 1]) * nat.freq;
                if (rate > 15 && Math.abs(v - nat.v[k - 1]) > 2 && !c.nearHold(k / nat.freq, 2)) { jumps++; if (firstJump === null) firstJump = k / nat.freq; }
            }
        }
        if (bad.length) add(g, 'fail', name + ' outside −35…145 °C', bad.length + ' samples, first at ' + lhAt(bad[0]) +
            '. An open or shorted sensor reads at the ends of its range.', [[bad[0] - 2, bad[0] + 2]], [[name]]);
        if (jumps) add(g, 'warn', name + ' jumps faster than 15 °C/s', jumps + ' jumps, first at ' + lhAt(firstJump) +
            '. A real temperature can\'t move that fast: an intermittent connection or electrical noise.', [[firstJump - 3, firstJump + 3]], [[name]]);
    });
    // Cold soak: at a cold start every temperature sensor reads about the same.
    var ct = c.native('Coolant Temperature');
    if (ct && c.stopped[c.start]) {
        var t0 = LH_SKIP_S + 0.5, readings = [];
        names.filter(function (n) { return !/Sensor$/.test(n); }).forEach(function (n) {
            var nat = c.native(n), k = Math.min(nat.v.length - 1, Math.ceil(t0 * nat.freq));
            readings.push([n, nat.v[k]]);
        });
        var coolant = readings.filter(function (r) { return r[0] === 'Coolant Temperature'; })[0];
        if (coolant && coolant[1] < 40 && readings.length >= 3) {
            var vals = readings.map(function (r) { return r[1]; }), spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
            add(g, spread > 6 ? 'warn' : 'ok', 'Cold start: temperature sensors ' + (spread > 6 ? lhFmt(spread) + ' °C apart' : 'agree'),
                readings.map(function (r) { return r[0] + ' ' + lhFmt(r[1]) + ' °C'; }).join(', ') + '. After a long soak they should be within a few °C; ' +
                (spread > 6 ? 'the odd one out has a wrong calibration (or the car wasn\'t fully soaked).' : 'calibrations look consistent.'),
                [], [names]);
        }
    }
    var cool = c.base('Coolant Temperature');
    if (cool) {
        var hot = lhEpisodes(c, lhMask(c, function (k) { return c.running[k] && cool[k] > 108; }), 1.0);
        if (hot.length) add(g, 'fail', 'Coolant above 108 °C', lhEpisodeText(hot) + ' (max ' + lhFmt(Math.max.apply(null, lhPick(cool, c.running, 10))) + ' °C).',
            hot, [['Coolant Temperature'], ['Engine Speed']]);
    }
    var iat = c.base('Inlet Air Temperature'), map = c.base('Inlet Manifold Pressure');
    if (iat && map) {
        var boost = lhPick(iat, lhMask(c, function (k) { return c.running[k] && map[k] > 120; }), 1);
        if (boost.length * c.dt > 1) {
            var mx = Math.max.apply(null, boost);
            add(g, mx > 65 ? 'warn' : 'ok', 'Inlet Air Temperature under boost: up to ' + lhFmt(mx) + ' °C', lhS(boost.length * c.dt) + ' above 120 kPa. ' +
                (mx > 65 ? 'Hot charge air under boost raises knock risk — check the intercooler pump/heat exchanger, and that the IAT ignition compensation covers it.'
                    : 'Within a normal range for an intercooled blower.'), [], [['Inlet Air Temperature'], ['Inlet Manifold Pressure']]);
        }
    }
}

/** Lambda sensors: agreement between banks, readings that can't be combustion, trims at their limits. */
function lhCheckLambda(c, add, opts) {
    var g = 'Lambda', b1 = c.base('Exhaust Lambda Bank 1'), b2 = c.base('Exhaust Lambda Bank 2');
    var ct = c.base('Coolant Temperature'), ov = c.base('Engine Overrun State'), aim = c.base('Fuel Mixture Aim');
    var warm = function (k) { return c.warmedUp[k] && (!ct || ct[k] > 60); };
    var notCut = function (k) { return !ov || ov[k] !== 2; };
    [['Exhaust Lambda Bank 1', b1], ['Exhaust Lambda Bank 2', b2]].forEach(function (p) {
        if (!p[1]) return;
        var v = p[1];
        // Free air (≥ 5) or no reading (≤ 0.3) while fuelling, for more than 3 s, isn't an exhaust reading.
        var eps = lhEpisodes(c, lhMask(c, function (k) { return warm(k) && notCut(k) && (v[k] >= 5 || v[k] <= 0.3); }), 3.0, 0.5);
        var fuelled = eps.filter(function (e) { return e[1] - e[0] >= 3; });
        if (fuelled.length) add(g, 'fail', p[0] + ' not reading exhaust while fuelling', lhEpisodeText(fuelled) + ' at ≥ 5 or ≤ 0.3 λ with no overrun cut. ' +
            'A heater, sensor or wiring fault — closed loop on that bank is then wrong.', fuelled, [[p[0], 'Fuel Mixture Aim'], ['Engine Overrun State'], ['Engine Speed']]);
    });
    if (b1 && b2) {
        var steady = lhMask(c, function (k) { return warm(k) && notCut(k) && b1[k] > 0.7 && b1[k] < 1.3 && b2[k] > 0.7 && b2[k] < 1.3; });
        var r = [];
        for (var k = 0; k < c.n; k += 5) if (steady[k]) r.push((b1[k] / b2[k] - 1) * 100);
        if (r.length * 5 * c.dt > 30) {
            var med = lhQuantile(r, 0.5);
            var t1 = c.base('Fuel Closed Loop Control Bank 1 Trim'), t2 = c.base('Fuel Closed Loop Control Bank 2 Trim'), trims = '';
            if (t1 && t2) trims = ' Trims: bank 1 ' + lhFmt(lhQuantile(lhPick(t1, steady, 5), 0.5)) + ' %, bank 2 ' + lhFmt(lhQuantile(lhPick(t2, steady, 5), 0.5)) + ' %.';
            add(g, Math.abs(med) > 3 ? 'warn' : 'ok', 'Bank 1 vs bank 2 lambda: ' + (med >= 0 ? '+' : '') + lhFmt(med) + ' % (median)',
                lhS(r.length * 5 * c.dt) + ' of warm fuelled running.' + trims + (Math.abs(med) > 3 ? ' A steady split with closed loop active means one sensor reads off ' +
                    '(calibration, exhaust leak, sensor age) or one bank really runs different — swap the sensors to tell which.' : ''),
                [], [['Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2'], ['Fuel Closed Loop Control Bank 1 Trim', 'Fuel Closed Loop Control Bank 2 Trim']]);
        }
    }
    var lim = opts.tune && opts.tune.clTrim;
    ['Fuel Closed Loop Control Bank 1 Trim', 'Fuel Closed Loop Control Bank 2 Trim'].forEach(function (name) {
        var t = c.base(name);
        if (!t) return;
        var vals = lhPick(t, c.running, 5), hi = lim ? lim.max : Math.max.apply(null, vals), lo = lim ? lim.min : Math.min.apply(null, vals);
        if (Math.max(Math.abs(hi), Math.abs(lo)) < 5) return;
        var at = lhMask(c, function (k) { return c.running[k] && (t[k] >= hi - 0.05 || t[k] <= lo + 0.05); });
        var eps = lhEpisodes(c, at, 1.0, 0.3), share = lhTotal(eps) / Math.max(1, c.runningS) * 100;
        if (share > 3) add(g, 'warn', name + ' at its limit ' + lhFmt(share, 0) + ' % of the time', lhEpisodeText(eps) + ' at ' + lhFmt(lo, 0) + ' / +' + lhFmt(hi, 0) +
            ' %. Trims at the limit mean the fuel model is off by more than closed loop may correct — the error is in a sensor, the fuel properties or VE, ' +
            'not something to fix by widening the limits.', eps, [[name], ['Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Fuel Mixture Aim'], ['Inlet Manifold Pressure']]);
    });
}

/** Linear interpolation, clamped. */
function lhInterp(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    for (var i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[ys.length - 1];
}

function lhTable2(t, rpm, kpa) {
    var col = t.v.map(function (row) { return lhInterp(t.x, row, rpm); });
    return lhInterp(t.y, col, kpa);
}

/** Fuel properties and mixture aim against the tune: stoich vs composition, and where Fuel Mixture Aim comes from. */
function lhCheckFuelModel(c, add, opts) {
    var g = 'Fuel model', tune = opts.tune, comp = c.base('Fuel Composition'), stoich = c.base('Fuel Stoichiometric Ratio');
    if (comp) {
        var cv = lhPick(comp, c.running, 10), lo = lhQuantile(cv, 0.02), hi = lhQuantile(cv, 0.98);
        if (hi - lo > 5) add(g, 'warn', 'Fuel Composition moved ' + lhFmt(hi - lo) + ' % during the drive', 'It should only change after refuelling. ' +
            'A noisy or failing composition sensor moves stoich, aim and ignition blend with it.', [], [['Fuel Composition', 'Fuel Composition Sensor']]);
        if (cv.length && (lhQuantile(cv, 0.5) <= 0.1 || lhQuantile(cv, 0.5) >= 99.9)) add(g, 'warn', 'Fuel Composition reads ' + lhFmt(lhQuantile(cv, 0.5)) + ' %',
            'At the very end of the range — a disconnected sensor or a default value; check Fuel Composition Sensor Diagnostic.', [], [['Fuel Composition']]);
    }
    if (!tune) {
        add(g, 'info', 'Choose the tune for the fuel model checks', 'Stoich against fuel composition and where Fuel Mixture Aim comes from need the tune.');
        return;
    }
    var f = tune.fuel;
    if (comp && stoich && f.stoich && f.altStoich && f.density && f.altDensity) {
        var calc = [], logged = [];
        for (var k = c.start; k < c.n; k += 10) {
            if (!c.running[k] || !(stoich[k] > 0)) continue;
            var e = comp[k] / 100, mf = e * f.altDensity / (e * f.altDensity + (1 - e) * f.density);
            calc.push(mf * f.altStoich + (1 - mf) * f.stoich);
            logged.push(stoich[k]);
        }
        if (logged.length) {
            var ls = lhQuantile(logged, 0.5), cs = lhQuantile(calc, 0.5), e0 = lhQuantile(lhPick(comp, c.running, 10), 0.5) / 100;
            if (Math.abs(ls / cs - 1) > 0.005) add(g, 'warn', 'Logged stoich ' + lhFmt(ls, 2) + ' doesn\'t follow this tune\'s fuel properties (' + lhFmt(cs, 2) + ')',
                'Either a different tune ran the log, or composition/stoich is set up in a way this check doesn\'t model.', [], [['Fuel Stoichiometric Ratio'], ['Fuel Composition']]);
            // If the sensor reports ethanol content (most flex sensors do), the blend should go to pure ethanol, not the alternative fuel.
            if (f.altStoich > 9.3) {
                var ETH_STOICH = 9.0, ETH_DENSITY = 789, mfe = e0 * ETH_DENSITY / (e0 * ETH_DENSITY + (1 - e0) * f.density);
                var trueStoich = mfe * ETH_STOICH + (1 - mfe) * f.stoich, err = (ls / trueStoich - 1) * 100;
                add(g, Math.abs(err) > 2 ? 'warn' : 'info', 'Stoich ' + lhFmt(ls, 2) + ' at ' + lhFmt(e0 * 100) + ' % composition assumes the alternative fuel is ' +
                    'stoich ' + lhFmt(f.altStoich, 2) + ' (E85-like)',
                    'Fuel Composition blends from Fuel Properties (' + lhFmt(f.stoich, 2) + ') to Alternative Fuel Properties (' + lhFmt(f.altStoich, 2) + ', ' + lhFmt(f.altDensity, 0) +
                    ' kg/m³). If the sensor reports ethanol content, ' + lhFmt(e0 * 100) + ' % ethanol is stoich ≈ ' + lhFmt(trueStoich, 2) + ', and the fuel model is ' +
                    lhFmt(Math.abs(err)) + ' % ' + (err > 0 ? 'lean' : 'rich') + ' before closed loop (trims would read ' + (err > 0 ? '+' : '−') + lhFmt(Math.abs(err)) + ' %). ' +
                    'If the sensor is scaled to E85 content, this is right. Check the sensor\'s output scaling against the Alternative Fuel settings.',
                    [], [['Fuel Stoichiometric Ratio'], ['Fuel Composition'], ['Fuel Closed Loop Control Bank 1 Trim', 'Fuel Closed Loop Control Bank 2 Trim']]);
            }
        }
    }
    var a = tune.aim, rpm = c.base('Engine Speed'), map = c.base('Inlet Manifold Pressure'), aim = c.base('Fuel Mixture Aim');
    if (a && a.main && rpm && map && aim) {
        var dMain = [], dBlend = [], blends = [], cruiseMain = [], cruiseAlt = [];
        for (k = c.start; k < c.n; k += 10) {
            if (!c.running[k] || !(aim[k] > 0)) continue;
            var m = lhTable2(a.main, rpm[k], map[k]), bl = a.alt && a.blend && comp ? lhInterp(a.blend.x, a.blend.y, comp[k]) / 100 : 0;
            var al = a.alt ? lhTable2(a.alt, rpm[k], map[k]) : m, x = m + (al - m) * bl;
            dMain.push(aim[k] - m); dBlend.push(aim[k] - x); blends.push(bl);
            if (map[k] < 80) { cruiseMain.push(m); cruiseAlt.push(al); }
        }
        if (dMain.length) {
            var mm = lhQuantile(dMain, 0.5), mb = lhQuantile(dBlend, 0.5), b = lhQuantile(blends, 0.5);
            var explained = Math.abs(mb) < 0.005 && lhQuantile(dBlend.map(Math.abs), 0.9) < 0.01;
            var detail = 'Median logged Fuel Mixture Aim − Fuel Mixture Aim Main: ' + (mm >= 0 ? '+' : '') + lhFmt(mm, 3) + ' λ. ';
            if (b > 0) detail += 'Alternative Fuel Mixture Aim Blend is ' + lhFmt(b * 100, 0) + ' % at this fuel composition, so the aim is Main + (Alternative − Main) × ' +
                lhFmt(b * 100, 0) + ' %; at part load Main is ' + lhFmt(lhQuantile(cruiseMain, 0.5), 3) + ' and Alternative ' + lhFmt(lhQuantile(cruiseAlt, 0.5), 3) + ' λ (medians). ';
            detail += explained ? 'That reproduces the logged aim (median error ' + lhFmt(mb, 3) + ' λ), so no other compensation is active.'
                : 'After the blend ' + lhFmt(mb, 3) + ' λ is still unexplained — a compensation (coolant, air temperature, trim switch…) is changing the aim, ' +
                  'or a different tune ran this log.';
            if (stoich) detail += ' Target AFR = aim × Fuel Stoichiometric Ratio (' + lhFmt(lhQuantile(lhPick(stoich, c.running, 10), 0.5), 2) + ' here), so it reads lower than on petrol at the same λ.';
            add(g, Math.abs(mm) > 0.01 ? (explained ? 'info' : 'warn') : 'ok', Math.abs(mm) > 0.01 ? 'Fuel Mixture Aim runs ' + lhFmt(Math.abs(mm), 3) + ' λ ' +
                (mm < 0 ? 'richer' : 'leaner') + ' than Fuel Mixture Aim Main' + (explained && b > 0 ? ' — the alternative fuel blend' : '') : 'Fuel Mixture Aim follows Fuel Mixture Aim Main',
                detail, [], [['Fuel Mixture Aim'], ['Fuel Composition'], ['Inlet Manifold Pressure'], ['Engine Speed']]);
        }
    }
}

/** Low-side and direct-injection fuel pressure plausibility. */
function lhCheckFuelSupply(c, add, opts) {
    var g = 'Fuel supply', fp = c.base('Fuel Pressure'), flow = c.base('Fuel Flow');
    if (fp && c.runningS > 10) {
        var run = lhPick(fp, c.running, 5), med = lhQuantile(run, 0.5);
        var low = lhEpisodes(c, lhMask(c, function (k) { return c.settled[k] && fp[k] < 250; }), 0.5);
        if (low.length) add(g, 'fail', 'Low-side Fuel Pressure below 250 kPa while running', lhEpisodeText(low) + ' (median ' + lhFmt(med, 0) +
            ' kPa). The high-pressure pump needs feed pressure — lift pump, filter, or the sensor.', low, [['Fuel Pressure'], ['Fuel Pressure Direct Bank 1', 'Fuel Pressure Direct Bank 1 Aim'], ['Engine Speed']]);
        if (flow) {
            var flows = lhPick(flow, c.running, 5), f95 = lhQuantile(flows, 0.95), f50 = lhQuantile(flows, 0.5);
            var hiMask = lhMask(c, function (k) { return c.running[k] && flow[k] >= f95; }), loMask = lhMask(c, function (k) { return c.running[k] && flow[k] < f50; });
            var droop = lhQuantile(lhPick(fp, loMask, 5), 0.5) - lhQuantile(lhPick(fp, hiMask, 5), 0.5);
            if (droop > 40) add(g, 'warn', 'Low-side Fuel Pressure drops ' + lhFmt(droop, 0) + ' kPa at high fuel flow', 'Median at the top 5 % of Fuel Flow (≥ ' + lhFmt(f95, 0) +
                ' ml/min) vs light load. The lift pump or its supply voltage is running out; check before more boost.', [], [['Fuel Pressure'], ['Fuel Flow']]);
            else add(g, 'ok', 'Low-side Fuel Pressure holds with flow', 'Median ' + lhFmt(med, 0) + ' kPa; ' + lhFmt(Math.max(0, droop), 0) + ' kPa lower at the top 5 % of Fuel Flow.');
        }
        var max = opts.tune && opts.tune.fuelPressureWarnMax;
        if (max) {
            var over = lhEpisodes(c, lhMask(c, function (k) { return c.running[k] && fp[k] > max; }), 0.5);
            if (over.length) add(g, 'info', 'Fuel Pressure above the tune\'s warning maximum (' + lhFmt(max, 0) + ' kPa)', lhEpisodeText(over) +
                '. Either the regulator sits close to the limit or the limit is set too tight.', over, [['Fuel Pressure']]);
        }
    }
    // Gauge pressures (relative to the atmosphere) can't go far below zero: a reading under −20 kPa is the sensor or its translation.
    ['Fuel Pressure', 'Engine Oil Pressure'].forEach(function (name) {
        var v = c.base(name);
        if (!v) return;
        var neg = lhEpisodes(c, lhMask(c, function (k) { return v[k] < -20; }), 0.2);
        if (!neg.length) return;
        var min = Infinity;
        for (var k = c.start; k < c.n; k++) if (v[k] < min) min = v[k];
        var atStart = neg.every(function (e) { var k = Math.floor(e[0] / c.dt); return c.running[k] && !c.settled[k]; });
        add(g, 'warn', name + ' reads ' + lhFmt(min, 0) + ' kPa', lhEpisodeText(neg) + '. A gauge sensor below −20 kPa means suction in the line or a ' +
            'sensor offset/translation error' + (atStart ? ' — here only just after the engine started, while the pumps came up to pressure.' : '.'),
            neg, [[name], ['Engine Speed'], ['ECU Battery Voltage', 'PDM Battery Voltage']]);
    });
    var rail = c.base('Fuel Pressure Direct Bank 1');
    if (rail) {
        var dead = lhEpisodes(c, lhMask(c, function (k) { return c.settled[k] && rail[k] < 0.5; }), 2.0);
        if (dead.length) add(g, 'fail', 'Direct injection rail pressure below 0.5 MPa while running', lhEpisodeText(dead) + '. The rail sensor or the high-pressure pump isn\'t working.',
            dead, [['Fuel Pressure Direct Bank 1', 'Fuel Pressure Direct Bank 1 Aim'], ['Engine Speed']]);
    }
}

/** Electronic throttle: position follows aim. */
function lhCheckThrottle(c, add) {
    var pos = c.base('Throttle Position'), aim = c.base('Throttle Aim');
    if (!pos || !aim) return;
    var eps = lhEpisodes(c, lhMask(c, function (k) { return c.running[k] && Math.abs(pos[k] - aim[k]) > 5; }), 0.5, 0.2);
    add('Throttle', eps.length ? 'warn' : 'ok', eps.length ? 'Throttle Position off Throttle Aim by more than 5 %' : 'Throttle Position follows Throttle Aim',
        eps.length ? lhEpisodeText(eps) + '. A sticking throttle, a weak servo supply or a position sensor problem.' : 'Within 5 % throughout.',
        eps, [['Throttle Position', 'Throttle Aim'], ['Throttle Pedal']]);
}

/** Supply voltages. */
function lhCheckElectrical(c, add) {
    var g = 'Electrical', v = c.base('ECU Battery Voltage'), pdm = c.base('PDM Battery Voltage'), inj = c.base('ECU Injector Supply Voltage');
    if (v && c.runningS > 10) {
        var settled = lhEpisodes(c, c.running, 3.0), mask = lhMask(c, function (k) { return c.running[k] && settled.some(function (e) { return c.time[k] > e[0] + 3 && c.time[k] < e[1]; }); });
        var med = lhQuantile(lhPick(v, mask, 10), 0.5);
        var dips = lhEpisodes(c, lhMask(c, function (k) { return mask[k] && v[k] < 12.0; }), 0.2);
        var sev = med < 13.2 || med > 15.0 || dips.length ? 'warn' : 'ok';
        add(g, sev, 'ECU Battery Voltage while running: ' + lhFmt(med, 2) + ' V (median)', (med < 13.2 ? 'Low for a running charging system — alternator or wiring. ' :
            med > 15.0 ? 'High — check the alternator regulator. ' : '') + (dips.length ? 'Dips below 12 V: ' + lhEpisodeText(dips) + '. ' : ''), dips, [['ECU Battery Voltage', 'PDM Battery Voltage'], ['Engine Speed']]);
        if (pdm) {
            var d = [];
            for (var k = 0; k < c.n; k += 10) if (mask[k] && pdm[k] > 5) d.push(pdm[k] - v[k]);
            var md = lhQuantile(d, 0.5);
            if (d.length && Math.abs(md) > 0.5) add(g, 'warn', 'PDM and ECU battery voltages differ by ' + lhFmt(md, 2) + ' V',
                'Both should see the same battery; a steady difference is voltage drop in the supply or ground wiring of the lower one.', [], [['ECU Battery Voltage', 'PDM Battery Voltage']]);
        }
    }
    if (inj && c.runningS > 10) {
        var low = lhEpisodes(c, lhMask(c, function (k) { return c.running[k] && inj[k] < 50; }), 1.0);
        if (low.length) add(g, 'warn', 'ECU Injector Supply Voltage below 50 V while running', lhEpisodeText(low) + '. The direct injector boost supply sagged — injector opening becomes unreliable.',
            low, [['ECU Injector Supply Voltage'], ['Engine Speed']]);
    }
}

/** Knock inputs: both banks alive and comparable. */
function lhCheckKnockInputs(c, add, opts) {
    var rpm = c.base('Engine Speed');
    if (!rpm) return;
    var banks = opts.tune && opts.tune.banks || [1, 2, 1, 2, 1, 2, 1, 2], per = {}, dead = [];
    var mask = lhMask(c, function (k) { return rpm[k] > 1500; });
    if (lhCount(mask) * c.dt < 20) return;
    for (var cyl = 1; cyl <= banks.length; cyl++) {
        var lv = c.base('Ignition Cylinder ' + cyl + ' Knock Level');
        if (!lv) continue;
        var med = lhQuantile(lhPick(lv, mask, 5), 0.5);
        (per[banks[cyl - 1]] = per[banks[cyl - 1]] || []).push([cyl, med]);
        if (Math.max.apply(null, lhPick(lv, mask, 5)) === 0) dead.push(cyl);
    }
    var keys = Object.keys(per);
    if (!keys.length) return;
    if (dead.length) add('Knock inputs', 'fail', 'Knock level always 0 on cylinder ' + dead.join(', '), 'No signal above 1500 rpm: the input or its cylinder assignment isn\'t working.',
        [], [dead.map(function (n) { return 'Ignition Cylinder ' + n + ' Knock Level'; })]);
    if (keys.length >= 2) {
        var meds = keys.map(function (b) { return [b, lhQuantile(per[b].map(function (p) { return p[1]; }), 0.5)]; });
        meds.sort(function (a, b) { return b[1] - a[1]; });
        var ratio = meds[0][1] / Math.max(1e-6, meds[meds.length - 1][1]);
        add('Knock inputs', ratio > 3 ? 'warn' : 'ok', 'Knock level by bank: ' + meds.map(function (m) { return 'bank ' + m[0] + ' ' + lhFmt(m[1], 2) + ' %'; }).join(', '),
            'Median above 1500 rpm' + (ratio > 3 ? '; one bank reads ' + lhFmt(ratio, 1) + '× lower. Knock on that bank may go undetected — check that sensor, its wiring, ' +
                'connector and mounting torque before timing or boost changes.' : '; both banks comparable.'),
            [], [keys.map(function (b) { return 'Ignition Cylinder ' + per[b][0][0] + ' Knock Level'; })]);
    }
}

/** Engine speed signal and wheel speeds. */
function lhCheckSpeeds(c, add) {
    var nat = c.native('Engine Speed');
    if (nat && nat.freq >= 50) {
        var jumps = [], skip = Math.ceil(LH_SKIP_S * nat.freq), dt = 1 / nat.freq;
        for (var k = skip + 1; k < nat.v.length; k++) {
            if (nat.v[k] > 300 && nat.v[k - 1] > 300 && Math.abs(nat.v[k] - nat.v[k - 1]) > 30000 * dt) jumps.push(k * dt);
        }
        if (jumps.length) add('Speed signals', 'warn', 'Engine Speed jumps ' + jumps.length + ' times', 'More than 30,000 rpm/s between samples, first at ' + lhAt(jumps[0]) +
            '. Lost or extra teeth — check Engine Speed Reference Diagnostic and the crank sensor wiring.', [[jumps[0] - 1, jumps[0] + 1]], [['Engine Speed'], ['Engine Speed Reference Diagnostic']]);
    }
    var names = ['Wheel Speed Front Left', 'Wheel Speed Front Right', 'Wheel Speed Rear Left', 'Wheel Speed Rear Right'].filter(c.has);
    if (names.length === 4) {
        var w = names.map(c.base), out = [];
        var moving = lhMask(c, function (k) { var s = (w[0][k] + w[1][k] + w[2][k] + w[3][k]) / 4; return s > 30; });
        if (lhCount(moving) * c.dt > 30) {
            names.forEach(function (n, i) {
                var r = [];
                for (var k = 0; k < c.n; k += 10) if (moving[k]) {
                    var others = (w[0][k] + w[1][k] + w[2][k] + w[3][k] - w[i][k]) / 3;
                    r.push((w[i][k] / others - 1) * 100);
                }
                var med = lhQuantile(r, 0.5);
                if (Math.abs(med) > 3) out.push(n + ' ' + (med > 0 ? '+' : '') + lhFmt(med) + ' %');
                var drop = lhEpisodes(c, lhMask(c, function (k) { return moving[k] && w[i][k] < 1; }), 0.3);
                if (drop.length) add('Speed signals', 'warn', n + ' drops to 0 while moving', lhEpisodeText(drop) + '. A wheel speed sensor or tone-ring fault.', drop, [names]);
            });
            add('Speed signals', out.length ? 'warn' : 'ok', out.length ? 'Wheel speeds disagree: ' + out.join(', ') : 'Wheel speeds agree',
                out.length ? 'Median against the other three above 30 km/h. Tyre size/pressure or a sensor/tone-ring problem (also affects traction and gear estimates).' : 'Within 3 % of each other above 30 km/h.',
                [], [names]);
        }
    }
}

/** ECU load and logging. */
function lhCheckEcu(c, add) {
    var cpu = c.base('ECU CPU Usage');
    if (cpu && c.runningS > 10) {
        var med = lhQuantile(lhPick(cpu, c.running, 10), 0.5);
        if (med >= 95) add('ECU', 'info', 'ECU CPU Usage ' + lhFmt(med, 0) + ' % (median)', 'The ECU is close to fully loaded. Compare with earlier logs; logging many channels at high rates adds load.', [], [['ECU CPU Usage']]);
    }
    var nanCh = c.log.channels.filter(function (ch, i) {
        var v = lvChannel(c.log, i);
        for (var k = 0; k < v.length; k += Math.max(1, Math.floor(v.length / 200))) if (!isFinite(v[k])) return true;
        return false;
    }).map(function (ch) { return ch.name; });
    if (nanCh.length) add('Log', 'info', nanCh.length + ' channels with unreadable values', nanCh.join(', '));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { lhAnalyze: lhAnalyze, lhFind: lhFind, lhEnumFor: lhEnumFor, lhEpisodes: lhEpisodes, LH_SKIP_S: LH_SKIP_S };
}
