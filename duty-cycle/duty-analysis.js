/**
 * duty-cycle/duty-analysis.js — Injector duty cycle analysis (no DOM; used by app.js and the tests).
 *
 * dcAnalyze(columnNames, rows, opts) → result
 *   opts: { warn (%, default 80), crit (%, default 90) }
 *   rows are samples (logs are resampled to 100 Hz), so everything is measured in seconds and episodes, not samples:
 *   an episode is a stretch above the warning level lasting at least DC_EPISODE_MIN s (gaps up to DC_EPISODE_GAP s joined),
 *   and the "sustained peak" is the highest duty cycle held for DC_HOLD s.
 *
 * On a direct-injection M1 the logged Fuel Injector Primary Duty Cycle is measured against the injection window, not the whole
 * 720° cycle: pulse width in crank degrees ÷ duty cycle comes out at a near-constant window (about 160° in the LT4 logs, about
 * 205° with an older tune). 100 % therefore means the pulse fills the window. dcAnalyze reports that implied window when the
 * cylinder 1 pulse width is logged.
 */

var DC_HOLD = 0.3, DC_EPISODE_MIN = 0.3, DC_EPISODE_GAP = 0.2;

function dcFind(columnNames, candidates) {
    var lower = columnNames.map(function (n) { return String(n).toLowerCase().trim(); });
    for (var c = 0; c < candidates.length; c++) {
        var want = candidates[c].toLowerCase();
        for (var i = 0; i < lower.length; i++) {
            // .ld channel names can be cut short ("Fuel Injector Secondary Duty Cyc").
            if (lower[i] === want || (lower[i].length >= 24 && want.indexOf(lower[i]) === 0)) return i;
        }
    }
    return -1;
}

function dcPercentile(values, p) {
    if (!values.length) return null;
    var v = values.slice().sort(function (a, b) { return a - b; });
    return v[Math.min(v.length - 1, Math.floor(v.length * p))];
}

function dcAnalyze(columnNames, rows, opts) {
    opts = opts || {};
    var warn = opts.warn > 0 ? opts.warn : 80, crit = opts.crit > 0 ? opts.crit : 90;
    var ix = {
        time: dcFind(columnNames, ['Time']), rpm: dcFind(columnNames, ['Engine Speed']),
        pri: dcFind(columnNames, ['Fuel Injector Primary Duty Cycle']), sec: dcFind(columnNames, ['Fuel Injector Secondary Duty Cycle']),
        map: dcFind(columnNames, ['Inlet Manifold Pressure']), pw: dcFind(columnNames, ['Fuel Cylinder 1 Primary Output Pulse Width 1'])
    };
    if (ix.rpm === -1) throw new Error('Engine Speed channel not found.');
    if (ix.pri === -1 && ix.sec === -1) throw new Error('No injector duty cycle channel found. Log "Fuel Injector Primary Duty Cycle".');
    if (ix.time === -1) throw new Error('Time channel not found.');
    var dcIdx = ix.pri >= 0 ? ix.pri : ix.sec;
    var dt = rows.length > 1 ? (rows[rows.length - 1][ix.time] - rows[0][ix.time]) / (rows.length - 1) : 0.01;
    if (!(dt > 0)) dt = 0.01;
    var hold = Math.max(1, Math.round(DC_HOLD / dt));

    var bins = [];
    for (var b = 0; b < 16; b++) bins.push({ min: b * 500, max: (b + 1) * 500, seconds: 0, values: [], peak: 0, sustained: 0, sustainedMap: null });
    var secondaryUsed = false, running = 0, aboveWarn = 0, aboveCrit = 0, maxRpm = 0, maxMap = null, boostSeconds = 0, windows = [];
    var series = [];   // running samples: [index, dc]
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i], rpm = r[ix.rpm], dc = r[dcIdx];
        if (ix.pri >= 0 && ix.sec >= 0 && r[ix.sec] > 0.5) secondaryUsed = true;
        if (isNaN(rpm) || isNaN(dc) || rpm < 300) { series.push(null); continue; }
        running += dt;
        series.push(dc);
        var bin = bins[Math.min(15, Math.floor(rpm / 500))];
        bin.seconds += dt;
        bin.values.push(dc);
        if (dc > bin.peak) bin.peak = dc;
        if (dc > warn) aboveWarn += dt;
        if (dc > crit) aboveCrit += dt;
        if (rpm > maxRpm) maxRpm = rpm;
        if (ix.map >= 0 && !isNaN(r[ix.map])) {
            if (maxMap === null || r[ix.map] > maxMap) maxMap = r[ix.map];
            if (r[ix.map] > 100) boostSeconds += dt;
        }
        if (ix.pw >= 0 && dc > 2 && r[ix.pw] > 0.3) windows.push(r[ix.pw] * rpm * 6 / 1000 / (dc / 100));
    }
    if (!running) throw new Error('The engine is not running anywhere in this log (Engine Speed below 300 rpm).');

    // Sustained peak: the highest value held for DC_HOLD s (the minimum over each window, maximised), overall and per bin.
    var sustained = 0, sustainedAt = -1;
    for (var s = 0; s + hold <= series.length; s++) {
        var lo = Infinity;
        for (var k = s; k < s + hold; k++) { if (series[k] === null) { lo = -1; break; } if (series[k] < lo) lo = series[k]; }
        if (lo > sustained) { sustained = lo; sustainedAt = s; }
        if (lo > 0) {
            var bb = bins[Math.min(15, Math.floor(rows[s][ix.rpm] / 500))];
            if (lo > bb.sustained) { bb.sustained = lo; bb.sustainedMap = ix.map >= 0 ? rows[s][ix.map] : null; }
        }
    }

    // Episodes above the warning level.
    var episodes = [], cur = null;
    for (var e = 0; e < series.length; e++) {
        var v = series[e];
        if (v !== null && v > warn) {
            if (cur && (e - cur.end) * dt <= DC_EPISODE_GAP) { cur.end = e; if (v > cur.peak) { cur.peak = v; cur.at = e; } }
            else { if (cur) episodes.push(cur); cur = { start: e, end: e, peak: v, at: e }; }
        }
    }
    if (cur) episodes.push(cur);
    episodes = episodes.filter(function (p) { return (p.end - p.start + 1) * dt >= DC_EPISODE_MIN; }).map(function (p) {
        var r = rows[p.at];
        return { time: r[ix.time], duration: (p.end - p.start + 1) * dt, peak: p.peak, rpm: r[ix.rpm], map: ix.map >= 0 ? r[ix.map] : null, critical: p.peak > crit };
    }).sort(function (a, b) { return b.peak - a.peak; });

    var peakAt = sustainedAt >= 0 ? rows[sustainedAt] : null;
    var result = {
        warn: warn, crit: crit, runningSeconds: running, secondsAboveWarn: aboveWarn, secondsAboveCrit: aboveCrit,
        sustainedPeak: sustained, sustainedPeakRpm: peakAt ? peakAt[ix.rpm] : null, sustainedPeakMap: peakAt && ix.map >= 0 ? peakAt[ix.map] : null,
        maxRpm: maxRpm, maxMap: maxMap, boostSeconds: boostSeconds,
        window: windows.length >= 100 ? dcPercentile(windows, 0.5) : null,
        usesSecondary: ix.pri === -1, hasSecondary: secondaryUsed,
        bins: bins.filter(function (x) { return x.seconds > 0; }).map(function (x) {
            return { min: x.min, max: x.max, seconds: x.seconds, p95: dcPercentile(x.values, 0.95), peak: x.peak, sustained: x.sustained, sustainedMap: x.sustainedMap };
        }),
        episodes: episodes.slice(0, 30), episodeCount: episodes.length
    };
    result.recommendations = dcRecommendations(result);
    return result;
}

