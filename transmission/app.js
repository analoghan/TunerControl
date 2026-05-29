/**
 * transmission/app.js — UI controller for the Transmission Shift Analyzer.
 */

var logInput = document.getElementById('log-input');
var adxInput = document.getElementById('adx-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorContainer = document.getElementById('error-container');
var progressSection = document.getElementById('progress-section');
var progressBar = document.getElementById('progress-bar');
var progressPct = document.getElementById('progress-pct');
var progressPhase = document.getElementById('progress-phase');
var resultsSection = document.getElementById('results-section');

var selectedFile = null;
var selectedAdxFile = null;
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

function updateAnalyzeButton() {
    if (!selectedFile) { analyzeBtn.disabled = true; return; }
    var ext = selectedFile.name.toLowerCase().split('.').pop();
    if (ext === 'csv') {
        analyzeBtn.disabled = false;
    } else if (ext === 'xdl') {
        analyzeBtn.disabled = !selectedAdxFile;
    } else {
        analyzeBtn.disabled = true;
    }
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

    if (ext === 'xdl') {
        // XDL binary path: read both XDL (binary) and ADX (text)
        if (!selectedAdxFile) {
            showError('Please select an ADX channel definition file for XDL parsing.');
            analyzeBtn.disabled = false;
            progressSection.hidden = true;
            return;
        }

        var adxReader = new FileReader();
        adxReader.onload = function() {
            var adxText = adxReader.result;
            var xdlReader = new FileReader();
            xdlReader.onload = function() {
                startWorkerXdl(xdlReader.result, adxText);
            };
            xdlReader.onerror = function() {
                progressSection.hidden = true;
                showError('Could not read the XDL file.');
                analyzeBtn.disabled = false;
            };
            xdlReader.readAsArrayBuffer(selectedFile);
        };
        adxReader.onerror = function() {
            progressSection.hidden = true;
            showError('Could not read the ADX file.');
            analyzeBtn.disabled = false;
        };
        adxReader.readAsText(selectedAdxFile);
    } else {
        // CSV text path (original)
        var reader = new FileReader();
        reader.onload = function() {
            startWorkerCsv(reader.result);
        };
        reader.onerror = function() {
            progressSection.hidden = true;
            showError('Could not read the selected file.');
            analyzeBtn.disabled = false;
        };
        reader.readAsText(selectedFile);
    }
});

