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

    // Build importScripts list
    var scripts = [];
    var parserUrl = new URL('xdl-parser.js', window.location.href).href;
    var binReaderUrl = new URL('bin-reader.js', window.location.href).href;
    var workerUrl = new URL('worker.js', window.location.href).href;

    if (ext === 'xdl') scripts.push(parserUrl);
    if (hasBin) scripts.push(binReaderUrl);
    scripts.push(workerUrl);

    var blob = new Blob([
        'importScripts(' + scripts.map(function(s) { return '"' + s + '"'; }).join(',') + ');'
    ], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    attachWorkerHandlers(worker);

    // Build message
    var msg;
    if (hasBin) {
        // Full analysis with bin correlation
        msg = { type: 'analyzeWithBin', binBuffer: files.bin, xdfText: files.xdf };
        if (ext === 'xdl') {
            msg.xdlBuffer = files.xdl;
            msg.adxText = files.adx;
        } else {
            msg.logText = files.csv;
        }
        var transferables = [files.bin];
        if (files.xdl) transferables.push(files.xdl);
        worker.postMessage(msg, transferables);
    } else if (ext === 'xdl') {
        msg = { type: 'analyzeXdl', xdlBuffer: files.xdl, adxText: files.adx };
        worker.postMessage(msg, [files.xdl]);
    } else {
        msg = { type: 'analyze', logText: files.csv };
        worker.postMessage(msg);
    }
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
    if (msg.binConfig) {
        renderBinCorrelation(msg.events, msg.binConfig, msg.binMetadata);
        renderAdaptationMonitor(msg.binConfig, msg.summary);
    }
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
// Shift-to-Bin Correlator
// ---------------------------------------------------------------------------

function renderBinCorrelation(events, binConfig, binMetadata) {
    var container = document.getElementById('bin-correlation-content');
    if (!container) return;
    container.innerHTML = '';

    // Group downshifts by transition and find the problematic ones
    var downshifts = events.filter(function(e) { return e.isDownshift; });
    var byTransition = {};
    downshifts.forEach(function(e) {
        var key = e.fromGear + '->' + e.toGear;
        if (!byTransition[key]) byTransition[key] = [];
        byTransition[key].push(e);
    });

    // For each transition with harshness issues, show the relevant bin params
    var transitions = Object.keys(byTransition).sort(function(a, b) {
        var avgA = byTransition[a].reduce(function(s,e){return s+e.harshness;},0) / byTransition[a].length;
        var avgB = byTransition[b].reduce(function(s,e){return s+e.harshness;},0) / byTransition[b].length;
        return avgB - avgA;
    });

    transitions.forEach(function(key) {
        var evts = byTransition[key];
        var avgHarsh = Math.round(evts.reduce(function(s,e){return s+e.harshness;},0) / evts.length);
        var maxHarsh = Math.max.apply(null, evts.map(function(e){return e.harshness;}));
        var avgSlipDur = Math.round(evts.reduce(function(s,e){return s+e.slipDuration;},0) / evts.length);

        var section = document.createElement('div');
        section.className = 'correlation-block';

        var severityClass = avgHarsh > 30 ? 'severity-high' : avgHarsh > 15 ? 'severity-medium' : 'severity-low';

        var header = document.createElement('h3');
        header.innerHTML = key.replace('->', '→') + ' Downshift <span class="' + severityClass + '">(' + evts.length + ' events, avg harshness ' + avgHarsh + '/100)</span>';
        section.appendChild(header);

        // Stats row
        var stats = document.createElement('div');
        stats.className = 'correlation-stats';
        stats.innerHTML =
            '<span>Max harshness: <b>' + maxHarsh + '</b></span>' +
            '<span>Avg slip duration: <b>' + avgSlipDur + 'ms</b></span>' +
            '<span>Clutch applying: <b>' + (evts[0].clutchInvolved || '?') + '</b></span>';
        section.appendChild(stats);

        // Correction tables from bin
        var transKey = key.replace('->', '-');
        var corrections = binConfig.perGearCorrections[transKey];
        if (corrections) {
            if (corrections.start) {
                var startDiv = document.createElement('div');
                startDiv.className = 'correction-table-block';
                startDiv.innerHTML = '<h4>' + key.replace('->', '→') + ' Correction Start</h4>' + renderCorrectionTable(corrections.start);
                section.appendChild(startDiv);
            }
            if (corrections.end) {
                var endDiv = document.createElement('div');
                endDiv.className = 'correction-table-block';
                endDiv.innerHTML = '<h4>' + key.replace('->', '→') + ' Correction End</h4>' + renderCorrectionTable(corrections.end);
                section.appendChild(endDiv);
            }
        }

        // Blip status for this transition
        var blipFired = evts.filter(function(e) { return e.blipActive; }).length;
        var avgInputRpm = Math.round(evts.reduce(function(s,e){return s+(e.inputRpmAtShift||0);},0) / evts.length);
        var blipDiv = document.createElement('div');
        blipDiv.className = 'blip-status';
        var blipMinRpm = binConfig.blip.minRpmForBlip;
        var minRpmStr = blipMinRpm ? (Array.isArray(blipMinRpm[0]) ? blipMinRpm.map(function(r){return r[0];}).join('/') : blipMinRpm.join('/')) : '?';
        blipDiv.innerHTML =
            '<h4>Blip Status</h4>' +
            '<p>Blip fired: <b>' + blipFired + '/' + evts.length + '</b> shifts' +
            (blipFired === 0 ? ' <span class="severity-medium">(never active)</span>' : '') + '</p>' +
            '<p>Avg input RPM at shift: <b>' + avgInputRpm + '</b> | Min RPM for blip: <b>' + minRpmStr + '</b></p>';
        section.appendChild(blipDiv);

        container.appendChild(section);
    });

    // Global pressure/timing params
    var globalDiv = document.createElement('div');
    globalDiv.className = 'correlation-block';
    globalDiv.innerHTML =
        '<h3>Global Shift Parameters</h3>' +
        '<div class="param-grid">' +
        paramRow('Pulse Time', binConfig.timing.pulseTime, 'ms') +
        paramRow('Clutch Closing Time', binConfig.timing.clutchClosingTime ? binConfig.timing.clutchClosingTime.toFixed(1) : 'N/A', 'ms') +
        paramRow('Min Clutch Press', binConfig.pressures.minClutchPress, '') +
        paramRow('Min Clutch Press Drive', binConfig.pressures.minClutchPressDrive, '') +
        paramRow('Start Press', binConfig.pressures.startPress ? binConfig.pressures.startPress.join(', ') : 'N/A', '') +
        paramRow('TQ Reduction Threshold', binConfig.torqueReduction.outputThreshold ? binConfig.torqueReduction.outputThreshold.toFixed(1) : 'N/A', '%') +
        paramRow('TQ Reduction Advance Time', binConfig.torqueReduction.advanceTime ? binConfig.torqueReduction.advanceTime.join(', ') : 'N/A', 'ms') +
        paramRow('Max TPS for Blip', binConfig.blip.maxTpsForBlip, '%') +
        paramRow('Max TQ for Blip', binConfig.blip.maxTqForBlip, 'NM') +
        '</div>';
    container.appendChild(globalDiv);
}

function renderCorrectionTable(tableData) {
    if (!tableData) return '<p style="color:#666;">Not available</p>';
    var isFlat = !Array.isArray(tableData[0]);
    var rows = isFlat ? [tableData] : tableData;

    var html = '<table class="correction-table"><tbody>';
    for (var r = 0; r < rows.length; r++) {
        html += '<tr>';
        for (var c = 0; c < rows[r].length; c++) {
            var val = rows[r][c];
            var cls = val > 0 ? 'val-pos' : val < 0 ? 'val-neg' : 'val-zero';
            html += '<td class="' + cls + '">' + (typeof val === 'number' ? val.toFixed(1) : val) + '</td>';
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
}

function paramRow(label, value, unit) {
    return '<div class="param-row"><span class="param-label">' + label + '</span><span class="param-value">' + value + (unit ? ' ' + unit : '') + '</span></div>';
}

// ---------------------------------------------------------------------------
// Adaptation Monitor
// ---------------------------------------------------------------------------

function renderAdaptationMonitor(binConfig, summary) {
    var container = document.getElementById('adaptation-content');
    if (!container) return;
    container.innerHTML = '';

    var adapt = binConfig.adaptation;

    // Oil temp check — adaptation requires >50C
    var oilTemp = summary.oilTemp;
    var tempWarning = '';
    if (oilTemp !== null && oilTemp < 50) {
        tempWarning = '<div class="adapt-warning"><b>Oil temp during log: ' + oilTemp + '°C</b> — below 50°C threshold for Standard Clutch Filling Adaptation. The TCU will not learn adaptation values until oil is above 50°C (122°F).</div>';
    }

    // Downshift adaptation
    var downAdap = adapt.downshiftAdap;
    var downAdapMax = adapt.downshiftAdapMaxValue;
    var brakeAdap = adapt.brakeAdap;
    var endAdap = adapt.endAdap;
    var tqAdap = adapt.torqueReductionAdap;

    var html = tempWarning;

    // Downshift ADAP (per gear 2-8)
    html += '<div class="adapt-section">';
    html += '<h4>Downshift Adaptation (per gear)</h4>';
    html += '<p class="adapt-desc">Learned pressure correction for downshift engagement. Zero = no adaptation learned yet.</p>';
    html += renderAdaptBar('Downshift ADAP', downAdap, downAdapMax, ['2', '3', '4', '5', '6', '7', '8']);
    html += '</div>';

    // Brake ADAP (per clutch A-E)
    html += '<div class="adapt-section">';
    html += '<h4>Brake Adaptation (per clutch)</h4>';
    html += '<p class="adapt-desc">Learned pressure correction when braking. Applied to the oncoming clutch during braking downshifts.</p>';
    html += renderAdaptBar('Brake ADAP', brakeAdap, null, ['A', 'B', 'E', 'C', 'D']);
    html += '</div>';

    // End ADAP (per gear 2-8)
    if (endAdap) {
        html += '<div class="adapt-section">';
        html += '<h4>End Adaptation (per gear)</h4>';
        html += '<p class="adapt-desc">Learned correction for shift completion phase timing.</p>';
        html += renderAdaptBar('End ADAP', endAdap, null, ['2', '3', '4', '5', '6', '7', '8']);
        html += '</div>';
    }

    // Torque Reduction ADAP (per gear 2-8)
    html += '<div class="adapt-section">';
    html += '<h4>Torque Reduction Adaptation (per gear)</h4>';
    html += '<p class="adapt-desc">Learned torque reduction timing. Higher values = more torque cut during shift. Non-zero values indicate active learning.</p>';
    html += renderAdaptBar('TQ Reduction', tqAdap, null, ['2', '3', '4', '5', '6', '7', '8']);
    html += '</div>';

    // Adaptation status summary
    var allZero = true;
    if (downAdap) { for (var i = 0; i < downAdap.length; i++) { if (downAdap[i] !== 0) allZero = false; } }
    if (brakeAdap) { for (var i = 0; i < brakeAdap.length; i++) { if (brakeAdap[i] !== 0) allZero = false; } }

    html += '<div class="adapt-section adapt-summary">';
    if (allZero) {
        html += '<p class="adapt-status adapt-status-none"><b>No clutch adaptation learned.</b> The Downshift and Brake adaptation values are all zero. This typically means:</p>';
        html += '<ul>';
        html += '<li>The adaptation was recently reset</li>';
        html += '<li>The vehicle has not been driven in conditions that trigger learning (oil temp >50°C, specific RPM/torque windows)</li>';
        html += '<li>The TCU needs more drive cycles to converge</li>';
        html += '</ul>';
        html += '<p>Drive the vehicle with oil temp above 50°C through normal city/highway conditions to allow adaptation learning. See the ZF 8HP adaptation procedure for specific conditions per clutch.</p>';
    } else {
        html += '<p class="adapt-status adapt-status-active"><b>Adaptation values present.</b> The TCU has learned some clutch corrections.</p>';
    }
    html += '</div>';

    container.innerHTML = html;
}

function renderAdaptBar(title, values, maxValues, labels) {
    if (!values) return '<p style="color:#666;">Not available in bin</p>';

    var flat = Array.isArray(values[0]) ? values.map(function(r){return r[0];}) : values;
    var maxFlat = maxValues ? (Array.isArray(maxValues[0]) ? maxValues.map(function(r){return r[0];}) : maxValues) : null;

    var html = '<div class="adapt-bars">';
    for (var i = 0; i < flat.length; i++) {
        var val = flat[i];
        var label = labels && labels[i] ? labels[i] : String(i);
        var maxVal = maxFlat ? maxFlat[i] : null;
        var isZero = val === 0;
        var barClass = isZero ? 'bar-zero' : val > 0 ? 'bar-pos' : 'bar-neg';

        // Normalize bar width (use max adaptation value or fixed scale)
        var scale = maxVal ? Math.abs(maxVal) : 50;
        var barWidth = scale > 0 ? Math.min(100, Math.abs(val) / scale * 100) : 0;

        html += '<div class="adapt-bar-row">';
        html += '<span class="adapt-label">' + label + '</span>';
        html += '<div class="adapt-bar-track">';
        html += '<div class="adapt-bar-fill ' + barClass + '" style="width:' + barWidth + '%"></div>';
        html += '</div>';
        html += '<span class="adapt-value ' + barClass + '">' + (typeof val === 'number' ? val.toFixed(1) : val) + '</span>';
        if (maxVal !== null) {
            html += '<span class="adapt-max">(max: ' + maxVal.toFixed(1) + ')</span>';
        }
        html += '</div>';
    }
    html += '</div>';
    return html;
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
