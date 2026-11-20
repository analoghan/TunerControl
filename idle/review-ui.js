/**
 * idle/review-ui.js — Pull-aways and Feed Forward by Coolant Temperature on the Idle page: runs irAnalyze (idle-review.js) in
 * its own worker next to the idle worker, renders the findings and tables, and shows each finding in the embedded Log Viewer.
 *
 *   irRun(file, tune) — start a review of this log (tune = m1pkgIdle() | null)
 */

var irState = { result: null, file: null, panel: null, panelReady: null, worker: null };
var IR_SEV_LABEL = { fail: 'Fail', warn: 'Check', info: 'Note', ok: 'OK' };
var IR_UI_PA_CHANNELS = [['Engine Speed', 'Idle Aim'], ['Throttle Aim', 'Throttle Pedal', 'Throttle Position'], ['Idle State', 'Throttle Aim State'],
                         ['Vehicle Speed'], ['Ignition Timing']];     // = IR_PA_CHANNELS in idle-review.js (worker side)

function irEsc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function irFmt(v, d) { return v === null || v === undefined || isNaN(v) ? '—' : Number(v).toFixed(d === undefined ? 1 : d); }
function irClock(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }

function irCreateWorker() {
    var urls = ['../lib/ld-parser.js', '../ve-table/worker.js', '../log-viewer/log-file.js', '../log-health/health-checks.js', 'idle-review.js', 'review-worker.js']
        .map(function (u) { return JSON.stringify(new URL(u, window.location.href).href); });
    var blob = new Blob(['importScripts(' + urls.join(',') + ');'], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob), w = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
}

function irRun(file, tune) {
    var block = document.getElementById('ir-section'), status = document.getElementById('ir-status');
    if (irState.worker) irState.worker.terminate();
    block.hidden = false;
    status.textContent = 'Reviewing pull-aways and feed forward…';
    ['ir-pullaway-findings', 'ir-pullaways', 'ir-ff-findings', 'ir-ff'].forEach(function (id) { document.getElementById(id).innerHTML = ''; });
    var isCsv = /\.csv$/i.test(file.name);
    (isCsv ? file.text() : file.arrayBuffer()).then(function (data) {
        var w = irState.worker = irCreateWorker();
        w.onmessage = function (e) {
            w.terminate();
            irState.worker = null;
            if (e.data.type === 'error') { status.textContent = 'Could not review pull-aways: ' + e.data.message; return; }
            irState.result = e.data.result;
            irState.file = file;
            irState.panelReady = null;
            status.textContent = '';
            irRender();
        };
        w.onerror = function (err) { w.terminate(); irState.worker = null; status.textContent = 'The pull-away review failed: ' + (err.message || 'worker error'); };
        w.postMessage({ type: 'analyze', data: data, name: file.name, tune: tune }, isCsv ? [] : [data]);
    }).catch(function (err) { status.textContent = err.message; });
}

function irFindingsHtml(group) {
    return irState.result.findings.map(function (f, i) { return { f: f, i: i }; }).filter(function (x) { return x.f.group === group; }).map(function (x) {
        var f = x.f, canShow = (f.times && f.times.length) || (f.channels && f.channels.length);
        return '<div class="lh-finding ' + f.severity + '"><div class="lh-title"><span class="lh-sev">' + IR_SEV_LABEL[f.severity] + '</span>' + irEsc(f.title) +
            '</div>' + (f.detail ? '<div class="lh-detail">' + irEsc(f.detail) + '</div>' : '') +
            (canShow ? '<button class="lh-show" data-i="' + x.i + '">Show in log</button>' : '') + '</div>';
    }).join('');
}

function irPullAwaysHtml(list) {
    if (!list.length) return '';
    return '<table class="ff-cells ir-table"><thead><tr><th>Moved off</th><th class="num">Coolant</th><th class="num">Top speed</th><th class="num">Idle rpm</th>' +
        '<th class="num">Lowest rpm</th><th>Outcome</th><th class="num">Pedal held at idle opening</th><th class="num">Throttle at the low point</th>' +
        '<th class="num">Timing (median)</th><th></th></tr></thead><tbody>' + list.map(function (p, i) {
            var cls = p.outcome === 'clean' ? '' : p.outcome === 'dip' ? 'ir-dip' : 'ir-bad';
            return '<tr class="' + cls + '"><td>' + irClock(p.t) + '</td><td class="num">' + irFmt(p.coolant, 0) + ' °C</td><td class="num">' + irFmt(p.topSpeed, 0) +
                ' km/h</td><td class="num">' + irFmt(p.idleRpm, 0) + '</td><td class="num">' + irFmt(p.minRpm, 0) + '</td><td>' + p.outcome + '</td><td class="num">' +
                (p.deadBandS >= 0.2 ? irFmt(p.deadBandS) + ' s' + (p.deadBandDrop >= 100 ? ', −' + irFmt(p.deadBandDrop, 0) + ' rpm' : '') : '—') + '</td><td class="num">' +
                (p.throttleAtMin !== null ? irFmt(p.throttleAtMin) + ' %' + (p.idleOpeningAtMin !== null ? ' <small>(idle ' + irFmt(p.idleOpeningAtMin) + ')</small>' : '') : '—') +
                '</td><td class="num">' + (p.timing !== null ? irFmt(p.timing) + '°' : '—') + '</td><td><button class="lh-show ir-show-pa" data-p="' + i + '">Show</button></td></tr>';
        }).join('') + '</tbody></table><p class="ir-legend">Throttle at the low point: Throttle Aim in the 0.5 s before the lowest engine speed, with the idle feed forward ' +
        'opening it can\'t go below. Timing: Ignition Timing under 1500 rpm with idle control off.</p>';
}