function dcRecommendations(r) {
    var recs = [], at = r.sustainedPeakRpm !== null ? ' at ' + Math.round(r.sustainedPeakRpm) + ' rpm' +
        (r.sustainedPeakMap !== null ? ', ' + Math.round(r.sustainedPeakMap) + ' kPa' : '') : '';
    var held = r.sustainedPeak.toFixed(1) + ' % (held ' + DC_HOLD + ' s)' + at;
    var window = r.window ? ' On this direct-injection ECU the duty cycle is measured against the injection window (about ' +
        Math.round(r.window) + '° in this log), so 100 % means the pulse fills the window.' : '';
    var cover = 'This log reaches ' + Math.round(r.maxRpm) + ' rpm' + (r.maxMap !== null ? ' and ' + Math.round(r.maxMap) + ' kPa, with ' +
        r.boostSeconds.toFixed(1) + ' s above 100 kPa' : '') + '.';
    if (r.sustainedPeak > r.crit) {
        recs.push({ severity: 'critical', text: 'Duty cycle reaches ' + held + ', above ' + r.crit + ' % — for ' + r.secondsAboveCrit.toFixed(1) +
            ' s in all. The injectors are close to delivering no more fuel.' + window + ' Options: a longer window (earlier start of injection, ' +
            'within the valve events — see DI Injection Timing), more rail pressure (a shorter pulse for the same fuel), or larger injectors.' });
    } else if (r.sustainedPeak > r.warn) {
        recs.push({ severity: 'warning', text: 'Duty cycle reaches ' + held + ', above the ' + r.warn + ' % warning level for ' +
            r.secondsAboveWarn.toFixed(1) + ' s in all. More boost or rpm will push it further.' + window });
    } else {
        recs.push({ severity: 'good', text: 'Duty cycle stays at or below ' + held + ' — below the ' + r.warn + ' % warning level.' + window });
    }
    var thin = r.maxMap !== null && r.boostSeconds < 2;
    recs.push({ severity: thin ? 'warning' : 'info', text: cover + (thin
        ? ' That is too little time under boost to judge headroom at full load: duty cycle rises with load and rpm, so log full-throttle pulls ' +
          'to near the rev limit before relying on this.'
        : ' Duty cycle above these conditions is not measured.') });
    if (r.hasSecondary) recs.push({ severity: 'info', text: 'The secondary injectors are used in this log too; this covers the primary injectors.' });
    return recs;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { dcAnalyze: dcAnalyze, dcFind: dcFind };
