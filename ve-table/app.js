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
let veM1pkgCsv = null; // VE table CSV built from a selected .m1pkg or stored tune (null for CSV inputs)
let veFromStore = false; // the VE table came from a tune stored by the M1 Config Viewer
let vePicked = false;    // the user chose the VE source themselves (don't replace it with a suggestion)
let storedTunes = [];    // tunes stored by the M1 Config Viewer, newest first
let lastResult = null; // stores the last processing result for table toggling
let worker  = null;   // current Web Worker instance
let lastRun = null;   // { file, settings, tune } of the last processed log, for the log panel and the tuning history
let veTuneInfo = null; // { id, name } of the tune the VE table came from (id only for a stored tune), or { name: csv file name }
let logPanel = null, logPanelReady = null;   // log panel (../log-viewer/log-panel.js) and its load promise for lastRun

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
 * Validates that a file has a .m1pkg extension (case-insensitive).
 * @param {File} file
 * @returns {boolean}
 */
function isM1Pkg(file) {
    return file && file.name.toLowerCase().endsWith('.m1pkg');
}

/**
 * Updates the Process button enabled/disabled state based on current file selections.
 */
function updateProcessButtonState() {
    processBtn.disabled = !(logFile && (veFile || veM1pkgCsv));
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
        suggestStoredTune(file);
    } else {
        logFile = null;
        logFilename.textContent = 'No file selected';
    }
    updateProcessButtonState();
});

