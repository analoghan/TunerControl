/**
 * ignition/app.js — UI for the Ignition Review page: pick a log and the tune that ran it, run igAnalyze (ign-analysis.js) in a
 * worker, and show the findings, timing by cell, ignition states and cylinder trims, each finding viewable in the embedded Log Viewer.
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorBox = document.getElementById('error-container');
var progress = document.getElementById('progress');
var resultsSection = document.getElementById('results-section');

var logFile = null, tuneIgn = null;
var lastResult = null, lastRunFile = null, lastTuneName = null;
var logPanel = null, logPanelReady = null;

var IG_GROUP_ORDER = ['Log', 'Timing', 'Compensation', 'Flex fuel', 'Cylinder trims', 'Knock margin', 'Tune'];
var IG_SEV_LABEL = { fail: 'Fail', warn: 'Check', info: 'Note', ok: 'OK' };

function showError(msg) { errorBox.textContent = msg || ''; errorBox.hidden = !msg; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fmt(v, d) { return v === null || v === undefined || isNaN(v) ? '—' : Number(v).toFixed(d === undefined ? 1 : d); }
function updateButton() { analyzeBtn.disabled = !logFile; }

var tunePicker = tsPicker({
    pkgInput: document.getElementById('pkg-input'), select: document.getElementById('tune-select'), row: document.getElementById('tune-row'),
    hint: document.getElementById('tune-hint'), status: document.getElementById('tune-status'), extract: m1pkgIgnition, what: 'the ignition tables',
    none: 'No tune chosen: only the ignition states are counted. Choose the tune that ran the log.',
    describe: function (t) {
        var bits = [];
        if (t.alt && t.blend) bits.push('Main + Alternative Fuel Ignition Timing');
        if (t.compensations.length) bits.push(t.compensations.length + ' active compensation' + (t.compensations.length > 1 ? 's' : ''));
        var trimmed = t.cylinderTrims.filter(function (x) { return x && x.v.some(function (r) { return r.some(function (v) { return v !== 0; }); }); }).length;
        if (trimmed) bits.push(trimmed + ' cylinder trim' + (trimmed > 1 ? 's' : ''));
        return bits.join(', ') + '.';
    },
    onError: showError,
    onChange: function (t) { tuneIgn = t; }
});

logInput.addEventListener('change', function () {
    logFile = logInput.files[0] || null;
    resultsSection.hidden = true;
    showError('');
    if (logFile) tunePicker.suggest(logFile);
    updateButton();
});

function createWorker() {
    var urls = ['../lib/ld-parser.js', '../ve-table/worker.js', '../log-viewer/log-file.js', '../log-health/health-checks.js', 'ign-analysis.js', 'worker.js']
        .map(function (u) { return JSON.stringify(new URL(u, window.location.href).href); });
    var blob = new Blob(['importScripts(' + urls.join(',') + ');'], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob), w = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
}

analyzeBtn.addEventListener('click', function () {
    if (!logFile) return;
    var file = logFile, isCsv = /\.csv$/i.test(file.name);
    showError('');
    progress.hidden = false;
    analyzeBtn.disabled = true;
    (isCsv ? file.text() : file.arrayBuffer()).then(function (data) {
        var w = createWorker();
        w.onmessage = function (e) {
            w.terminate();
            progress.hidden = true;
            updateButton();
            if (e.data.type === 'error') { showError('Could not review the log: ' + e.data.message); return; }
            lastResult = e.data.result;
            lastRunFile = file;
            lastTuneName = tuneIgn ? tuneIgn.tuneName : null;
            logPanelReady = null;
            render();
            resultsSection.hidden = false;
        };
        w.onerror = function (err) { w.terminate(); progress.hidden = true; updateButton(); showError('The review failed: ' + (err.message || 'worker error')); };
        w.postMessage({ type: 'analyze', data: data, name: file.name, tune: tuneIgn }, isCsv ? [] : [data]);
    }).catch(function (err) { progress.hidden = true; updateButton(); showError(err.message); });
});

// ---------------------------------------------------------------------------
// Rendering (each part returns HTML so the PDF report reuses it)
// ---------------------------------------------------------------------------

function groupsOf(findings) {
    var by = {};
    findings.forEach(function (f, i) { (by[f.group] = by[f.group] || []).push({ f: f, i: i }); });
    return IG_GROUP_ORDER.concat(Object.keys(by).filter(function (g) { return IG_GROUP_ORDER.indexOf(g) < 0; }))
        .filter(function (g) { return by[g]; }).map(function (g) { return { name: g, items: by[g] }; });
}

function summaryHtml(r) {
    return '<p class="section-desc">' + esc(lastRunFile.name) + ' — ' + Math.round(r.runningS) + ' s running, ' + Math.round(r.normalS) + ' s in the Normal state' +
        (r.composition !== null ? ', fuel composition ' + fmt(r.composition) + ' %' : '') + (r.blendPct !== null ? ' (ignition blend ' + fmt(r.blendPct, 0) + ' %)' : '') +
        (lastTuneName ? ', tune ' + esc(lastTuneName) : ', no tune') + '.</p>';
}

function findingHtml(f, i, withButtons) {
    var canShow = withButtons && ((f.times && f.times.length) || (f.channels && f.channels.length && f.channels[0].length));
    return '<div class="lh-finding ' + f.severity + '"><div class="lh-title"><span class="lh-sev">' + IG_SEV_LABEL[f.severity] + '</span>' + esc(f.title) +
        '</div>' + (f.detail ? '<div class="lh-detail">' + esc(f.detail) + '</div>' : '') +
        (canShow ? '<button class="lh-show" data-i="' + i + '">Show in log</button>' : '') + '</div>';
}

function findingsHtml(r, withButtons) {
    return groupsOf(r.findings).map(function (g) {
        return '<div class="lh-group"><h3>' + esc(g.name) + '</h3>' + g.items.map(function (x) { return findingHtml(x.f, x.i, withButtons); }).join('') + '</div>';
    }).join('');
}

function cellsHtml(r) {
    if (!r.cells.length) return '<p class="section-desc">No table cell has ' + 0.5 + ' s of Normal-state running' + (lastTuneName ? '' : ' (choose the tune)') + '.</p>';
    var rpms = [], kpas = [], at = {};
    r.cells.forEach(function (c) {
        if (rpms.indexOf(c.rpm) < 0) rpms.push(c.rpm);
        if (kpas.indexOf(c.kpa) < 0) kpas.push(c.kpa);
        at[c.rpm + ',' + c.kpa] = c;
    });
    rpms.sort(function (a, b) { return a - b; });
    kpas.sort(function (a, b) { return b - a; });
    var html = '<div class="ig-scroll"><table class="ig-table ig-grid"><tr><th>kPa \\ rpm</th>' + rpms.map(function (x) { return '<th>' + x + '</th>'; }).join('') + '</tr>';
    kpas.forEach(function (y) {
        html += '<tr><th>' + y + '</th>' + rpms.map(function (x) {
            var c = at[x + ',' + y];
            if (!c) return '<td></td>';
            var cls = c.knockPct === null ? '' : c.knockPct >= 80 ? 'k2' : c.knockPct >= 50 ? 'k1' : 'k0';
            var tip = x + ' rpm × ' + y + ' kPa: ' + c.seconds.toFixed(1) + ' s; logged ' + fmt(c.timing) + '°, table ' + fmt(c.table) + '°, compensation ' + fmt(c.comp) +
                '°; Alternative − Main ' + fmt(c.altMinusMain) + '°' + (c.knockPct !== null ? '; knock ' + Math.round(c.knockPct) + ' % of threshold' : '');
            return '<td class="' + cls + '" title="' + esc(tip) + '">' + fmt(c.timing) + '°<small>' + fmt(c.comp) + '° comp' +
                (c.knockPct !== null ? ' · ' + Math.round(c.knockPct) + ' %' : '') + '</small></td>';
        }).join('') + '</tr>';
    });
    return html + '</table></div><p class="ig-legend">Green: knock level under 50 % of the threshold · amber: 50–80 % · red: 80 % or more. ' +
        'Hover a cell for the table value, the Alternative − Main difference and the seconds behind it.</p>';
}

function statesHtml(r) {
    if (!r.states.length) return '<p class="section-desc">Ignition Timing State is not logged.</p>';
    return '<table class="ig-table"><tr><th style="text-align:left">State</th><th>Time</th><th>Stretches</th><th>Median timing</th></tr>' + r.states.map(function (s) {
        return '<tr><td style="text-align:left">' + esc(s.name) + '</td><td>' + (s.seconds < 10 ? s.seconds.toFixed(1) : Math.round(s.seconds)) + ' s</td><td>' + s.episodes +
            '</td><td>' + fmt(s.timing) + '°</td></tr>';
    }).join('') + '</table><p class="ig-legend">Only Normal follows the tables. Idle is the idle speed controller\'s timing, Engine Overrun the overrun target.</p>';
}

function cylindersHtml(r) {
    if (!r.cylinders.length) return '<p class="section-desc">Choose the tune for the cylinder trims.</p>';
    return '<table class="ig-table"><tr><th>Cylinder</th><th style="text-align:left">Knock input</th><th>Most retard</th><th>From</th><th>Most advance</th><th>Knock level (median)</th></tr>' +
        r.cylinders.map(function (c) {
            return '<tr><td>' + c.cylinder + '</td><td style="text-align:left">' + esc(c.input || '—') + '</td><td>' + (c.retard ? fmt(c.retard) + '°' : '0') + '</td><td>' +
                (c.retardFrom !== null ? c.retardFrom + ' kPa' : '—') + '</td><td>' + (c.advance ? '+' + fmt(c.advance) + '°' : '0') + '</td><td>' +
                (c.knockMedian !== null ? fmt(c.knockMedian, 2) + ' %' : '—') + '</td></tr>';
        }).join('') + '</table><p class="ig-legend">Ignition Cylinder N Trim Main from the tune; knock level above 1500 rpm from the log.</p>';
}

function render() {
    var r = lastResult;
    document.getElementById('summary').innerHTML = summaryHtml(r);
    document.getElementById('findings').innerHTML = findingsHtml(r, true);
    document.getElementById('cells').innerHTML = cellsHtml(r);
    document.getElementById('states').innerHTML = statesHtml(r);
    document.getElementById('cylinders').innerHTML = cylindersHtml(r);
    var file = lastRunFile, tuneName = lastTuneName, tuneId = tuneName ? tunePicker.currentId() : null;
    rsSaveControl(document.getElementById('history-save'), function () {
        return rsLogFacts(file).then(function (facts) {
            return Object.assign({ tool: 'ignition', tuneId: tuneId, tuneName: tuneName, settings: {} }, facts, rbIgnition(r));
        });
    });
}

document.getElementById('findings').addEventListener('click', function (e) {
    var b = e.target.closest('.lh-show');
    if (b) showFinding(lastResult.findings[+b.dataset.i]);
});

function showFinding(f) {
    var el = document.getElementById('log-panel');
    if (!logPanel) logPanel = new LogPanel(el, { preset: 'fuelling', storageKey: 'ignition', showVe: false, showTf: false });
    if (!logPanelReady) logPanelReady = logPanel.open(lastRunFile);
    logPanelReady.then(function () {
        return f.channels && f.channels.length ? logPanel.showChannels(f.channels) : null;
    }).then(function () {
        logPanel.setMarkers((f.times || []).map(function (t) { return { t: t[0], t1: t[1], label: f.title, color: '#ff9800', fill: 'rgba(255,152,0,0.15)' }; }));
        if (f.times && f.times.length) {
            var t = f.times[0], pad = Math.max(3, (t[1] - t[0]) * 0.5);
            logPanel.zoomTo(Math.max(0, t[0] - pad), t[1] + pad);
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) { logPanelReady = null; showError(err.message); });
}

document.getElementById('pdf-btn').addEventListener('click', function () {
    if (!lastResult) return;
    var r = lastResult;
    prPrint({
        title: 'Ignition Review', subtitle: lastRunFile.name, fileName: 'Ignition Review - ' + lastRunFile.name,
        meta: [['Running', Math.round(r.runningS) + ' s'], ['Normal state', Math.round(r.normalS) + ' s'], ['Tune', lastTuneName || 'none'],
               ['Fuel composition', r.composition !== null ? fmt(r.composition) + ' %' : '—']],
        sections: [{ title: 'Findings', html: findingsHtml(r, false) }, { title: 'Timing by Cell', html: cellsHtml(r) },
                   { title: 'Ignition States', html: statesHtml(r) }, { title: 'Cylinder Trims', html: cylindersHtml(r) }]
    });
});
