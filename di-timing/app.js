/**
 * di-timing/app.js — DI Injection Timing page: valve events from the cam, the recommended start of injection, the M1
 * limits, and (optionally) a review of the tune's Fuel Timing Primary Main table and a log. Calculations: di-calc.js.
 */

var diTune = null, diTunePicker = null, diLogFile = null, diLogResult = null, diWorker = null;
var diPwEdited = false;   // the user typed a design pulse width: don't replace it with the log's

function $(id) { return document.getElementById(id); }
function num(id, dflt) { var v = parseFloat($(id).value); return isNaN(v) ? dflt : v; }
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function deg(v, d) { return v === null || v === undefined || isNaN(v) ? '—' : (+v).toFixed(d === undefined ? 0 : d) + '°'; }

function readInputs() {
    return {
        cam: { intakeDur: num('intake-duration', 229), exhaustDur: num('exhaust-duration', 244), basis: $('lift-basis').value,
               lsa: num('lsa', 118), icl: num('icl', 114), seatExtra: num('seat-extra', 52), phaser: num('phaser', 0),
               phaserMovesExhaust: $('phaser-exhaust').checked },
        maxRpm: Math.max(500, num('max-rpm', 7000)), rpmStep: Math.max(100, num('rpm-step', 500)), pwMs: Math.max(0, num('design-pw', 6)),
        spark: num('max-spark', 35), startLimit: num('start-limit', null), primaryLimit: num('primary-limit', null)
    };
}

function showError(msg) { $('error').hidden = !msg; $('error').textContent = msg || ''; }

// --- tune ---------------------------------------------------------------------------------------------------

/** A tune fills the limits, spark, phaser and RPM sites from the tune and recalculates (its timing table is reviewed). */
function onDiTune(di) {
    diTune = di;
    if (!di) return;
    if (di.startLimit !== null) $('start-limit').value = di.startLimit;
    if (di.primaryLimit !== null) $('primary-limit').value = di.primaryLimit;
    if (di.spark !== null) $('max-spark').value = Math.ceil(di.spark);
    if (di.camAim) $('phaser').value = di.camAim.max;
    if (di.table && di.table.rpm.length > 1) {
        var r = di.table.rpm, gaps = r.slice(1).map(function (v, i) { return v - r[i]; });
        $('max-rpm').value = r[r.length - 1];
        if (gaps.every(function (g) { return g === gaps[0]; })) $('rpm-step').value = gaps[0];
    }
    calculate();
}

diTunePicker = tsPicker({
    pkgInput: $('pkg-input'), select: $('tune-select'), row: $('tune-row'), hint: $('tune-hint'), status: $('tune-status'), extract: m1pkgDi,
    none: 'No tune chosen: enter the limits below, or choose a tune to fill them and review its timing table.',
    describe: function (di) {
        return 'Filled the Injection Start Limit (' + di.startLimit + '), Primary Limit (' + di.primaryLimit + '), most spark advance (' + di.spark +
            '° BTDC)' + (di.camAim ? ', cam phaser (' + di.camAim.min + '–' + di.camAim.max + '° advance)' : '') + ' and the RPM sites from the tune.';
    },
    onError: showError, onChange: onDiTune
});

// --- log ----------------------------------------------------------------------------------------------------

$('log-input').addEventListener('change', function () {
    diLogFile = $('log-input').files[0] || null;
    diLogResult = null;
    $('log-status').textContent = diLogFile ? diLogFile.name : '';
    if (diLogFile) diTunePicker.suggest(diLogFile);
    calculate();
});

