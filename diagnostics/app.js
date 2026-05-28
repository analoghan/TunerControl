/**
 * diagnostics/app.js — UI controller for the Cross-Tool Diagnostics page.
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorContainer = document.getElementById('error-container');
var progressSection = document.getElementById('progress-section');
var progressBar = document.getElementById('progress-bar');
var progressPct = document.getElementById('progress-pct');
var progressPhase = document.getElementById('progress-phase');
var resultsSection = document.getElementById('results-section');
var summaryGrid = document.getElementById('summary-grid');
var findingsContainer = document.getElementById('findings-container');

var selectedFile = null;
var worker = null;

// ---------------------------------------------------------------------------
// File Input
// ---------------------------------------------------------------------------

logInput.addEventListener('change', function() {
    var file = logInput.files[0] || null;
    if (file) {
        var name = file.name.toLowerCase();
        if (name.endsWith('.csv') || name.endsWith('.ld')) {
            selectedFile = file;
            analyzeBtn.disabled = false;
            errorContainer.hidden = true;
        } else {
            selectedFile = null;
            analyzeBtn.disabled = true;
            showError('Please select a .csv or .ld file');
        }
    } else {
        selectedFile = null;
        analyzeBtn.disabled = true;
    }
});

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

    var isLd = selectedFile.name.toLowerCase().endsWith('.ld');
    var reader = new FileReader();

    reader.onload = function() {
        if (worker) { worker.terminate(); worker = null; }

        var workerUrl = new URL('worker-diagnostics.js', window.location.href).href;
        var blob = new Blob(['importScripts("' + workerUrl + '");'], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));

        worker.onmessage = function(e) {
            var msg = e.data;
            if (!msg) return;

            if (msg.type === 'progress') {
                var pct = Math.round(msg.percent);
                progressBar.style.width = pct + '%';
                progressPct.textContent = pct + '%';
                progressPhase.textContent = msg.phase || '';
            } else if (msg.type === 'error') {
                progressSection.hidden = true;
                showError(msg.message);
                analyzeBtn.disabled = false;
            } else if (msg.type === 'result') {
                progressSection.hidden = true;
                renderResults(msg.diagnostics);
                analyzeBtn.disabled = false;
            }
        };

        worker.onerror = function() {
            progressSection.hidden = true;
            showError('An unexpected error occurred during analysis.');
            analyzeBtn.disabled = false;
        };

        if (isLd) {
            worker.postMessage({ type: 'analyze_ld', buffer: reader.result });
        } else {
            worker.postMessage({ type: 'analyze', logText: reader.result });
        }
    };

    reader.onerror = function() {
        progressSection.hidden = true;
        showError('Could not read the selected file.');
        analyzeBtn.disabled = false;
    };

    if (isLd) {
        reader.readAsArrayBuffer(selectedFile);
    } else {
        reader.readAsText(selectedFile);
    }
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResults(diagnostics) {
    resultsSection.hidden = false;
    summaryGrid.innerHTML = '';
    findingsContainer.innerHTML = '';

    var s = diagnostics.summary;

    // Summary stats
    addStat(s.duration, 'Log Duration');
    addStat(s.totalSamples.toLocaleString(), 'Total Samples');
    addStat(s.leanEvents.toLocaleString(), 'Lean Events');
    addStat(s.knockEvents.toLocaleString(), 'Knock Events');
    addStat(s.pressureBelowAim + '%', 'Pressure Below Aim');
    addStat(s.lowPWSamples.toLocaleString(), 'Low PW Samples');

    // Findings
    for (var i = 0; i < diagnostics.findings.length; i++) {
        var f = diagnostics.findings[i];
        var div = document.createElement('div');
        div.className = 'finding';

        var header = document.createElement('div');
        header.className = 'finding-header';

        var badge = document.createElement('span');
        badge.className = 'finding-severity severity-' + f.severity;
        badge.textContent = f.severity;
        header.appendChild(badge);

        var title = document.createElement('span');
        title.className = 'finding-title';
        title.textContent = f.title;
        header.appendChild(title);

        div.appendChild(header);

        var body = document.createElement('div');
        body.className = 'finding-body';
        var p = document.createElement('p');
        p.textContent = f.body;
        body.appendChild(p);
        div.appendChild(body);

        if (f.action) {
            var action = document.createElement('div');
            action.className = 'finding-action';
            action.textContent = '\u2192 ' + f.action;
            div.appendChild(action);
        }

        findingsContainer.appendChild(div);
    }
}

function addStat(value, label) {
    var div = document.createElement('div');
    div.className = 'summary-stat';
    var valSpan = document.createElement('span');
    valSpan.className = 'stat-value';
    valSpan.textContent = value;
    var labelSpan = document.createElement('span');
    labelSpan.className = 'stat-label';
    labelSpan.textContent = label;
    div.appendChild(valSpan);
    div.appendChild(labelSpan);
    summaryGrid.appendChild(div);
}

function showError(message) {
    errorContainer.textContent = message;
    errorContainer.hidden = false;
}
