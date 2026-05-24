/**
 * fuel-pressure/app.js — UI Controller for the DI Fuel Pressure Deep Dive page.
 * Manages file input, worker lifecycle, progress display, and report rendering.
 */

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------

var csvInput = document.getElementById('csv-input');
var analyzeBtn = document.getElementById('analyze-btn');
var fileError = document.getElementById('file-error');

var progressSection = document.getElementById('progress-section');
var progressBarFill = document.getElementById('progress-bar-fill');
var progressPct = document.getElementById('progress-pct');
var progressPhase = document.getElementById('progress-phase');

var reportSection = document.getElementById('report-section');
var chartsSection = document.getElementById('charts-section');

var channelInfoEl = document.getElementById('channel-info');
var warningsArea = document.getElementById('warnings-area');
var warningsList = document.getElementById('warnings-list');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var selectedFile = null;
var worker = null;
var collectedWarnings = [];

// ---------------------------------------------------------------------------
// File Input Handling
// ---------------------------------------------------------------------------

function handleFileSelect(event) {
    var file = csvInput.files[0] || null;
    clearErrorBanner();

    if (worker) {
        worker.terminate();
        worker = null;
    }
    progressSection.hidden = true;

    if (!file) {
        selectedFile = null;
        analyzeBtn.disabled = true;
        fileError.hidden = true;
        return;
    }

    var name = file.name || '';
    var isCSV = name.toLowerCase().endsWith('.csv');
    var isLD = name.toLowerCase().endsWith('.ld');

    if (isCSV || isLD) {
        selectedFile = file;
        analyzeBtn.disabled = false;
        fileError.hidden = true;
    } else {
        selectedFile = null;
        analyzeBtn.disabled = true;
        fileError.textContent = 'Please select a .csv or .ld file';
        fileError.hidden = false;
    }
}

// ---------------------------------------------------------------------------
// Worker Lifecycle
// ---------------------------------------------------------------------------

