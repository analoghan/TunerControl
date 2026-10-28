/**
 * pulls/app.js — UI for the Pull Report: pick one or more logs (and optionally the tune, for Knock Threshold), find the pulls in a
 * worker (pull-analysis.js) and show the findings, a table of pulls and the selected pull's flags and numbers with the log.
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorBox = document.getElementById('error-container');
var progress = document.getElementById('progress');
var resultsSection = document.getElementById('results-section');

var logFiles = [], tuneKnock = null;
var lastResult = null, lastFiles = [], lastTuneName = null, selected = -1;
var logPanel = null, panelFile = -1, panelReady = null;

var PU_GROUP_ORDER = ['Log', 'Pulls', 'Across pulls'];
var PU_SEV_LABEL = { fail: 'Fail', warn: 'Check', info: 'Note', ok: 'OK' };
var PU_SEV_RANK = { fail: 0, warn: 1, info: 2, ok: 3 };

function showError(msg) { errorBox.textContent = msg || ''; errorBox.hidden = !msg; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fmt(v, d) { return v === null || v === undefined || isNaN(v) ? '—' : Number(v).toFixed(d === undefined ? 0 : d); }
function clock(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
function updateButton() { analyzeBtn.disabled = !logFiles.length; }

var tunePicker = tsPicker({
    pkgInput: document.getElementById('pkg-input'), select: document.getElementById('tune-select'), row: document.getElementById('tune-row'),
    hint: document.getElementById('tune-hint'), status: document.getElementById('tune-status'), extract: m1pkgKnock, what: 'the knock threshold',
    none: 'No tune chosen: knock levels are shown without the threshold. Choose the tune that ran the logs to judge knock.',
    describe: function (t) {
        return t.threshold ? 'Knock Threshold ' + t.threshold.values[0].map(function (v) { return Math.round(v); }).join(' / ') + ' % over ' +
            t.threshold.rpm[0] + '–' + t.threshold.rpm[t.threshold.rpm.length - 1] + ' rpm.' : 'This tune has no Knock Threshold table.';
    },
    onError: showError,
    onChange: function (t) { tuneKnock = t; }
});

logInput.addEventListener('change', function () {
    logFiles = Array.prototype.slice.call(logInput.files || []);
    resultsSection.hidden = true;
    showError('');
    if (logFiles.length) tunePicker.suggest(logFiles[0]);
    updateButton();
});

function createWorker() {
    var urls = ['../lib/ld-parser.js', '../ve-table/worker.js', '../log-viewer/log-file.js', '../log-health/health-checks.js', 'pull-analysis.js', 'worker.js']
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
            if (e.data.type === 'error') { showError('Could not find the pulls: ' + e.data.message); return; }
            lastResult = e.data.result;
            lastFiles = files;
            lastTuneName = tuneKnock ? tuneKnock.tuneName : null;
            selected = -1;
            panelFile = -1;
            render();
            resultsSection.hidden = false;
        };
        w.onerror = function (err) { w.terminate(); progress.hidden = true; updateButton(); showError('The analysis failed: ' + (err.message || 'worker error')); };
        var tune = tuneKnock ? { tuneName: tuneKnock.tuneName, threshold: tuneKnock.threshold } : null;
        w.postMessage({ type: 'analyze', logs: datas.map(function (d, i) { return { data: d, name: files[i].name }; }), tune: tune },
            datas.filter(function (d) { return typeof d !== 'string'; }));
    }).catch(function (err) { progress.hidden = true; updateButton(); showError(err.message); });
});

// ---------------------------------------------------------------------------
// Rendering (each part returns HTML so the PDF report reuses it)
// ---------------------------------------------------------------------------

function findingsHtml(r) {
    var by = {};
    r.findings.forEach(function (f) { (by[f.group] = by[f.group] || []).push(f); });
    return PU_GROUP_ORDER.concat(Object.keys(by).filter(function (g) { return PU_GROUP_ORDER.indexOf(g) < 0; })).filter(function (g) { return by[g]; }).map(function (g) {
        return '<div class="lh-group"><h3>' + esc(g) + '</h3>' + by[g].map(function (f) {
            return '<div class="lh-finding ' + f.severity + '"><div class="lh-title"><span class="lh-sev">' + PU_SEV_LABEL[f.severity] + '</span>' + esc(f.title) + '</div>' +
                (f.detail ? '<div class="lh-detail">' + esc(f.detail) + '</div>' : '') + '</div>';
        }).join('') + '</div>';
    }).join('');
}

function worstOf(p) {
    return p.flags.reduce(function (a, f) { return PU_SEV_RANK[f.severity] < PU_SEV_RANK[a] ? f.severity : a; }, 'ok');
}

function lambdaCell(p, b) {
    var m = p.metrics, d = m.lambda && m.lambda[b];
    if (!d) return '<td>—</td>';
    var cls = d.lean > 0.05 ? 'fail' : d.lean > 0.03 ? 'warn' : '';
    return '<td class="' + cls + '" title="median ' + fmt(d.median, 3) + ', most lean vs aim ' + fmt(d.lean, 3) + ' λ">' + fmt(d.median, 3) + '</td>';
}

function pullsHtml(r, withButtons) {
    if (!r.pulls.length) return '<p class="section-desc">No pulls.</p>';
    var multi = lastFiles.length > 1;
    var html = '<div class="pu-scroll"><table class="pu-table"><tr><th>#</th>' + (multi ? '<th>Log</th>' : '') + '<th>Time</th><th>Length</th><th>Gear</th><th>rpm</th>' +
        '<th>MAP max</th><th>Pedal</th><th>Aim λ</th><th>Bank 1 λ</th><th>Bank 2 λ</th><th>Trims</th><th>Knock max</th><th>Timing min</th><th>Inlet air</th>' +
        '<th>Rail under</th><th>Low side</th><th>Duty</th><th>Flags</th>' + (withButtons ? '<th></th>' : '') + '</tr>';
    r.pulls.forEach(function (p, i) {
        var m = p.metrics, worst = worstOf(p), kn = m.knock && m.knock.length ? m.knock.reduce(function (a, x) { return (x.pctOfThreshold || x.peak) > (a.pctOfThreshold || a.peak) ? x : a; }) : null;
        var knTxt = !kn ? '—' : kn.pctOfThreshold !== null ? Math.round(kn.pctOfThreshold) + ' % (cyl ' + kn.cylinder + ')' : fmt(kn.peak, 1) + ' (cyl ' + kn.cylinder + ')';
        var knCls = kn && kn.pctOfThreshold >= 100 ? 'fail' : kn && kn.pctOfThreshold >= 80 ? 'warn' : '';
        var nFlags = p.flags.filter(function (f) { return f.severity !== 'info'; }).length;
        html += '<tr' + (i === selected ? ' class="sel"' : '') + '><td>' + (i + 1) + '</td>' + (multi ? '<td style="text-align:left">' + esc(lastFiles[p.file].name) + '</td>' : '') +
            '<td>' + clock(p.t0) + '</td><td>' + p.seconds.toFixed(1) + ' s</td><td>' + (p.gear !== null ? p.gear : '—') + '</td><td>' + p.rpm[0] + '–' + p.rpmMax + '</td>' +
            '<td>' + fmt(p.mapMax) + ' kPa</td><td>' + fmt(p.pedal) + ' %</td><td>' + fmt(m.aim, 3) + '</td>' + lambdaCell(p, 0) + lambdaCell(p, 1) +
            '<td>' + (m.trims ? m.trims.map(function (x) { return fmt(x, 1); }).join(' / ') + ' %' : '—') + '</td><td class="' + knCls + '">' + knTxt + '</td>' +
            '<td>' + (m.timing ? fmt(m.timing.min, 1) + '°' : '—') + '</td><td>' + (m.iat ? fmt(m.iat.start) + '→' + fmt(m.iat.max) + ' °C' : '—') + '</td>' +
            '<td>' + (m.rail && m.rail.worstUnder !== null ? fmt(Math.max(0, -m.rail.worstUnder)) + ' bar' : '—') + '</td>' +
            '<td>' + (m.low ? fmt(m.low.min) + ' kPa' + (m.low.pump2 ? ' · P2' : '') : '—') + '</td><td>' + (m.dutyMax !== undefined ? fmt(m.dutyMax) + ' %' : '—') + '</td>' +
            '<td class="' + (worst === 'fail' || worst === 'warn' ? worst : '') + '">' + (nFlags ? nFlags : '—') + '</td>' +
            (withButtons ? '<td><button class="pu-btn pu-show" data-i="' + i + '">Show</button></td>' : '') + '</tr>';
    });
    return html + '</table></div><p class="pu-legend">Lambda: median past the first 0.5 s, compared with the aim 0.3 s earlier (orange / red: held 0.03 / 0.05 λ ' +
        'leaner than aim). Knock: loudest cylinder against Knock Threshold. Rail under: most under aim held 0.2 s. Low side: lowest held 0.2 s; P2 = Fuel Pump 2 on.</p>';
}

function detailHtml(p) {
    var m = p.metrics, items = [];
    function it(label, v) { if (v !== null && v !== undefined && v !== '') items.push('<div>' + esc(label) + ': <b>' + v + '</b></div>'); }
    it('Throttle position max', m.throttleMax !== undefined ? fmt(m.throttleMax) + ' %' : null);
    if (m.timing) it('Ignition timing', fmt(m.timing.min, 1) + '° min, ' + fmt(m.timing.median, 1) + '° median');
    if (m.knock && m.knock.length) it('Knock (peak, % of threshold)', m.knock.map(function (x) { return x.cylinder + ': ' + (x.pctOfThreshold !== null ? Math.round(x.pctOfThreshold) + '%' : fmt(x.peak, 1)); }).join(', '));
    if (m.knockTrim) it('Knock trim (min)', m.knockTrim.map(function (x) { return x.cylinder + ': ' + fmt(x.min, 1) + '°'; }).join(', '));
    if (m.iat) it('Inlet air', fmt(m.iat.start) + ' → ' + fmt(m.iat.end) + ' °C (max ' + fmt(m.iat.max) + ')');
    it('Charge temperature max', m.chargeMax !== undefined ? fmt(m.chargeMax) + ' °C' : null);
    it('Coolant max', m.coolantMax !== undefined ? fmt(m.coolantMax, 1) + ' °C' : null);
    if (m.rail) it('Rail pressure', 'aim up to ' + fmt(m.rail.aimMax) + ' bar, lowest ' + fmt(m.rail.min) + ' bar' + (m.rail.controlMax !== null ? ', pump control ≤ ' + fmt(m.rail.controlMax) + ' %' : ''));
    if (m.low) it('Low-side pressure', fmt(m.low.before) + ' kPa before → ' + fmt(m.low.min) + ' kPa lowest' + (m.low.pump2 === null ? '' : m.low.pump2 ? ', Pump 2 on' : ', Pump 2 off'));
    it('Injector duty max', m.dutyMax !== undefined ? fmt(m.dutyMax) + ' %' : null);
    it('Pulse width max (cyl 1)', m.pwMax !== undefined ? fmt(m.pwMax, 2) + ' ms' : null);
    it('Fuel flow max', m.flowMax !== undefined ? fmt(m.flowMax) + ' ml/min' : null);
    it('Battery min', m.battMin !== undefined && m.battMin !== null ? fmt(m.battMin, 1) + ' V' : null);
    it('Injector supply min', m.injVMin !== undefined && m.injVMin !== null ? fmt(m.injVMin, 1) + ' V' : null);
    if (m.oil) it('Oil pressure', fmt(m.oil.min) + ' kPa min; tightest ' + fmt(m.oil.worst.kpa) + ' kPa at ' + fmt(m.oil.worst.rpm) + ' rpm');
    it('Oil temperature max', m.oilTempMax !== undefined ? fmt(m.oilTempMax) + ' °C' : null);
    var flags = p.flags.slice().sort(function (a, b) { return PU_SEV_RANK[a.severity] - PU_SEV_RANK[b.severity]; });
    return '<div class="pu-flags">' + (flags.length ? flags.map(function (f) {
        return '<div class="lh-finding ' + f.severity + '"><div class="lh-title"><span class="lh-sev">' + PU_SEV_LABEL[f.severity] + '</span>' + esc(f.text) + '</div></div>';
    }).join('') : '<div class="lh-finding ok"><div class="lh-title"><span class="lh-sev">OK</span>Nothing flagged</div></div>') + '</div><div class="pu-metrics">' + items.join('') + '</div>';
}

function pullTitle(p, i) {
    return 'Pull ' + (i + 1) + ' — ' + (lastFiles.length > 1 ? lastFiles[p.file].name + ', ' : '') + clock(p.t0) + ', ' + p.seconds.toFixed(1) + ' s' +
        (p.gear !== null ? ', gear ' + p.gear : '') + ', ' + p.rpm[0] + '–' + p.rpmMax + ' rpm';
}

function render() {
    var r = lastResult;
    document.getElementById('summary').innerHTML = '<p class="section-desc">' + (lastFiles.length === 1 ? esc(lastFiles[0].name) : lastFiles.length + ' logs') + ' — ' +
        r.pulls.length + ' pull' + (r.pulls.length === 1 ? '' : 's') + (lastTuneName ? ', knock threshold from ' + esc(lastTuneName) : ', no tune') + '.</p>';
    document.getElementById('findings').innerHTML = findingsHtml(r);
    document.getElementById('pulls').innerHTML = pullsHtml(r, true);
}

document.getElementById('pulls').addEventListener('click', function (e) {
    var b = e.target.closest('.pu-show');
    if (!b) return;
    selected = +b.dataset.i;
    document.getElementById('pulls').innerHTML = pullsHtml(lastResult, true);
    showPull(lastResult.pulls[selected], selected);
});

function showPull(p, i) {
    var block = document.getElementById('detail-block'), el = document.getElementById('log-panel');
    block.hidden = false;
    document.getElementById('detail-title').textContent = pullTitle(p, i);
    document.getElementById('detail').innerHTML = detailHtml(p);
    if (!logPanel) logPanel = new LogPanel(el, { preset: 'fuelling', storageKey: 'pulls', showVe: false, showTf: false });
    if (panelFile !== p.file || !panelReady) { panelFile = p.file; panelReady = logPanel.open(lastFiles[p.file]); }
    var kn = p.metrics.knock && p.metrics.knock.length ? p.metrics.knock.reduce(function (a, x) { return (x.pctOfThreshold || x.peak) > (a.pctOfThreshold || a.peak) ? x : a; }) : null;
    panelReady.then(function () {
        return logPanel.showChannels([['Engine Speed'], ['Inlet Manifold Pressure', 'Throttle Pedal'], ['Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Fuel Mixture Aim'],
            ['Fuel Pressure Direct Bank 1', 'Fuel Pressure Direct Bank 1 Aim'], ['Ignition Timing'].concat(kn ? ['Ignition Cylinder ' + kn.cylinder + ' Knock Level'] : [])]);
    }).then(function () {
        logPanel.setMarkers([{ t: p.t0, t1: p.t1, label: 'pull ' + (i + 1), color: '#ff9800', fill: 'rgba(255,152,0,0.12)' }]);
        logPanel.zoomTo(Math.max(0, p.t0 - 2), p.t1 + 2);
        block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) { panelReady = null; showError(err.message); });
}

document.getElementById('pdf-btn').addEventListener('click', function () {
    if (!lastResult) return;
    var r = lastResult;
    prPrint({
        title: 'Pull Report', subtitle: lastFiles.map(function (f) { return f.name; }).join(', '), fileName: 'Pull Report - ' + lastFiles[0].name, landscape: true,
        meta: [['Logs', String(lastFiles.length)], ['Pulls', String(r.pulls.length)], ['Tune', lastTuneName || 'none']],
        sections: [{ title: 'Findings', html: findingsHtml(r) }, { title: 'Pulls', html: pullsHtml(r, false) }].concat(r.pulls.map(function (p, i) {
            return { title: pullTitle(p, i), html: detailHtml(p) };
        }))
    });
});
