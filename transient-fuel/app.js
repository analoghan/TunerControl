/**
 * transient-fuel/app.js — UI controller for Transient Fuel Analyzer
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorContainer = document.getElementById('error-container');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');

logInput.addEventListener('change', function() {
    var file = logInput.files[0];
    document.getElementById('log-filename').textContent = file ? file.name : 'No file selected';
    analyzeBtn.disabled = !file;
    if (file) tunePicker.suggest(file);
});

var ffFromPkg = null;    // Fuel Film Primary Main from the chosen tune (m1pkg-film.js), or null without a tune
var ffTuneChecks = null; // tune settings checked by the recommendations (m1pkg-film.js tuneChecks), from the chosen tune
var ffTuneInfo = null;   // { id, name } of the tune the fuel film table came from (id only for a stored tune)

/** The optional tune: its fuel film table, scale, offset and time constants (filled into the inputs below). */
var tunePicker = tsPicker({
    pkgInput: document.getElementById('pkg-input'), select: document.getElementById('tune-select'), row: document.getElementById('tune-row'),
    hint: document.getElementById('tune-hint'), status: document.getElementById('tune-status'), extract: m1pkgFuelFilm, what: 'the fuel film table',
    none: 'No tune chosen: enter the scale, offset and time constants below. With a tune they are filled in and its Fuel Film Primary Main gets suggested corrections.',
    describe: function (film) {
        return 'Fuel Film Primary Main (' + film.table.breakpoints.length + ' sites); scale, offset and time constants filled from the tune' +
            (film.notes.length ? '. ' + film.notes.join(' ') : '.');
    },
    onError: function (msg) { errorContainer.textContent = msg; errorContainer.hidden = false; },
    onChange: function (film, id) {
        ffFromPkg = film ? film.table : null;
        ffTuneInfo = film ? { id: id, name: film.tuneName || null } : null;
        if (film) { applyTuneSettings(film); errorContainer.hidden = true; } else ffTuneChecks = null;
    }
});

/** Fills the scale, offset and time-constant inputs with the values read from a tune package. */
function applyTuneSettings(film) {
    ffTuneChecks = film.tuneChecks || null;
    function set(id, value, dps) {
        if (typeof value === 'number' && isFinite(value)) document.getElementById(id).value = +value.toFixed(dps);
    }
    set('ff-scale', film.ffScale, 1);
    set('ff-offset', film.ffOffset, 2);
    set('fast-pct', film.timeConstants.fastPct, 1);
    set('fast-increase', film.timeConstants.fastIncrease, 3);
    set('fast-decrease', film.timeConstants.fastDecrease, 3);
    set('slow-increase', film.timeConstants.slowIncrease, 3);
    set('slow-decrease', film.timeConstants.slowDecrease, 3);
}

analyzeBtn.addEventListener('click', function() {
    var file = logInput.files[0];
    if (!file) return;

    analyzeBtn.disabled = true;
    errorContainer.hidden = true;
    resultsSection.hidden = true;
    progressSection.hidden = false;

    var settings = {
        mapRateThreshold: parseInt(document.getElementById('map-rate-threshold').value, 10) || 200,
        minMapChange: parseInt(document.getElementById('min-map-change').value, 10) || 20,
        mapWindow: parseInt(document.getElementById('map-window').value, 10) || 500,
        lambdaTarget: parseFloat(document.getElementById('lambda-target').value) || 1.0,
        ffScale: parseFloat(document.getElementById('ff-scale').value) || 100,
        ffOffset: parseFloat(document.getElementById('ff-offset').value) || 0,
        minCoolant: parseFloat(document.getElementById('min-coolant').value),
        tuneFilm: ffFromPkg && ffTuneChecks ? ffTuneChecks : null,
        currentTimeConstants: {
            fastPct: parseFloat(document.getElementById('fast-pct').value) || 30,
            fastIncrease: parseFloat(document.getElementById('fast-increase').value) || 0.2,
            fastDecrease: parseFloat(document.getElementById('fast-decrease').value) || 0.3,
            slowIncrease: parseFloat(document.getElementById('slow-increase').value) || 0.5,
            slowDecrease: parseFloat(document.getElementById('slow-decrease').value) || 0.3,
        },
    };

    // Read the log file
    var filesToRead = [];
    if (file.name.toLowerCase().endsWith('.ld')) {
        filesToRead.push({ key: 'log', file: file, mode: 'binary' });
    } else {
        filesToRead.push({ key: 'log', file: file, mode: 'text' });
    }

    var fileResults = {};
    var remaining = filesToRead.length;
    filesToRead.forEach(function(item) {
        var reader = new FileReader();
        reader.onload = function() {
            fileResults[item.key] = reader.result;
            remaining--;
            if (remaining === 0) runAnalysis(file, fileResults, settings);
        };
        reader.onerror = function() {
            progressSection.hidden = true;
            errorContainer.textContent = 'Could not read: ' + item.file.name;
            errorContainer.hidden = false;
            analyzeBtn.disabled = false;
        };
        if (item.mode === 'binary') reader.readAsArrayBuffer(item.file);
        else reader.readAsText(item.file);
    });
});

