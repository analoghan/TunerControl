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

    // Render knock vs engine load normalized table
    renderKnockByLoad(analysis.knockByLoad);

    // Render per-cylinder RPM × Load knock grid
    renderKnockRpmLoadGrid(analysis.knockRpmLoadGrid);
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
// Knock vs Engine Load Normalized Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the knock vs engine load normalized table.
 * Shows knock event rate (events/minute) per load bin, normalized by dwell time.
 * Only displays bins that have either events or significant dwell time.
 *
 * @param {Object|null} knockByLoad - Result from computeKnockByLoadNormalized
 */
function renderKnockByLoad(knockByLoad) {
    var content = document.getElementById('knock-by-load-content');
    if (!content) return;

    clearElement(content);

    var block = content.closest('.report-block');

    if (!knockByLoad || !knockByLoad.bins) {
        if (block) block.hidden = true;
        return;
    }

    if (block) block.hidden = false;

    // Filter to bins with either events or meaningful dwell time (>1s)
    var activeBins = [];
    for (var i = 0; i < knockByLoad.bins.length; i++) {
        var bin = knockByLoad.bins[i];
        if (bin.events > 0 || bin.dwellTime > 1) {
            activeBins.push(bin);
        }
    }

    if (activeBins.length === 0) {
        renderUnavailable(content, 'No load data available for normalization.');
        return;
    }

    // Summary
    var summary = document.createElement('p');
    summary.className = 'distribution-summary';
    summary.textContent = 'Knock event rate normalized by time spent at each engine load (MAP) range. Higher rate = more knock-prone at that load.';
    content.appendChild(summary);

    // Create table
    var table = document.createElement('table');
    table.className = 'distribution-table';

    // Header row
    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Load (kPa)', 'Events', 'Dwell (s)', 'Rate (events/min)', 'Avg Level', 'Max Level'];
    for (var h = 0; h < headers.length; h++) {
        var th = document.createElement('th');
        th.textContent = headers[h];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows — sorted by rate descending for quick identification of problem areas
    activeBins.sort(function(a, b) { return b.rate - a.rate; });

    var tbody = document.createElement('tbody');
    for (var i = 0; i < activeBins.length; i++) {
        var bin = activeBins[i];
        var tr = document.createElement('tr');

        var tdLoad = document.createElement('td');
        tdLoad.textContent = bin.loadMin + '–' + bin.loadMax;
        tr.appendChild(tdLoad);

        var tdEvents = document.createElement('td');
        tdEvents.textContent = bin.events.toLocaleString();
        tr.appendChild(tdEvents);

        var tdDwell = document.createElement('td');
        tdDwell.textContent = bin.dwellTime.toFixed(1);
        tr.appendChild(tdDwell);

        var tdRate = document.createElement('td');
        tdRate.textContent = bin.rate.toFixed(2);
        if (bin.rate > 0) {
            tdRate.style.color = '#f44336';
            tdRate.style.fontWeight = '600';
        }
        tr.appendChild(tdRate);

        var tdAvg = document.createElement('td');
        tdAvg.textContent = bin.events > 0 ? bin.avgLevel.toFixed(1) : '—';
        tr.appendChild(tdAvg);

        var tdMax = document.createElement('td');
        tdMax.textContent = bin.events > 0 ? bin.maxLevel.toFixed(1) : '—';
        tr.appendChild(tdMax);

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    content.appendChild(table);
}

// ---------------------------------------------------------------------------
// Knock Rate Grid — RPM × Load (per Cylinder) Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the per-cylinder RPM × Load knock rate grid with a cylinder selector.
 * Layout matches MoTeC spark table: Load (MAP) on rows, RPM on columns.
 * Color-coded by knock rate intensity.
 *
 * @param {Object|null} gridData - Result from computeKnockRpmLoadGrid
 */
function renderKnockRpmLoadGrid(gridData) {
    var content = document.getElementById('knock-rpm-load-grid-content');
    if (!content) return;

    clearElement(content);

    var block = content.closest('.report-block');

    if (!gridData || !gridData.cylinders) {
        if (block) block.hidden = true;
        return;
    }

    if (block) block.hidden = false;

    // Description
    var desc = document.createElement('p');
    desc.className = 'distribution-summary';
    desc.textContent = 'Knock events/minute normalized by dwell time at each RPM × Load cell. Select a cylinder to isolate its knock pattern. Layout matches MoTeC spark table (Load rows, RPM columns).';
    content.appendChild(desc);

    // Cylinder selector
    var controlRow = document.createElement('div');
    controlRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;';

    var label = document.createElement('label');
    label.textContent = 'Cylinder:';
    label.style.cssText = 'font-weight:500;color:#b0b0b0;';
    controlRow.appendChild(label);

    var select = document.createElement('select');
    select.style.cssText = 'background:#222;border:1px solid #333;border-radius:4px;color:#fff;padding:6px 10px;font-size:0.85rem;';

    var optAll = document.createElement('option');
    optAll.value = '0';
    optAll.textContent = 'All Cylinders';
    select.appendChild(optAll);

    for (var c = 1; c <= 8; c++) {
        var opt = document.createElement('option');
        opt.value = String(c);
        opt.textContent = 'Cylinder ' + c;
        select.appendChild(opt);
    }
    controlRow.appendChild(select);

    // Display mode selector
    var modeLabel = document.createElement('label');
    modeLabel.textContent = 'Show:';
    modeLabel.style.cssText = 'font-weight:500;color:#b0b0b0;margin-left:12px;';
    controlRow.appendChild(modeLabel);

    var modeSelect = document.createElement('select');
    modeSelect.style.cssText = 'background:#222;border:1px solid #333;border-radius:4px;color:#fff;padding:6px 10px;font-size:0.85rem;';

    var modes = [
        { value: 'rate', label: 'Rate (events/min)' },
        { value: 'weightedRate', label: 'Severity-Weighted Rate' },
        { value: 'events', label: 'Event Count' },
        { value: 'maxLevel', label: 'Max Knock Level' },
        { value: 'avgTiming', label: 'Timing at Knock (°)' }
    ];
    for (var m = 0; m < modes.length; m++) {
        var mOpt = document.createElement('option');
        mOpt.value = modes[m].value;
        mOpt.textContent = modes[m].label;
        modeSelect.appendChild(mOpt);
    }
    controlRow.appendChild(modeSelect);

    content.appendChild(controlRow);

    // Table container
    var tableContainer = document.createElement('div');
    tableContainer.style.cssText = 'overflow-x:auto;margin-top:8px;';
    content.appendChild(tableContainer);

    function renderGrid() {
        tableContainer.innerHTML = '';
        var cylIdx = parseInt(select.value, 10);
        var mode = modeSelect.value;
        var grid = gridData.cylinders[cylIdx];
        if (!grid) return;

        var table = document.createElement('table');
        table.className = 'distribution-table';
        table.style.cssText = 'border-collapse:collapse;font-size:0.75rem;white-space:nowrap;';

        // Find max value for color scaling
        var maxVal = 0;
        for (var l = 0; l < grid.length; l++) {
            for (var r = 0; r < grid[l].length; r++) {
                var val = mode === 'rate' ? grid[l][r].rate :
                          mode === 'weightedRate' ? grid[l][r].weightedRate :
                          mode === 'events' ? grid[l][r].events :
                          mode === 'avgTiming' ? (grid[l][r].avgTiming !== null ? grid[l][r].avgTiming : 0) :
                          grid[l][r].maxLevel;
                if (val > maxVal) maxVal = val;
            }
        }

        // Header row: corner + RPM labels
        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        var cornerTh = document.createElement('th');
        cornerTh.textContent = 'Load\\RPM';
        cornerTh.style.cssText = 'background:#222;color:#fff;padding:4px 6px;border:1px solid #333;position:sticky;left:0;z-index:2;';
        headerRow.appendChild(cornerTh);

        for (var r = 0; r < gridData.rpmLabels.length; r++) {
            var th = document.createElement('th');
            th.textContent = gridData.rpmLabels[r];
            th.style.cssText = 'background:#222;color:#fff;padding:4px 6px;border:1px solid #333;font-size:0.7rem;';
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Data rows: load bins (high to low for natural MAP reading)
        var tbody = document.createElement('tbody');
        for (var l = grid.length - 1; l >= 0; l--) {
            // Skip rows with zero dwell across all RPM bins
            var hasData = false;
            for (var r = 0; r < grid[l].length; r++) {
                if (gridData.dwellGrid[l][r] > 0) { hasData = true; break; }
            }
            if (!hasData) continue;

            var tr = document.createElement('tr');
            var rowTh = document.createElement('th');
            rowTh.textContent = gridData.loadLabels[l];
            rowTh.style.cssText = 'background:#222;color:#fff;padding:4px 6px;border:1px solid #333;font-weight:600;position:sticky;left:0;z-index:1;';
            tr.appendChild(rowTh);

            for (var r = 0; r < grid[l].length; r++) {
                var cell = grid[l][r];
                var td = document.createElement('td');
                td.style.cssText = 'padding:4px 6px;border:1px solid #333;text-align:center;min-width:44px;';

                var val = mode === 'rate' ? cell.rate :
                          mode === 'weightedRate' ? cell.weightedRate :
                          mode === 'events' ? cell.events :
                          mode === 'avgTiming' ? (cell.avgTiming !== null ? cell.avgTiming : 0) :
                          cell.maxLevel;

                if (gridData.dwellGrid[l][r] < 0.5) {
                    // No meaningful dwell — grey out
                    td.style.background = '#1a1a1a';
                    td.style.color = '#444';
                    td.textContent = '—';
                } else if (mode === 'avgTiming') {
                    // Timing mode: show timing value, color by whether knock occurred
                    if (cell.avgTiming === null || cell.events === 0) {
                        td.style.background = 'rgba(76,175,80,0.15)';
                        td.style.color = '#4caf50';
                        td.textContent = '—';
                    } else {
                        // Higher timing at knock = more aggressive, show as red
                        var intensity = maxVal > 0 ? Math.min(val / maxVal, 1) : 0;
                        td.style.background = 'rgba(255,152,0,0.3)';
                        td.style.color = '#ff9800';
                        td.style.fontWeight = '600';
                        td.textContent = val.toFixed(1) + '\u00B0';
                    }
                } else if (val === 0) {
                    td.style.background = 'rgba(76,175,80,0.15)';
                    td.style.color = '#4caf50';
                    td.textContent = '0';
                } else {
                    // Color intensity based on value relative to max
                    var intensity = maxVal > 0 ? Math.min(val / maxVal, 1) : 0;
                    var red = Math.round(60 + intensity * 195);
                    var green = Math.round(60 - intensity * 40);
                    var blue = Math.round(60 - intensity * 40);
                    td.style.background = 'rgba(' + red + ',' + green + ',' + blue + ',0.4)';
                    td.style.color = '#f44336';
                    td.style.fontWeight = '600';
                    td.textContent = mode === 'rate' ? val.toFixed(1) :
                                     mode === 'events' ? val :
                                     val.toFixed(1);
                }

                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableContainer.appendChild(table);
    }

    select.addEventListener('change', renderGrid);
    modeSelect.addEventListener('change', renderGrid);

    // Initial render
    renderGrid();
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
