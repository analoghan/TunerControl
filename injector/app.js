/**
 * injector/app.js — UI Controller for the Injector Characterization page.
 * Manages file input, worker lifecycle, progress display, and report rendering.
 *
 * Requirements: 3.1, 3.2, 3.3, 6.4, 14.1, 14.2, 14.3, 14.4, 15.1, 15.2, 15.3, 15.4, 16.2, 16.3
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
var progressRows = document.getElementById('progress-rows');

var reportSection = document.getElementById('report-section');
var chartsSection = document.getElementById('charts-section');

var channelInfoEl = document.getElementById('channel-info');
var warningsArea = document.getElementById('warnings-area');
var warningsList = document.getElementById('warnings-list');

var reportLeanSpikes = document.getElementById('report-lean-spikes');
var reportPWStability = document.getElementById('report-pw-stability');
var reportFuelPressure = document.getElementById('report-fuel-pressure');
var reportInjectionTiming = document.getElementById('report-injection-timing');
var reportClosedLoop = document.getElementById('report-closed-loop');

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
function createInjectorWorker() {
    var workerUrl = new URL('worker.js', window.location.href).href;
    var blob = new Blob(['importScripts("' + workerUrl + '");'], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

/**
 * Handles the Analyze button click.
 * Reads the selected file as text (CSV) or ArrayBuffer (.ld), creates a worker, and posts the data.
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
    progressRows.textContent = '';

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
        worker = createInjectorWorker();
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
            updateProgress(data.rowsProcessed, data.totalRows);
            break;

        case 'warning':
            collectedWarnings.push(data.message);
            break;

        case 'result':
            progressSection.hidden = true;
            renderReport(data.analyses);
            // Render charts if the renderAllCharts function is available and chart data exists
            if (typeof renderAllCharts === 'function' && data.chartData) {
                var cd = data.chartData;
                // Only show charts section if at least one chart has renderable data
                var hasChartData = cd.lambdaB1 || cd.lambdaB2 || cd.injPW ||
                    cd.fuelPressDI || cd.injTiming;
                if (hasChartData) {
                    chartsSection.hidden = false;
                    var chartContainers = {
                        lambdaTs: document.getElementById('chart-lambda-ts'),
                        pwTs: document.getElementById('chart-pw-ts'),
                        lambdaPwScatter: document.getElementById('chart-lambda-pw-scatter'),
                        fuelPressureTs: document.getElementById('chart-fuel-pressure-ts'),
                        pwHistogram: document.getElementById('chart-pw-histogram'),
                        lambdaRpmDensity: document.getElementById('chart-lambda-rpm-density'),
                        timingRpmScatter: document.getElementById('chart-timing-rpm-scatter')
                    };
                    renderAllCharts(chartContainers, data.chartData);
                }
            }
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
 * Updates the progress bar with current parsing progress.
 *
 * @param {number} rowsProcessed - Number of rows parsed so far
 * @param {number} totalRows - Total number of data rows
 */
