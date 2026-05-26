/**
 * app.js — Main thread: UI event handling, Worker lifecycle, result rendering.
 * Implemented in tasks 9 and 10.
 */

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const logInput        = document.getElementById('log-input');
const veInput         = document.getElementById('ve-input');
const logFilename     = document.getElementById('log-filename');
const veFilename      = document.getElementById('ve-filename');
const processBtn      = document.getElementById('process-btn');

const progressContainer = document.getElementById('progress-container');
const progressBar       = document.getElementById('progress-bar');
const progressPct       = document.getElementById('progress-pct');
const progressRows      = document.getElementById('progress-rows');

const warningContainer = document.getElementById('warning-container');
const errorContainer   = document.getElementById('error-container');
const resultsContainer = document.getElementById('results-container');

const hitThresholdInput = document.getElementById('hit-threshold');
const minCoolantTempInput = document.getElementById('min-coolant-temp');
const minRunTimeInput = document.getElementById('min-run-time');
const minChangeAmountInput = document.getElementById('min-change-amount');
const scalingFactorInput = document.getElementById('scaling-factor');
const outlierStddevInput = document.getElementById('outlier-stddev');
const maxTpsRateInput = document.getElementById('max-tps-rate');
const smoothingAmountInput = document.getElementById('smoothing-amount');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let logFile = null;   // currently selected log File object (null if invalid/cleared)
let veFile  = null;   // currently selected VE table File object (null if invalid/cleared)
let lastResult = null; // stores the last processing result for table toggling
let worker  = null;   // current Web Worker instance

// ---------------------------------------------------------------------------
// File input handling (Task 9.1 context — needed for Process button state)
// ---------------------------------------------------------------------------

/**
 * Validates that a file has a .csv or .ld extension (case-insensitive).
 * @param {File} file
 * @returns {boolean}
 */
function isValidLogFile(file) {
    if (!file) return false;
    const name = file.name.toLowerCase();
    return name.endsWith('.csv') || name.endsWith('.ld');
}

/**
 * Validates that a file has a .csv extension (case-insensitive).
 * @param {File} file
 * @returns {boolean}
 */
function isValidCsv(file) {
    return file && file.name.toLowerCase().endsWith('.csv');
}

/**
 * Updates the Process button enabled/disabled state based on current file selections.
 */
function updateProcessButtonState() {
    processBtn.disabled = !(logFile && veFile);
}

logInput.addEventListener('change', () => {
    const file = logInput.files[0] || null;
    if (file && !isValidLogFile(file)) {
        showError(`Invalid file: "${file.name}" is not a .csv or .ld file.`);
        logFile = null;
        logFilename.textContent = 'No file selected';
        logInput.value = '';
    } else if (file) {
        logFile = file;
        logFilename.textContent = file.name;
        clearError();
    } else {
        logFile = null;
        logFilename.textContent = 'No file selected';
    }
    updateProcessButtonState();
});

veInput.addEventListener('change', () => {
    const file = veInput.files[0] || null;
    if (file && !isValidCsv(file)) {
        showError(`Invalid file: "${file.name}" is not a .csv file.`);
        veFile = null;
        veFilename.textContent = 'No file selected';
        veInput.value = '';
    } else if (file) {
        veFile = file;
        veFilename.textContent = file.name;
        clearError();
    } else {
        veFile = null;
        veFilename.textContent = 'No file selected';
    }
    updateProcessButtonState();
});

// ---------------------------------------------------------------------------
// Error / Warning display helpers
// ---------------------------------------------------------------------------

/**
 * Shows a red error banner with the given message.
 * @param {string} message
 */
function showError(message) {
    errorContainer.textContent = message;
    errorContainer.hidden = false;
}

/**
 * Clears the error banner.
 */
function clearError() {
    errorContainer.textContent = '';
    errorContainer.hidden = true;
}

/**
 * Clears all warning banners.
 */
function clearWarnings() {
    warningContainer.innerHTML = '';
    warningContainer.hidden = true;
}

/**
 * Appends a yellow warning banner with the given message.
 * @param {string} message
 */
