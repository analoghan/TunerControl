/**
 * haltech/ve-table/app.js — UI controller for Haltech VE Table Analyzer
 */

var logInput = document.getElementById('log-input');
var veInput = document.getElementById('ve-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorContainer = document.getElementById('error-container');
var progressSection = document.getElementById('progress-section');
var progressBar = document.getElementById('progress-bar');
var progressPct = document.getElementById('progress-pct');
var progressPhase = document.getElementById('progress-phase');
var resultsSection = document.getElementById('results-section');

var selectedLogFile = null;
var selectedVeFile = null;
var worker = null;
var lastResult = null;

// ---------------------------------------------------------------------------
// File Input
// ---------------------------------------------------------------------------

logInput.addEventListener('change', function() {
    selectedLogFile = logInput.files[0] || null;
    analyzeBtn.disabled = !selectedLogFile;
    errorContainer.hidden = true;
});

veInput.addEventListener('change', function() {
    selectedVeFile = veInput.files[0] || null;
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

analyzeBtn.addEventListener('click', function() {
    if (!selectedLogFile) return;

    analyzeBtn.disabled = true;
    errorContainer.hidden = true;
    resultsSection.hidden = true;
    progressSection.hidden = false;
    progressBar.style.width = '0%';
    progressPct.textContent = '0%';
    progressPhase.textContent = '';

    var filesToRead = [{ key: 'log', file: selectedLogFile }];
    if (selectedVeFile) filesToRead.push({ key: 've', file: selectedVeFile });

    var results = {};
    var remaining = filesToRead.length;

    filesToRead.forEach(function(item) {
        var reader = new FileReader();
        reader.onload = function() {
            results[item.key] = reader.result;
            remaining--;
            if (remaining === 0) startWorker(results);
        };
        reader.onerror = function() {
            progressSection.hidden = true;
            showError('Could not read file: ' + item.file.name);
            analyzeBtn.disabled = false;
        };
        reader.readAsText(item.file);
    });
});

function startWorker(files) {
    if (worker) { worker.terminate(); worker = null; }

    var workerUrl = new URL('worker.js', window.location.href).href;
    var blob = new Blob(['importScripts("' + workerUrl + '");'], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));

    worker.onmessage = function(e) {
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
            lastResult = msg;
            renderResults(msg);
            analyzeBtn.disabled = false;
        }
    };

    worker.onerror = function() {
        progressSection.hidden = true;
        showError('An unexpected error occurred during analysis.');
        analyzeBtn.disabled = false;
    };

    worker.postMessage({ type: 'analyze', logText: files.log, veTableText: files.ve || null });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResults(msg) {
    resultsSection.hidden = false;
    renderSummary(msg.stats, msg.logStats);
    renderDiffGrid(msg.grid);
    renderHitGrid(msg.grid);

    if (msg.newValuesCsv) {
        document.getElementById('new-values-section').hidden = false;
        renderNewValuesGrid(msg.grid, msg.newValuesCsv);
    }

    // Warnings
    if (msg.logStats.channelWarnings && msg.logStats.channelWarnings.length > 0) {
        document.getElementById('warnings-section').hidden = false;
        var wc = document.getElementById('warnings-content');
        wc.innerHTML = '';
        msg.logStats.channelWarnings.forEach(function(w) {
            var div = document.createElement('div');
            div.className = 'warning-item';
            div.textContent = w;
            wc.appendChild(div);
        });
    }

    // Copy buttons
    var copyDiffBtn = document.getElementById('copy-diff-btn');
    copyDiffBtn.hidden = false;
    copyDiffBtn.onclick = function() { copyToClipboard(msg.diffCsv); };

    if (msg.newValuesCsv) {
        var copyNewBtn = document.getElementById('copy-new-btn');
        copyNewBtn.onclick = function() { copyToClipboard(msg.newValuesCsv); };
    }
}

function renderSummary(stats, logStats) {
    var content = document.getElementById('summary-content');
    content.innerHTML = '';
    var grid = document.createElement('div');
    grid.className = 'summary-grid';

    addStat(grid, logStats.totalSamples.toLocaleString(), 'Total Samples');
    addStat(grid, logStats.validSamples.toLocaleString(), 'Valid Samples');
    addStat(grid, logStats.filteredOut.toLocaleString(), 'Filtered Out');
    addStat(grid, stats.cellsAboveThreshold + '/' + stats.totalCells, 'Cells with Data');
    addStat(grid, stats.avgCorrection.toFixed(1) + '%', 'Avg |Correction|');
    addStat(grid, (stats.maxCorrection > 0 ? '+' : '') + stats.maxCorrection.toFixed(1) + '%', 'Max Lean');
    addStat(grid, stats.minCorrection.toFixed(1) + '%', 'Max Rich');

    content.appendChild(grid);
}

function renderDiffGrid(grid) {
    var container = document.getElementById('diff-grid');
    container.innerHTML = '';

    var table = document.createElement('table');
    table.className = 've-grid';

    // Header row (RPM breakpoints)
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th class="corner">MAP\\RPM</th>';
    for (var r = 0; r < grid.rpmBreakpoints.length; r++) {
        headerRow.innerHTML += '<th>' + Math.round(grid.rpmBreakpoints[r]) + '</th>';
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows
    var tbody = document.createElement('tbody');
    for (var m = 0; m < grid.mapBreakpoints.length; m++) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<th>' + grid.mapBreakpoints[m].toFixed(0) + '</th>';
        for (var r = 0; r < grid.rpmBreakpoints.length; r++) {
            var cell = grid.cells[m][r];
            var td = document.createElement('td');
            if (cell.count > 50) {
                var avg = cell.correctionSum / cell.count;
                td.textContent = avg.toFixed(1);
                if (avg > 1) { td.className = 'cell-pos'; if (avg > 5) td.className += ' cell-hot'; }
                else if (avg < -1) { td.className = 'cell-neg'; if (avg < -5) td.className += ' cell-cold'; }
                else { td.className = 'cell-zero'; }
            } else {
                td.textContent = '';
                td.className = 'cell-empty';
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
}

function renderHitGrid(grid) {
    var container = document.getElementById('hit-grid');
    container.innerHTML = '';

    var table = document.createElement('table');
    table.className = 've-grid';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th class="corner">MAP\\RPM</th>';
    for (var r = 0; r < grid.rpmBreakpoints.length; r++) {
        headerRow.innerHTML += '<th>' + Math.round(grid.rpmBreakpoints[r]) + '</th>';
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var m = 0; m < grid.mapBreakpoints.length; m++) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<th>' + grid.mapBreakpoints[m].toFixed(0) + '</th>';
        for (var r = 0; r < grid.rpmBreakpoints.length; r++) {
            var cell = grid.cells[m][r];
            var td = document.createElement('td');
            td.textContent = cell.count > 0 ? cell.count : '';
            if (cell.count > 200) td.className = 'hit-high';
            else if (cell.count > 50) td.className = 'hit-med';
            else td.className = 'hit-low';
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
}

function renderNewValuesGrid(grid, newValuesCsv) {
    var container = document.getElementById('new-values-grid');
    container.innerHTML = '';

    // Parse the new values CSV to render as a grid
    var lines = newValuesCsv.split('\n');
    var table = document.createElement('table');
    table.className = 've-grid';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th class="corner">MAP\\RPM</th>';
    for (var r = 0; r < grid.rpmBreakpoints.length; r++) {
        headerRow.innerHTML += '<th>' + Math.round(grid.rpmBreakpoints[r]) + '</th>';
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Find cell values lines (after CellValues:)
    var dataStart = -1;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('CellValues:')) { dataStart = i + 1; break; }
    }

    if (dataStart > 0) {
        var tbody = document.createElement('tbody');
        var mapIdx = 0;
        for (var i = dataStart; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line === '') continue;
            var fields = line.split(',');
            var tr = document.createElement('tr');
            tr.innerHTML = '<th>' + (mapIdx < grid.mapBreakpoints.length ? grid.mapBreakpoints[mapIdx].toFixed(0) : '') + '</th>';
            for (var f = 0; f < fields.length; f++) {
                var td = document.createElement('td');
                var val = parseInt(fields[f], 10);
                td.textContent = isNaN(val) ? '' : (val / 10).toFixed(1);
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
            mapIdx++;
        }
        table.appendChild(tbody);
    }

    container.appendChild(table);
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

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(function() {
        // Brief visual feedback could be added here
    }).catch(function() {
        // Fallback for older browsers
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    });
}
