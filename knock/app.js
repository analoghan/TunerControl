/**
 * knock/app.js — UI Controller for the Knock Analyzer page.
 * Manages file input, worker lifecycle, progress display, and report rendering.
 *
 * Requirements: 1.3, 2.5, 3.3, 3.5, 6.1, 6.5, 8.5, 9.4, 9.5, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3
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

/**
 * Handles file input change event.
 * Validates that the selected file has a .csv or .ld extension (case-insensitive).
 * Enables/disables the Analyze button accordingly.
 *
 * @param {Event} event - The change event from the file input
 */
function handleFileSelect(event) {
    var file = csvInput.files[0] || null;

    // Clear any previous error banner when a new file is selected
    clearErrorBanner();

    // Terminate any running worker from a previous analysis
    if (worker) {
        worker.terminate();
        worker = null;
    }

    // Hide progress if it was showing from a previous analysis
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

/**
 * Creates a Web Worker using the Blob URL pattern for file:// compatibility.
 * This allows the worker to load even when opened directly from the filesystem.
 *
 * @returns {Worker} A new Web Worker instance
 */
function createKnockWorker() {
    var workerUrl = new URL('worker.js', window.location.href).href;
    var blob = new Blob(['importScripts("' + workerUrl + '");'], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

/**
 * Handles the Analyze button click.
 * Reads the selected file as text (CSV) or ArrayBuffer (.ld), creates a worker,
 * and posts the data.
 */
function handleAnalyzeClick() {
    if (!selectedFile) return;

    // Reset UI state
    analyzeBtn.disabled = true;
    fileError.hidden = true;
    reportSection.hidden = true;
    chartsSection.hidden = true;
    collectedWarnings = [];

    // Show progress section and reset it
    progressSection.hidden = false;
    progressBarFill.style.width = '0%';
    progressPct.textContent = '0%';
    progressPhase.textContent = '';

    // Update the progressbar ARIA attribute
    var progressTrack = progressBarFill.parentElement;
    if (progressTrack) {
        progressTrack.setAttribute('aria-valuenow', '0');
    }

    var isLD = selectedFile.name.toLowerCase().endsWith('.ld');

    // Read file
    var reader = new FileReader();
    reader.onload = function () {
        // Terminate any existing worker
        if (worker) {
            worker.terminate();
            worker = null;
        }

        // Create new worker and set up message handling
        worker = createKnockWorker();
        worker.onmessage = handleWorkerMessage;
        worker.onerror = function (err) {
            // Unexpected worker crash
            progressSection.hidden = true;
            showErrorBanner('An unexpected error occurred during analysis. Please try again.');
            analyzeBtn.disabled = false;
            if (worker) {
                worker.terminate();
                worker = null;
            }
        };

        if (isLD) {
            // Post ArrayBuffer for .ld binary parsing
            worker.postMessage({ type: 'analyze_ld', buffer: reader.result });
        } else {
            // Post text for CSV parsing
            worker.postMessage({ type: 'analyze', logText: reader.result });
        }
    };

    reader.onerror = function () {
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

/**
 * Dispatches worker messages based on their type.
 *
 * @param {MessageEvent} event - The message event from the worker
 */
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

            // Render charts from chartData
            renderCharts(data.chartData);

            analyzeBtn.disabled = false;
            // Terminate worker to free resources
            if (worker) {
                worker.terminate();
                worker = null;
            }
            break;

        case 'error':
            progressSection.hidden = true;
            showErrorBanner(data.message);
            analyzeBtn.disabled = false;
            // Terminate worker to free resources
            if (worker) {
                worker.terminate();
                worker = null;
            }
            break;
    }
}

// ---------------------------------------------------------------------------
// Progress Display
// ---------------------------------------------------------------------------

/**
 * Updates the progress bar with current analysis progress.
 *
 * @param {string} phase - Current analysis phase label
 * @param {number} percent - Percentage complete (0–100)
 */
function updateProgress(phase, percent) {
    var pct = Math.max(0, Math.min(100, Math.round(percent)));
    progressBarFill.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    progressPhase.textContent = phase || '';

    // Update ARIA
    var progressTrack = progressBarFill.parentElement;
    if (progressTrack) {
        progressTrack.setAttribute('aria-valuenow', String(pct));
    }
}

// ---------------------------------------------------------------------------
// Error Display
// ---------------------------------------------------------------------------

/**
 * Shows an error banner in the report section area.
 * Uses textContent for safe rendering.
 *
 * @param {string} message - The error message to display
 */
function showErrorBanner(message) {
    // Remove any existing error banner
    var existing = document.querySelector('.error-banner');
    if (existing) {
        existing.parentElement.removeChild(existing);
    }

    var banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.setAttribute('role', 'alert');
    banner.textContent = message;

    // Insert after the file section
    var fileSection = csvInput.closest('.file-section');
    if (fileSection && fileSection.nextElementSibling) {
        fileSection.parentElement.insertBefore(banner, fileSection.nextElementSibling);
    } else {
        document.querySelector('.app-container').appendChild(banner);
    }
}

/**
 * Removes any existing error banner from the page.
 */
function clearErrorBanner() {
    var existing = document.querySelector('.error-banner');
    if (existing) {
        existing.parentElement.removeChild(existing);
    }
}

// ---------------------------------------------------------------------------
// Report Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the full analysis report from the worker results.
 * Uses textContent and DOM element creation — never innerHTML with user data.
 *
 * @param {Object} analysis - The AnalysisResult object from the worker
 */
function renderReport(analysis) {
    // Clear any previous error banner
    clearErrorBanner();

    // Show report section
    reportSection.hidden = false;

    // Render channel mapping
    renderChannelMapping(analysis.channelMapping);

    // Render warnings
    renderWarnings(analysis.channelWarnings);

    // Render diagnostic summary
    renderDiagnostics(analysis.diagnostics);

    // Render cylinder distribution table
    renderCylinderDistribution(analysis.cylinderDistribution);

    // Render timing recommendations table
    renderTimingRecommendations(analysis.timingRecommendations);
}

// ---------------------------------------------------------------------------
// Chart Rendering
// ---------------------------------------------------------------------------

/**
 * Renders all analysis charts using the chartData from the worker.
 * Calls each chart renderer with the appropriate canvas and data.
 * Handles null retardTimeSeries (renderTimingRetardTimeSeries handles null internally).
 * All chart renderers handle zero-event scenarios internally.
 *
 * @param {Object} chartData - The ChartData object from the worker
 * @param {Array} chartData.knockEvents - All classified knock events
 * @param {Object} chartData.cylinderDistribution - CylinderDistribution object
 * @param {Object} chartData.heatmapData - HeatmapData object
 * @param {Object|null} chartData.retardTimeSeries - { time: number[], values: number[] } or null
 * @param {Object} chartData.timingCorrelation - TimingCorrelation object
 */
function renderCharts(chartData) {
    // Show the charts section BEFORE rendering so Chart.js can measure dimensions
    chartsSection.hidden = false;

    // Get canvas elements
    var cylinderBarCanvas = document.getElementById('chart-cylinder-bar');
    var knockRpmScatterCanvas = document.getElementById('chart-knock-rpm-scatter');
    var knockHeatmapCanvas = document.getElementById('chart-knock-heatmap');
    var timingRpmScatterCanvas = document.getElementById('chart-timing-rpm-scatter');
    var timingRetardTsCanvas = document.getElementById('chart-timing-retard-ts');

    // Render each chart (renderers handle zero-event and null cases internally)
    renderCylinderBarChart(cylinderBarCanvas, chartData.cylinderDistribution);
    renderKnockVsRpmScatter(knockRpmScatterCanvas, chartData.knockEvents);
    renderKnockHeatmap(knockHeatmapCanvas, chartData.heatmapData);
    renderTimingVsRpmScatter(timingRpmScatterCanvas, chartData.knockEvents);
    renderTimingRetardTimeSeries(timingRetardTsCanvas, chartData.retardTimeSeries);
}

// ---------------------------------------------------------------------------
// Channel Mapping Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the channel mapping information showing which channels were resolved.
 *
 * @param {Object} channelMapping - Object with channel keys mapped to boolean (found/not found)
 */
function renderChannelMapping(channelMapping) {
    // Clear previous content
    clearElement(channelInfoEl);

    if (!channelMapping) return;

    var channelLabels = {
        knock_cyl_1: 'Knock Cyl 1',
        knock_cyl_2: 'Knock Cyl 2',
        knock_cyl_3: 'Knock Cyl 3',
        knock_cyl_4: 'Knock Cyl 4',
        knock_cyl_5: 'Knock Cyl 5',
        knock_cyl_6: 'Knock Cyl 6',
        knock_cyl_7: 'Knock Cyl 7',
        knock_cyl_8: 'Knock Cyl 8',
        ign_timing: 'Ignition Timing',
        ign_timing_comp: 'Timing Compensation',
        rpm: 'Engine Speed',
        map: 'Inlet Manifold Pressure',
        tps: 'Throttle Position',
        gear: 'Gear',
        coolant_temp: 'Coolant Temperature'
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

/**
 * Renders channel resolution warnings and any collected worker warnings.
 *
 * @param {string[]} channelWarnings - Warnings from channel resolution
 */
function renderWarnings(channelWarnings) {
    // Combine channel warnings with any collected worker warnings
    var allWarnings = collectedWarnings.concat(channelWarnings || []);

    // Clear previous warnings
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
// Diagnostics Rendering
// ---------------------------------------------------------------------------

/**
 * Renders diagnostic messages with appropriate severity classes.
 * Uses diagnostic-warning and diagnostic-healthy CSS classes.
 *
 * @param {string[]} diagnostics - Array of diagnostic message strings
 */
function renderDiagnostics(diagnostics) {
    var content = document.getElementById('diagnostics-content');
    if (!content) return;

    clearElement(content);

    if (!diagnostics || diagnostics.length === 0) {
        renderUnavailable(content, 'No diagnostic messages available');
        return;
    }

    for (var i = 0; i < diagnostics.length; i++) {
        var msg = diagnostics[i];
        var div = document.createElement('div');
        div.className = 'diagnostic ' + classifyDiagnostic(msg);
        div.textContent = msg;
        content.appendChild(div);
    }
}

/**
 * Classifies a diagnostic message to determine its CSS class.
 * Returns 'diagnostic-warning' or 'diagnostic-healthy'.
 *
 * @param {string} message - The diagnostic message text
 * @returns {string} CSS class name for the diagnostic severity
 */
function classifyDiagnostic(message) {
    var lower = message.toLowerCase();
    if (lower.indexOf('no knock events') !== -1) {
        return 'diagnostic-healthy';
    }
    return 'diagnostic-warning';
}

// ---------------------------------------------------------------------------
// Cylinder Distribution Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the per-cylinder knock distribution as a table.
 *
 * @param {Object} distribution - CylinderDistribution object with counts, percentages, total, ranking
 */
function renderCylinderDistribution(distribution) {
    var content = document.getElementById('cylinder-distribution-content');
    if (!content) return;

    clearElement(content);

    if (!distribution || distribution.total === 0) {
        renderUnavailable(content, 'No knock events detected at the current threshold.');
        return;
    }

    // Summary line
    var summary = document.createElement('p');
    summary.className = 'distribution-summary';
    summary.textContent = 'Total knock events: ' + distribution.total.toLocaleString();
    content.appendChild(summary);

    // Create table
    var table = document.createElement('table');
    table.className = 'distribution-table';

    // Header row
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Cylinder', 'Count', 'Percentage'];
    for (var h = 0; h < headers.length; h++) {
        var th = document.createElement('th');
        th.textContent = headers[h];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows (one per cylinder, ordered 1–8)
    var tbody = document.createElement('tbody');
    for (var c = 0; c < distribution.counts.length; c++) {
        var tr = document.createElement('tr');

        var tdCyl = document.createElement('td');
        tdCyl.textContent = 'Cyl ' + (c + 1);
        tr.appendChild(tdCyl);

        var tdCount = document.createElement('td');
        tdCount.textContent = distribution.counts[c].toLocaleString();
        tr.appendChild(tdCount);

        var tdPct = document.createElement('td');
        tdPct.textContent = distribution.percentages[c].toFixed(1) + '%';
        tr.appendChild(tdPct);

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    content.appendChild(table);
}

// ---------------------------------------------------------------------------
// Timing Recommendations Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the timing adjustment recommendations as a table.
 * Hides the section if there are no recommendations (zero knock events).
 *
 * @param {Array<{cylinderIndex: number, reductionDeg: number}>} recommendations - Array of timing recommendations
 */
function renderTimingRecommendations(recommendations) {
    var content = document.getElementById('timing-recommendations-content');
    if (!content) return;

    clearElement(content);

    // Hide the entire recommendations block if empty (no knock events)
    var recommendationsBlock = content.closest('.report-block');
    if (!recommendations || recommendations.length === 0) {
        if (recommendationsBlock) {
            recommendationsBlock.hidden = true;
        }
        return;
    }

    if (recommendationsBlock) {
        recommendationsBlock.hidden = false;
    }

    // Create table
    var table = document.createElement('table');
    table.className = 'recommendations-table';

    // Header row
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Cylinder', 'Recommended Timing Reduction (\u00B0)'];
    for (var h = 0; h < headers.length; h++) {
        var th = document.createElement('th');
        th.textContent = headers[h];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows
    var tbody = document.createElement('tbody');
    for (var i = 0; i < recommendations.length; i++) {
        var rec = recommendations[i];
        var tr = document.createElement('tr');

        var tdCyl = document.createElement('td');
        tdCyl.textContent = 'Cyl ' + rec.cylinderIndex;
        tr.appendChild(tdCyl);

        var tdReduction = document.createElement('td');
        tdReduction.textContent = rec.reductionDeg.toFixed(1);
        tr.appendChild(tdReduction);

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    content.appendChild(table);
}

// ---------------------------------------------------------------------------
// Rendering Helpers
// ---------------------------------------------------------------------------

/**
 * Removes all child nodes from an element.
 *
 * @param {HTMLElement} el - The element to clear
 */
function clearElement(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

/**
 * Renders an "unavailable" message for a section whose data was not available.
 *
 * @param {HTMLElement} container - The container to render into
 * @param {string} message - The unavailability message
 */
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
analyzeBtn.addEventListener('click', function () {
    // Clear any previous error banner before starting new analysis
    clearErrorBanner();
    handleAnalyzeClick();
});