function addWarning(message) {
    warningContainer.hidden = false;
    const div = document.createElement('div');
    div.className = 'warning-item';
    div.textContent = '\u26A0 ' + message;
    warningContainer.appendChild(div);
}

// ---------------------------------------------------------------------------
// Progress bar helpers
// ---------------------------------------------------------------------------

/**
 * Shows the progress bar container and resets it to 0%.
 */
function showProgress() {
    progressContainer.hidden = false;
    progressBar.style.width = '0%';
    progressPct.textContent = '0%';
    progressRows.textContent = '';
}

/**
 * Updates the progress bar with current row counts.
 * @param {number} rowsProcessed
 * @param {number} totalRows
 */
function updateProgress(rowsProcessed, totalRows) {
    const pct = totalRows > 0 ? Math.round((rowsProcessed / totalRows) * 100) : 0;
    progressBar.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    progressRows.textContent = `Processing rows ${rowsProcessed.toLocaleString()} / ${totalRows.toLocaleString()}`;
}

/**
 * Hides the progress bar container.
 */
function hideProgress() {
    progressContainer.hidden = true;
}

// ---------------------------------------------------------------------------
// Worker lifecycle and message dispatch (Task 9.2)
// ---------------------------------------------------------------------------

/**
 * Creates a fresh Web Worker instance pointing to worker.js.
 * Uses a Blob URL with importScripts to work around file:// CORS restrictions.
 * @returns {Worker}
 */
function createWorker() {
    // Construct absolute URL to worker.js relative to this page
    const workerUrl = new URL('worker.js', window.location.href).href;
    const blob = new Blob(
        ['importScripts("' + workerUrl + '");'],
        { type: 'application/javascript' }
    );
    const blobUrl = URL.createObjectURL(blob);
    const w = new Worker(blobUrl);
    // Clean up the blob URL after the worker starts (it's already loaded)
    URL.revokeObjectURL(blobUrl);
    return w;
}

/**
 * Reads a File object as text using FileReader.
 * Returns a Promise that resolves with the text content or rejects on error.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Could not read file: "${file.name}"`));
        reader.readAsText(file);
    });
}

/**
 * Reads a File object as an ArrayBuffer using FileReader.
 * Returns a Promise that resolves with the ArrayBuffer or rejects on error.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Could not read file: "${file.name}"`));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Handles the Process button click:
 *  1. Disables the button and shows the progress bar.
 *  2. Reads both files as text.
 *  3. Terminates any existing worker and creates a new one.
 *  4. Posts the file contents to the worker.
 *  5. Handles worker messages (progress, warning, error, result).
 */
processBtn.addEventListener('click', async () => {
    // --- UI reset ---
    processBtn.disabled = true;
    clearError();
    clearWarnings();
    resultsContainer.hidden = true;
    showProgress();

    // --- Read files ---
    const isLd = logFile.name.toLowerCase().endsWith('.ld');
    let logData, veText;
    try {
        const results = await Promise.all([
            isLd ? readFileAsArrayBuffer(logFile) : readFileAsText(logFile),
            readFileAsText(veFile),
        ]);
        logData = results[0];
        veText = results[1];
    } catch (err) {
        hideProgress();
        showError(err.message);
        updateProcessButtonState();
        return;
    }

    // --- Terminate existing worker and create a fresh one ---
    if (worker) {
        worker.terminate();
        worker = null;
    }
    worker = createWorker();

    // --- Handle messages from the worker ---
    worker.onmessage = (e) => {
        const msg = e.data;
        if (!msg) return;

        switch (msg.type) {
            case 'progress':
                updateProgress(msg.rowsProcessed, msg.totalRows);
                break;

            case 'warning':
                addWarning(msg.message);
                break;

            case 'error':
                hideProgress();
                showError(msg.message);
                updateProcessButtonState();
                break;

            case 'result':
                hideProgress();
                renderResults(msg);
                updateProcessButtonState();
                break;
        }
    };

    // --- Handle unexpected worker errors ---
    worker.onerror = (err) => {
        hideProgress();
        showError('An unexpected error occurred during processing.');
        updateProcessButtonState();
    };

    // --- Post the data to the worker ---
    const hitThreshold = parseInt(hitThresholdInput.value, 10) || 50;
    const minCoolantTemp = parseFloat(minCoolantTempInput.value) || 55;
    const minRunTime = parseFloat(minRunTimeInput.value) || 60;
    const minChangeAmount = parseFloat(minChangeAmountInput.value) || 0;
    const scalingFactor = parseFloat(scalingFactorInput.value) || 100;
    const outlierStddev = parseFloat(outlierStddevInput.value) || 0;
    const maxTpsRate = parseFloat(maxTpsRateInput.value) || 0;
    const smoothing = parseFloat(smoothingAmountInput.value) || 0;
    const payload = { veText, hitThreshold, minCoolantTemp, minRunTime, minChangeAmount, scalingFactor, outlierStddev, maxTpsRate, smoothing };
    if (isLd) {
        worker.postMessage(Object.assign({ type: 'process_ld', logBuffer: logData }, payload));
    } else {
        worker.postMessage(Object.assign({ type: 'process', logText: logData }, payload));
    }
});

