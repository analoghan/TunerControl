/**
 * transmission/app.js — UI controller for the Transmission Shift Analyzer.
 */

var logInput = document.getElementById('log-input');
var adxInput = document.getElementById('adx-input');
var binInput = document.getElementById('bin-input');
var xdfInput = document.getElementById('xdf-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorContainer = document.getElementById('error-container');
var progressSection = document.getElementById('progress-section');
var progressBar = document.getElementById('progress-bar');
var progressPct = document.getElementById('progress-pct');
var progressPhase = document.getElementById('progress-phase');
var resultsSection = document.getElementById('results-section');

var selectedFile = null;
var selectedAdxFile = null;
var selectedBinFile = null;
var selectedXdfFile = null;
var worker = null;

// ---------------------------------------------------------------------------
// File Input
// ---------------------------------------------------------------------------

logInput.addEventListener('change', function() {
    var file = logInput.files[0] || null;
    if (file) {
        var ext = file.name.toLowerCase().split('.').pop();
        if (ext === 'csv' || ext === 'xdl') {
            selectedFile = file;
            errorContainer.hidden = true;
            updateAnalyzeButton();
        } else {
            selectedFile = null;
            analyzeBtn.disabled = true;
            showError('Please select a .csv or .xdl log file');
        }
    } else {
        selectedFile = null;
        analyzeBtn.disabled = true;
    }
});

if (adxInput) {
    adxInput.addEventListener('change', function() {
        var file = adxInput.files[0] || null;
        if (file && file.name.toLowerCase().endsWith('.adx')) {
            selectedAdxFile = file;
            errorContainer.hidden = true;
        } else {
            selectedAdxFile = null;
            if (file) showError('Please select an .adx channel definition file');
        }
        updateAnalyzeButton();
    });
}

if (binInput) {
    binInput.addEventListener('change', function() {
        var file = binInput.files[0] || null;
        if (file && file.name.toLowerCase().endsWith('.bin')) {
            selectedBinFile = file;
            errorContainer.hidden = true;
        } else {
            selectedBinFile = null;
            if (file) showError('Please select a .bin config file');
        }
        updateAnalyzeButton();
    });
}

if (xdfInput) {
    xdfInput.addEventListener('change', function() {
        var file = xdfInput.files[0] || null;
        if (file && file.name.toLowerCase().endsWith('.xdf')) {
            selectedXdfFile = file;
            errorContainer.hidden = true;
        } else {
            selectedXdfFile = null;
            if (file) showError('Please select an .xdf definition file');
        }
        updateAnalyzeButton();
    });
}

function updateAnalyzeButton() {
    if (!selectedFile) { analyzeBtn.disabled = true; return; }
    var ext = selectedFile.name.toLowerCase().split('.').pop();
    if (ext === 'csv') {
        // CSV needs no companion files (bin+xdf optional)
        analyzeBtn.disabled = false;
    } else if (ext === 'xdl') {
        // XDL requires ADX (bin+xdf optional)
        analyzeBtn.disabled = !selectedAdxFile;
    } else {
        analyzeBtn.disabled = true;
    }
    // Bin requires XDF (but both are optional for analysis)
    // No additional gating needed — bin is always optional
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

analyzeBtn.addEventListener('click', function() {
    if (!selectedFile) return;

    analyzeBtn.disabled = true;
    errorContainer.hidden = true;
    resultsSection.hidden = true;
    progressSection.hidden = false;
    progressBar.style.width = '0%';
    progressPct.textContent = '0%';
    progressPhase.textContent = '';

    var ext = selectedFile.name.toLowerCase().split('.').pop();
    var hasBin = selectedBinFile && selectedXdfFile;

    // Collect all files needed
    var filesToRead = [];
    var fileResults = {};

    // Always read the log file
    if (ext === 'xdl') {
        filesToRead.push({ key: 'xdl', file: selectedFile, mode: 'binary' });
        filesToRead.push({ key: 'adx', file: selectedAdxFile, mode: 'text' });
    } else {
        filesToRead.push({ key: 'csv', file: selectedFile, mode: 'text' });
    }

    // Optionally read bin + xdf
    if (hasBin) {
        filesToRead.push({ key: 'bin', file: selectedBinFile, mode: 'binary' });
        filesToRead.push({ key: 'xdf', file: selectedXdfFile, mode: 'text' });
    }

    // Read all files then start worker
    var remaining = filesToRead.length;
    var readError = false;

    filesToRead.forEach(function(item) {
        var reader = new FileReader();
        reader.onload = function() {
            fileResults[item.key] = reader.result;
            remaining--;
            if (remaining === 0 && !readError) startAnalysis(ext, hasBin, fileResults);
        };
        reader.onerror = function() {
            readError = true;
            progressSection.hidden = true;
            showError('Could not read file: ' + item.file.name);
            analyzeBtn.disabled = false;
        };
        if (item.mode === 'binary') {
            reader.readAsArrayBuffer(item.file);
        } else {
            reader.readAsText(item.file);
        }
    });
});

function startAnalysis(ext, hasBin, files) {
    if (worker) { worker.terminate(); worker = null; }
    var scripts = ['xdl-parser.js', 'bin-reader.js', 'shift-analysis.js', 'worker.js'].map(function (f) { return new URL(f, window.location.href).href; });
    var blob = new Blob(['importScripts(' + scripts.map(function (s) { return JSON.stringify(s); }).join(',') + ');'], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    attachWorkerHandlers(worker);
    var msg = { type: 'analyze' }, transfer = [];
    if (ext === 'xdl') { msg.xdlBuffer = files.xdl; msg.adxText = files.adx; transfer.push(files.xdl); }
    else msg.logText = files.csv;
    if (hasBin) { msg.binBuffer = files.bin; msg.xdfText = files.xdf; transfer.push(files.bin); }
    worker.postMessage(msg, transfer);
}

function attachWorkerHandlers(w) {
    w.onmessage = function (e) {
        var msg = e.data;
        if (!msg) return;
        if (msg.type === 'progress') {
            progressBar.style.width = msg.percent + '%';
            progressPct.textContent = msg.percent + '%';
            progressPhase.textContent = msg.phase || '';
        } else if (msg.type === 'error') {
            progressSection.hidden = true;
            showError(msg.message);
            analyzeBtn.disabled = false;
        } else if (msg.type === 'result') {
            progressSection.hidden = true;
            renderResults(msg);
            analyzeBtn.disabled = false;
        }
    };
    w.onerror = function (e) {
        progressSection.hidden = true;
        showError('An unexpected error occurred during analysis' + (e && e.message ? ': ' + e.message : '.'));
        analyzeBtn.disabled = false;
    };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

var current = null;      // last result message
var shiftFilter = 'all';
var KIND_LABELS = { power: 'Power', light: 'Light throttle', coast: 'Coast', brake: 'Braking' };

function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function num(v, digits, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '<span class="muted">—</span>';
    return esc((digits === undefined ? v : Number(v).toFixed(digits)) + (unit ? ' ' + unit : ''));
}

function table(headers, rows, cls) {
    return '<table class="shift-table' + (cls ? ' ' + cls : '') + '"><thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
}

function renderResults(msg) {
    current = msg;
    resultsSection.hidden = false;
    var a = msg.analysis;
    renderFindings(a.findings, a.notes);
    renderSummary(a, msg);
    renderTransitions(a);
    renderShifts();
    renderClutches(a.clutches);
    renderAdaptation(a.adaptation, msg.bin);
    renderBin(msg.bin, a);
    renderMethod(a.limits);
    $('shift-chart').hidden = true;
}

function $(id) { return document.getElementById(id); }

function renderFindings(findings, notes) {
    $('findings-content').innerHTML = findings.map(function (f) {
        return '<div class="diagnostic diagnostic-' + esc(f.severity) + '"><p class="finding-title">' + esc(f.title) + '</p><p class="finding-text">' + esc(f.text) + '</p>' +
            (f.action ? '<p class="finding-action">→ ' + esc(f.action) + '</p>' : '') + '</div>';
    }).join('') + (notes || []).map(function (n) { return '<div class="diagnostic diagnostic-info">' + esc(n) + '</div>'; }).join('');
}

function stat(value, label) {
    return '<div class="summary-stat"><span class="stat-value">' + value + '</span><span class="stat-label">' + esc(label) + '</span></div>';
}

/** "27–40 °C", or "31 °C" when both ends are the same. */
function rangeText(r, unit) { return r ? (r[0] === r[1] ? r[0] : r[0] + '–' + r[1]) + ' ' + unit : '—'; }

function renderSummary(a, msg) {
    var s = a.summary, oil = s.oilAtShifts;
    var start = msg.bin && msg.bin.settings.startGear ? msg.bin.settings.startGear : null;
    var same = start && start.every(function (g) { return g === start[0]; });
    var startText = start ? (same ? String(start[0]) : start.join(' / ')) : '';
    var startLabel = 'Start gear (bin)' + (same && start[0] === 2 ? ' — 1st not used' : '');
    $('summary-content').innerHTML = '<div class="summary-grid">' + stat(s.shifts, 'Shifts') + stat(s.upshifts, 'Upshifts') + stat(s.downshifts, 'Downshifts') +
        stat(esc(Math.round(s.duration) + ' s'), 'Log length') + stat(esc(rangeText(oil, '°C')), 'Oil at the shifts') +
        stat(esc(s.gearsUsed.join(', ')), 'Gears used') + (startText ? stat(esc(startText), startLabel) : '') + '</div>' +
        '<p class="section-desc">' + esc((msg.log.date ? 'Recorded ' + msg.log.date + '. ' : '') + msg.log.rows.toLocaleString() + ' rows, ' + msg.log.channels + ' channels.' +
            (s.cancelled ? ' ' + s.cancelled + ' shift request' + (s.cancelled === 1 ? ' was' : 's were') + ' cancelled before the gear changed.' : '') +
            (s.incomplete ? ' ' + s.incomplete + ' request' + (s.incomplete === 1 ? '' : 's') + ' didn’t complete within 5 s.' : '') +
            (s.lowSpeed ? ' ' + s.lowSpeed + ' shift' + (s.lowSpeed === 1 ? ' was' : 's were') + ' too slow (output under 150 rpm) to measure the ratio.' : '')) + '</p>' +
        '<p class="section-desc">Gear ratios: ' + Object.keys(a.ratios.ratios).map(function (g) {
            return esc(g + ' ' + a.ratios.ratios[g] + (a.ratios.source[g] === 'log' ? '' : ' (' + a.ratios.source[g] + ')'));
        }).join(' · ') + ' — measured from this log unless marked.</p>';
}

function renderTransitions(a) {
    $('transition-content').innerHTML = a.transitions.length ? table(['Shift', 'Count', 'Applies / releases', 'Delay', 'Ratio change', 'Total', 'TCU shift time', 'Flare',
        'Sag', 'Bump', 'Oil', 'Blip', 'Type'], a.transitions.map(function (t) {
        var flare = t.flareMax && t.flareMax[1] >= a.limits.flareRpm ? ' class="flag"' : '';
        var bump = t.bump !== null && t.bump >= a.limits.bumpG ? ' class="flag"' : '';
        return '<tr><td><b>' + t.from + '→' + t.to + '</b></td><td>' + t.count + '</td><td>' + esc(t.applying + ' / ' + t.releasing) + '</td><td>' + num(t.delay, 2, 's') +
            '</td><td>' + num(t.ratioChange, 2, 's') + '</td><td>' + num(t.total, 2, 's') + '</td><td>' + num(t.tcuShiftTime, 0, 'ms') + '</td><td' + flare + '>' +
            num(t.flare, 0, 'rpm') + (t.flareMax && t.flareMax[1] > (t.flare || 0) ? ' <span class="muted">(max ' + t.flareMax[1] + ')</span>' : '') + '</td><td>' + num(t.sag, 2, 'g') +
            '</td><td' + bump + '>' + num(t.bump, 2, 'g') + '</td><td>' + esc(rangeText(t.oil, '°C')) + '</td><td>' + (t.up ? '<span class="muted">—</span>' : t.blips + '/' + t.count) +
            '</td><td class="left">' + esc(Object.keys(t.kinds).map(function (k) { return t.kinds[k] + ' ' + (KIND_LABELS[k] || k).toLowerCase(); }).join(', ')) + '</td></tr>';
    })) : '<p class="muted">No shifts found.</p>';
}

function renderShifts() {
    var a = current.analysis, list = a.shifts.map(function (s, i) { return [s, i]; }).filter(function (p) {
        return shiftFilter === 'all' || (shiftFilter === 'up' ? p[0].up : !p[0].up);
    });
    $('shift-content').innerHTML = list.length ? table(['Time', 'Shift', 'Type', 'Oil', 'TPS', 'Torque', 'Engine', 'Delay', 'Ratio change', 'Total', 'TCU', 'Flare', 'Sag',
        'Bump', 'Blip', 'TQ cut', 'Adapt.'], list.map(function (p) {
        var s = p[0];
        return '<tr class="clickable" data-shift="' + p[1] + '"><td>' + num(s.tReq, 1, 's') + '</td><td><b>' + s.from + '→' + s.to + '</b></td><td class="left">' +
            esc(KIND_LABELS[s.kind] || s.kind) + '</td><td>' + num(s.oil, 0, '°C') + '</td><td>' + num(s.tps, 0, '%') + '</td><td>' + num(s.torque, 0, 'Nm') + '</td><td>' +
            num(s.rpm, 0) + '</td><td>' + num(s.delay, 2) + '</td><td>' + num(s.ratioChange, 2) + '</td><td>' + num(s.total, 2) + '</td><td>' + num(s.tcuShiftTime, 0) +
            '</td><td' + (s.flare >= a.limits.flareRpm ? ' class="flag"' : '') + '>' + num(s.flare, 0) + '</td><td>' + num(s.sag, 2) + '</td><td' +
            (s.bump >= a.limits.bumpG ? ' class="flag"' : '') + '>' + num(s.bump, 2) + '</td><td>' + (s.up ? '' : s.blip ? 'Yes' : 'No') + '</td><td>' +
            (s.tqCut === null ? '' : s.tqCut ? 'Yes' : 'No') + '</td><td title="' + esc(TSA_ADAPT_CODES[s.adaptCode] || '') + '">' + num(s.adaptCode, 0) + '</td></tr>';
    })) + '<p class="section-desc">Times in s, engine speed in rpm, flare in rpm, sag and bump in g. Adapt. = Adaptation Activation Parameter (hover for its meaning).</p>'
        : '<p class="muted">No shifts.</p>';
}

/** One shift as an SVG: speeds (input, engine, the old and new gears' speeds from Output RPM) and acceleration, with the phase markers. */
function shiftChartSvg(s) {
    var tr = s.trace, W = 900, H1 = 220, H2 = 110, L = 52, R = 12, T = 10, gap = 26, n = tr.t.length;
    if (!n) return '';
    var t0 = tr.t[0], t1 = tr.t[n - 1], x = function (t) { return L + (t - t0) / ((t1 - t0) || 1) * (W - L - R); };
    var speeds = [];
    for (var i = 0; i < n; i++) [tr.input[i], tr.engine[i], tr.output[i] * tr.rFrom, tr.output[i] * tr.rTo].forEach(function (v) { if (isFinite(v) && v !== null) speeds.push(v); });
    var sMin = Math.max(0, Math.min.apply(null, speeds) - 100), sMax = Math.max.apply(null, speeds) + 100;
    var y1 = function (v) { return T + H1 - (v - sMin) / ((sMax - sMin) || 1) * H1; };
    var acc = tr.acc.filter(function (v) { return v !== null && isFinite(v); }), aMin = Math.min.apply(null, acc.concat([-0.05])), aMax = Math.max.apply(null, acc.concat([0.05]));
    var top2 = T + H1 + gap, y2 = function (v) { return top2 + H2 - (v - aMin) / ((aMax - aMin) || 1) * H2; };
    function line(vals, yf, color, dash) {
        var d = '', pen = false;
        for (var k = 0; k < n; k++) {
            var v = vals[k];
            if (v === null || !isFinite(v)) { pen = false; continue; }
            d += (pen ? 'L' : 'M') + x(tr.t[k]).toFixed(1) + ',' + yf(v).toFixed(1);
            pen = true;
        }
        return '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6"' + (dash ? ' stroke-dasharray="5 4"' : '') + '/>';
    }
    var fromSpd = tr.output.map(function (o) { return o * tr.rFrom; }), toSpd = tr.output.map(function (o) { return o * tr.rTo; });
    var marks = [[0, 'Request', '#bbb'], [s.tMove !== null ? s.tMove - s.tReq : null, 'Ratio moves', '#ff9800'], [s.tSync !== null ? s.tSync - s.tReq : null, 'New ratio', '#4caf50'],
        [s.tEnd - s.tReq, 'Gear', '#036ffc']].filter(function (m) { return m[0] !== null; });
    var svg = '<svg viewBox="0 0 ' + W + ' ' + (top2 + H2 + 24) + '" role="img" aria-label="Shift chart">';
    [sMin, (sMin + sMax) / 2, sMax].forEach(function (v) {
        svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y1(v) + '" y2="' + y1(v) + '" stroke="#262626"/><text x="' + (L - 6) + '" y="' + (y1(v) + 4) + '" fill="#888" font-size="10" text-anchor="end">' + Math.round(v) + '</text>';
    });
    [aMin, 0, aMax].forEach(function (v) {
        svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y2(v) + '" y2="' + y2(v) + '" stroke="' + (v === 0 ? '#444' : '#262626') + '"/><text x="' + (L - 6) + '" y="' + (y2(v) + 4) + '" fill="#888" font-size="10" text-anchor="end">' + v.toFixed(2) + '</text>';
    });
    marks.forEach(function (m, i) {   // labels on alternating lines so close markers don't overlap
        svg += '<line x1="' + x(m[0]) + '" x2="' + x(m[0]) + '" y1="' + T + '" y2="' + (top2 + H2) + '" stroke="' + m[2] + '" stroke-dasharray="2 3"/><text x="' + (x(m[0]) + 3) + '" y="' + (T + 10 + (i % 2) * 12) + '" fill="' + m[2] + '" font-size="10">' + esc(m[1]) + '</text>';
    });
    svg += line(fromSpd, y1, '#9c27b0', true) + line(toSpd, y1, '#4caf50', true) + line(tr.engine, y1, '#888') + line(tr.input, y1, '#2d8aff') + line(tr.acc, y2, '#ff9800');
    svg += '<text x="' + L + '" y="' + (top2 - 8) + '" fill="#888" font-size="10">Acceleration (g)</text><text x="' + (W - R) + '" y="' + (top2 + H2 + 18) + '" fill="#888" font-size="10" text-anchor="end">s from request</text>';
    [t0, 0].forEach(function (t) { svg += '<text x="' + x(t) + '" y="' + (top2 + H2 + 18) + '" fill="#888" font-size="10" text-anchor="middle">' + t.toFixed(1) + '</text>'; });
    return svg + '</svg>';
}

function showShift(index) {
    var s = current.analysis.shifts[index], el = $('shift-chart');
    el.hidden = false;
    el.innerHTML = '<div class="chart-head"><span><b>' + s.from + '→' + s.to + '</b> at ' + s.tReq.toFixed(1) + ' s · ' + esc(KIND_LABELS[s.kind] || s.kind) +
        ' · oil ' + num(s.oil, 0, '°C') + ' · applies ' + esc(s.applying) + ', releases ' + esc(s.releasing) + '</span><span>' +
        '<span style="color:#2d8aff">— Input</span> · <span style="color:#888">— Engine</span> · <span style="color:#9c27b0">- - ' + s.from + ' gear speed</span> · ' +
        '<span style="color:#4caf50">- - ' + s.to + ' gear speed</span> · <span style="color:#ff9800">— Acceleration</span></span></div>' + shiftChartSvg(s);
    document.querySelectorAll('#shift-content tr.selected').forEach(function (r) { r.classList.remove('selected'); });
    var row = document.querySelector('#shift-content tr[data-shift="' + index + '"]');
    if (row) row.classList.add('selected');
    el.scrollIntoView({ block: 'nearest' });
}

function renderClutches(clutches) {
    $('clutch-content').innerHTML = table(['Element', 'Applies on', 'Upshifts', 'Downshifts', 'Ratio change', 'Flare', 'Bump'], clutches.map(function (c) {
        return '<tr><td><b>' + c.element + '</b></td><td class="left">' + esc(c.appliesOn.join(', ')) + '</td><td>' + c.upshifts + '</td><td>' + c.downshifts + '</td><td>' +
            num(c.ratioChange, 2, 's') + '</td><td>' + num(c.flare, 0, 'rpm') + '</td><td>' + num(c.bump, 2, 'g') + '</td></tr>';
    })) + '<p class="section-desc">Medians over the shifts each element applies on, in this log.</p>';
}

function valuesTable(view) {
    if (!view) return '';
    var head = view.colLabels.length && view.colLabels.some(function (l) { return String(l).trim(); }) ?
        '<tr><th></th>' + view.values[0].map(function (v, i) { return '<th>' + esc(view.colLabels[i] !== undefined ? view.colLabels[i] : '') + '</th>'; }).join('') + '</tr>' : '';
    return '<table class="correction-table">' + head + view.values.map(function (r, i) {
        return '<tr><th>' + esc(view.rowLabels[i] !== undefined ? view.rowLabels[i] : '') + '</th>' + r.map(function (v) {
            var cls = v > 0 ? 'val-pos' : v < 0 ? 'val-neg' : 'val-zero';
            return '<td class="' + cls + '">' + (typeof v === 'number' ? +v.toFixed(2) : esc(v)) + '</td>';
        }).join('') + '</tr>';
    }).join('') + '</table>';
}

function renderAdaptation(ad, bin) {
    var html = '';
    if (ad.codes.length) {
        html += '<h4 style="margin:0 0 6px">Adaptation Activation Parameter while in 3rd–7th (' + ad.secondsInGears3to7 + ' s)</h4>' +
            table(['Code', 'Meaning', 'Time', 'Share'], ad.codes.map(function (c) {
                return '<tr><td>' + c.code + '</td><td class="left">' + esc(c.meaning) + '</td><td>' + num(c.seconds, 1, 's') + '</td><td>' + num(c.share * 100, 0, '%') + '</td></tr>';
            })) + '<p class="section-desc">Code meanings from the TurboLamik manual (Adaptations); it notes the limits may change between firmware versions.</p>';
    } else html += '<p class="muted">The log has no Adaptation Activation Parameter channel.</p>';
    if (ad.learnShifts.length) {
        html += '<h4 style="margin:12px 0 6px">Shifts the TCU learns on</h4>' + table(['Time', 'Shift', 'Element', 'Oil', 'Code'], ad.learnShifts.map(function (x) {
            return '<tr><td>' + num(x.tReq, 1, 's') + '</td><td>' + esc(x.key.replace('-', '→')) + '</td><td>' + x.element + '</td><td>' + num(x.oil, 0, '°C') + '</td><td' +
                (x.code === 0 ? '' : ' class="flag"') + '>' + num(x.code, 0) + ' <span class="muted">' + esc(TSA_ADAPT_CODES[x.code] || '') + '</span></td></tr>';
        }));
    }
    if (ad.channels.length) {
        html += '<h4 style="margin:12px 0 6px">Logged clutch pressure adaptation</h4>' + table(['Element', 'Start of log', 'End of log', 'Range'], ad.channels.map(function (c) {
            return '<tr><td>' + c.element + '</td><td>' + num(c.first, 1) + '</td><td>' + num(c.last, 1) + '</td><td>' + num(c.min, 1) + ' – ' + num(c.max, 1) + '</td></tr>';
        }));
    }
    if (bin && bin.settings.adaptationTables.length) {
        html += '<h4 style="margin:12px 0 6px">Adaptation values in the bin</h4>' + bin.settings.adaptationTables.map(function (v) {
            return '<details class="bin-table"' + (v.values.some(function (r) { return r.some(function (x) { return x !== 0; }); }) ? ' open' : '') + '><summary>' + esc(v.title) + '</summary>' + valuesTable(v) + '</details>';
        }).join('');
    }
    $('adaptation-content').innerHTML = html;
}

function renderBin(bin, a) {
    $('bin-section').hidden = !bin;
    if (!bin) return;
    var st = bin.settings, html = '<p class="section-desc">' + esc([bin.metadata.xdfTitle, bin.metadata.xdfDescription].filter(Boolean).join(' — ') + ' · ' + bin.metadata.tableCount + ' tables.') + '</p>';
    html += '<div class="param-grid">';
    if (st.gearRatios) html += '<div class="param-row"><span class="param-label">Gear Ratio</span><span class="param-value">' + Object.keys(st.gearRatios).map(function (g) { return g + ': ' + st.gearRatios[g]; }).join('  ') + '</span></div>';
    if (st.startGear) html += '<div class="param-row"><span class="param-label">Start gear per program (Program Selector)</span><span class="param-value">' + esc(st.startGear.join(' ')) + '</span></div>';
    if (st.adaptOil) html += '<div class="param-row"><span class="param-label">Adaptation oil window</span><span class="param-value">' + st.adaptOil.min + '–' + st.adaptOil.max + ' °C</span></div>';
    var b = st.blip;
    if (b.minRpm) html += '<div class="param-row"><span class="param-label">Min RPM for blip (' + esc(b.rowLabels.join(' / ')) + ')</span><span class="param-value">' + esc(b.minRpm.join(' / ')) + '</span></div>';
    if (b.maxTps !== null) html += '<div class="param-row"><span class="param-label">Max TPS / Max TQ for blip</span><span class="param-value">' + b.maxTps + ' % / ' + b.maxTq + ' Nm</span></div>';
    if (b.slipDeactivation) html += '<div class="param-row"><span class="param-label">Clutch slip blip deactivation</span><span class="param-value">' + esc(b.slipDeactivation.join(' / ')) + '</span></div>';
    html += '</div>';
    var seen = {};
    a.transitions.forEach(function (t) { seen[t.key] = t; });
    var keys = Object.keys(st.corrections).filter(function (k) { return seen[k]; });
    if (keys.length) {
        html += '<h4 style="margin:14px 0 6px">Correction Start / End for the shifts in this log</h4>' + keys.map(function (k) {
            var c = st.corrections[k], flagged = a.findings.some(function (f) { return f.title.indexOf(k.replace('-', '→') + ':') === 0; });
            return '<details class="bin-table"' + (flagged ? ' open' : '') + '><summary>' + esc(k.replace('-', '→')) + ' (' + seen[k].count + ' shifts)' + (flagged ? ' — has a finding' : '') + '</summary>' +
                (c.start ? '<p class="muted">' + esc(c.start.title) + '</p>' + valuesTable(c.start) : '') + (c.end ? '<p class="muted">' + esc(c.end.title) + '</p>' + valuesTable(c.end) : '') + '</details>';
        }).join('');
    }
    if (st.shiftTables.length) {
        html += '<h4 style="margin:14px 0 6px">Shift feel tables</h4>' + st.shiftTables.map(function (v) {
            return '<details class="bin-table"><summary>' + esc(v.title) + '</summary>' + valuesTable(v) + '</details>';
        }).join('');
    }
    $('bin-content').innerHTML = html;
}

function renderMethod(limits) {
    $('method-content').innerHTML = '<ul class="method-list">' +
        '<li>A shift starts when <b>Gear Target</b> changes and ends when <b>Gear</b> reaches the new gear; the TCU changes Gear only once the new ratio is reached.</li>' +
        '<li><b>Delay</b>: request until Input ÷ Output RPM is more than ' + limits.ratioMoved * 100 + ' % from the old gear’s ratio. <b>Ratio change</b>: until it is within ' +
        limits.ratioSynced * 100 + ' % of the new gear’s for 0.1 s. Ratios are measured from the log. <b>TCU shift time</b> is the logged Time 1 Shift Time, which counts the ratio change.</li>' +
        '<li><b>Flare</b>: on an upshift, input speed above the old gear’s speed (Output RPM × ratio); on a downshift, above the new gear’s. The highest excess held for 0.1 s. ' +
        'Flagged from ' + limits.flareRpm + ' rpm.</li>' +
        '<li><b>Sag / bump</b>: vehicle acceleration from Output RPM (slope over 0.25 s, scaled by the logged km/h per output rpm), against its median in the 0.5 s before the request, ' +
        'from the request to 0.3 s after the new ratio. Bumps are flagged from ' + limits.bumpG + ' g. Braking shifts are left out of the findings because the brake pedal moves it more.</li>' +
        '<li>A finding needs at least ' + limits.minEvents + ' shifts of a kind, and at least half of that transition’s shifts. These thresholds are this tool’s, not TurboLamik’s.</li>' +
        '<li>Tables named in the advice are from TurboLamik’s shift-quality guide (turbolamik.help) and manual (manual.turbolamik.eu).</li></ul>';
}

document.querySelectorAll('.filter-btn').forEach(function (b) {
    b.addEventListener('click', function () {
        shiftFilter = b.getAttribute('data-filter');
        document.querySelectorAll('.filter-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
        if (current) renderShifts();
    });
});
$('shift-content').addEventListener('click', function (e) {
    var row = e.target.closest('tr[data-shift]');
    if (row) showShift(parseInt(row.getAttribute('data-shift'), 10));
});

function showError(message) {
    errorContainer.textContent = message;
    errorContainer.hidden = false;
}
