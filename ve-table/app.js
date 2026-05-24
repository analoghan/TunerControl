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
    if (isLd) {
        worker.postMessage({ type: 'process_ld', logBuffer: logData, veText, hitThreshold, minCoolantTemp, minRunTime });
    } else {
        worker.postMessage({ type: 'process', logText: logData, veText, hitThreshold, minCoolantTemp, minRunTime });
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

    const { correctionGrid, diffCsv, newValuesCsv, totalSamples, cellsAboveThreshold, filteredByTime, filteredByCoolant } = msg;

    // Clear previous table content
    tableContainer.innerHTML = '';

    // Show stats line
    const threshold = parseInt(hitThresholdInput.value, 10) || 50;
    let statsText = `Processed ${totalSamples.toLocaleString()} valid samples \u00B7 ${cellsAboveThreshold} cells above threshold (>${threshold} hits)`;
    if (filteredByTime > 0 || filteredByCoolant > 0) {
        const parts = [];
        if (filteredByTime > 0) parts.push(`${filteredByTime.toLocaleString()} by run time`);
        if (filteredByCoolant > 0) parts.push(`${filteredByCoolant.toLocaleString()} by coolant temp`);
        statsText += ` \u00B7 Filtered: ${parts.join(', ')}`;
    }
    statsLine.textContent = statsText;

    // No data case: zero valid samples or zero cells above threshold
    if (totalSamples === 0 || cellsAboveThreshold === 0) {
        noDataMsg.hidden = false;
        downloadBtns.hidden = true;
        tableToggle.hidden = true;
        tableLabel.hidden = true;
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

    downloadDiffBtn.onclick = () => downloadCsv(diffCsv, 'VE_Difference.csv');
    downloadNewBtn.onclick = () => downloadCsv(newValuesCsv, 'VE_New_Values.csv');

    // Wire up table toggle buttons
    const showCorrectionsBtn = document.getElementById('show-corrections-btn');
    const showHitsBtn = document.getElementById('show-hits-btn');

    showCorrectionsBtn.onclick = () => {
        showCorrectionsBtn.classList.add('active');
        showHitsBtn.classList.remove('active');
        renderCorrectionTable(correctionGrid, tableContainer, tableLabel);
    };

    showHitsBtn.onclick = () => {
        showHitsBtn.classList.add('active');
        showCorrectionsBtn.classList.remove('active');
        renderHitCountTable(correctionGrid, tableContainer, tableLabel);
    };

    // Default: show corrections table
    renderCorrectionTable(correctionGrid, tableContainer, tableLabel);
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
