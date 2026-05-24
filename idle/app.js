/**
 * idle/app.js — UI Controller for the Idle Behavior Analyzer page.
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

function createIdleWorker() {
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

        worker = createIdleWorker();
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
    renderCoolantCorrelation(analysis.coolantTempCorrelation);
}

// ---------------------------------------------------------------------------
// Channel Mapping Rendering
// ---------------------------------------------------------------------------

function renderChannelMapping(channelMapping) {
    clearElement(channelInfoEl);
    if (!channelMapping) return;

    var channelLabels = {
        rpm: 'Engine Speed',
        idle_aim: 'Idle Speed Aim',
        tps: 'Throttle Position',
        map: 'Inlet Manifold Pressure',
        coolant_temp: 'Coolant Temperature',
        idle_mass_flow: 'Idle Mass Flow',
        idle_mass_flow_ff: 'Idle Mass Flow FF',
        clutch_pos: 'Clutch Position'
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

    // Total decel events
    addStat(grid, analysis.totalDecelEvents, 'Decel Events', '');
    // Hang events
    var hangPct = analysis.totalDecelEvents > 0
        ? (analysis.hangEvents / analysis.totalDecelEvents * 100).toFixed(0) + '%'
        : '0%';
    addStat(grid, analysis.hangEvents + ' (' + hangPct + ')', 'Idle Hangs',
        analysis.hangEvents > 0 ? 'stat-warning' : 'stat-healthy');

    // Normal events
    addStat(grid, analysis.normalEvents, 'Normal Settles', 'stat-healthy');
    // Avg settle time
    addStat(grid, analysis.avgSettleTime.toFixed(1) + 's', 'Avg Settle Time', '');
    // Worst settle time
    addStat(grid, analysis.worstSettleTime.toFixed(1) + 's', 'Worst Settle Time',
        analysis.worstSettleTime > 5 ? 'stat-warning' : '');
    // Avg hang RPM
    if (analysis.hangEvents > 0) {
        addStat(grid, Math.round(analysis.avgHangRpm) + ' RPM', 'Avg Hang RPM', 'stat-warning');
    }

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

    var messages = [];

    if (analysis.totalDecelEvents === 0) {
        messages.push({ text: 'No deceleration events detected in this log.', severity: 'warning' });
    } else {
        if (analysis.hangEvents === 0) {
            messages.push({
                text: 'No idle hang detected. All ' + analysis.totalDecelEvents + ' decel events settled normally.',
                severity: 'healthy'
            });
        } else {
            var pct = (analysis.hangEvents / analysis.totalDecelEvents * 100).toFixed(0);
            messages.push({
                text: 'Idle hang detected in ' + analysis.hangEvents + ' of ' +
                      analysis.totalDecelEvents + ' decel events (' + pct + '%).',
                severity: 'severe'
            });
        }

        if (analysis.worstSettleTime > 5) {
            messages.push({
                text: 'Worst settle time is ' + analysis.worstSettleTime.toFixed(1) +
                      's — consider reviewing idle control parameters.',
                severity: 'warning'
            });
        }

        if (analysis.avgSettleTime > 3) {
            messages.push({
                text: 'Average settle time (' + analysis.avgSettleTime.toFixed(1) +
                      's) is elevated — idle mass flow feed forward may need adjustment.',
                severity: 'warning'
            });
        }

        // Coolant correlation insight
        var cold = analysis.coolantTempCorrelation.cold;
        var warm = analysis.coolantTempCorrelation.warm;
        if (cold.events > 0 && cold.hangs / cold.events > 0.5) {
            messages.push({
                text: 'High hang rate when cold (' + cold.hangs + '/' + cold.events +
                      ') — cold start idle calibration may need attention.',
                severity: 'warning'
            });
        }
    }

    for (var i = 0; i < messages.length; i++) {
        var div = document.createElement('div');
        div.className = 'diagnostic diagnostic-' + messages[i].severity;
        div.textContent = messages[i].text;
        content.appendChild(div);
    }
}

// ---------------------------------------------------------------------------
// Coolant Correlation Rendering
// ---------------------------------------------------------------------------

function renderCoolantCorrelation(correlation) {
    var content = document.getElementById('coolant-content');
    if (!content) return;
    clearElement(content);

    if (!correlation) {
        renderUnavailable(content, 'Coolant temperature data not available.');
        return;
    }

    var total = correlation.cold.events + correlation.warm.events + correlation.hot.events;
    if (total === 0) {
        renderUnavailable(content, 'No coolant temperature data available for correlation.');
        return;
    }

    var table = document.createElement('table');
    table.className = 'coolant-table';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Temp Range', 'Events', 'Hangs', 'Hang Rate'];
    for (var h = 0; h < headers.length; h++) {
        var th = document.createElement('th');
        th.textContent = headers[h];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var ranges = [
        { label: 'Cold (< 60\u00B0C)', data: correlation.cold },
        { label: 'Warm (60-85\u00B0C)', data: correlation.warm },
        { label: 'Hot (> 85\u00B0C)', data: correlation.hot }
    ];

    for (var r = 0; r < ranges.length; r++) {
        var tr = document.createElement('tr');
        var range = ranges[r];

        var tdLabel = document.createElement('td');
        tdLabel.textContent = range.label;
        tr.appendChild(tdLabel);

        var tdEvents = document.createElement('td');
        tdEvents.textContent = range.data.events;
        tr.appendChild(tdEvents);

        var tdHangs = document.createElement('td');
        tdHangs.textContent = range.data.hangs;
        tr.appendChild(tdHangs);

        var tdRate = document.createElement('td');
        var rate = range.data.events > 0
            ? (range.data.hangs / range.data.events * 100).toFixed(0) + '%'
            : 'N/A';
        tdRate.textContent = rate;
        tr.appendChild(tdRate);

        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    content.appendChild(table);
}

// ---------------------------------------------------------------------------
// Chart Rendering
// ---------------------------------------------------------------------------

function renderCharts(chartData, analysis) {
    // Show charts section BEFORE rendering so Chart.js can measure dimensions
    chartsSection.hidden = false;

    var rpmTimelineCanvas = document.getElementById('chart-rpm-timeline');
    var decelOverlayCanvas = document.getElementById('chart-decel-overlay');
    var settleDistCanvas = document.getElementById('chart-settle-dist');
    var mapEventsCanvas = document.getElementById('chart-map-events');
    var massFlowCanvas = document.getElementById('chart-mass-flow');

    renderRpmTimeline(rpmTimelineCanvas, chartData, analysis.events);
    renderDecelOverlay(decelOverlayCanvas, analysis.events);
    renderSettleDistribution(settleDistCanvas, analysis.events);
    renderMapEvents(mapEventsCanvas, analysis.events);
    renderMassFlowComparison(massFlowCanvas, analysis.events);
}

// ---------------------------------------------------------------------------
// Rendering Helpers
// ---------------------------------------------------------------------------

function clearElement(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

function renderUnavailable(container, message) {
    var p = document.createElement('p');
    p.textContent = message;
    p.style.color = '#a0a0b0';
    p.style.fontStyle = 'italic';
    container.appendChild(p);
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

csvInput.addEventListener('change', handleFileSelect);
analyzeBtn.addEventListener('click', function() {
    clearErrorBanner();
    handleAnalyzeClick();
});