var lastRun = null;                          // { file, settings } of the last analysis, for the log panel
var logPanel = null, logPanelReady = null;   // log panel (../log-viewer/log-panel.js) and its load promise for lastRun

function runAnalysis(logFile, files, settings) {
    lastRun = { file: logFile, settings: settings, tune: ffFromPkg ? ffTuneInfo : null };
    logPanelReady = null;
    try {
        var result;
        if (logFile.name.toLowerCase().endsWith('.ld')) {
            result = analyzeTransientsLd(files.log, settings);
        } else {
            result = analyzeTransients(files.log, settings);
        }

        // If fuel film table was provided, compute corrections
        if (ffFromPkg) {
            result.ffTable = ffFromPkg;
            result.ffCorrected = computeFuelFilmCorrections(result, settings);
        }

        progressSection.hidden = true;
        renderResults(result);
        analyzeBtn.disabled = false;
    } catch (err) {
        progressSection.hidden = true;
        errorContainer.textContent = err.message;
        errorContainer.hidden = false;
        analyzeBtn.disabled = false;
    }
}

function renderResults(result) {
    resultsSection.hidden = false;
    renderSummary(result);
    renderTipInTable(result.tipIns);
    renderTipOutTable(result.tipOuts);
    document.getElementById('log-check').hidden = typeof LogPanel === 'undefined';
    if (typeof rsSaveControl === 'function' && lastRun) {
        var run = lastRun;
        rsSaveControl(document.getElementById('history-save'), function () {
            return rsLogFacts(run.file).then(function (facts) {
                var settings = Object.assign({}, run.settings);
                return Object.assign({ tool: 'transient', tuneId: run.tune && run.tune.id, tuneName: run.tune && run.tune.name, settings: settings },
                    facts, rbTransient(result));
            });
        });
    }
    renderRecommendations(result.recommendations);
    if (result.ffCorrected) {
        renderCorrectedTable(result.ffTable, result.ffCorrected);
    }
}

function renderSummary(r) {
    var c = document.getElementById('summary-content');
    c.innerHTML = '<div class="summary-grid">' +
        stat(r.totalEvents, 'Total Events') +
        stat(r.tipInCount, 'Tip-In Events') +
        stat(r.tipOutCount, 'Tip-Out Events') +
        stat(r.avgLeanSpike.toFixed(1) + '%', 'Avg Lean Spike') +
        stat(r.avgRichOvershoot.toFixed(1) + '%', 'Avg Rich Overshoot') +
        stat((r.unsettledTipIns ? '≥ ' : '') + Math.round(r.avgRecoveryTime) + 'ms', 'Avg Recovery Time' +
            (r.unsettledTipIns ? ' (' + r.unsettledTipIns + ' never settled)' : '')) +
        stat(r.skippedFuelCut || 0, 'Skipped (fuel cut)' + skippedDetail(r.skippedByReason)) +
        stat(r.nearIdleEvents || 0, 'Near idle (not used for advice)') +
        stat(r.richFirstTipIns || 0, 'Tip-ins rich, then lean') +
        '</div>';
}

/** " — 3 overrun, 5 injectors off" from the skipped-event reasons. */
function skippedDetail(by) {
    var names = { overrun: 'overrun', 'injection-off': 'injectors off', 'cut-count': 'cut count', air: 'lambda > 1.5' };
    var parts = Object.keys(by || {}).map(function (k) { return by[k] + ' ' + (names[k] || k); });
    return parts.length ? ' — ' + parts.join(', ') : '';
}

function stat(value, label) {
    return '<div class="summary-stat"><span class="stat-value">' + value + '</span><span class="stat-label">' + label + '</span></div>';
}

/** Recovery time, or "> window" for an event whose lambda never settled within the measuring window. */
/** "52→60 kPa", plus the peak when MAP overshot where it settled. */
function fmtMapChange(e) {
    return e.mapFrom + '→' + e.mapTo + ' kPa' + (mapOvershoot(e) >= TF_MAP_OVERSHOOT_KPA ? ' <span style="color:#ff9800">(peak ' + e.mapPeak + ')</span>' : '');
}