function createFuelPressureWorker() {
    var workerUrl = new URL('worker.js', window.location.href).href;
    var blob = new Blob(['importScripts("' + workerUrl + '");'], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

function handleAnalyzeClick() {
    if (!selectedFile) return;

    analyzeBtn.disabled = true;
    fileError.hidden = true;
    reportSection.hidden = true;
    chartsSection.hidden = true;
    collectedWarnings = [];

    progressSection.hidden = false;
    progressBarFill.style.width = '0%';
    progressPct.textContent = '0%';
    progressPhase.textContent = '';

    var progressTrack = progressBarFill.parentElement;
    if (progressTrack) {
        progressTrack.setAttribute('aria-valuenow', '0');
    }

    var isLD = selectedFile.name.toLowerCase().endsWith('.ld');

    var reader = new FileReader();
    reader.onload = function() {
        if (worker) {
            worker.terminate();
            worker = null;
        }

        worker = createFuelPressureWorker();
        worker.onmessage = handleWorkerMessage;
        worker.onerror = function(err) {
            progressSection.hidden = true;
            showErrorBanner('An unexpected error occurred during analysis. Please try again.');
            analyzeBtn.disabled = false;
            if (worker) { worker.terminate(); worker = null; }
        };

        if (isLD) {
            worker.postMessage({ type: 'analyze_ld', buffer: reader.result });
        } else {
            worker.postMessage({ type: 'analyze', logText: reader.result });
        }
    };

    reader.onerror = function() {
        progressSection.hidden = true;
        showErrorBanner('Could not read the selected file.');
        analyzeBtn.disabled = false;
    };

    if (isLD) {
        reader.readAsArrayBuffer(selectedFile);
    } else {
        reader.readAsText(selectedFile);
    }
}

// ---------------------------------------------------------------------------
// Worker Message Handling
// ---------------------------------------------------------------------------

function handleWorkerMessage(event) {
    var data = event.data;
    if (!data) return;

    switch (data.type) {
        case 'progress':
            updateProgress(data.phase, data.percent);
            break;

        case 'warning':
            collectedWarnings.push(data.message);
            break;

        case 'result':
            progressSection.hidden = true;
            renderReport(data.analysis);
            renderCharts(data.chartData, data.analysis);
            analyzeBtn.disabled = false;
            if (worker) { worker.terminate(); worker = null; }
            break;

        case 'error':
            progressSection.hidden = true;
            showErrorBanner(data.message);
            analyzeBtn.disabled = false;
            if (worker) { worker.terminate(); worker = null; }
            break;
    }
}

// ---------------------------------------------------------------------------
// Progress Display
// ---------------------------------------------------------------------------

function updateProgress(phase, percent) {
    var pct = Math.max(0, Math.min(100, Math.round(percent)));
    progressBarFill.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    progressPhase.textContent = phase || '';

    var progressTrack = progressBarFill.parentElement;
    if (progressTrack) {
        progressTrack.setAttribute('aria-valuenow', String(pct));
    }
}

// ---------------------------------------------------------------------------
// Error Display
// ---------------------------------------------------------------------------

function showErrorBanner(message) {
    var existing = document.querySelector('.error-banner');
    if (existing) {
        existing.parentElement.removeChild(existing);
    }

    var banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.setAttribute('role', 'alert');
    banner.textContent = message;

    var fileSection = csvInput.closest('.file-section');
    if (fileSection && fileSection.nextElementSibling) {
        fileSection.parentElement.insertBefore(banner, fileSection.nextElementSibling);
    } else {
        document.querySelector('.app-container').appendChild(banner);
    }
}

function clearErrorBanner() {
    var existing = document.querySelector('.error-banner');
    if (existing) {
        existing.parentElement.removeChild(existing);
    }
}

// ---------------------------------------------------------------------------
// Report Rendering
// ---------------------------------------------------------------------------

function renderReport(analysis) {
    clearErrorBanner();
    reportSection.hidden = false;

    renderChannelMapping(analysis.channelMapping);
    renderWarnings(analysis.channelWarnings);
    renderSummary(analysis);
    renderDiagnostics(analysis);
}

// ---------------------------------------------------------------------------
// Channel Mapping Rendering
// ---------------------------------------------------------------------------

function renderChannelMapping(channelMapping) {
    clearElement(channelInfoEl);
    if (!channelMapping) return;

    var channelLabels = {
        fuel_press: 'Fuel Pressure',
        fuel_press_aim: 'Fuel Pressure Aim',
        fuel_press_control: 'Fuel Pressure Control',
        rpm: 'Engine Speed',
        inj_duty: 'Injector Duty Cycle',
        fuel_flow: 'Fuel Flow',
        fuel_volume: 'Fuel Volume',
        throttle_pedal: 'Throttle Pedal'
    };

    var keys = Object.keys(channelLabels);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var found = channelMapping[key];
        var span = document.createElement('span');
        span.style.display = 'inline-block';
        span.style.marginRight = '12px';
        span.style.marginBottom = '4px';

        var indicator = document.createElement('span');
        indicator.textContent = found ? '\u2713 ' : '\u2717 ';
        indicator.style.color = found ? '#6fdc8c' : '#ff6b7a';
        indicator.style.fontWeight = '600';

        var label = document.createElement('span');
        label.textContent = channelLabels[key];

        span.appendChild(indicator);
        span.appendChild(label);
        channelInfoEl.appendChild(span);
    }
}

// ---------------------------------------------------------------------------
// Warnings Rendering
// ---------------------------------------------------------------------------

function renderWarnings(channelWarnings) {
    var allWarnings = collectedWarnings.concat(channelWarnings || []);
    clearElement(warningsList);

    if (allWarnings.length === 0) {
        warningsArea.hidden = true;
        return;
    }

    warningsArea.hidden = false;
    for (var i = 0; i < allWarnings.length; i++) {
        var li = document.createElement('li');
        li.textContent = allWarnings[i];
        warningsList.appendChild(li);
    }
}

// ---------------------------------------------------------------------------
// Summary Rendering
// ---------------------------------------------------------------------------

function renderSummary(analysis) {
    var content = document.getElementById('summary-content');
    if (!content) return;
    clearElement(content);

    var grid = document.createElement('div');
    grid.className = 'summary-grid';

    addStat(grid, analysis.meanError.toFixed(2) + ' bar', 'Mean Error', '');
    addStat(grid, analysis.meanAbsError.toFixed(2) + ' bar', 'Mean |Error|', '');
    addStat(grid, analysis.maxOvershoot.toFixed(1) + ' bar', 'Max Overshoot',
        analysis.maxOvershoot > 5 ? 'stat-warning' : '');
    addStat(grid, analysis.maxUndershoot.toFixed(1) + ' bar', 'Max Undershoot',
        analysis.maxUndershoot < -5 ? 'stat-warning' : '');
    addStat(grid, analysis.pctWithinTolerance.toFixed(1) + '%', 'Within \u00B12 bar',
        analysis.pctWithinTolerance > 95 ? 'stat-healthy' : (analysis.pctWithinTolerance < 80 ? 'stat-warning' : ''));
    addStat(grid, analysis.transientEvents.length.toString(), 'Transient Events', '');

    content.appendChild(grid);
}

function addStat(container, value, label, extraClass) {
    var div = document.createElement('div');
    div.className = 'summary-stat' + (extraClass ? ' ' + extraClass : '');

    var valSpan = document.createElement('span');
    valSpan.className = 'stat-value';
    valSpan.textContent = value;

    var labelSpan = document.createElement('span');
    labelSpan.className = 'stat-label';
    labelSpan.textContent = label;

    div.appendChild(valSpan);
    div.appendChild(labelSpan);
    container.appendChild(div);
}

// ---------------------------------------------------------------------------
// Diagnostics Rendering
// ---------------------------------------------------------------------------

function renderDiagnostics(analysis) {
    var content = document.getElementById('diagnostics-content');
    if (!content) return;
    clearElement(content);

    var messages = analysis.diagnostics || [];

    if (messages.length === 0) {
        var div = document.createElement('div');
        div.className = 'diagnostic diagnostic-healthy';
        div.textContent = 'No significant issues detected.';
        content.appendChild(div);
        return;
    }

    for (var i = 0; i < messages.length; i++) {
        var div = document.createElement('div');
        var msg = messages[i];
        var severity = 'warning';
        if (msg.indexOf('tracks aim well') !== -1) {
            severity = 'healthy';
        } else if (msg.indexOf('Significant') !== -1 || msg.indexOf('Worst') !== -1) {
            severity = 'severe';
        }
        div.className = 'diagnostic diagnostic-' + severity;
        div.textContent = msg;
        content.appendChild(div);
    }
}

// ---------------------------------------------------------------------------
// Chart Rendering
// ---------------------------------------------------------------------------

function renderCharts(chartData, analysis) {
    // Show charts section BEFORE rendering so Chart.js can measure dimensions
    chartsSection.hidden = false;

    var pressureAimCanvas = document.getElementById('chart-pressure-aim');
    var errorTimelineCanvas = document.getElementById('chart-error-timeline');
    var errorRpmCanvas = document.getElementById('chart-error-rpm');
    var errorDutyCanvas = document.getElementById('chart-error-duty');
    var errorFlowCanvas = document.getElementById('chart-error-flow');
    var transientCanvas = document.getElementById('chart-transient');
    var histogramCanvas = document.getElementById('chart-error-histogram');

    renderPressureAimTimeline(pressureAimCanvas, chartData);
    renderErrorTimeline(errorTimelineCanvas, chartData);
    renderErrorVsRpm(errorRpmCanvas, chartData);
    renderErrorVsDuty(errorDutyCanvas, chartData);
    renderErrorVsFlow(errorFlowCanvas, chartData);
    renderTransientOverlay(transientCanvas, chartData);
    renderErrorHistogram(histogramCanvas, chartData);
}

// ---------------------------------------------------------------------------
// Rendering Helpers
// ---------------------------------------------------------------------------

function clearElement(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

csvInput.addEventListener('change', handleFileSelect);
analyzeBtn.addEventListener('click', function() {
    clearErrorBanner();
    handleAnalyzeClick();
});
