/**
 * knock/profile-app.js — UI for the Knock Noise Profile: pick one or more logs and the tune (Knock Threshold, cylinder gains), build the
 * profile in a worker (knock-profile.js), and show the findings, the rpm × cylinder table per load band and each hump in the log.
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorBox = document.getElementById('error-container');
var progress = document.getElementById('progress');
var resultsSection = document.getElementById('results-section');
var bandSelect = document.getElementById('band-select');

var logFiles = [], tuneKnock = null, lastResult = null, lastFiles = [], lastTuneName = null;
var logPanel = null, panelFile = -1, panelReady = null;

var KP_GROUP_ORDER = ['Profile', 'Humps'];
var KP_SEV_LABEL = { fail: 'Fail', warn: 'Check', info: 'Note', ok: 'OK' };

function showError(msg) { errorBox.textContent = msg || ''; errorBox.hidden = !msg; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function updateButton() { analyzeBtn.disabled = !logFiles.length; }

var tunePicker = tsPicker({
    pkgInput: document.getElementById('pkg-input'), select: document.getElementById('tune-select'), row: document.getElementById('tune-row'),
    hint: document.getElementById('tune-hint'), status: document.getElementById('tune-status'), extract: m1pkgKnock, what: 'the knock threshold and cylinder gains',
    none: 'No tune chosen: levels are shown as logged, without the threshold. Choose the tune that ran the logs.',
    describe: function (t) {
        return (t.threshold ? 'Knock Threshold ' + t.threshold.values[0].map(function (v) { return Math.round(v); }).join(' / ') + ' % over ' +
            t.threshold.rpm[0] + '–' + t.threshold.rpm[t.threshold.rpm.length - 1] + ' rpm. ' : 'This tune has no Knock Threshold table. ') +
            (t.gains ? 'Cylinder gains ' + t.gains.map(function (g) { return g === null ? '—' : Math.round(g); }).join(' / ') + '.' : '');
    },
    onError: showError,
    onChange: function (t) { tuneKnock = t; }
});

logInput.addEventListener('change', function () {
    logFiles = Array.prototype.slice.call(logInput.files || []);
    resultsSection.hidden = true;
    showError('');
    if (logFiles.length) tunePicker.suggest(logFiles[logFiles.length - 1]);
    updateButton();
});

function createWorker() {
    var urls = ['../lib/ld-parser.js', '../ve-table/worker.js', '../log-viewer/log-file.js', '../log-health/health-checks.js', 'knock-profile.js', 'profile-worker.js']
        .map(function (u) { return JSON.stringify(new URL(u, window.location.href).href); });
    var blob = new Blob(['importScripts(' + urls.join(',') + ');'], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob), w = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
}

analyzeBtn.addEventListener('click', function () {
    if (!logFiles.length) return;
    var files = logFiles.slice();
    showError('');
    progress.hidden = false;
    analyzeBtn.disabled = true;
    Promise.all(files.map(function (f) { return /\.csv$/i.test(f.name) ? f.text() : f.arrayBuffer(); })).then(function (datas) {
        var w = createWorker();
        w.onmessage = function (e) {
            w.terminate();
            progress.hidden = true;
            updateButton();
            if (e.data.type === 'error') { showError('Could not build the profile: ' + e.data.message); return; }
            lastResult = e.data.result;
            lastFiles = files;
            lastTuneName = tuneKnock ? tuneKnock.tuneName : null;
            panelFile = -1;
            panelReady = null;
            document.getElementById('log-block').hidden = true;
            render();
            resultsSection.hidden = false;
        };
        w.onerror = function (err) { w.terminate(); progress.hidden = true; updateButton(); showError('The analysis failed: ' + (err.message || 'worker error')); };
        w.postMessage({ type: 'analyze', logs: datas.map(function (d, i) { return { data: d, name: files[i].name }; }), tune: tuneKnock || null },
            datas.filter(function (d) { return typeof d !== 'string'; }));
    }).catch(function (err) { progress.hidden = true; updateButton(); showError(err.message); });
});

// ---------------------------------------------------------------------------
// Rendering (each part returns HTML so the PDF report reuses it)
// ---------------------------------------------------------------------------

function findingsHtml(r, withButtons) {
    var by = {};
    r.findings.forEach(function (f, i) { (by[f.group] = by[f.group] || []).push({ f: f, i: i }); });
    return KP_GROUP_ORDER.filter(function (g) { return by[g]; }).map(function (g) {
        return '<div class="lh-group"><h3>' + esc(g) + '</h3>' + by[g].map(function (x) {
            var f = x.f;
            return '<div class="lh-finding ' + f.severity + '"><div class="lh-title"><span class="lh-sev">' + KP_SEV_LABEL[f.severity] + '</span>' + esc(f.title) + '</div>' +
                (f.detail ? '<div class="lh-detail">' + esc(f.detail) + '</div>' : '') +
                (withButtons && f.file !== null && f.times.length ? '<button class="lh-show" data-i="' + x.i + '">Show in ' + esc(lastFiles[f.file].name) + '</button>' : '') + '</div>';
        }).join('') + '</div>';
    }).join('');
}

/** Cell tint: % of threshold (or logged %) → transparent … orange … red at 100. */
function tint(v, withThreshold) {
    var x = Math.max(0, Math.min(1, v / (withThreshold ? 100 : 40)));
    var r = 255, gch = Math.round(200 - 160 * x), a = (0.08 + 0.55 * x).toFixed(2);
    return 'background: rgba(' + r + ',' + gch + ',40,' + a + ')';
}