function fmtRecovery(e) {
    return (e.settled === false ? '&gt; ' : '') + e.recoveryTime + 'ms';
}

/** Click an event row: show that event in the log panel. */
['tipin-content', 'tipout-content'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-time]');
        if (tr && lastRun && typeof LogPanel !== 'undefined') showEventInLog(parseFloat(tr.dataset.time));
    });
});

function showEventInLog(time) {
    var el = document.getElementById('log-panel');
    el.hidden = false;
    if (!logPanel) logPanel = new LogPanel(el, { preset: 'transient', storageKey: 'transient', showVe: false });
    if (!logPanelReady) {
        var s = lastRun.settings;
        logPanelReady = logPanel.open(lastRun.file).then(function () {
            return logPanel.analyze({ tf: s, ve: { minCoolantTemp: s.minCoolant } });
        });
    }
    logPanelReady.then(function () { logPanel.showEvent(time); }).catch(function () { logPanelReady = null; });
    document.getElementById('log-check').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTipInTable(events) {
    var c = document.getElementById('tipin-content');
    if (events.length === 0) { c.innerHTML = '<p style="color:#888;">No tip-in events detected.</p>'; return; }

    var html = '<table class="event-table lv-clickable"><thead><tr><th>Time</th><th>RPM</th><th>MAP Change</th><th>Rate</th><th title="Rich before the lean peak">Rich First</th><th>Lean Spike</th><th title="Rich after the lean peak">Rich Overshoot</th><th>Recovery</th></tr></thead><tbody>';
    var limit = Math.min(events.length, 30);
    for (var i = 0; i < limit; i++) {
        var e = events[i];
        var leanCls = e.leanSpike > 10 ? 'severity-high' : e.leanSpike > 5 ? 'severity-med' : 'severity-low';
        var firstCls = e.richBefore > 10 ? 'severity-high' : e.richBefore > 3 ? 'severity-med' : 'severity-low';
        var richCls = e.richOvershoot > 10 ? 'severity-high' : e.richOvershoot > 5 ? 'severity-med' : 'severity-low';
        var recCls = e.recoveryTime > 800 ? 'severity-high' : e.recoveryTime > 500 ? 'severity-med' : 'severity-low';
        html += '<tr data-time="' + e.time + '" title="Show in the log"><td>' + e.time.toFixed(2) + 's</td><td>' + e.rpm + '</td><td>' + fmtMapChange(e) + '</td><td>' + e.mapRate + ' kPa/s</td><td class="' + firstCls + '">' + (e.richBefore || 0).toFixed(1) + '%</td><td class="' + leanCls + '">' + e.leanSpike.toFixed(1) + '%' + (isRichFirst(e) ? ' <span title="Follows a rich dip: not counted as a shortage of fuel film">*</span>' : '') + '</td><td class="' + richCls + '">' + e.richOvershoot.toFixed(1) + '%</td><td class="' + recCls + '">' + fmtRecovery(e) + '</td></tr>';
    }
    html += '</tbody></table>';
    if (events.some(isRichFirst)) html += '<p style="color:#888;font-size:0.8rem;">* Lean spike after a rich dip: not counted as a shortage of fuel film.</p>';
    if (events.length > limit) html += '<p style="color:#888;font-size:0.8rem;">Showing top ' + limit + ' of ' + events.length + ' events.</p>';
    c.innerHTML = html;
}

function renderTipOutTable(events) {
    var c = document.getElementById('tipout-content');
    if (events.length === 0) { c.innerHTML = '<p style="color:#888;">No tip-out events detected.</p>'; return; }

    var html = '<table class="event-table lv-clickable"><thead><tr><th>Time</th><th>RPM</th><th>MAP Change</th><th>Rate</th><th>Rich Overshoot</th><th>Recovery</th></tr></thead><tbody>';
    var limit = Math.min(events.length, 30);
    for (var i = 0; i < limit; i++) {
        var e = events[i];
        var richCls = e.richOvershoot > 10 ? 'severity-high' : e.richOvershoot > 5 ? 'severity-med' : 'severity-low';
        var recCls = e.recoveryTime > 800 ? 'severity-high' : e.recoveryTime > 500 ? 'severity-med' : 'severity-low';
        html += '<tr data-time="' + e.time + '" title="Show in the log"><td>' + e.time.toFixed(2) + 's</td><td>' + e.rpm + '</td><td>' + e.mapFrom + '→' + e.mapTo + ' kPa</td><td>' + e.mapRate + ' kPa/s</td><td class="' + richCls + '">' + e.richOvershoot.toFixed(1) + '%</td><td class="' + recCls + '">' + fmtRecovery(e) + '</td></tr>';
    }
    html += '</tbody></table>';
    if (events.length > limit) html += '<p style="color:#888;font-size:0.8rem;">Showing top ' + limit + ' of ' + events.length + ' events.</p>';
    c.innerHTML = html;
}

function renderRecommendations(recs) {
    var c = document.getElementById('recommendations-content');
    var html = '';
    recs.forEach(function(r) {
        html += '<div class="rec-item rec-' + r.severity + '">' + r.text + '</div>';
    });
    c.innerHTML = html;
}

function renderCorrectedTable(ffTable, corrected) {
    var section = document.getElementById('corrected-table-section');
    section.hidden = false;
    var container = document.getElementById('corrected-table-content');

    var html = '';

    // Scale vs Offset vs Cell recommendation
    if (corrected.scaleOffsetAdvice) {
        var advice = corrected.scaleOffsetAdvice;
        var adviceClass = advice.type === 'scale' ? 'rec-warning' : advice.type === 'offset' ? 'rec-info' : 'rec-good';
        html += '<div class="rec-item ' + adviceClass + '" style="margin-bottom:16px;">';
        html += '<b>Strategy recommendation (' + advice.type.toUpperCase() + '):</b> ' + advice.message;
        html += '</div>';
    }

    html += '<table class="event-table"><thead><tr><th>MAP (kPa)</th>';
    for (var i = 0; i < corrected.breakpoints.length; i++) {
        html += '<th>' + corrected.breakpoints[i] + '</th>';
    }
    html += '</tr></thead><tbody>';

    // Original row
    html += '<tr><td style="font-weight:600;color:#888;">Original (ul)</td>';
    for (var i = 0; i < corrected.original.length; i++) {
        html += '<td style="color:#888;">' + corrected.original[i].toFixed(1) + '</td>';
    }
    html += '</tr>';

    // Corrected row
    html += '<tr><td style="font-weight:600;color:#4caf50;">Corrected (ul)</td>';
    for (var i = 0; i < corrected.corrected.length; i++) {
        var changed = Math.abs(corrected.corrected[i] - corrected.original[i]) > 0.5;
        var cls = changed ? 'color:#4caf50;font-weight:600;' : 'color:#ccc;';
        html += '<td style="' + cls + '">' + corrected.corrected[i].toFixed(1) + '</td>';
    }
    html += '</tr>';

    // Change row
    html += '<tr><td style="font-weight:600;color:#ff9800;">Change (ul)</td>';
    for (var i = 0; i < corrected.corrections.length; i++) {
        var val = corrected.corrections[i];
        var cls = val > 0 ? 'color:#ff9800;' : 'color:#666;';
        html += '<td style="' + cls + '">' + (val > 0 ? '+' : '') + val.toFixed(1) + '</td>';
    }
    html += '</tr>';

    // Event count row
    html += '<tr><td style="font-weight:600;color:#666;">Events</td>';
    for (var i = 0; i < corrected.eventCounts.length; i++) {
        html += '<td style="color:#666;">' + corrected.eventCounts[i] + '</td>';
    }
    html += '</tr>';

    html += '</tbody></table>';
    container.innerHTML = html;

    // Build corrected CSV for download
    var csvLines = [
        'M1,v2',
        'Body,ul',
        'Cols,kPa,Inlet Man Pres',
        ',' + corrected.breakpoints.map(function(v) { return formatSci(v); }).join(','),
        '"0",' + corrected.corrected.map(function(v) { return formatSci(v); }).join(',')
    ];
    var correctedCsv = csvLines.join('\r\n');

    document.getElementById('download-ff-btn').onclick = function() {
        var blob = new Blob([correctedCsv], { type: 'text/csv' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'Fuel_Film_Prim_Main_Corrected.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };
    document.getElementById('copy-ff-btn').onclick = function() {
        navigator.clipboard.writeText(correctedCsv).catch(function(){});
        this.textContent = 'Copied!';
        var btn = this;
        setTimeout(function() { btn.textContent = 'Copy to Clipboard'; }, 1500);
    };
}

function formatSci(value) {
    // MoTeC M1 v2 format: 17 decimal places, e notation
    return '"' + value.toExponential(17) + '"';
}

// Export PDF: the rendered report blocks (lib/print-report.js)
document.getElementById('pdf-btn').addEventListener('click', function () {
    if (!lastRun) return;
    var name = lastRun.file.name;
    prPrint({ title: 'Transient Fuel Analysis', subtitle: name, fileName: 'Transient Fuel - ' + name,
        meta: [['Fuel film table', lastRun.tune && lastRun.tune.name ? lastRun.tune.name : 'none']],
        sections: prBlocks(resultsSection) });
});