// ---------------------------------------------------------------------------
// Result rendering (Task 9.3)
// ---------------------------------------------------------------------------

/**
 * Downloads a CSV string as a file using Blob + <a> click.
 * @param {string} csvString
 * @param {string} filename
 */
function downloadCsv(csvString, filename) {
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Renders the processing results in the results container.
 * Displays stats, colour-coded 2-D summary table, and download buttons.
 * @param {{ correctionGrid: object, diffCsv: string, newValuesCsv: string, totalSamples: number, cellsAboveThreshold: number }} msg
 */
function renderResults(msg) {
    resultsContainer.hidden = false;
    lastResult = msg;

    const statsLine = document.getElementById('stats-line');
    const noDataMsg = document.getElementById('no-data-msg');
    const downloadBtns = document.getElementById('download-btns');
    const tableContainer = document.getElementById('table-container');
    const tableToggle = document.getElementById('table-toggle');
    const tableLabel = document.getElementById('table-label');

    const { correctionGrid, diffCsv, newValuesCsv, totalSamples, cellsAboveThreshold, filteredByTime, filteredByCoolant, filteredByTps, filteredByOutlier } = msg;

    // Clear previous table content
    tableContainer.innerHTML = '';

    // Show stats line
    const threshold = parseInt(hitThresholdInput.value, 10) || 50;
    let statsText = `Processed ${totalSamples.toLocaleString()} valid samples \u00B7 ${cellsAboveThreshold} cells above threshold (>${threshold} hits)`;
    if (filteredByTime > 0 || filteredByCoolant > 0 || filteredByTps > 0 || filteredByOutlier > 0) {
        const parts = [];
        if (filteredByTime > 0) parts.push(`${filteredByTime.toLocaleString()} by run time`);
        if (filteredByCoolant > 0) parts.push(`${filteredByCoolant.toLocaleString()} by coolant temp`);
        if (filteredByTps > 0) parts.push(`${filteredByTps.toLocaleString()} by TPS rate`);
        if (filteredByOutlier > 0) parts.push(`${filteredByOutlier.toLocaleString()} as outliers`);
        statsText += ` \u00B7 Filtered: ${parts.join(', ')}`;
    }
    statsLine.textContent = statsText;

    // No data case: zero valid samples or zero cells above threshold
    if (totalSamples === 0 || cellsAboveThreshold === 0) {
        noDataMsg.hidden = false;
        downloadBtns.hidden = true;
        tableToggle.hidden = true;
        tableLabel.hidden = true;
        document.getElementById('surface-section').hidden = true;
        return;
    }

    // Has data — hide no-data message, show downloads and toggle
    noDataMsg.hidden = true;
    downloadBtns.hidden = false;
    tableToggle.hidden = false;
    tableLabel.hidden = false;

    // Wire up download buttons
    const downloadDiffBtn = document.getElementById('download-diff-btn');
    const downloadNewBtn = document.getElementById('download-new-btn');
    const copyTableBtn = document.getElementById('copy-table-btn');

    downloadDiffBtn.onclick = () => downloadCsv(diffCsv, 'VE_Difference.csv');
    downloadNewBtn.onclick = () => downloadCsv(newValuesCsv, 'VE_New_Values.csv');
    copyTableBtn.onclick = () => copyCurrentTableToClipboard();

    // Wire up table toggle buttons
    const showCorrectionsBtn = document.getElementById('show-corrections-btn');
    const showHitsBtn = document.getElementById('show-hits-btn');
    const showNewValuesBtn = document.getElementById('show-new-values-btn');
    const showStddevBtn = document.getElementById('show-stddev-btn');

    showCorrectionsBtn.onclick = () => {
        showCorrectionsBtn.classList.add('active');
        showHitsBtn.classList.remove('active');
        showNewValuesBtn.classList.remove('active');
        showStddevBtn.classList.remove('active');
        renderCorrectionTable(correctionGrid, tableContainer, tableLabel);
    };

    showNewValuesBtn.onclick = () => {
        showNewValuesBtn.classList.add('active');
        showCorrectionsBtn.classList.remove('active');
        showHitsBtn.classList.remove('active');
        showStddevBtn.classList.remove('active');
        renderNewValuesTable(correctionGrid, msg.newValuesGrid, tableContainer, tableLabel);
    };

    showHitsBtn.onclick = () => {
        showHitsBtn.classList.add('active');
        showCorrectionsBtn.classList.remove('active');
        showNewValuesBtn.classList.remove('active');
        showStddevBtn.classList.remove('active');
        renderHitCountTable(correctionGrid, tableContainer, tableLabel);
    };

    showStddevBtn.onclick = () => {
        showStddevBtn.classList.add('active');
        showCorrectionsBtn.classList.remove('active');
        showNewValuesBtn.classList.remove('active');
        showHitsBtn.classList.remove('active');
        renderStdDevTable(correctionGrid, tableContainer, tableLabel);
    };

    // Default: show corrections table
    showCorrectionsBtn.classList.add('active');
    showNewValuesBtn.classList.remove('active');
    showHitsBtn.classList.remove('active');
    showStddevBtn.classList.remove('active');
    renderCorrectionTable(correctionGrid, tableContainer, tableLabel);

    // Show 3D surface section and initialize
    const surfaceSection = document.getElementById('surface-section');
    surfaceSection.hidden = false;
    initSurface3D(msg);
}

/**
 * Renders the correction percentage table.
 */
function renderCorrectionTable(correctionGrid, tableContainer, tableLabel) {
    tableContainer.innerHTML = '';
    tableLabel.textContent = 'VE Correction % — How much to adjust each cell (positive = add fuel, negative = remove fuel)';

    const { mapBreakpoints, rpmBreakpoints, cells } = correctionGrid;

    const table = document.createElement('table');
    table.className = 'correction-table';

    // Header row: empty corner + RPM breakpoints
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const cornerTh = document.createElement('th');
    cornerTh.textContent = 'MAP \\ RPM';
    headerRow.appendChild(cornerTh);

    for (let r = 0; r < rpmBreakpoints.length; r++) {
        const th = document.createElement('th');
        th.textContent = rpmBreakpoints[r];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows
    const tbody = document.createElement('tbody');
    for (let m = 0; m < mapBreakpoints.length; m++) {
        const row = document.createElement('tr');
        const rowHeader = document.createElement('th');
        rowHeader.textContent = mapBreakpoints[m];
        row.appendChild(rowHeader);

        for (let r = 0; r < rpmBreakpoints.length; r++) {
            const td = document.createElement('td');
            const cell = cells[m][r];
            const correction = cell.correction;

            if (correction === null) {
                td.className = 'below-threshold';
            } else if (correction > 0) {
                td.className = 'positive';
                td.textContent = '+' + correction.toFixed(2);
            } else if (correction < 0) {
                td.className = 'negative';
                td.textContent = correction.toFixed(2);
            } else {
                td.className = 'zero';
                td.textContent = '0.00';
            }

            row.appendChild(td);
        }
        tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableContainer.appendChild(table);
}

/**
 * Renders the hit count table showing how many samples landed in each cell.
 */
function renderHitCountTable(correctionGrid, tableContainer, tableLabel) {
    tableContainer.innerHTML = '';
    const threshold = parseInt(hitThresholdInput.value, 10) || 50;
    tableLabel.textContent = `Sample Hit Counts — Number of valid log samples per cell (cells with >${threshold} are included in corrections)`;

    const { mapBreakpoints, rpmBreakpoints, cells } = correctionGrid;

    const table = document.createElement('table');
    table.className = 'correction-table';

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const cornerTh = document.createElement('th');
    cornerTh.textContent = 'MAP \\ RPM';
    headerRow.appendChild(cornerTh);

    for (let r = 0; r < rpmBreakpoints.length; r++) {
        const th = document.createElement('th');
        th.textContent = rpmBreakpoints[r];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows
    const tbody = document.createElement('tbody');
    for (let m = 0; m < mapBreakpoints.length; m++) {
        const row = document.createElement('tr');
        const rowHeader = document.createElement('th');
        rowHeader.textContent = mapBreakpoints[m];
        row.appendChild(rowHeader);

        for (let r = 0; r < rpmBreakpoints.length; r++) {
            const td = document.createElement('td');
            const cell = cells[m][r];

            if (cell.count === 0) {
                td.className = 'below-threshold';
            } else if (cell.count > threshold) {
                td.className = 'positive';
                td.textContent = cell.count;
            } else {
                td.className = 'zero';
                td.textContent = cell.count;
            }

            row.appendChild(td);
        }
        tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableContainer.appendChild(table);
}


/**
 * Renders the new VE values table showing the recommended VE table after corrections.
 */
function renderNewValuesTable(correctionGrid, newValuesGrid, tableContainer, tableLabel) {
    tableContainer.innerHTML = '';
    tableLabel.textContent = 'Recommended VE Table — New values after applying corrections (highlighted cells were changed)';

    const { mapBreakpoints, rpmBreakpoints, cells } = correctionGrid;

    const table = document.createElement('table');
    table.className = 'correction-table';

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const cornerTh = document.createElement('th');
    cornerTh.textContent = 'MAP \\ RPM';
    headerRow.appendChild(cornerTh);

    for (let r = 0; r < rpmBreakpoints.length; r++) {
        const th = document.createElement('th');
        th.textContent = rpmBreakpoints[r];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows
    const tbody = document.createElement('tbody');
    for (let m = 0; m < mapBreakpoints.length; m++) {
        const row = document.createElement('tr');
        const rowHeader = document.createElement('th');
        rowHeader.textContent = mapBreakpoints[m];
        row.appendChild(rowHeader);

        for (let r = 0; r < rpmBreakpoints.length; r++) {
            const td = document.createElement('td');
            const cell = cells[m][r];
            const newValue = newValuesGrid[m][r];

            if (cell.correction === null) {
                // Below threshold — show original value, greyed out
                td.className = 'below-threshold';
                td.textContent = newValue.toFixed(2);
            } else if (cell.correction > 0) {
                td.className = 'positive';
                td.textContent = newValue.toFixed(2);
            } else if (cell.correction < 0) {
                td.className = 'negative';
                td.textContent = newValue.toFixed(2);
            } else {
                td.className = 'zero';
                td.textContent = newValue.toFixed(2);
            }

            row.appendChild(td);
        }
        tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableContainer.appendChild(table);
}


/**
 * Renders the standard deviation table showing correction variability per cell.
 */
function renderStdDevTable(correctionGrid, tableContainer, tableLabel) {
    tableContainer.innerHTML = '';
    tableLabel.textContent = 'Correction Std Dev — Lower values indicate more consistent/trustworthy corrections';

    const { mapBreakpoints, rpmBreakpoints, cells } = correctionGrid;

    const table = document.createElement('table');
    table.className = 'correction-table';

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const cornerTh = document.createElement('th');
    cornerTh.textContent = 'MAP \\ RPM';
    headerRow.appendChild(cornerTh);

    for (let r = 0; r < rpmBreakpoints.length; r++) {
        const th = document.createElement('th');
        th.textContent = rpmBreakpoints[r];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Data rows
    const tbody = document.createElement('tbody');
    for (let m = 0; m < mapBreakpoints.length; m++) {
        const row = document.createElement('tr');
        const rowHeader = document.createElement('th');
        rowHeader.textContent = mapBreakpoints[m];
        row.appendChild(rowHeader);

        for (let r = 0; r < rpmBreakpoints.length; r++) {
            const td = document.createElement('td');
            const cell = cells[m][r];

            if (cell.stddev === undefined || cell.stddev === null) {
                td.className = 'below-threshold';
            } else if (cell.stddev <= 1.0) {
                // Low variance — high confidence
                td.className = 'positive';
                td.textContent = cell.stddev.toFixed(2);
            } else if (cell.stddev <= 3.0) {
                // Moderate variance
                td.className = 'zero';
                td.textContent = cell.stddev.toFixed(2);
            } else {
                // High variance — low confidence
                td.className = 'negative';
                td.textContent = cell.stddev.toFixed(2);
            }

            row.appendChild(td);
        }
        tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableContainer.appendChild(table);
}


// ---------------------------------------------------------------------------
// Copy to Clipboard
// ---------------------------------------------------------------------------

/**
 * Copies the currently displayed table to the clipboard as tab-separated values.
 * This format pastes cleanly into Excel, Google Sheets, etc.
 */
function copyCurrentTableToClipboard() {
    const tableContainer = document.getElementById('table-container');
    const table = tableContainer.querySelector('table');
    if (!table) return;

    const rows = [];
    const allRows = table.querySelectorAll('tbody tr');
    for (let i = 0; i < allRows.length; i++) {
        const cells = allRows[i].querySelectorAll('td');
        const rowData = [];
        for (let j = 0; j < cells.length; j++) {
            rowData.push(cells[j].textContent);
        }
        rows.push(rowData.join('\t'));
    }

    const text = rows.join('\n');

    // Use a textarea + execCommand as primary method (works on file:// protocol)
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    let success = false;
    try {
        success = document.execCommand('copy');
    } catch (e) {
        success = false;
    }
    document.body.removeChild(textarea);

    // If execCommand failed, try the async clipboard API as fallback
    if (!success && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showCopyFeedback();
        }).catch(() => {
            // Both methods failed
            showCopyFeedback('Copy failed');
        });
        return;
    }

    showCopyFeedback(success ? null : 'Copy failed');
}

/**
 * Shows brief feedback on the copy button.
 * @param {string|null} errorMsg - If null, shows success. Otherwise shows the error.
 */
function showCopyFeedback(errorMsg) {
    const btn = document.getElementById('copy-table-btn');
    const originalText = btn.textContent;
    if (errorMsg) {
        btn.textContent = errorMsg;
    } else {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
    }
    setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('copied');
    }, 2000);
}

// ---------------------------------------------------------------------------
// 3D Surface Plot
// ---------------------------------------------------------------------------

let surfaceState = null; // Holds current 3D state for rotation/zoom

/**
 * Initializes the 3D surface plot with the processing results.
 */
function initSurface3D(msg) {
    // Replace canvas to clear old event listeners
    const oldCanvas = document.getElementById('surface-canvas');
    const canvas = oldCanvas.cloneNode(false);
    oldCanvas.parentNode.replaceChild(canvas, oldCanvas);

    const ctx = canvas.getContext('2d');

    surfaceState = {
        rotX: -0.6,   // pitch (radians)
        rotZ: 0.8,    // yaw (radians)
        zoom: 1.0,
        dragging: false,
        lastX: 0,
        lastY: 0,
        msg: msg,
    };

    function getDataGrid() {
        const { correctionGrid, newValuesGrid } = surfaceState.msg;
        const { cells } = correctionGrid;
        const mode = document.getElementById('surface-data-select').value;

        const grid = [];
        for (let m = 0; m < cells.length; m++) {
            const row = [];
            for (let r = 0; r < cells[m].length; r++) {
                const cell = cells[m][r];
                if (mode === 'corrections') {
                    row.push(cell.correction !== null ? cell.correction : 0);
                } else if (mode === 'newValues') {
                    row.push(newValuesGrid[m][r]);
                } else if (mode === 'stddev') {
                    row.push(cell.stddev !== null && cell.stddev !== undefined ? cell.stddev : 0);
                }
            }
            grid.push(row);
        }
        return grid;
    }

    function render() {
        const { correctionGrid } = surfaceState.msg;
        const { mapBreakpoints, rpmBreakpoints } = correctionGrid;
        const dataGrid = getDataGrid();

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        // Find data range for color mapping
        let minVal = Infinity, maxVal = -Infinity;
        for (let m = 0; m < dataGrid.length; m++) {
            for (let r = 0; r < dataGrid[m].length; r++) {
                const v = dataGrid[m][r];
                if (v < minVal) minVal = v;
                if (v > maxVal) maxVal = v;
            }
        }
        if (minVal === maxVal) { minVal -= 1; maxVal += 1; }

        const numRows = dataGrid.length;
        const numCols = dataGrid[0] ? dataGrid[0].length : 0;
        if (numRows === 0 || numCols === 0) return;

        // Normalize coordinates to [-1, 1] range
        const cosX = Math.cos(surfaceState.rotX);
        const sinX = Math.sin(surfaceState.rotX);
        const cosZ = Math.cos(surfaceState.rotZ);
        const sinZ = Math.sin(surfaceState.rotZ);

        // Project 3D point to 2D (isometric-style)
        function project(x, y, z) {
            // Rotate around Z axis (yaw)
            const x1 = x * cosZ - y * sinZ;
            const y1 = x * sinZ + y * cosZ;
            const z1 = z;

            // Rotate around X axis (pitch)
            const y2 = y1 * cosX - z1 * sinX;
            const z2 = y1 * sinX + z1 * cosX;

            // Simple perspective projection
            const scale = surfaceState.zoom * Math.min(width, height) * 0.3;
            const px = width / 2 + x1 * scale;
            const py = height / 2 - y2 * scale;

            return { px, py, depth: z2 };
        }

        // Map value to color
        function valueToColor(v, alpha) {
            const t = (v - minVal) / (maxVal - minVal); // 0 to 1
            // Blue (cold/low) -> Green (mid) -> Red (hot/high)
            let r, g, b;
            if (t < 0.5) {
                const s = t * 2;
                r = Math.round(0 + s * 76);
                g = Math.round(100 + s * 155);
                b = Math.round(200 - s * 100);
            } else {
                const s = (t - 0.5) * 2;
                r = Math.round(76 + s * 179);
                g = Math.round(255 - s * 155);
                b = Math.round(100 - s * 100);
            }
            return `rgba(${r},${g},${b},${alpha})`;
        }

        // Build faces (quads) with depth sorting
        const faces = [];
        for (let m = 0; m < numRows - 1; m++) {
            for (let r = 0; r < numCols - 1; r++) {
                // Normalize grid positions to [-1, 1]
                const x0 = (r / (numCols - 1)) * 2 - 1;
                const x1n = ((r + 1) / (numCols - 1)) * 2 - 1;
                const y0 = (m / (numRows - 1)) * 2 - 1;
                const y1n = ((m + 1) / (numRows - 1)) * 2 - 1;

                // Z values normalized to [-0.5, 0.5]
                const z00 = ((dataGrid[m][r] - minVal) / (maxVal - minVal) - 0.5);
                const z10 = ((dataGrid[m][r + 1] - minVal) / (maxVal - minVal) - 0.5);
                const z01 = ((dataGrid[m + 1][r] - minVal) / (maxVal - minVal) - 0.5);
                const z11 = ((dataGrid[m + 1][r + 1] - minVal) / (maxVal - minVal) - 0.5);

                const p00 = project(x0, y0, z00);
                const p10 = project(x1n, y0, z10);
                const p01 = project(x0, y1n, z01);
                const p11 = project(x1n, y1n, z11);

                const avgDepth = (p00.depth + p10.depth + p01.depth + p11.depth) / 4;
                const avgVal = (dataGrid[m][r] + dataGrid[m][r + 1] + dataGrid[m + 1][r] + dataGrid[m + 1][r + 1]) / 4;

                faces.push({
                    points: [p00, p10, p11, p01],
                    depth: avgDepth,
                    color: valueToColor(avgVal, 0.8),
                    wireColor: valueToColor(avgVal, 1.0),
                });
            }
        }

        // Sort faces back-to-front (painter's algorithm)
        faces.sort((a, b) => a.depth - b.depth);

        // Draw faces
        for (let i = 0; i < faces.length; i++) {
            const face = faces[i];
            ctx.beginPath();
            ctx.moveTo(face.points[0].px, face.points[0].py);
            for (let j = 1; j < face.points.length; j++) {
                ctx.lineTo(face.points[j].px, face.points[j].py);
            }
            ctx.closePath();
            ctx.fillStyle = face.color;
            ctx.fill();
            ctx.strokeStyle = face.wireColor;
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }

        // Draw axes labels
        ctx.fillStyle = '#b0b0b0';
        ctx.font = '12px sans-serif';

        // RPM axis label
        const rpmLabel = project(0, -1.2, -0.5);
        ctx.fillText('RPM →', rpmLabel.px - 20, rpmLabel.py);

        // MAP axis label
        const mapLabel = project(-1.2, 0, -0.5);
        ctx.fillText('MAP →', mapLabel.px - 20, mapLabel.py);

        // Draw color legend
        const legendX = width - 80;
        const legendY = 30;
        const legendH = 120;
        for (let i = 0; i < legendH; i++) {
            const t = 1 - (i / legendH);
            const val = minVal + t * (maxVal - minVal);
            ctx.fillStyle = valueToColor(val, 1.0);
            ctx.fillRect(legendX, legendY + i, 15, 1);
        }
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px sans-serif';
        ctx.fillText(maxVal.toFixed(1), legendX + 20, legendY + 10);
        ctx.fillText(((minVal + maxVal) / 2).toFixed(1), legendX + 20, legendY + legendH / 2 + 4);
        ctx.fillText(minVal.toFixed(1), legendX + 20, legendY + legendH);
    }

    // Mouse interaction for rotation
    canvas.addEventListener('mousedown', (e) => {
        surfaceState.dragging = true;
        surfaceState.lastX = e.clientX;
        surfaceState.lastY = e.clientY;
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!surfaceState.dragging) return;
        const dx = e.clientX - surfaceState.lastX;
        const dy = e.clientY - surfaceState.lastY;
        surfaceState.rotZ += dx * 0.01;
        surfaceState.rotX += dy * 0.01;
        // Clamp pitch
        surfaceState.rotX = Math.max(-Math.PI / 2, Math.min(0.1, surfaceState.rotX));
        surfaceState.lastX = e.clientX;
        surfaceState.lastY = e.clientY;
        render();
    });

    canvas.addEventListener('mouseup', () => { surfaceState.dragging = false; });
    canvas.addEventListener('mouseleave', () => { surfaceState.dragging = false; });

    // Scroll to zoom
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        surfaceState.zoom *= e.deltaY > 0 ? 0.9 : 1.1;
        surfaceState.zoom = Math.max(0.3, Math.min(3.0, surfaceState.zoom));
        render();
    });

    // Data selector change — clone to remove old listeners
    const oldSelect = document.getElementById('surface-data-select');
    const newSelect = oldSelect.cloneNode(true);
    oldSelect.parentNode.replaceChild(newSelect, oldSelect);
    newSelect.addEventListener('change', () => { render(); });

    // Reset view button — clone to remove old listeners
    const oldResetBtn = document.getElementById('reset-view-btn');
    const newResetBtn = oldResetBtn.cloneNode(true);
    oldResetBtn.parentNode.replaceChild(newResetBtn, oldResetBtn);
    newResetBtn.addEventListener('click', () => {
        surfaceState.rotX = -0.6;
        surfaceState.rotZ = 0.8;
        surfaceState.zoom = 1.0;
        render();
    });

    // Initial render
    render();
}