function profileHtml(r, band) {
    var prof = r.profile[band], n = r.cylinders, withThr = !!lastTuneName;
    if (!prof) return '<p class="section-desc">No data.</p>';
    var humpCells = {};
    r.humps.forEach(function (h) { for (var rpm = h.r0; rpm < h.r1; rpm += 100) humpCells[(h.cyl - 1) + ':' + rpm] = 1; });
    var html = '<div class="kp-scroll"><table class="kp-table"><tr><th>rpm</th><th>Data</th>';
    for (var c = 0; c < n; c++) html += '<th>Cyl ' + (c + 1) + '</th>';
    html += '<th>Median</th></tr>';
    var rows = 0;
    r.bins.forEach(function (rpm, bi) {
        var cells = prof.map(function (cyl) { return cyl[bi]; });
        if (!cells.some(Boolean)) return;
        rows++;
        var s = Math.max.apply(null, cells.map(function (x) { return x ? x.s : 0; })), vals = cells.filter(Boolean).map(function (x) { return x.v; }).sort(function (a, b) { return a - b; });
        html += '<tr><td>' + rpm + '–' + (rpm + 100) + '</td><td>' + (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s</td>' + cells.map(function (x, ci) {
            return x ? '<td class="' + (humpCells[ci + ':' + rpm] ? 'hump' : '') + '" style="' + tint(x.v, withThr) + '">' + Math.round(x.v) + '</td>' : '<td class="empty">—</td>';
        }).join('') + '<td>' + Math.round(vals[Math.floor((vals.length - 1) / 2)]) + '</td></tr>';
    });
    if (!rows) return '<p class="section-desc">No engine-speed band has 1 s of data at this load.</p>';
    return html + '</table></div><p class="kp-legend">95th percentile of each cylinder\'s knock level in the band, ' +
        (withThr ? 'as % of Knock Threshold (100 = the ECU calls it knock)' : 'as logged (%) — choose the tune to compare with the threshold') +
        '. Outlined: the humps in the findings. Warm running only (coolant 60 °C or more); a cell needs 1 s.</p>';
}

function render() {
    var r = lastResult;
    var warm = r.logs.reduce(function (s, l) { return s + l.warmS; }, 0);
    document.getElementById('summary').innerHTML = '<p class="section-desc">' + (lastFiles.length === 1 ? esc(lastFiles[0].name) : lastFiles.length + ' logs') + ' — ' +
        Math.round(warm) + ' s of warm running, ' + r.humps.length + ' hump' + (r.humps.length === 1 ? '' : 's') +
        (lastTuneName ? ', threshold and gains from ' + esc(lastTuneName) : ', no tune') + '.</p>';
    document.getElementById('findings').innerHTML = findingsHtml(r, true);
    bandSelect.innerHTML = r.bands.map(function (b, i) { return '<option value="' + i + '">' + esc(b) + '</option>'; }).join('');
    document.getElementById('profile').innerHTML = profileHtml(r, 0);
}

bandSelect.addEventListener('change', function () {
    if (lastResult) document.getElementById('profile').innerHTML = profileHtml(lastResult, +bandSelect.value);
});

document.getElementById('findings').addEventListener('click', function (e) {
    var b = e.target.closest('.lh-show');
    if (!b || !lastResult) return;
    var f = lastResult.findings[+b.dataset.i];
    var block = document.getElementById('log-block'), el = document.getElementById('log-panel');
    block.hidden = false;
    document.getElementById('log-title').textContent = f.title + ' — ' + lastFiles[f.file].name;
    if (!logPanel) logPanel = new LogPanel(el, { preset: 'fuelling', storageKey: 'knock-profile', showVe: false, showTf: false });
    if (panelFile !== f.file || !panelReady) { panelFile = f.file; panelReady = logPanel.open(lastFiles[f.file]); }
    panelReady.then(function () { return logPanel.showChannels(f.channels); }).then(function () {
        logPanel.setMarkers(f.times.map(function (t) { return { t: t[0], t1: t[1], label: 'in band', color: '#ff9800', fill: 'rgba(255,152,0,0.15)' }; }));
        var longest = f.times.reduce(function (a, t) { return !a || t[1] - t[0] > a[1] - a[0] ? t : a; }, null);
        if (longest) logPanel.zoomTo(Math.max(0, longest[0] - 5), longest[1] + 5);
        block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) { panelReady = null; showError(err.message); });
});

document.getElementById('pdf-btn').addEventListener('click', function () {
    if (!lastResult) return;
    var r = lastResult;
    prPrint({
        title: 'Knock Noise Profile', subtitle: lastFiles.map(function (f) { return f.name; }).join(', '), fileName: 'Knock Noise Profile - ' + lastFiles[0].name, landscape: true,
        meta: [['Logs', String(lastFiles.length)], ['Humps', String(r.humps.length)], ['Tune', lastTuneName || 'none']],
        sections: [{ title: 'Findings', html: findingsHtml(r, false) }].concat(r.bands.map(function (b, i) {
            return { title: 'Profile — ' + b, html: profileHtml(r, i) };
        }))
    });
});