function irFfHtml(rows) {
    if (!rows.length) return '';
    var withCells = rows.some(function (r) { return r.cells.length; });
    return '<table class="ff-cells ir-table"><thead><tr><th>Coolant</th><th class="num">Data</th><th class="num">Median coolant</th><th class="num">Feed forward</th>' +
        '<th class="num">Mass Flow − Feed Forward</th><th class="num">Post start</th>' + (withCells ? '<th>Feed Forward Main cells (current → suggested)</th>' : '') +
        '</tr></thead><tbody>' + rows.map(function (r) {
            return '<tr class="' + (r.suggest ? (Math.abs(r.delta) >= 3 ? 'ir-bad' : 'ir-dip') : '') + '"><td>' + irEsc(r.label) + '</td><td class="num">' + irFmt(r.seconds, 0) +
                ' s</td><td class="num">' + irFmt(r.coolantMedian, 0) + ' °C</td><td class="num">' + irFmt(r.ff) + ' %</td><td class="num">' + (r.delta >= 0 ? '+' : '') +
                irFmt(r.delta) + ' %</td><td class="num">' + (r.postStart > 0.05 ? irFmt(r.postStart) + ' %' : '—') + '</td>' + (withCells ? '<td>' + (r.suggest ? r.cells.map(function (k) {
                    return Math.round(k.aim) + ' rpm: ' + irFmt(k.value) + ' → ' + irFmt(k.suggested);
                }).join(', ') : r.seconds < 20 ? 'not enough data' : 'within 1.5 %') + '</td>' : '') + '</tr>';
        }).join('') + '</tbody></table>';
}

function irRender() {
    var r = irState.result;
    document.getElementById('ir-pullaway-findings').innerHTML = irFindingsHtml('Pull-aways');
    document.getElementById('ir-pullaways').innerHTML = irPullAwaysHtml(r.pullAways);
    document.getElementById('ir-ff-findings').innerHTML = irFindingsHtml('Feed forward');
    document.getElementById('ir-ff').innerHTML = irFfHtml(r.ffRows);
}

function irShow(channels, times, label, zoom) {
    var el = document.getElementById('ir-log-panel');
    el.parentElement.hidden = false;
    if (!irState.panel) irState.panel = new LogPanel(el, { preset: 'fuelling', storageKey: 'idle-review', showVe: false, showTf: false });
    if (!irState.panelReady) irState.panelReady = irState.panel.open(irState.file);
    irState.panelReady.then(function () {
        return channels && channels.length ? irState.panel.showChannels(channels) : null;
    }).then(function () {
        irState.panel.setMarkers((times || []).map(function (t) { return { t: t[0], t1: t[1], label: label, color: '#ff9800', fill: 'rgba(255,152,0,0.15)' }; }));
        if (zoom) irState.panel.zoomTo(Math.max(0, zoom[0]), zoom[1]);
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) { irState.panelReady = null; document.getElementById('ir-status').textContent = err.message; });
}

document.getElementById('ir-section').addEventListener('click', function (e) {
    var b = e.target.closest('.lh-show');
    if (!b || !irState.result) return;
    if (b.dataset.p !== undefined) {
        var p = irState.result.pullAways[+b.dataset.p];
        irShow(IR_UI_PA_CHANNELS,[[p.takeUp, p.t]].concat(p.deadBandEps), 'Pull-away ' + irClock(p.t), [p.from - 1, p.to + 1]);
        return;
    }
    var f = irState.result.findings[+b.dataset.i], t = f.times && f.times[0];
    irShow(f.channels, f.times, f.title, t ? [t[0] - Math.max(3, (t[1] - t[0]) * 0.5), t[1] + Math.max(3, (t[1] - t[0]) * 0.5)] : null);
});