function analyzeLog(evc, primaryLimit) {
    if (!diLogFile) return Promise.resolve(null);
    if (diWorker) diWorker.terminate();
    var base = new URL('.', window.location.href).href;
    var urls = ['../ve-table/worker.js', '../log-viewer/log-file.js', 'di-calc.js', 'worker.js'].map(function (u) { return JSON.stringify(new URL(u, base).href); });
    var blob = new Blob(['importScripts(' + urls.join(',') + ');'], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    diWorker = new Worker(url);
    URL.revokeObjectURL(url);
    var isCsv = /\.csv$/i.test(diLogFile.name), file = diLogFile;
    $('log-status').textContent = 'Reading ' + file.name + '…';
    return (isCsv ? file.text() : file.arrayBuffer()).then(function (data) {
        return new Promise(function (resolve, reject) {
            diWorker.onmessage = function (e) { if (e.data.type === 'error') reject(new Error(e.data.message)); else resolve(e.data); };
            diWorker.onerror = function (e) { reject(new Error(e.message || 'Log analysis failed')); };
            diWorker.postMessage({ type: 'analyze', data: data, name: file.name, evc: evc, primaryLimit: primaryLimit,
                                   table: diTune && diTune.table ? { rpm: diTune.table.rpm, map: diTune.table.map } : null }, isCsv ? [] : [data]);
        });
    }).then(function (r) { $('log-status').textContent = file.name + ': ' + r.samples.toLocaleString() + ' injection readings.'; return r; },
            function (err) { $('log-status').textContent = 'Could not check the log: ' + err.message; return null; });
}

// --- calculation and rendering --------------------------------------------------------------------------------

var calcSeq = 0;

function calculate() {
    showError('');
    var inp = readInputs(), seq = ++calcSeq;
    if (!(inp.cam.intakeDur > 0 && inp.cam.exhaustDur > 0 && inp.cam.lsa > 0)) { showError('Enter the cam durations and lobe separation.'); return; }
    var ev = diValveEvents(inp.cam), e6 = ev.at006, rec = diRecommendSoi(e6);
    var evc = e6.dBTDC.evc, earliest = Math.floor(evc - 5);
    var rpms = [];
    if (diTune && diTune.table && diTune.table.rpm.length > 1 && diTune.table.rpm[diTune.table.rpm.length - 1] === inp.maxRpm) rpms = diTune.table.rpm.slice();
    else for (var r = 0; r <= inp.maxRpm; r += inp.rpmStep) rpms.push(r);
    var rows = diSoiTable(rpms, { soi: Math.round(rec.dBTDC), earliest: earliest, pwMs: inp.pwMs, spark: inp.spark, primaryLimit: inp.primaryLimit, evc: evc });
    var tableCheck = diTune && diTune.table ? diTableCheck(diTune.table, e6) : null;

    $('results-section').hidden = false;
    renderEvents(ev);
    renderRecommendation(rec, e6, inp);
    renderLimits(diLimitAdvice({ startLimit: inp.startLimit, primaryLimit: inp.primaryLimit }, e6, inp.spark, tableCheck ? tableCheck.max : null), inp, e6);
    renderSoiTable(rows, inp);
    renderDiagram(e6, ev.at050, rec, inp, rows);
    renderTune(tableCheck, e6, rec, inp, null);
    $('log-block').hidden = !diLogFile;
    if (diLogFile) {
        $('log-content').innerHTML = '<p class="hint">Checking the log…</p>';
        analyzeLog(evc, inp.primaryLimit).then(function (lr) {
            if (seq !== calcSeq) return;
            diLogResult = lr;
            // Design for the longest pulse the engine actually reached, plus 10 %, unless a value was typed.
            if (lr && !diPwEdited) {
                var pw = Math.ceil(lr.pw.max * 1.1 * 2) / 2;
                if (pw !== inp.pwMs) {
                    $('design-pw').value = pw;
                    inp.pwMs = pw;
                    rows = diSoiTable(rpms, { soi: Math.round(rec.dBTDC), earliest: earliest, pwMs: pw, spark: inp.spark, primaryLimit: inp.primaryLimit, evc: evc });
                    renderSoiTable(rows, inp);
                    renderDiagram(e6, ev.at050, rec, inp, rows);
                }
            }
            renderLog(lr, e6, inp);
            renderTune(tableCheck, e6, rec, inp, lr);
        });
    }
}

function evRow(name, crank, dbtdc050, dbtdc006) {
    return '<tr><td>' + name + '</td><td>' + crank[0] + '</td><td>' + crank[1] + '</td><td>' + deg(dbtdc006, 1) + '</td><td>' + deg(720 - dbtdc006, 1) + '</td></tr>';
}

function renderEvents(ev) {
    var a = ev.at050, b = ev.at006;
    var f = function (v, w) { return (+v).toFixed(1) + '° ' + w; };
    $('valve-events').innerHTML = '<div class="scroll"><table class="ev-table"><thead><tr><th>Event</th><th>0.050"</th><th>0.006" (seat)</th>' +
        '<th>M1 dBTDC (0.006")</th><th>720° from firing TDC</th></tr></thead><tbody>' +
        evRow('Exhaust valve opens (EVO)', [f(a.evoBBDC, 'BBDC'), f(b.evoBBDC, 'BBDC')], a.dBTDC.evo, b.dBTDC.evo) +
        evRow('Intake valve opens (IVO)', [f(a.ivoBTDC, 'BTDC'), f(b.ivoBTDC, 'BTDC')], a.dBTDC.ivo, b.dBTDC.ivo) +
        evRow('Exhaust valve closes (EVC)', [f(a.evcATDC, 'ATDC'), f(b.evcATDC, 'ATDC')], a.dBTDC.evc, b.dBTDC.evc) +
        evRow('Intake valve closes (IVC)', [f(a.ivcABDC, 'ABDC'), f(b.ivcABDC, 'ABDC')], a.dBTDC.ivc, b.dBTDC.ivc) +
        '</tbody></table></div><p class="hint">Exhaust centreline ' + deg(b.ecl, 1) + ' BTDC, intake centreline ' + deg(b.icl, 1) + ' ATDC (with the phaser). ' +
        'Overlap ' + deg(a.overlap, 1) + ' at 0.050", ' + deg(b.overlap, 1) + ' seat to seat. "720° from firing TDC" is the scale of the MoTeC training ' +
        'spreadsheet (= 720 − dBTDC).</p>';
}

function renderRecommendation(rec, e6, inp) {
    var html = '<p><span class="big">' + rec.dBTDC.toFixed(0) + ' dBTDC</span> &nbsp; (' + rec.atdc.toFixed(1) + '° after overlap TDC)</p>' +
        '<p class="hint">Halfway between the intake valve opening (' + deg(e6.ivoBTDC, 1) + ' BTDC) and the intake centreline (' + deg(e6.icl, 1) +
        ' ATDC), but at least 20° after TDC — the method of the GM Gen V calculator. It starts ' + deg(rec.atdc - e6.evcATDC, 1) + ' after the exhaust ' +
        'valve seats (' + deg(e6.dBTDC.evc) + ' dBTDC)' + (rec.limitedByEvc ? ', which is what sets it here' : '') + '. Use it across the table as a ' +
        'starting point, then fine-tune: move it a few degrees at a time at steady load and keep the setting where lambda goes richest without ' +
        'a VE change (the fuel is mixing best).</p>';
    if (inp.cam.phaser) {
        html += '<p class="hint">With ' + inp.cam.phaser + '° of cam advance the valve events above already include the phaser. If the phaser moves ' +
            'with load, check the recommendation at each end of its range.</p>';
    }
    $('soi-rec').innerHTML = html;
}

function renderLimits(advice, inp, e6) {
    var maxRpm = inp.maxRpm, html = advice.map(function (a) { return '<div class="advice ' + a.severity + '">' + esc(a.text) + '</div>'; }).join('');
    if (inp.primaryLimit !== null) {
        html += '<p class="hint">At ' + maxRpm + ' rpm a pulse lasts ' + (maxRpm * 0.006).toFixed(1) + '° per millisecond. From the recommended start, the ' +
            'Primary Limit leaves room for ' + diMaxPw(diRecommendSoi(e6).dBTDC, inp.primaryLimit, maxRpm).toFixed(1) + ' ms there before the pulse is cut short.</p>';
    }
    if (diTune && diTune.limitMargin !== null) {
        html += '<p class="hint">The tune also has Fuel Timing Primary Limit Margin = ' + diTune.limitMargin + '°; it is shown for reference and ' +
            'not used in these checks.</p>';
    }
    $('limits-content').innerHTML = html;
}

function renderSoiTable(rows, inp) {
    var cell = function (v, cls) { return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</td>'; };
    var html = '<div class="scroll"><table class="soi-table"><thead><tr><th>RPM</th>' + rows.map(function (r) { return '<th>' + r.rpm + '</th>'; }).join('') +
        '</tr></thead><tbody>';
    html += '<tr><td class="dim">Start (dBTDC)</td>' + rows.map(function (r) { return cell(r.soi); }).join('') + '</tr>';
    html += '<tr><td class="dim">End at ' + inp.pwMs + ' ms</td>' + rows.map(function (r) {
        return cell(r.rpm ? Math.round(r.eoi) : '—', r.rpm && (r.intoCompression || r.truncated || r.nearSpark) ? 'flag' : 'dim');
    }).join('') + '</tr>';
    html += '<tr><td class="dim">Max PW to BDC (ms)</td>' + rows.map(function (r) { return cell(r.rpm ? (r.maxPwToBdc > 50 ? '>50' : r.maxPwToBdc.toFixed(1)) : '—', 'dim'); }).join('') + '</tr>';
    if (inp.primaryLimit !== null) {
        html += '<tr><td class="dim">Max PW to limit (ms)</td>' + rows.map(function (r) { return cell(r.rpm ? (r.maxPwToLimit > 50 ? '>50' : r.maxPwToLimit.toFixed(1)) : '—', 'dim'); }).join('') + '</tr>';
    }
    html += '</tbody></table></div>';
    var comp = rows.filter(function (r) { return r.rpm && r.intoCompression; }), trunc = rows.filter(function (r) { return r.rpm && r.truncated; });
    var fix = ' The better fix is more rail pressure, which shortens the pulse for the same fuel; otherwise start earlier — even before the exhaust valve ' +
        'seats where that is what it takes. Around 6 ms is the practical limit at high rpm.';
    if (trunc.length) html += '<div class="advice warning">From ' + trunc[0].rpm + ' rpm a ' + inp.pwMs + ' ms pulse runs past the Primary Limit and is cut short — the ' +
        'engine would run lean there. Check the pulse widths you actually reach (load a log) first.' + fix + '</div>';
    else if (comp.length) html += '<div class="advice info">From ' + comp[0].rpm + ' rpm a ' + inp.pwMs + ' ms pulse ends on the compression stroke (before the ' +
        'Primary Limit). Fuel injected against rising cylinder pressure flows less and mixes poorly — watch for sooting, misfire or lost power.' + fix + '</div>';
    $('soi-table').innerHTML = html;
    $('copy-btn').onclick = function () {
        var text = rows.map(function (r) { return r.rpm; }).join('\t') + '\n' + rows.map(function (r) { return r.soi; }).join('\t');
        var btn = this;
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { btn.textContent = 'Copied'; }, function () { btn.textContent = 'Copy failed'; })
            .then(function () { setTimeout(function () { btn.textContent = 'Copy start of injection row'; }, 1500); });
    };
}

/** Seconds of log behind a cell: readings are taken every 0.1 s (see worker.js). */
function tuneCellSeconds(c) { return c ? c.n / 10 : 0; }

/** "How to read this table" notes for the Fuel Timing Primary Main grid. */
function tuneTableNotes(evc, rec, inp, lr) {
    var hasLog = !!(lr && lr.cells), limit = inp.primaryLimit;
    var html = '<div class="table-notes"><p><strong>How to read this table.</strong> Rows are manifold pressure (kPa), columns engine speed ' +
        '(rpm), both the table\'s own sites. All angles are dBTDC (degrees before firing TDC): a <em>bigger</em> number is <em>earlier</em>. ' +
        'Exhaust valve seats at ' + Math.round(evc) + ', intake BDC is ' + DI_BDC + ', recommended start ' + rec.dBTDC.toFixed(0) + '.</p><ul>';
    html += '<li><strong>Big number</strong> — the start of injection the tune asks for in that cell (Fuel Timing Primary Main, as in M1 Tune). ' +
        'It comes from the tune alone and does not change with the log.</li>';
    if (hasLog) {
        html += '<li><strong>Small line, <code>X ms → Y</code></strong> — from the log, for the readings whose rpm and MAP are nearest to this ' +
            'cell. <code>X</code> = the longest pulse width (99th percentile, cylinder 1); <code>Y</code> = the latest end of injection seen, ' +
            'worked out as the <em>logged</em> start angle minus the pulse\'s crank degrees (pulse ms × rpm × 0.006). A cell with no small line ' +
            'had no log readings.</li>';
        html += '<li><strong>Logged vs table start</strong> — the end of injection uses the start angle the ECU actually used, which can differ ' +
            'from the big number: the ECU interpolates between sites and applies trims and the Injection Start Limit' +
            (inp.startLimit !== null ? ' (' + inp.startLimit + ')' : '') + '. Hover a cell to see both.</li>';
        html += '<li><strong>How much data</strong> — readings are taken every 0.1 s, so a cell can be filled by a moment of transient. ' +
            'Hover a cell for the time behind it; treat cells with less than 1 s as a hint, not a measurement.</li>';
    } else {
        html += '<li>Open a log to add, under each number, the longest logged pulse and the latest end of injection in that cell.</li>';
    }
    var key = function (cls, text) { return '<span class="legend-item"><span class="swatch ' + cls + '"></span>' + text + '</span>'; };
    html += '</ul><div class="table-legend">' +
        key('bad', 'Starts before the exhaust valve seats (above ' + Math.round(evc) + ')' +
            (hasLog && limit !== null ? ', or ends past the Primary Limit (' + limit + ') — the ECU cuts that pulse short' : '')) +
        (hasLog ? key('warn', 'Ends on the compression stroke (below ' + DI_BDC + '): less flow against rising pressure, poorer mixing') +
            key('ok', 'Logged injection fits on the intake stroke') : '') +
        key('none', hasLog ? 'No log readings (tune check only)' : 'Starts after the valve seats') + '</div></div>';
    return html;
}

/** Hover text for one cell: the table value and, with a log, everything behind the small line. */
function tuneCellTip(rpm, map, soi, c, evc, inp, hasLog) {
    var lines = [rpm + ' rpm' + (map === null ? '' : ' / ' + map + ' kPa'), 'Table start: ' + Math.round(soi) + ' dBTDC' +
        (soi > evc ? ' — ' + Math.round(soi - evc) + '° before the exhaust valve seats (' + Math.round(evc) + ')' : '')];
    if (!c) return lines.concat(hasLog ? ['No log readings in this cell.'] : []).join('\n');
    var s = tuneCellSeconds(c);
    lines.push('Log: ' + c.n + ' reading' + (c.n > 1 ? 's' : '') + ' (' + s.toFixed(1) + ' s)' + (s < 1 ? ' — thin data, treat as a hint' : ''));
    lines.push('Logged start (median): ' + c.angle + ' dBTDC');
    lines.push('Pulse width: ' + c.p99Pw + ' ms (99th pct), ' + c.maxPw + ' ms longest');
    var eoi = 'Latest end of injection: ' + c.worstEoi + ' dBTDC';
    if (inp.primaryLimit !== null && c.worstEoi < inp.primaryLimit) eoi += ' — past the Primary Limit (' + inp.primaryLimit + ')';
    else if (c.worstEoi < DI_BDC) eoi += ' — ' + Math.round(DI_BDC - c.worstEoi) + '° into the compression stroke';
    else eoi += ' — ' + Math.round(c.worstEoi - DI_BDC) + '° before BDC';
    lines.push(eoi);
    return lines.join('\n');
}

function renderTune(check, e6, rec, inp, lr) {
    $('tune-block').hidden = !(diTune && diTune.table);
    if (!diTune || !diTune.table) return;
    var t = diTune.table, evc = e6.dBTDC.evc, html = '';
    if (check.early.length) {
        var maxBy = Math.max.apply(null, check.early.map(function (c) { return c.by; }));
        html += '<div class="advice ' + (maxBy > 10 ? 'warning' : 'info') + '">' + check.early.length + ' cell' + (check.early.length > 1 ? 's start' : ' starts') +
            ' injection before the exhaust valve seats (' + Math.round(evc) + ' dBTDC), by up to ' + Math.round(maxBy) + '°: ' +
            check.early.slice(0, 6).map(function (c) { return c.rpm + ' rpm / ' + c.map + ' kPa (' + c.soi + ')'; }).join(', ') + (check.early.length > 6 ? '…' : '') +
            '. Some fuel leaves through the exhaust there. That can be a deliberate trade at high rpm and boost, to keep a long pulse out of the ' +
            'compression stroke; if the pulse fits anyway (see the log figures), start them after ' + Math.round(evc) + '.' +
            (inp.startLimit !== null && inp.startLimit < check.max ? ' The Injection Start Limit (' + inp.startLimit + ') caps them at ' + inp.startLimit + '.' : '') + '</div>';
    } else {
        html += '<div class="advice good">Every cell starts after the exhaust valve seats (' + Math.round(evc) + ' dBTDC).</div>';
    }
    if (check.late.length) {
        html += '<div class="advice info">' + check.late.length + ' cell' + (check.late.length > 1 ? 's start' : ' starts') + ' injection later than ' + DI_LATE_SOI +
            ' dBTDC, close to BDC: the intake air is slow there, so the fuel mixes poorly (sooting, lost power). Start them earlier unless there is a ' +
            'reason.</div>';
    }
    html += tuneTableNotes(evc, rec, inp, lr);
    html += '<div class="scroll"><table class="grid-table"><thead><tr><th>kPa \\ rpm</th>' + t.rpm.map(function (r) { return '<th>' + r + '</th>'; }).join('') + '</tr></thead><tbody>';
    for (var m = t.map.length - 1; m >= 0; m--) {
        html += '<tr><th>' + (t.map[m] === null ? '' : t.map[m]) + '</th>';
        t.values[m].forEach(function (v, r) {
            var c = lr && lr.cells ? lr.cells[m][r] : null, cls = v > evc ? 'bad' : '';
            if (c && c.worstEoi !== null) {
                if (inp.primaryLimit !== null && c.worstEoi < inp.primaryLimit) cls = 'bad';
                else if (c.worstEoi < DI_BDC && !cls) cls = 'warn';
                else if (!cls) cls = 'ok';
            }
            html += '<td class="' + cls + '" title="' + esc(tuneCellTip(t.rpm[r], t.map[m], v, c, evc, inp, !!(lr && lr.cells))) + '">' + Math.round(v) +
                (c ? '<small>' + c.p99Pw + ' ms → ' + Math.round(c.worstEoi) + '</small>' : '') + '</td>';
        });
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    $('tune-content').innerHTML = html;
}

function renderLog(lr, e6, inp) {
    if (!lr) { $('log-content').innerHTML = '<p class="hint">' + esc($('log-status').textContent) + '</p>'; return; }
    var c = lr.counts, n = lr.samples, pct = function (k) { return (c[k] / n * 100).toFixed(1) + '%'; };
    var problems = c.beforeEvc + c.truncated + c.nearSpark;
    var html = '<p>Logged pulse width ' + lr.pw.median + ' ms typical, ' + lr.pw.p99 + ' ms (99th percentile), ' + lr.pw.max + ' ms longest. Logged start of ' +
        'injection ' + lr.angle.min + '–' + lr.angle.max + ' dBTDC.</p>';
    html += '<div class="advice ' + (problems ? 'warning' : 'good') + '">' + (problems
        ? 'Of ' + n.toLocaleString() + ' injection readings: ' + [c.beforeEvc ? c.beforeEvc + ' (' + pct('beforeEvc') + ') started before the exhaust valve seats' : '',
            c.truncated ? c.truncated + ' (' + pct('truncated') + ') ran past the Primary Limit' : '',
            c.nearSpark ? c.nearSpark + ' (' + pct('nearSpark') + ') ended within 10° of the spark' : ''].filter(Boolean).join('; ') + '.'
        : 'All ' + n.toLocaleString() + ' injection readings started after the exhaust valve seats and ended well before the spark' +
          (c.intoCompression ? '' : ', on the intake stroke') + '.') + '</div>';
    if (c.intoCompression) html += '<p class="hint">' + c.intoCompression + ' readings (' + pct('intoCompression') + ') ended on the compression stroke.</p>';
    if (lr.worst) {
        var w = lr.worst;
        html += '<p class="hint">Latest end of injection: ' + w.eoi + ' dBTDC at ' + w.time + ' s (' + w.rpm + ' rpm, ' + (w.map !== null ? w.map + ' kPa, ' : '') +
            w.pw + ' ms from ' + w.soi + ' dBTDC' + (w.spark !== null ? ', spark ' + w.spark + '° BTDC' : '') + ').</p>';
    }
    if (lr.pw.max > num('design-pw', 6)) {
        html += '<p class="hint">The longest logged pulse (' + lr.pw.max + ' ms) is longer than the design pulse width above; raise it to check the table at that length.</p>';
    } else if (!diPwEdited) {
        html += '<p class="hint">"Longest pulse width" is set from this log (' + lr.pw.max + ' ms + 10%). Pulses get longer at full load and high rpm, so if the log ' +
            'has no full-throttle pulls at the top of the rev range, enter the pulse width you expect there.</p>';
    }
    $('log-content').innerHTML = html;
}

/** Cycle diagram: crank angle from firing TDC (left) through the four strokes, valve events at 0.006" (and 0.050"), injection. */
function renderDiagram(e6, e5, rec, inp, rows) {
    var W = 900, H = 230, L = 20, R = 20, x = function (dbtdc) { return L + (720 - dbtdc) / 720 * (W - L - R); };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Engine cycle with valve events and the injection window">';
    [['Power', 720, 540], ['Exhaust', 540, 360], ['Intake', 360, 180], ['Compression', 180, 0]].forEach(function (s, i) {
        svg += '<rect x="' + x(s[1]) + '" y="22" width="' + (x(s[2]) - x(s[1])) + '" height="' + (H - 54) + '" fill="' + (i % 2 ? '#1c1c1c' : '#161616') + '" stroke="#2c2c2c"/>' +
            '<text x="' + (x(s[1]) + x(s[2])) / 2 + '" y="16" fill="#888" font-size="12" text-anchor="middle">' + s[0] + '</text>';
    });
    [[720, 'TDC 720/0'], [540, 'BDC 540'], [360, 'TDC 360'], [180, 'BDC 180'], [0, 'TDC 0']].forEach(function (p, i, all) {
        var anchor = i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle';
        svg += '<text x="' + x(p[0]) + '" y="' + (H - 18) + '" fill="#777" font-size="11" text-anchor="' + anchor + '">' + p[1] + '</text>';
    });
    var bar = function (from, to, y, color, label, light) {
        return '<rect x="' + x(from) + '" y="' + y + '" width="' + Math.max(1, x(to) - x(from)) + '" height="16" rx="3" fill="' + color + '" opacity="' + (light ? 0.35 : 0.75) + '"/>' +
            (label ? '<text x="' + (x(from) + x(to)) / 2 + '" y="' + (y + 12) + '" fill="#fff" font-size="11" text-anchor="middle">' + label + '</text>' : '');
    };
    svg += bar(e6.dBTDC.evo, e6.dBTDC.evc, 34, '#f44336', 'Exhaust open (seat to seat)') + bar(e5.dBTDC.evo, e5.dBTDC.evc, 54, '#f44336', '0.050"', true);
    svg += bar(e6.dBTDC.ivo, e6.dBTDC.ivc, 78, '#2196f3', 'Intake open (seat to seat)') + bar(e5.dBTDC.ivo, e5.dBTDC.ivc, 98, '#2196f3', '0.050"', true);
    var last = rows[rows.length - 1], start = last ? last.soi : rec.dBTDC, eoi = last && last.rpm ? last.soi - last.crank : rec.dBTDC - 30;
    svg += bar(start, Math.max(eoi, 0), 124, '#4caf50', inp.pwMs + ' ms at ' + (last ? last.rpm : '') + ' rpm');
    var line = function (dbtdc, color, label, y) {
        return '<line x1="' + x(dbtdc) + '" x2="' + x(dbtdc) + '" y1="22" y2="' + (H - 32) + '" stroke="' + color + '" stroke-width="2" stroke-dasharray="4 3"/>' +
            '<text x="' + (x(dbtdc) + 4) + '" y="' + y + '" fill="' + color + '" font-size="11">' + label + '</text>';
    };
    svg += line(rec.dBTDC, '#4caf50', 'Start ' + rec.dBTDC.toFixed(0), 162);
    if (inp.startLimit !== null) svg += line(inp.startLimit, '#ffb74d', 'Start limit ' + inp.startLimit, 176);
    if (inp.primaryLimit !== null) svg += line(inp.primaryLimit, '#ff9800', 'Primary limit ' + inp.primaryLimit, 162);
    svg += line(inp.spark, '#ce93d8', 'Spark ' + inp.spark + '°', 176);
    svg += '</svg>';
    $('diagram').innerHTML = svg;
}

$('calc-btn').addEventListener('click', calculate);
$('design-pw').addEventListener('input', function () { diPwEdited = true; });

if (typeof module !== 'undefined' && module.exports) module.exports = {};