function updateProgress(rowsProcessed, totalRows) {
    var pct = totalRows > 0 ? Math.round((rowsProcessed / totalRows) * 100) : 0;
    progressBarFill.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    progressRows.textContent = rowsProcessed.toLocaleString() + ' / ' + totalRows.toLocaleString() + ' rows';

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
    if (fileSection && fileSection.nextSibling) {
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
 * @param {Object} analyses - The analyses result object from the worker
 */
function renderReport(analyses) {
    // Clear any previous error banner
    clearErrorBanner();

    // Show report section
    reportSection.hidden = false;

    // Render channel mapping
    renderChannelMapping(analyses.channelMapping);

    // Render warnings
    renderWarnings(analyses.channelWarnings);

    // Render each analysis module
    renderLeanSpikesReport(analyses.leanSpikes);
    renderPWStabilityReport(analyses.pwStability);
    renderFuelPressureReport(analyses.fuelPressure);
    renderInjectionTimingReport(analyses.injectionTiming);
    renderClosedLoopReport(analyses.closedLoop);
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
    while (channelInfoEl.firstChild) {
        channelInfoEl.removeChild(channelInfoEl.firstChild);
    }

    var channelLabels = {
        time: 'Time',
        rpm: 'Engine Speed',
        map: 'Inlet Manifold Pressure',
        lambda_b1: 'Lambda Bank 1',
        lambda_b2: 'Lambda Bank 2',
        lambda_avg: 'Lambda Average',
        inj_pw: 'Injector Pulse Width',
        inj_timing: 'Injection Timing',
        tps: 'Throttle Position',
        fuel_press_di: 'DI Fuel Pressure',
        fuel_press_di_aim: 'DI Fuel Pressure Aim',
        coolant_temp: 'Coolant Temperature',
        iat: 'Inlet Air Temperature',
        cl_trim_b1: 'CL Trim Bank 1',
        cl_trim_b2: 'CL Trim Bank 2',
        fuel_mix_aim: 'Fuel Mixture Aim'
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
    while (warningsList.firstChild) {
        warningsList.removeChild(warningsList.firstChild);
    }

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
// Lean Spikes Report
// ---------------------------------------------------------------------------

/**
 * Renders the lean spike analysis section.
 *
 * @param {Object|null} result - LeanSpikeResult or null if unavailable
 */
function renderLeanSpikesReport(result) {
    var content = reportLeanSpikes.querySelector('.report-content');
    clearElement(content);

    if (!result) {
        renderUnavailable(content, 'Lambda channel not available');
        return;
    }

    // Summary statistics
    var statsGrid = createStatsGrid([
        ['Lambda Channel', result.lambdaChannelUsed],
        ['Total Samples', result.totalSamples.toLocaleString()],
        ['Lean Events', result.leanEventCount.toLocaleString()],
        ['Lean Event %', result.leanEventPct.toFixed(2) + '%']
    ]);
    content.appendChild(statsGrid);

    // Bank categorization (if available)
    if (result.bothBanksLean !== null) {
        var bankHeading = document.createElement('h3');
        bankHeading.textContent = 'Bank Categorization';
        content.appendChild(bankHeading);

        var bankGrid = createStatsGrid([
            ['Both Banks Lean', result.bothBanksLean.toLocaleString()],
            ['Only Bank 1 Lean', result.onlyB1Lean.toLocaleString()],
            ['Only Bank 2 Lean', result.onlyB2Lean.toLocaleString()]
        ]);
        content.appendChild(bankGrid);
    }

    // Low-PW correlation (if available)
    if (result.lowPWEvents !== null) {
        var pwHeading = document.createElement('h3');
        pwHeading.textContent = 'Low-PW Correlation';
        content.appendChild(pwHeading);

        var pwGrid = createStatsGrid([
            ['Low PW Events (< 0.8 ms)', result.lowPWEvents.toLocaleString()],
            ['Lean with Low PW', result.leanWithLowPW.toLocaleString()],
            ['Lean with Low PW %', result.leanWithLowPWPct.toFixed(1) + '%']
        ]);
        content.appendChild(pwGrid);
    }

    // RPM distribution table
    if (result.rpmDistribution && result.rpmDistribution.length > 0) {
        var rpmHeading = document.createElement('h3');
        rpmHeading.textContent = 'RPM Distribution';
        content.appendChild(rpmHeading);

        var table = document.createElement('table');
        table.className = 'rpm-table';

        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        var headers = ['RPM Band', 'Spikes', 'Total', '%'];
        for (var h = 0; h < headers.length; h++) {
            var th = document.createElement('th');
            th.textContent = headers[h];
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        for (var r = 0; r < result.rpmDistribution.length; r++) {
            var row = result.rpmDistribution[r];
            var tr = document.createElement('tr');

            var tdBand = document.createElement('td');
            tdBand.textContent = row.band;
            tr.appendChild(tdBand);

            var tdSpikes = document.createElement('td');
            tdSpikes.textContent = row.spikes.toLocaleString();
            tr.appendChild(tdSpikes);

            var tdTotal = document.createElement('td');
            tdTotal.textContent = row.total.toLocaleString();
            tr.appendChild(tdTotal);

            var tdPct = document.createElement('td');
            tdPct.textContent = row.pct.toFixed(1) + '%';
            tr.appendChild(tdPct);

            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        content.appendChild(table);
    }

    // Diagnostics
    renderDiagnostics(content, result.diagnostics);
}

// ---------------------------------------------------------------------------
// PW Stability Report
// ---------------------------------------------------------------------------

/**
 * Renders the injector pulsewidth stability section.
 *
 * @param {Object|null} result - PWStabilityResult or null if unavailable
 */
function renderPWStabilityReport(result) {
    var content = reportPWStability.querySelector('.report-content');
    clearElement(content);

    if (!result) {
        renderUnavailable(content, 'Injector PW channel not available');
        return;
    }

    // Statistics grid
    var statsGrid = createStatsGrid([
        ['Min PW', result.min.toFixed(3) + ' ms'],
        ['Max PW', result.max.toFixed(3) + ' ms'],
        ['Mean PW', result.mean.toFixed(3) + ' ms'],
        ['Median PW', result.median.toFixed(3) + ' ms'],
        ['Std Dev', result.stdDev.toFixed(3) + ' ms'],
        ['5th Percentile', result.pct5th.toFixed(3) + ' ms'],
        ['1st Percentile', result.pct1st.toFixed(3) + ' ms'],
        ['Below 0.8 ms', result.belowThresholdCount.toLocaleString() + ' (' + result.belowThresholdPct.toFixed(1) + '%)']
    ]);
    content.appendChild(statsGrid);

    // Diagnostics
    renderDiagnostics(content, result.diagnostics);
}

// ---------------------------------------------------------------------------
// Fuel Pressure Report
// ---------------------------------------------------------------------------

/**
 * Renders the DI fuel pressure analysis section.
 *
 * @param {Object|null} result - FuelPressureResult or null if unavailable
 */
function renderFuelPressureReport(result) {
    var content = reportFuelPressure.querySelector('.report-content');
    clearElement(content);

    if (!result) {
        renderUnavailable(content, 'DI fuel pressure channel not available');
        return;
    }

    // Pressure statistics
    var pressureStats = [
        ['Min Pressure', result.minBar.toFixed(1) + ' bar'],
        ['Max Pressure', result.maxBar.toFixed(1) + ' bar'],
        ['Mean Pressure', result.meanBar.toFixed(1) + ' bar'],
        ['Std Dev', result.stdBar.toFixed(1) + ' bar'],
        ['Below 150 bar', result.below150BarCount.toLocaleString() + ' (' + result.below150BarPct.toFixed(1) + '%)']
    ];
    content.appendChild(createStatsGrid(pressureStats));

    // Error statistics (if aim channel was available)
    if (result.meanErrorBar !== null) {
        var errorHeading = document.createElement('h3');
        errorHeading.textContent = 'Pressure Error (Actual \u2212 Aim)';
        content.appendChild(errorHeading);

        var errorStats = [
            ['Mean Error', result.meanErrorBar.toFixed(2) + ' bar'],
            ['Std Dev Error', result.stdErrorBar.toFixed(2) + ' bar'],
            ['Large Errors (> 20 bar)', result.largeErrorCount.toLocaleString()]
        ];
        content.appendChild(createStatsGrid(errorStats));
    }

    // Lean spike correlation
    if (result.leanSpikeFPMeanBar !== null) {
        var corrHeading = document.createElement('h3');
        corrHeading.textContent = 'Lean Spike Correlation';
        content.appendChild(corrHeading);

        var corrStats = [
            ['Mean Pressure During Lean Spikes', result.leanSpikeFPMeanBar.toFixed(1) + ' bar'],
            ['Overall Mean Pressure', result.overallFPMeanBar.toFixed(1) + ' bar']
        ];
        content.appendChild(createStatsGrid(corrStats));
    }

    // Diagnostics
    renderDiagnostics(content, result.diagnostics);
}

// ---------------------------------------------------------------------------
// Injection Timing Report
// ---------------------------------------------------------------------------

/**
 * Renders the injection timing analysis section.
 *
 * @param {Object|null} result - InjectionTimingResult or null if unavailable
 */
function renderInjectionTimingReport(result) {
    var content = reportInjectionTiming.querySelector('.report-content');
    clearElement(content);

    if (!result) {
        renderUnavailable(content, 'Injection timing channel not available');
        return;
    }

    // Timing statistics
    var timingStats = [
        ['Min Timing', result.min.toFixed(1) + ' dBTDC'],
        ['Max Timing', result.max.toFixed(1) + ' dBTDC'],
        ['Mean Timing', result.mean.toFixed(1) + ' dBTDC'],
        ['In Optimal Window (240\u2013320)', result.inOptimalCount.toLocaleString() + ' (' + result.inOptimalPct.toFixed(1) + '%)'],
        ['In Compression (< 180)', result.inCompressionCount.toLocaleString() + ' (' + result.inCompressionPct.toFixed(1) + '%)']
    ];
    content.appendChild(createStatsGrid(timingStats));

    // Lean spike timing correlation
    if (result.leanSpikeMeanTiming !== null) {
        var corrHeading = document.createElement('h3');
        corrHeading.textContent = 'Lean Spike Timing';
        content.appendChild(corrHeading);

        var corrStats = [
            ['Mean Timing During Lean Spikes', result.leanSpikeMeanTiming.toFixed(1) + ' dBTDC'],
            ['Median Timing During Lean Spikes', result.leanSpikeMedianTiming.toFixed(1) + ' dBTDC']
        ];
        content.appendChild(createStatsGrid(corrStats));
    }

    // Diagnostics
    renderDiagnostics(content, result.diagnostics);
}

// ---------------------------------------------------------------------------
// Closed-Loop Report
// ---------------------------------------------------------------------------

/**
 * Renders the closed-loop fuel trim analysis section.
 *
 * @param {Object|null} result - ClosedLoopResult or null if unavailable
 */
function renderClosedLoopReport(result) {
    var content = reportClosedLoop.querySelector('.report-content');
    clearElement(content);

    if (!result) {
        renderUnavailable(content, 'Closed-loop trim channels not available');
        return;
    }

    // Check if both banks are null
    if (!result.bank1 && !result.bank2) {
        renderUnavailable(content, 'Closed-loop trim channels not available');
        return;
    }

    // Bank 1 stats
    if (result.bank1) {
        var b1Heading = document.createElement('h3');
        b1Heading.textContent = 'Bank 1';
        content.appendChild(b1Heading);

        var b1Stats = [
            ['Mean Trim', result.bank1.mean.toFixed(2) + '%'],
            ['Std Dev', result.bank1.std.toFixed(2) + '%'],
            ['Min', result.bank1.min.toFixed(2) + '%'],
            ['Max', result.bank1.max.toFixed(2) + '%']
        ];
        content.appendChild(createStatsGrid(b1Stats));
    }

    // Bank 2 stats
    if (result.bank2) {
        var b2Heading = document.createElement('h3');
        b2Heading.textContent = 'Bank 2';
        content.appendChild(b2Heading);

        var b2Stats = [
            ['Mean Trim', result.bank2.mean.toFixed(2) + '%'],
            ['Std Dev', result.bank2.std.toFixed(2) + '%'],
            ['Min', result.bank2.min.toFixed(2) + '%'],
            ['Max', result.bank2.max.toFixed(2) + '%']
        ];
        content.appendChild(createStatsGrid(b2Stats));
    }

    // Diagnostics
    renderDiagnostics(content, result.diagnostics);
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
 * Renders an "unavailable" message for a section whose channel was not found.
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

/**
 * Creates a statistics grid element from an array of [label, value] pairs.
 *
 * @param {Array<[string, string]>} items - Array of [label, value] pairs
 * @returns {HTMLElement} The stats grid div
 */
function createStatsGrid(items) {
    var grid = document.createElement('div');
    grid.className = 'stats-grid';

    for (var i = 0; i < items.length; i++) {
        var item = document.createElement('div');
        item.className = 'stat-item';

        var label = document.createElement('span');
        label.className = 'stat-label';
        label.textContent = items[i][0];

        var value = document.createElement('span');
        value.className = 'stat-value';
        value.textContent = items[i][1];

        item.appendChild(label);
        item.appendChild(value);
        grid.appendChild(item);
    }

    return grid;
}

/**
 * Renders diagnostic messages with appropriate visual indicators.
 * Classifies diagnostics as severe, warning, or healthy based on content.
 *
 * @param {HTMLElement} container - The container to append diagnostics to
 * @param {string[]} diagnostics - Array of diagnostic message strings
 */
function renderDiagnostics(container, diagnostics) {
    if (!diagnostics || diagnostics.length === 0) return;

    var heading = document.createElement('h3');
    heading.textContent = 'Diagnostics';
    container.appendChild(heading);

    for (var i = 0; i < diagnostics.length; i++) {
        var msg = diagnostics[i];
        var div = document.createElement('div');
        div.className = 'diagnostic ' + classifyDiagnostic(msg);
        div.textContent = msg;
        container.appendChild(div);
    }
}

/**
 * Classifies a diagnostic message to determine its CSS class.
 * Returns 'diagnostic-severe', 'diagnostic-warning', or 'diagnostic-healthy'.
 *
 * @param {string} message - The diagnostic message text
 * @returns {string} CSS class name for the diagnostic severity
 */
function classifyDiagnostic(message) {
    var upper = message.toUpperCase();
    if (upper.indexOf('SEVERE') !== -1) {
        return 'diagnostic-severe';
    }
    if (upper.indexOf('HEALTHY') !== -1) {
        return 'diagnostic-healthy';
    }
    // Default to warning for everything else (WARNING, recommendations, correlations)
    return 'diagnostic-warning';
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
