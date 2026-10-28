/**
 * log-health/app.js — UI for the Log Health page: pick a log (and the tune that ran it), run the checks in a worker
 * (health-checks.js), list the findings by group and show each in the embedded Log Viewer.
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorBox = document.getElementById('error-container');
var progress = document.getElementById('progress');
var resultsSection = document.getElementById('results-section');
var showOk = document.getElementById('show-ok');

var logFile = null;
var tuneHealth = null;    // m1pkgHealth() of the chosen tune
var fileBytes = null;     // the chosen .m1pkg file's bytes, and a stored tune's original bytes (firmware names of diagnostic values)
var storedBytes = null;
var lastResult = null, lastRunFile = null, lastTuneName = null;
var logPanel = null, logPanelReady = null;

var LH_GROUP_ORDER = ['Log', 'ECU diagnostics', 'Substituted values', 'Stuck sensors', 'Pressure sensors', 'Temperatures', 'Lambda', 'Fuel model',
                      'Fuel supply', 'Throttle', 'Electrical', 'Knock inputs', 'Speed signals', 'ECU', 'Checks'];
var LH_SEV_LABEL = { fail: 'Fail', warn: 'Check', info: 'Note', ok: 'OK' };

function showError(msg) { errorBox.textContent = msg || ''; errorBox.hidden = !msg; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function updateButton() { analyzeBtn.disabled = !logFile; }

var tunePicker = tsPicker({
    pkgInput: document.getElementById('pkg-input'), select: document.getElementById('tune-select'), row: document.getElementById('tune-row'),
    hint: document.getElementById('tune-hint'), status: document.getElementById('tune-status'), extract: m1pkgHealth, what: 'the tune settings',
    none: 'No tune chosen: diagnostic codes are reported by number, and the fuel model checks (stoich against composition, where Fuel ' +
        'Mixture Aim comes from) are skipped. Choose the tune that ran the log.',
    describe: function (t) {
        var bits = [];
        if (t.fuel.altStoich) bits.push('stoich ' + t.fuel.stoich.toFixed(2) + ' → alternative ' + t.fuel.altStoich.toFixed(2));
        if (t.map) bits.push('MAP ' + t.map.at0.toFixed(1) + ' / ' + t.map.at5.toFixed(1) + ' kPa at 0 / 5 V');
        return bits.join(', ') + '.';
    },
    onError: showError,
    onChange: function (t, id) {
        tuneHealth = t;
        storedBytes = null;
        if (t && id) tsLoadFile(id).then(function (buf) { if (tunePicker.currentId() === id) storedBytes = buf; }).catch(function () { storedBytes = null; });
    }
});
// A .m1pkg file: keep its bytes too, for the diagnostic value names.
document.getElementById('pkg-input').addEventListener('change', function (e) {
    var f = e.target.files[0];
    fileBytes = null;
    if (f) f.arrayBuffer().then(function (buf) { fileBytes = buf; });
});

logInput.addEventListener('change', function () {
    logFile = logInput.files[0] || null;
    resultsSection.hidden = true;
    showError('');
    if (logFile) tunePicker.suggest(logFile);
    updateButton();
});

function createWorker() {
    var urls = ['../lib/ld-parser.js', '../ve-table/worker.js', '../log-viewer/log-file.js', '../lib/xz-decoder.js', '../lib/m1pkg-parser.js',
                'health-checks.js', 'worker.js'].map(function (u) { return JSON.stringify(new URL(u, window.location.href).href); });
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
            if (e.data.type === 'error') { showError('Could not check the log: ' + e.data.message); return; }
            lastResult = e.data.result;
            lastRunFile = file;
            lastTuneName = tuneHealth ? tuneHealth.tuneName : null;
            logPanelReady = null;
            render();
            var result = lastResult, tuneName = lastTuneName, tuneId = tuneName ? tunePicker.currentId() : null;
            rsSaveControl(document.getElementById('history-save'), function () {
                return rsLogFacts(file).then(function (facts) {
                    return Object.assign({ tool: 'log-health', tuneId: tuneId, tuneName: tuneName, settings: {} }, facts, rbLogHealth(result));
                });
            });
            resultsSection.hidden = false;
        };
        w.onerror = function (err) { w.terminate(); progress.hidden = true; updateButton(); showError('The check failed: ' + (err.message || 'worker error')); };
        var src = !tuneHealth ? null : tunePicker.currentId() ? storedBytes : fileBytes, bytes = src ? src.slice(0) : null;
        w.postMessage({ type: 'analyze', data: data, name: file.name, tune: tuneHealth, tuneBytes: bytes }, isCsv ? [] : [data]);
    }).catch(function (err) { progress.hidden = true; updateButton(); showError(err.message); });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function groupsOf(findings) {
    var by = {};
    findings.forEach(function (f, i) { (by[f.group] = by[f.group] || []).push({ f: f, i: i }); });
    return LH_GROUP_ORDER.concat(Object.keys(by).filter(function (g) { return LH_GROUP_ORDER.indexOf(g) < 0; }))
        .filter(function (g) { return by[g]; }).map(function (g) { return { name: g, items: by[g] }; });
}

function countsHtml(r) {
    return '<div class="lh-counts">' + ['fail', 'warn', 'info', 'ok'].map(function (s) {
        return '<span class="lh-count ' + s + '">' + r.counts[s] + ' ' + { fail: 'fail', warn: 'to check', info: 'notes', ok: 'passed' }[s] + '</span>';
    }).join('') + '</div><p class="section-desc">' + esc(lastRunFile.name) + ' — ' + Math.round(r.duration) + ' s logged, ' + Math.round(r.runningS) +
        ' s running' + (lastTuneName ? ', tune ' + esc(lastTuneName) : ', no tune') + '.</p>';
}

function findingHtml(f, i, withButtons) {
    var canShow = withButtons && ((f.times && f.times.length) || (f.channels && f.channels.length && f.channels[0].length));
    return '<div class="lh-finding ' + f.severity + '"><div class="lh-title"><span class="lh-sev">' + LH_SEV_LABEL[f.severity] + '</span>' + esc(f.title) +
        '</div>' + (f.detail ? '<div class="lh-detail">' + esc(f.detail) + '</div>' : '') +
        (canShow ? '<button class="lh-show" data-i="' + i + '">Show in log</button>' : '') + '</div>';
}

function render() {
    var r = lastResult, ok = showOk.checked;
    document.getElementById('summary').innerHTML = countsHtml(r);
    document.getElementById('findings').innerHTML = groupsOf(r.findings).map(function (g) {
        var items = g.items.filter(function (x) { return ok || x.f.severity !== 'ok'; });
        if (!items.length) return '';
        return '<div class="lh-group"><h3>' + esc(g.name) + '</h3>' + items.map(function (x) { return findingHtml(x.f, x.i, true); }).join('') + '</div>';
    }).join('');
}

showOk.addEventListener('change', function () { if (lastResult) render(); });

document.getElementById('findings').addEventListener('click', function (e) {
    var b = e.target.closest('.lh-show');
    if (b) showFinding(lastResult.findings[+b.dataset.i]);
});

function showFinding(f) {
    var el = document.getElementById('log-panel');
    if (!logPanel) logPanel = new LogPanel(el, { preset: 'fuelling', storageKey: 'log-health', showVe: false, showTf: false });
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
        title: 'Log Health', subtitle: lastRunFile.name, fileName: 'Log Health - ' + lastRunFile.name,
        meta: [['Logged', Math.round(r.duration) + ' s'], ['Running', Math.round(r.runningS) + ' s'], ['Tune', lastTuneName || 'none'],
               ['Findings', r.counts.fail + ' fail, ' + r.counts.warn + ' to check, ' + r.counts.info + ' notes, ' + r.counts.ok + ' passed']],
        sections: groupsOf(r.findings).map(function (g) {
            return { title: g.name, html: g.items.map(function (x) { return findingHtml(x.f, x.i, false); }).join('') };
        })
    });
});