function startWorkerCsv(logText) {
    if (worker) { worker.terminate(); worker = null; }

    var workerUrl = new URL('worker.js', window.location.href).href;
    var blob = new Blob(['importScripts("' + workerUrl + '");'], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    attachWorkerHandlers(worker);
    worker.postMessage({ type: 'analyze', logText: logText });
}

function startWorkerXdl(xdlBuffer, adxText) {
    if (worker) { worker.terminate(); worker = null; }

    // Worker needs both xdl-parser.js and worker.js
    var parserUrl = new URL('xdl-parser.js', window.location.href).href;
    var workerUrl = new URL('worker.js', window.location.href).href;
    var blob = new Blob([
        'importScripts("' + parserUrl + '", "' + workerUrl + '");'
    ], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    attachWorkerHandlers(worker);
    worker.postMessage({ type: 'analyzeXdl', xdlBuffer: xdlBuffer, adxText: adxText }, [xdlBuffer]);
}

function attachWorkerHandlers(w) {
    w.onmessage = function(e) {
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

    w.onerror = function() {
        progressSection.hidden = true;
        showError('An unexpected error occurred during analysis.');
        analyzeBtn.disabled = false;
    };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResults(msg) {
    resultsSection.hidden = false;

    renderSummary(msg.summary);
    renderDownshifts(msg.events);
    renderUpshifts(msg.events);
    renderClutchHealth(msg.clutchHealth);
    renderDiagnostics(msg.diagnostics);
}

function renderSummary(summary) {
    var content = document.getElementById('summary-content');
    content.innerHTML = '';

    var grid = document.createElement('div');
    grid.className = 'summary-grid';

    addStat(grid, summary.totalShifts, 'Total Shifts');
    addStat(grid, summary.upshifts, 'Upshifts');
    addStat(grid, summary.downshifts, 'Downshifts');
    addStat(grid, summary.avgShiftTime > 0 ? summary.avgShiftTime + ' ms' : 'N/A', 'Avg Shift Time');
    addStat(grid, summary.logDuration + 's', 'Log Duration');
    if (summary.oilTemp !== null) addStat(grid, summary.oilTemp + '°C', 'Oil Temp');

    content.appendChild(grid);
}

function renderDownshifts(events) {
    var content = document.getElementById('downshift-content');
    content.innerHTML = '';

    var downshifts = events.filter(function(e) { return e.isDownshift; });
    downshifts.sort(function(a, b) { return b.harshness - a.harshness; });

    if (downshifts.length === 0) {
        content.innerHTML = '<p style="color:#888;font-style:italic;">No downshift events detected.</p>';
        return;
    }

    var table = document.createElement('table');
    table.className = 'shift-table';

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Time</th><th>Shift</th><th>Harshness</th><th>RPM Flare</th><th>Slip %</th><th>Slip (ms)</th><th>Speed</th><th>Braking</th><th>Clutch</th></tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var limit = Math.min(downshifts.length, 30);
    for (var i = 0; i < limit; i++) {
        var evt = downshifts[i];
        var tr = document.createElement('tr');

        var severityClass = evt.harshness > 60 ? 'severity-high' : evt.harshness > 35 ? 'severity-medium' : 'severity-low';

        tr.innerHTML =
            '<td>' + (evt.time !== null ? evt.time.toFixed(1) + 's' : '—') + '</td>' +
            '<td>' + evt.fromGear + '→' + evt.toGear + '</td>' +
            '<td class="' + severityClass + '">' + evt.harshness + '/100</td>' +
            '<td>' + (evt.rpmFlare > 0 ? '+' + evt.rpmFlare : '0') + '</td>' +
            '<td>' + evt.maxSlip + '%</td>' +
            '<td>' + evt.slipDuration + '</td>' +
            '<td>' + (evt.vehicleSpeed !== null ? Math.round(evt.vehicleSpeed) + ' km/h' : '—') + '</td>' +
            '<td>' + (evt.braking ? 'Yes' : 'No') + '</td>' +
            '<td>' + (evt.clutchInvolved || '—') + '</td>';

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    content.appendChild(table);

    if (downshifts.length > limit) {
        var note = document.createElement('p');
        note.style.cssText = 'color:#888;font-size:0.8rem;margin-top:8px;';
        note.textContent = 'Showing top ' + limit + ' of ' + downshifts.length + ' downshifts (sorted by harshness).';
        content.appendChild(note);
    }
}

function renderUpshifts(events) {
    var content = document.getElementById('upshift-content');
    content.innerHTML = '';

    var upshifts = events.filter(function(e) { return e.isUpshift && e.tpsAtShift > 10; });
    upshifts.sort(function(a, b) { return b.maxSlip - a.maxSlip; });

    if (upshifts.length === 0) {
        content.innerHTML = '<p style="color:#888;font-style:italic;">No upshifts under power detected (TPS > 10%).</p>';
        return;
    }

    var table = document.createElement('table');
    table.className = 'shift-table';

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Time</th><th>Shift</th><th>Max Slip</th><th>Slip (ms)</th><th>TPS</th><th>Torque</th><th>RPM</th><th>Shift Time</th><th>Clutch</th></tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var limit = Math.min(upshifts.length, 30);
    for (var i = 0; i < limit; i++) {
        var evt = upshifts[i];
        var tr = document.createElement('tr');

        var severityClass = evt.maxSlip > 20 ? 'severity-high' : evt.maxSlip > 10 ? 'severity-medium' : 'severity-low';

        tr.innerHTML =
            '<td>' + (evt.time !== null ? evt.time.toFixed(1) + 's' : '—') + '</td>' +
            '<td>' + evt.fromGear + '→' + evt.toGear + '</td>' +
            '<td class="' + severityClass + '">' + evt.maxSlip + '%</td>' +
            '<td>' + evt.slipDuration + '</td>' +
            '<td>' + (evt.tpsAtShift !== null ? Math.round(evt.tpsAtShift) + '%' : '—') + '</td>' +
            '<td>' + (evt.torqueAtShift !== null ? Math.round(evt.torqueAtShift) + ' Nm' : '—') + '</td>' +
            '<td>' + (evt.engineRpmAtShift !== null ? Math.round(evt.engineRpmAtShift) : '—') + '</td>' +
            '<td>' + (evt.shiftTime !== null ? evt.shiftTime + ' ms' : '—') + '</td>' +
            '<td>' + (evt.clutchInvolved || '—') + '</td>';

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    content.appendChild(table);
}

function renderClutchHealth(clutchHealth) {
    var content = document.getElementById('clutch-content');
    content.innerHTML = '';

    var table = document.createElement('table');
    table.className = 'shift-table';

    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Clutch</th><th>Total Shifts</th><th>Upshifts</th><th>Downshifts</th><th>Avg Slip (up)</th><th>Max Slip (up)</th><th>Avg Harshness (down)</th><th>Avg Shift Time</th><th>Used For</th></tr>';
    table.appendChild(thead);

    var clutchUsage = {
        A: '1→2, 6→7 up / 2→1, 7→6 down',
        B: '2→3, 7→8 up / 3→2, 8→7 down',
        C: '4→5 up / 5→4 down',
        D: '3→4 up / 4→3 down',
        E: '5→6 up / 6→5 down',
    };

    var tbody = document.createElement('tbody');
    var keys = ['A', 'B', 'C', 'D', 'E'];
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var h = clutchHealth[key];
        var tr = document.createElement('tr');

        var slipClass = h.maxSlipUpshift > 20 ? 'severity-high' : h.maxSlipUpshift > 10 ? 'severity-medium' : 'severity-low';
        var harshClass = h.avgHarshness > 50 ? 'severity-high' : h.avgHarshness > 30 ? 'severity-medium' : 'severity-low';

        tr.innerHTML =
            '<td style="font-weight:600;">' + key + '</td>' +
            '<td>' + h.totalShifts + '</td>' +
            '<td>' + h.upshiftCount + '</td>' +
            '<td>' + h.downshiftCount + '</td>' +
            '<td>' + h.avgSlipUpshift + '%</td>' +
            '<td class="' + slipClass + '">' + h.maxSlipUpshift + '%</td>' +
            '<td class="' + harshClass + '">' + h.avgHarshness + '/100</td>' +
            '<td>' + (h.avgShiftTime > 0 ? h.avgShiftTime + ' ms' : '—') + '</td>' +
            '<td style="font-size:0.75rem;color:#888;">' + clutchUsage[key] + '</td>';

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    content.appendChild(table);
}

function renderDiagnostics(diagnostics) {
    var content = document.getElementById('diagnostics-content');
    content.innerHTML = '';

    for (var i = 0; i < diagnostics.length; i++) {
        var d = diagnostics[i];
        var div = document.createElement('div');
        div.className = 'diagnostic diagnostic-' + d.severity;

        var text = document.createElement('p');
        text.style.margin = '0 0 6px';
        text.textContent = d.text;
        div.appendChild(text);

        if (d.action) {
            var action = document.createElement('p');
            action.style.cssText = 'margin:0;font-size:0.85rem;opacity:0.8;';
            action.textContent = '→ ' + d.action;
            div.appendChild(action);
        }

        content.appendChild(div);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addStat(container, value, label) {
    var div = document.createElement('div');
    div.className = 'summary-stat';
    div.innerHTML = '<span class="stat-value">' + value + '</span><span class="stat-label">' + label + '</span>';
    container.appendChild(div);
}

function showError(message) {
    errorContainer.textContent = message;
    errorContainer.hidden = false;
}