veInput.addEventListener('change', async () => {
    const file = veInput.files[0] || null;
    veM1pkgCsv = null;
    if (file) { vePicked = true; clearStoredTune(); }
    if (file && !isValidCsv(file) && !isM1Pkg(file)) {
        showError(`Invalid file: "${file.name}" is not a .csv or .m1pkg file.`);
        veFile = null;
        veFilename.textContent = 'No file selected';
        veInput.value = '';
    } else if (isM1Pkg(file)) {
        // Extract Engine.Efficiency.Main from the tune package up front so problems show immediately.
        veFile = null;
        veFilename.textContent = 'Reading ' + file.name + '…';
        updateProcessButtonState();
        try {
            const table = m1pkgVeTableCsv(parseM1Pkg(await readFileAsArrayBuffer(file)));
            if (veInput.files[0] !== file) return; // a different file was picked meanwhile
            veFile = file;
            veM1pkgCsv = table.csv;
            veTuneInfo = { id: null, name: table.tuneName || file.name };
            veFilename.textContent = `${file.name} — ${table.tuneName || 'tune'}, ` +
                `${M1VE_TABLE_NAME} (${table.rpmSites} × ${table.mapSites})`;
            clearError();
        } catch (err) {
            if (veInput.files[0] !== file) return;
            showError(`Could not read the VE table from "${file.name}": ${err.message}`);
            veFilename.textContent = 'No file selected';
            veInput.value = '';
        }
    } else if (file) {
        veFile = file;
        veFilename.textContent = file.name;
        veTuneInfo = { id: null, name: file.name };
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
// Stored tunes (from the M1 Config Viewer)
// ---------------------------------------------------------------------------

const veTuneSelect = document.getElementById('ve-tune');
const veTuneHint = document.getElementById('ve-tune-hint');

function clearStoredTune() {
    if (veFromStore) { veM1pkgCsv = null; veFromStore = false; }
    veTuneSelect.value = '';
    veTuneHint.textContent = '';
    veTuneHint.classList.remove('suggested');
}

/** Use Engine Efficiency Main from a stored tune as the VE table. */
async function useStoredTune(id, hint, suggested) {
    if (!id) { clearStoredTune(); updateProcessButtonState(); return; }
    veTuneSelect.value = id;
    veTuneHint.textContent = 'Loading…';
    try {
        const table = m1pkgVeTableCsv(await tsLoad(id));
        if (veTuneSelect.value !== id) return;   // changed meanwhile
        veM1pkgCsv = table.csv;
        veFromStore = true;
        veFile = null;
        veInput.value = '';
        veFilename.textContent = `Stored tune: ${table.tuneName || 'tune'}, ${M1VE_TABLE_NAME} (${table.rpmSites} × ${table.mapSites})`;
        veTuneInfo = { id, name: table.tuneName || null };
        veTuneHint.textContent = hint || '';
        veTuneHint.classList.toggle('suggested', !!suggested);
        clearError();
    } catch (err) {
        clearStoredTune();
        showError(`Could not read the VE table from the stored tune: ${err.message}`);
    }
    updateProcessButtonState();
}

/** After a log is chosen: suggest the stored tune that was most likely in the ECU, unless a VE source was picked. */
async function suggestStoredTune(file) {
    if (!storedTunes.length || vePicked) return;
    const s = tsSuggest(storedTunes, await tsLogInfo(file));
    if (s.tune) await useStoredTune(s.tune.id, s.reason, true);
    else { veTuneHint.textContent = s.reason; veTuneHint.classList.remove('suggested'); }
}

veTuneSelect.addEventListener('change', () => {
    vePicked = !!veTuneSelect.value;
    useStoredTune(veTuneSelect.value, veTuneSelect.value ? '' : '', false);
});

tsInit().then(tsList).then((list) => {
    storedTunes = list;
    if (!list.length) return;
    veTuneSelect.insertAdjacentHTML('beforeend', list.map((t) => {
        const o = document.createElement('option');
        o.value = t.id;
        o.textContent = tsLabel(t);
        return o.outerHTML;
    }).join(''));
    document.getElementById('ve-tune-row').hidden = false;
    if (logFile) suggestStoredTune(logFile);
}).catch(() => { /* no stored tunes available: the file inputs still work */ });

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
            veM1pkgCsv !== null ? veM1pkgCsv : readFileAsText(veFile),
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
    const minMapForCorrection = parseFloat(document.getElementById('min-map-correction').value) || 0;
    const decelFilterEnabled = document.getElementById('decel-filter').value === 'on';
    const steadyWindowRaw = parseFloat(document.getElementById('steady-window').value);
    const steadyWindowMs = Number.isNaN(steadyWindowRaw) ? 300 : steadyWindowRaw;
    const lambdaDelayMs = parseFloat(document.getElementById('lambda-delay').value) || 0;
    const payload = { veText, hitThreshold, minCoolantTemp, minRunTime, minChangeAmount, scalingFactor, outlierStddev, maxTpsRate, smoothing, minMapForCorrection, decelFilterEnabled, steadyWindowMs, lambdaDelayMs };
    lastRun = { file: logFile, settings: Object.assign({}, payload, { veText: undefined }), tune: veTuneInfo };
    logPanelReady = null;
    if (isLd) {
        worker.postMessage(Object.assign({ type: 'process_ld', logBuffer: logData }, payload));
    } else {
        worker.postMessage(Object.assign({ type: 'process', logText: logData }, payload));
    }
});

// ---------------------------------------------------------------------------
// Log panel: click a table cell to see the samples behind it
// ---------------------------------------------------------------------------

document.getElementById('table-container').addEventListener('click', (e) => {
    const td = e.target.closest('td');
    if (!td || !lastResult || !lastRun || typeof LogPanel === 'undefined') return;
    const tr = td.parentElement, m = Array.prototype.indexOf.call(tr.parentElement.children, tr);
    const r = Array.prototype.indexOf.call(tr.children, td) - 1;   // the first cell is the MAP heading
    const grid = lastResult.correctionGrid;
    if (m < 0 || r < 0 || m >= grid.mapBreakpoints.length || r >= grid.rpmBreakpoints.length) return;
    showCellInLog(m, r);
});

function showCellInLog(m, r) {
    const grid = lastResult.correctionGrid, el = document.getElementById('log-panel');
    el.hidden = false;
    if (!logPanel) logPanel = new LogPanel(el, { preset: 'fuelling', storageKey: 've', showTf: false });
    if (!logPanelReady) {
        const veTable = { mapBreakpoints: grid.mapBreakpoints, rpmBreakpoints: grid.rpmBreakpoints,
                          values: grid.mapBreakpoints.map(() => grid.rpmBreakpoints.map(() => 0)) };
        logPanelReady = logPanel.open(lastRun.file).then(() => logPanel.analyze({ ve: lastRun.settings, veTable }));
    }
    const label = grid.mapBreakpoints[m] + ' kPa × ' + grid.rpmBreakpoints[r] + ' rpm';
    logPanelReady.then(() => logPanel.showCell(m, r, label)).catch(() => { logPanelReady = null; });
    document.getElementById('log-check').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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

    const { correctionGrid, diffCsv, newValuesCsv, totalSamples, cellsAboveThreshold, filteredByTime, filteredByCoolant, filteredByTps, filteredByOutlier, filteredByDecel, filteredByMinMap,
            filteredByFuelCut = 0, filteredBySteady = 0, filteredByLambda = 0 } = msg;

    // Clear previous table content
    tableContainer.innerHTML = '';

    // Show stats line
    const threshold = parseInt(hitThresholdInput.value, 10) || 50;
    let statsText = `Processed ${totalSamples.toLocaleString()} valid samples \u00B7 ${cellsAboveThreshold} cells above threshold (>${threshold} hits)`;
    if (filteredByTime > 0 || filteredByCoolant > 0 || filteredByTps > 0 || filteredByOutlier > 0 || filteredByDecel > 0 || filteredByMinMap > 0 ||
        filteredByFuelCut > 0 || filteredBySteady > 0 || filteredByLambda > 0) {
        const parts = [];
        if (filteredByTime > 0) parts.push(`${filteredByTime.toLocaleString()} by run time`);
        if (filteredByCoolant > 0) parts.push(`${filteredByCoolant.toLocaleString()} by coolant temp`);
        if (filteredByTps > 0) parts.push(`${filteredByTps.toLocaleString()} by TPS rate`);
        if (filteredByFuelCut > 0) parts.push(`${filteredByFuelCut.toLocaleString()} by overrun/fuel cut`);
        if (filteredByDecel > 0) parts.push(`${filteredByDecel.toLocaleString()} by decel/overrun`);
        if (filteredBySteady > 0) parts.push(`${filteredBySteady.toLocaleString()} as not steady-state`);
        if (filteredByLambda > 0) parts.push(`${filteredByLambda.toLocaleString()} by implausible lambda`);
        if (filteredByMinMap > 0) parts.push(`${filteredByMinMap.toLocaleString()} by min MAP`);
        if (filteredByOutlier > 0) parts.push(`${filteredByOutlier.toLocaleString()} as outliers`);
        statsText += ` \u00B7 Filtered: ${parts.join(', ')}`;
    }
    statsLine.textContent = statsText;

    // VE value range sanity check
    if (msg.newValuesGrid && cellsAboveThreshold > 0) {
        let outOfRangeCount = 0;
        let tooLow = 0;
        let tooHigh = 0;
        const { mapBreakpoints } = correctionGrid;
        for (let m = 0; m < msg.newValuesGrid.length; m++) {
            for (let r = 0; r < msg.newValuesGrid[m].length; r++) {
                const ve = msg.newValuesGrid[m][r];
                const cell = correctionGrid.cells[m][r];
                if (cell.correction === null) continue; // skip cells without data
                if (ve < 30) { tooLow++; outOfRangeCount++; }
                else if (ve > 170) { tooHigh++; outOfRangeCount++; }
            }
        }
        if (outOfRangeCount > 0) {
            addWarning(
                'VE range check: ' + outOfRangeCount + ' cell(s) have unusual values' +
                (tooLow > 0 ? ' (' + tooLow + ' below 30%)' : '') +
                (tooHigh > 0 ? ' (' + tooHigh + ' above 170%)' : '') +
                '. This may indicate incorrect injector reference flow or fuel pressure calibration rather than a VE table error.'
            );
        }

        // Check for global bias (all corrections in same direction)
        let posCount = 0, negCount = 0, totalCorrCells = 0;
        for (let m = 0; m < correctionGrid.cells.length; m++) {
            for (let r = 0; r < correctionGrid.cells[m].length; r++) {
                const cell = correctionGrid.cells[m][r];
                if (cell.correction === null || cell.correction === 0) continue;
                totalCorrCells++;
                if (cell.correction > 0) posCount++;
                else negCount++;
            }
        }
        if (totalCorrCells > 5) {
            const biasPct = Math.max(posCount, negCount) / totalCorrCells * 100;
            if (biasPct > 85) {
                const direction = posCount > negCount ? 'positive (lean)' : 'negative (rich)';
                addWarning(
                    'Global bias detected: ' + biasPct.toFixed(0) + '% of corrections are ' + direction +
                    '. This pattern suggests a systemic issue (injector reference flow, fuel pressure calibration, or sensor error) rather than individual VE cell errors.'
                );
            }
        }
    }

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
    const showCltrimBtn = document.getElementById('show-cltrim-btn');
    const showLambdaErrBtn = document.getElementById('show-lambdaerr-btn');

    const allToggleBtns = [showCorrectionsBtn, showHitsBtn, showNewValuesBtn, showStddevBtn, showCltrimBtn, showLambdaErrBtn].filter(Boolean);
    function clearToggle() { allToggleBtns.forEach(b => b.classList.remove('active')); }

    showCorrectionsBtn.onclick = () => {
        clearToggle();
        showCorrectionsBtn.classList.add('active');
        renderCorrectionTable(correctionGrid, tableContainer, tableLabel);
    };

    showNewValuesBtn.onclick = () => {
        clearToggle();
        showNewValuesBtn.classList.add('active');
        renderNewValuesTable(correctionGrid, msg.newValuesGrid, tableContainer, tableLabel);
    };

    showHitsBtn.onclick = () => {
        clearToggle();
        showHitsBtn.classList.add('active');
        renderHitCountTable(correctionGrid, tableContainer, tableLabel);
    };

    showStddevBtn.onclick = () => {
        clearToggle();
        showStddevBtn.classList.add('active');
        renderStdDevTable(correctionGrid, tableContainer, tableLabel);
    };

    showCltrimBtn.onclick = () => {
        clearToggle();
        showCltrimBtn.classList.add('active');
        renderClTrimTable(correctionGrid, tableContainer, tableLabel);
    };

    if (showLambdaErrBtn) {
        showLambdaErrBtn.onclick = () => {
            clearToggle();
            showLambdaErrBtn.classList.add('active');
            renderLambdaErrorTable(correctionGrid, tableContainer, tableLabel);
        };
    }

    // Default: show corrections table
    showCorrectionsBtn.classList.add('active');
    showCltrimBtn.classList.remove('active');
    renderCorrectionTable(correctionGrid, tableContainer, tableLabel);

    document.getElementById('log-check').hidden = typeof LogPanel === 'undefined' || !lastRun;
    if (typeof rsSaveControl === 'function' && lastRun) {
        const run = lastRun;
        rsSaveControl(document.getElementById('history-save'), () => rsLogFacts(run.file).then((facts) =>
            Object.assign({ tool: 've', tuneId: run.tune && run.tune.id, tuneName: run.tune && run.tune.name, settings: run.settings },
                facts, rbVe(msg))));
    }

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


/**
 * Renders the CL Trim absorption table showing how much of the correction
 * comes from closed-loop trim vs raw lambda error.
 */
function renderClTrimTable(correctionGrid, tableContainer, tableLabel) {
    tableContainer.innerHTML = '';
    tableLabel.textContent = 'CL Trim Breakdown — Shows CL trim contribution (top) vs lambda error (bottom) per cell. Large CL trim = ECU is compensating; large lambda error = VE table is wrong.';

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

            if (cell.clTrimAvg === null || cell.clTrimAvg === undefined) {
                td.className = 'below-threshold';
            } else {
                const trim = cell.clTrimAvg;
                const lambdaErr = cell.lambdaError;

                // Color based on which component dominates
                if (Math.abs(trim) > Math.abs(lambdaErr) && Math.abs(trim) > 1) {
                    td.className = 'negative'; // CL trim is doing heavy lifting — concerning
                } else if (Math.abs(lambdaErr) > 2) {
                    td.className = 'positive'; // Lambda error dominates — VE table needs work
                } else {
                    td.className = 'zero';
                }

                // Show both values: trim / lambda error
                td.innerHTML = '<span style="font-size:0.7rem;display:block;">CL: ' + trim.toFixed(1) + '%</span>' +
                               '<span style="font-size:0.7rem;display:block;">\u03BB: ' + lambdaErr.toFixed(1) + '%</span>';
            }

            row.appendChild(td);
        }
        tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableContainer.appendChild(table);
}

/**
 * Renders a Lambda Error table showing (actual/target - 1)*100 per cell.
 * Positive = lean of target, Negative = rich of target.
 */
function renderLambdaErrorTable(correctionGrid, tableContainer, tableLabel) {
    tableContainer.innerHTML = '';
    tableLabel.textContent = 'Lambda Error — Percentage difference between actual and target lambda per cell. Positive = lean of target, Negative = rich of target. This is the residual error after CL trim is applied.';

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

            if (cell.lambdaError === null || cell.lambdaError === undefined) {
                td.className = 'below-threshold';
            } else {
                const err = cell.lambdaError;
                td.textContent = err.toFixed(1) + '%';

                if (err > 2) {
                    td.className = 'positive'; // lean of target
                } else if (err < -2) {
                    td.className = 'negative'; // rich of target
                } else {
                    td.className = 'zero'; // near target
                }
            }

            row.appendChild(td);
        }
        tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableContainer.appendChild(table);
}
