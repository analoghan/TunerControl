/**
 * cl-period/app.js — UI for the Closed-Loop Period page: pick one or more logs and the tune that ran them, time the lambda steps
 * in a worker (cl-analysis.js) and show the findings, the Period by exhaust mass flow (with a copyable row) and every step,
 * each viewable in the embedded Log Viewer.
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorBox = document.getElementById('error-container');
var progress = document.getElementById('progress');
var resultsSection = document.getElementById('results-section');

var logFiles = [], tuneCl = null;
var lastResult = null, lastFiles = [], lastTuneName = null;
var logPanel = null, panelFile = -1, panelReady = null;

var CL_GROUP_ORDER = ['Log', 'Period', 'Steps', 'Step test', 'Tune'];
var CL_SEV_LABEL = { fail: 'Fail', warn: 'Check', info: 'Note', ok: 'OK' };

function showError(msg) { errorBox.textContent = msg || ''; errorBox.hidden = !msg; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fmt(v, d) { return v === null || v === undefined || isNaN(v) ? '—' : Number(v).toFixed(d === undefined ? 0 : d); }
function updateButton() { analyzeBtn.disabled = !logFiles.length; }

var tunePicker = tsPicker({
    pkgInput: document.getElementById('pkg-input'), select: document.getElementById('tune-select'), row: document.getElementById('tune-row'),
    hint: document.getElementById('tune-hint'), status: document.getElementById('tune-status'), extract: m1pkgClPeriod, what: 'Fuel Closed Loop Period',
    none: 'No tune chosen: steps are timed but not compared with Fuel Closed Loop Period. Choose the tune that ran the logs.',
    describe: function (t) {
        if (!t.period) return 'This tune has no Fuel Closed Loop Period by Exhaust Mass Flow.';
        return 'Fuel Closed Loop Period ' + t.period.flow.map(function (f, i) { return f + ' g/s ' + Math.round(t.period.ms[i]) + ' ms'; }).join(', ') +
            (t.gain !== null ? '; trim gain ' + Math.round(t.gain) + ' %' : '') + '.';
    },
    onError: showError,
    onChange: function (t) { tuneCl = t; }
});

logInput.addEventListener('change', function () {
    logFiles = Array.prototype.slice.call(logInput.files || []);
    resultsSection.hidden = true;
    showError('');
    if (logFiles.length) tunePicker.suggest(logFiles[0]);
    updateButton();
});

function createWorker() {
    var urls = ['../lib/ld-parser.js', '../ve-table/worker.js', '../log-viewer/log-file.js', '../log-health/health-checks.js', 'cl-analysis.js', 'worker.js']
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
            if (e.data.type === 'error') { showError('Could not time the steps: ' + e.data.message); return; }
            lastResult = e.data.result;
            lastFiles = files;
            lastTuneName = tuneCl ? tuneCl.tuneName : null;
            panelFile = -1;
            render();
            resultsSection.hidden = false;
        };
        w.onerror = function (err) { w.terminate(); progress.hidden = true; updateButton(); showError('The analysis failed: ' + (err.message || 'worker error')); };
        w.postMessage({ type: 'analyze', logs: datas.map(function (d, i) { return { data: d, name: files[i].name }; }), tune: tuneCl },
            datas.filter(function (d) { return typeof d !== 'string'; }));
    }).catch(function (err) { progress.hidden = true; updateButton(); showError(err.message); });
});

// ---------------------------------------------------------------------------
// Rendering (each part returns HTML so the PDF report reuses it)
// ---------------------------------------------------------------------------

function groupsOf(findings) {
    var by = {};
    findings.forEach(function (f) { (by[f.group] = by[f.group] || []).push(f); });
    return CL_GROUP_ORDER.concat(Object.keys(by).filter(function (g) { return CL_GROUP_ORDER.indexOf(g) < 0; }))
        .filter(function (g) { return by[g]; }).map(function (g) { return { name: g, items: by[g] }; });
}

function summaryHtml(r) {
    return '<p class="section-desc">' + (lastFiles.length === 1 ? esc(lastFiles[0].name) : lastFiles.length + ' logs') + ' — ' + Math.round(r.duration) + ' s, ' +
        r.events.length + ' step' + (r.events.length === 1 ? '' : 's') + ' timed' + (lastTuneName ? ', tune ' + esc(lastTuneName) : ', no tune') + '.</p>';
}

function findingsHtml(r) {
    return groupsOf(r.findings).map(function (g) {
        return '<div class="lh-group"><h3>' + esc(g.name) + '</h3>' + g.items.map(function (f) {
            return '<div class="lh-finding ' + f.severity + '"><div class="lh-title"><span class="lh-sev">' + CL_SEV_LABEL[f.severity] + '</span>' + esc(f.title) + '</div>' +
                (f.detail ? '<div class="lh-detail">' + esc(f.detail) + '</div>' : '') + '</div>';
        }).join('') + '</div>';
    }).join('');
}

function sitesHtml(r, withButton) {
    if (!r.sites.length) return '<p class="section-desc">Choose the tune to compare with its Fuel Closed Loop Period.</p>';
    var html = '<div class="cl-scroll"><table class="cl-table"><tr><th>Exhaust flow</th><th>Table</th><th>Steps (aim / cut)</th><th>Measured median</th><th>p10–p90</th>' +
        '<th>Suggested</th><th style="text-align:left">Why</th></tr>' + r.sites.map(function (s) {
            return '<tr><td>' + s.flow + ' g/s</td><td>' + fmt(s.tableMs) + ' ms</td><td>' + s.nAim + ' / ' + s.nCut + '</td><td>' + (s.medianMs !== null ? fmt(s.medianMs) + ' ms' : '—') +
                '</td><td>' + (s.p10Ms !== null ? fmt(s.p10Ms) + '–' + fmt(s.p90Ms) : '—') + '</td><td class="' + s.action + '">' + (s.suggested !== null ? s.suggested + ' ms' : s.action) +
                '</td><td class="note">' + esc(s.note) + '</td></tr>';
        }).join('') + '</table></div>';
    if (withButton && r.sites.some(function (s) { return s.suggested !== null; })) {
        html += '<button id="copy-period" class="cl-btn">Copy Period row (suggested, else current)</button>' +
            '<p class="cl-legend">Pastes into Fuel Closed Loop Period in M1 Tune. Sites without a measurement keep their value — blend them toward the measured ones ' +
            'by hand, and re-check the trim gain after the change.</p>';
    }
    return html;
}

function eventsHtml(r, withButtons) {
    if (!r.events.length) return '<p class="section-desc">No aim steps or clean overrun cuts in ' + (lastFiles.length > 1 ? 'these logs' : 'this log') + '.</p>';
    return '<div class="cl-scroll"><table class="cl-table"><tr>' + (lastFiles.length > 1 ? '<th style="text-align:left">Log</th>' : '') +
        '<th>Time</th><th style="text-align:left">Step</th><th>Exhaust flow</th><th>rpm</th><th>kPa</th>' +
        r.bankNames.map(function (n) { return '<th>' + esc(n.replace('Exhaust Lambda ', '')) + '</th>'; }).join('') + '<th>Table</th>' + (withButtons ? '<th></th>' : '') + '</tr>' +
        r.events.map(function (e, i) {
            var m = Math.floor(e.t / 60), s = e.t - m * 60;
            return '<tr>' + (lastFiles.length > 1 ? '<td style="text-align:left">' + esc(lastFiles[e.file].name) + '</td>' : '') +
                '<td>' + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1) + '</td><td style="text-align:left">' +
                (e.source === 'aim' ? 'aim ' + (e.step > 0 ? '+' : '') + e.step.toFixed(3) + ' λ' : 'overrun cut') + '</td><td>' + fmt(e.flow, 1) + ' g/s</td><td>' + fmt(e.rpm) +
                '</td><td>' + fmt(e.kpa) + '</td>' + e.banks.map(function (b) { return '<td>' + (b !== null ? b + ' ms' : '—') + '</td>'; }).join('') +
                '<td>' + fmt(e.tableMs) + ' ms</td>' + (withButtons ? '<td><button class="cl-btn cl-show" data-i="' + i + '">Show in log</button></td>' : '') + '</tr>';
        }).join('') + '</table></div><p class="cl-legend">Delay = from the step (aim change, or the logged switch to Engine Overrun State Enabled) until lambda ' +
        'has moved a quarter of the aim step (at least 0.01 λ), or 0.1 λ lean for a cut.</p>';
}

function render() {
    var r = lastResult;
    document.getElementById('summary').innerHTML = summaryHtml(r);
    document.getElementById('findings').innerHTML = findingsHtml(r);
    document.getElementById('sites').innerHTML = sitesHtml(r, true);
    document.getElementById('events').innerHTML = eventsHtml(r, true);
    var btn = document.getElementById('copy-period');
    if (btn) btn.onclick = function () {
        var text = r.sites.map(function (s) { return String(s.suggested !== null ? s.suggested : Math.round(s.tableMs)); }).join('\t');
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); btn.textContent = 'Copied'; } catch (e) { btn.textContent = 'Copy failed'; }
        document.body.removeChild(ta);
        setTimeout(function () { btn.textContent = 'Copy Period row (suggested, else current)'; }, 1200);
    };
    var files = lastFiles, tuneName = lastTuneName, tuneId = tuneName ? tunePicker.currentId() : null;
    rsSaveControl(document.getElementById('history-save'), function () {
        return rsLogFactsMany(files).then(function (facts) {
            return Object.assign({ tool: 'cl-period', tuneId: tuneId, tuneName: tuneName, settings: { logs: files.length } }, facts, rbClPeriod(r));
        });
    });
}

document.getElementById('events').addEventListener('click', function (e) {
    var b = e.target.closest('.cl-show');
    if (b) showEvent(lastResult.events[+b.dataset.i]);
});

function showEvent(ev) {
    var el = document.getElementById('log-panel');
    if (!logPanel) logPanel = new LogPanel(el, { preset: 'fuelling', storageKey: 'cl-period', showVe: false, showTf: false });
    if (panelFile !== ev.file || !panelReady) { panelFile = ev.file; panelReady = logPanel.open(lastFiles[ev.file]); }
    panelReady.then(function () {
        return logPanel.showChannels([lastResult.bankNames.concat(['Fuel Mixture Aim']), ['Engine Overrun State']]);
    }).then(function () {
        var ends = ev.banks.filter(function (b) { return b !== null; });
        logPanel.setMarkers([{ t: ev.t, t1: ev.t + (ends.length ? Math.max.apply(null, ends) / 1000 : 0.05), label: ev.source === 'aim' ? 'aim step' : 'overrun cut',
            color: '#ff9800', fill: 'rgba(255,152,0,0.15)' }]);
        logPanel.zoomTo(Math.max(0, ev.t - 1.5), ev.t + 3);
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) { panelReady = null; showError(err.message); });
}

document.getElementById('pdf-btn').addEventListener('click', function () {
    if (!lastResult) return;
    var r = lastResult;
    prPrint({
        title: 'Closed-Loop Period', subtitle: lastFiles.map(function (f) { return f.name; }).join(', '), fileName: 'Closed-Loop Period - ' + lastFiles[0].name,
        meta: [['Logs', String(lastFiles.length)], ['Steps', String(r.events.length)], ['Tune', lastTuneName || 'none']],
        sections: [{ title: 'Findings', html: findingsHtml(r) }, { title: 'Period by Exhaust Mass Flow', html: sitesHtml(r, false) },
                   { title: 'Steps', html: eventsHtml(r, false) }]
    });
});
