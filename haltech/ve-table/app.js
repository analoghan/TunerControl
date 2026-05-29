/**
 * haltech/ve-table/app.js — UI controller for Haltech VE Table Analyzer
 * Stage 2: Table toggle views, downloads, smoothing integration
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
var currentView = 'correction';

// ---------------------------------------------------------------------------
// File Input
// ---------------------------------------------------------------------------

logInput.addEventListener('change', function() {
    selectedLogFile = logInput.files[0] || null;
    document.getElementById('log-filename').textContent = selectedLogFile ? selectedLogFile.name : 'No file selected';
    analyzeBtn.disabled = !selectedLogFile;
    errorContainer.hidden = true;
});

veInput.addEventListener('change', function() {
    selectedVeFile = veInput.files[0] || null;
    document.getElementById('ve-filename').textContent = selectedVeFile ? selectedVeFile.name : 'No file selected';
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
    worker.postMessage({ type: 'analyze', logText: files.log, veTableText: files.ve || null, settings: getSettings() });
}

function getSettings() {
    return {
        hitThreshold: parseInt(document.getElementById('hit-threshold').value, 10) || 50,
        minCoolantTemp: parseInt(document.getElementById('min-coolant-temp').value, 10) || 55,
        minRunTime: parseInt(document.getElementById('min-run-time').value, 10) || 60,
        minChangeAmount: parseFloat(document.getElementById('min-change-amount').value) || 0,
        scalingFactor: parseInt(document.getElementById('scaling-factor').value, 10) || 100,
        outlierSigma: parseFloat(document.getElementById('outlier-sigma').value) || 0,
        maxTpsRate: parseInt(document.getElementById('max-tps-rate').value, 10) || 0,
        smoothing: parseFloat(document.getElementById('smoothing').value) || 0,
    };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResults(msg) {
    resultsSection.hidden = false;

    // Stats line (matching MoTeC format)
    var statsLine = document.getElementById('stats-line');
    var fs = msg.filterStats;
    statsLine.textContent = msg.logStats.totalSamples.toLocaleString() + ' samples → ' +
        fs.valid.toLocaleString() + ' valid (' +
        msg.stats.cellsAboveThreshold + '/' + msg.stats.totalCells + ' cells above threshold). ' +
        'Filtered: ' + fs.byRunTime + ' run time, ' + fs.byCoolant + ' coolant, ' +
        fs.byTpsRate + ' TPS rate, ' + fs.byLambda + ' lambda, ' + fs.byOutlier + ' outliers.';

    // Show download buttons
    var dlBtns = document.getElementById('download-btns');
    dlBtns.hidden = false;
    document.getElementById('download-new-btn').hidden = !msg.newValuesCsv;

    // Show table toggle
    document.getElementById('table-toggle').hidden = false;
    document.getElementById('table-label').hidden = false;

    // Render current view
    currentView = 'correction';
    renderCurrentView();
    setupToggle();
    setupDownloads(msg);
    render3DSurface(msg.grid);
    renderWarnings(msg);
}

function renderWarnings(msg) {
    var warnings = [];

    // Channel warnings
    if (msg.logStats.channelWarnings) {
        msg.logStats.channelWarnings.forEach(function(w) { warnings.push(w); });
    }

    // Global bias detection
    var grid = msg.grid;
    var posCount = 0, negCount = 0, totalCells = 0;
    for (var m = 0; m < grid.cells.length; m++) {
        for (var r = 0; r < grid.cells[m].length; r++) {
            var c = grid.cells[m][r];
            if (c.correction !== null && c.correction !== 0) {
                totalCells++;
                if (c.correction > 0) posCount++;
                else negCount++;
            }
        }
    }
    if (totalCells > 5) {
        var posRatio = posCount / totalCells;
        var negRatio = negCount / totalCells;
        if (posRatio > 0.85) {
            warnings.push('⚠ Global lean bias: ' + Math.round(posRatio * 100) + '% of cells need more fuel. This suggests a systemic issue (injector flow, fuel pressure, or base fuel equation) rather than individual VE cell errors.');
        } else if (negRatio > 0.85) {
            warnings.push('⚠ Global rich bias: ' + Math.round(negRatio * 100) + '% of cells need less fuel. This suggests a systemic issue (fuel pressure too high, injector data incorrect).');
        }
    }

    // VE range sanity check
    if (msg.newValuesCsv) {
        if (!lastResult._newValuesGrid) lastResult._newValuesGrid = parseNewValuesCsv(msg.newValuesCsv);
        var nv = lastResult._newValuesGrid;
        var outOfRange = 0;
        for (var m = 0; m < nv.length; m++) {
            for (var r = 0; r < nv[m].length; r++) {
                if (nv[m][r] > 170 || nv[m][r] < 20) outOfRange++;
            }
        }
        if (outOfRange > 0) {
            warnings.push('⚠ ' + outOfRange + ' corrected VE cells fall outside 20–170% range. Check injector reference flow or fuel pressure calibration.');
        }
    }

    // Render into warning banner
    var warningContainer = document.getElementById('warning-container');
    if (warnings.length > 0) {
        warningContainer.hidden = false;
        warningContainer.innerHTML = warnings.map(function(w) {
            return '<div class="warning-item">' + w + '</div>';
        }).join('');
    } else {
        warningContainer.hidden = true;
    }
}

// ---------------------------------------------------------------------------
// Table Toggle
// ---------------------------------------------------------------------------

function setupToggle() {
    var toggle = document.getElementById('table-toggle');
    var buttons = toggle.querySelectorAll('.toggle-btn');
    buttons.forEach(function(btn) {
        btn.onclick = function() {
            buttons.forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            currentView = btn.getAttribute('data-view');
            renderCurrentView();
        };
    });
}

var VIEW_META = {
    correction: { label: 'VE Correction Map (%)', desc: 'Percentage change needed per cell. Green = lean (needs more fuel), Red = rich (needs less).' },
    newvalues: { label: 'Corrected VE Values', desc: 'Original VE with corrections applied. Highlighted cells were modified.' },
    hits: { label: 'Hit Count Map', desc: 'Number of valid samples per cell. Higher = more confidence.' },
    stddev: { label: 'Standard Deviation', desc: 'Per-cell correction variance. Green (≤1) = confident, Yellow (≤3) = moderate, Red (>3) = noisy.' },
    trim: { label: 'Total Trim (STFT + LTFT)', desc: 'Average combined short-term + long-term fuel trim per cell. Shows how much the ECU is compensating.' },
    lambdaerr: { label: 'Lambda Error', desc: 'Percentage difference between actual and target lambda. Positive = lean of target, Negative = rich of target.' },
};

function renderCurrentView() {
    if (!lastResult) return;
    var meta = VIEW_META[currentView];
    document.getElementById('table-label').textContent = meta.label;
    var container = document.getElementById('table-grid');
    container.innerHTML = '';

    var grid = lastResult.grid;
    var table = buildGridTable(grid, currentView);
    container.appendChild(table);
}

function buildGridTable(grid, view) {
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
            formatCell(td, cell, view, m, r);
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

function formatCell(td, cell, view, mapIdx, rpmIdx) {
    if (view === 'correction') {
        if (cell.correction !== null) {
            td.textContent = cell.correction.toFixed(1);
            if (cell.correction > 1) { td.className = 'cell-pos'; if (cell.correction > 5) td.className += ' cell-hot'; }
            else if (cell.correction < -1) { td.className = 'cell-neg'; if (cell.correction < -5) td.className += ' cell-cold'; }
            else { td.className = 'cell-zero'; }
        } else { td.textContent = ''; td.className = 'cell-empty'; }
    } else if (view === 'newvalues') {
        if (cell.correction !== null && lastResult && lastResult.newValuesCsv) {
            // Compute new VE from original + correction
            var veTable = lastResult.veTable;
            // We don't have veTable stored separately, so show from grid data
            td.textContent = cell.correction !== 0 ? '✓' : '';
            td.className = cell.correction !== 0 ? 'cell-modified' : 'cell-unchanged';
        } else { td.textContent = ''; td.className = 'cell-empty'; }
        // Actually render from the newValuesCsv
        renderNewValueCell(td, cell, mapIdx, rpmIdx);
    } else if (view === 'hits') {
        td.textContent = cell.count > 0 ? cell.count : '';
        if (cell.count > 200) td.className = 'hit-high';
        else if (cell.count > 50) td.className = 'hit-med';
        else td.className = 'hit-low';
    } else if (view === 'stddev') {
        if (cell.stddev !== null) {
            td.textContent = cell.stddev.toFixed(1);
            if (cell.stddev <= 1.0) td.className = 'stddev-low';
            else if (cell.stddev <= 3.0) td.className = 'stddev-med';
            else td.className = 'stddev-high';
        } else { td.textContent = ''; td.className = 'cell-empty'; }
    } else if (view === 'trim') {
        if (cell.clTrimAvg !== null) {
            td.textContent = cell.clTrimAvg.toFixed(1);
            if (cell.clTrimAvg > 3) td.className = 'cell-pos';
            else if (cell.clTrimAvg < -3) td.className = 'cell-neg';
            else td.className = 'cell-zero';
        } else { td.textContent = ''; td.className = 'cell-empty'; }
    } else if (view === 'lambdaerr') {
        if (cell.correction !== null && cell.clTrimAvg !== null) {
            var lambdaErr = cell.correction - cell.clTrimAvg;
            td.textContent = lambdaErr.toFixed(1);
            if (lambdaErr > 1) { td.className = 'cell-pos'; if (lambdaErr > 5) td.className += ' cell-hot'; }
            else if (lambdaErr < -1) { td.className = 'cell-neg'; if (lambdaErr < -5) td.className += ' cell-cold'; }
            else { td.className = 'cell-zero'; }
        } else { td.textContent = ''; td.className = 'cell-empty'; }
    }
}

function renderNewValueCell(td, cell, mapIdx, rpmIdx) {
    if (!lastResult || !lastResult.newValuesCsv) { td.textContent = ''; td.className = 'cell-empty'; return; }
    // Parse new values from CSV (cached on first call)
    if (!lastResult._newValuesGrid) {
        lastResult._newValuesGrid = parseNewValuesCsv(lastResult.newValuesCsv);
    }
    var nv = lastResult._newValuesGrid;
    if (nv && nv[mapIdx] && nv[mapIdx][rpmIdx] !== undefined) {
        var val = nv[mapIdx][rpmIdx];
        td.textContent = val.toFixed(1);
        td.className = (cell.correction !== null && cell.correction !== 0) ? 'cell-modified' : 'cell-unchanged';
    } else { td.textContent = ''; td.className = 'cell-empty'; }
}

function parseNewValuesCsv(csv) {
    var lines = csv.split('\n');
    var grid = [];
    var inData = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('CellValues:')) { inData = true; continue; }
        if (inData && lines[i].trim() !== '') {
            var fields = lines[i].split(',');
            var row = [];
            for (var f = 0; f < fields.length; f++) {
                var v = parseInt(fields[f], 10);
                row.push(isNaN(v) ? 0 : v / 10.0);
            }
            grid.push(row);
        }
    }
    return grid;
}

// ---------------------------------------------------------------------------
// Downloads & Clipboard
// ---------------------------------------------------------------------------

function setupDownloads(msg) {
    document.getElementById('download-diff-btn').onclick = function() {
        downloadFile('VE_Difference.csv', msg.diffCsv);
    };
    document.getElementById('download-new-btn').onclick = function() {
        if (msg.newValuesCsv) downloadFile('VE_New_Values.csv', msg.newValuesCsv);
    };
    document.getElementById('copy-table-btn').onclick = function() {
        var csv = currentView === 'correction' ? msg.diffCsv :
                  currentView === 'hits' ? msg.hitCsv :
                  currentView === 'stddev' ? msg.stddevCsv :
                  currentView === 'newvalues' ? (msg.newValuesCsv || msg.diffCsv) :
                  msg.diffCsv;
        copyToClipboard(csv);
        var btn = document.getElementById('copy-table-btn');
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy Table to Clipboard'; }, 1500);
    };
}

function downloadFile(filename, content) {
    var blob = new Blob([content], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showError(message) {
    errorContainer.textContent = message;
    errorContainer.hidden = false;
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(function() {}).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    });
}

// ---------------------------------------------------------------------------
// 3D Surface Plot (Canvas-based wireframe)
// ---------------------------------------------------------------------------

var surfaceState = { yaw: -0.6, pitch: 0.5, zoom: 1.0, dragging: false, lastX: 0, lastY: 0 };

function render3DSurface(grid) {
    var section = document.getElementById('surface-section');
    if (!section) return;
    section.hidden = false;

    var canvas = document.getElementById('surface-canvas');
    var ctx = canvas.getContext('2d');
    var dataSelect = document.getElementById('surface-data-select');
    var resetBtn = document.getElementById('reset-view-btn');

    function getData() {
        var mode = dataSelect.value;
        var data = [];
        for (var m = 0; m < grid.cells.length; m++) {
            var row = [];
            for (var r = 0; r < grid.cells[m].length; r++) {
                var c = grid.cells[m][r];
                if (mode === 'corrections') row.push(c.correction !== null ? c.correction : 0);
                else if (mode === 'stddev') row.push(c.stddev !== null ? c.stddev : 0);
                else if (mode === 'newValues') {
                    if (!lastResult._newValuesGrid) lastResult._newValuesGrid = parseNewValuesCsv(lastResult.newValuesCsv || '');
                    var nv = lastResult._newValuesGrid;
                    row.push(nv && nv[m] && nv[m][r] !== undefined ? nv[m][r] : 0);
                }
                else row.push(0);
            }
            data.push(row);
        }
        return data;
    }

    function project(x, y, z) {
        var cosY = Math.cos(surfaceState.yaw), sinY = Math.sin(surfaceState.yaw);
        var cosP = Math.cos(surfaceState.pitch), sinP = Math.sin(surfaceState.pitch);
        var rx = x * cosY - z * sinY;
        var rz = x * sinY + z * cosY;
        var ry = y * cosP - rz * sinP;
        rz = y * sinP + rz * cosP;
        var scale = surfaceState.zoom * 250 / (rz + 4);
        return { x: canvas.width / 2 + rx * scale, y: canvas.height / 2 - ry * scale, z: rz };
    }

    function draw() {
        var data = getData();
        var numRows = data.length;
        var numCols = data[0] ? data[0].length : 0;
        if (numRows === 0 || numCols === 0) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111111';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Find data range for color mapping
        var minVal = Infinity, maxVal = -Infinity;
        for (var m = 0; m < numRows; m++) {
            for (var r = 0; r < numCols; r++) {
                var v = data[m][r];
                if (v < minVal) minVal = v;
                if (v > maxVal) maxVal = v;
            }
        }
        var range = maxVal - minVal || 1;

        // Build quads with depth for painter's algorithm
        var quads = [];
        for (var m = 0; m < numRows - 1; m++) {
            for (var r = 0; r < numCols - 1; r++) {
                var v00 = data[m][r], v10 = data[m][r+1], v01 = data[m+1][r], v11 = data[m+1][r+1];

                var x0 = (r / (numCols - 1)) * 2 - 1;
                var x1 = ((r + 1) / (numCols - 1)) * 2 - 1;
                var z0 = (m / (numRows - 1)) * 2 - 1;
                var z1 = ((m + 1) / (numRows - 1)) * 2 - 1;
                var y00 = (v00 - minVal) / range - 0.5;
                var y10 = (v10 - minVal) / range - 0.5;
                var y01 = (v01 - minVal) / range - 0.5;
                var y11 = (v11 - minVal) / range - 0.5;

                var p0 = project(x0, y00, z0);
                var p1 = project(x1, y10, z0);
                var p2 = project(x1, y11, z1);
                var p3 = project(x0, y01, z1);

                var avgZ = (p0.z + p1.z + p2.z + p3.z) / 4;
                var avgVal = (v00 + v10 + v01 + v11) / 4;
                quads.push({ pts: [p0, p1, p2, p3], depth: avgZ, val: avgVal });
            }
        }

        // Sort back-to-front
        quads.sort(function(a, b) { return b.depth - a.depth; });

        // Draw quads
        for (var i = 0; i < quads.length; i++) {
            var q = quads[i];
            var t = (q.val - minVal) / range;
            var color = valueToColor(t);

            ctx.beginPath();
            ctx.moveTo(q.pts[0].x, q.pts[0].y);
            ctx.lineTo(q.pts[1].x, q.pts[1].y);
            ctx.lineTo(q.pts[2].x, q.pts[2].y);
            ctx.lineTo(q.pts[3].x, q.pts[3].y);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }

        // Draw color legend
        drawLegend(ctx, minVal, maxVal);
    }

    function valueToColor(t) {
        // Blue (rich/negative) -> White (zero) -> Green (lean/positive)
        if (t < 0.5) {
            var s = t * 2;
            var r = Math.round(50 + s * 200);
            var g = Math.round(50 + s * 200);
            var b = Math.round(200 - s * 150);
            return 'rgb(' + r + ',' + g + ',' + b + ')';
        } else {
            var s = (t - 0.5) * 2;
            var r = Math.round(250 - s * 200);
            var g = Math.round(250 - s * 80);
            var b = Math.round(50);
            return 'rgb(' + r + ',' + g + ',' + b + ')';
        }
    }

    function drawLegend(ctx, minVal, maxVal) {
        var x = canvas.width - 80, y = 20, w = 15, h = 120;
        for (var i = 0; i < h; i++) {
            var t = 1 - i / h;
            ctx.fillStyle = valueToColor(t);
            ctx.fillRect(x, y + i, w, 1);
        }
        ctx.strokeStyle = '#555';
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = '#ccc';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(maxVal.toFixed(1) + '%', x + w + 4, y + 8);
        ctx.fillText('0', x + w + 4, y + h / 2 + 3);
        ctx.fillText(minVal.toFixed(1) + '%', x + w + 4, y + h);
    }

    // Mouse interaction
    canvas.onmousedown = function(e) { surfaceState.dragging = true; surfaceState.lastX = e.clientX; surfaceState.lastY = e.clientY; };
    canvas.onmouseup = function() { surfaceState.dragging = false; };
    canvas.onmouseleave = function() { surfaceState.dragging = false; };
    canvas.onmousemove = function(e) {
        if (!surfaceState.dragging) return;
        var dx = e.clientX - surfaceState.lastX;
        var dy = e.clientY - surfaceState.lastY;
        surfaceState.yaw += dx * 0.01;
        surfaceState.pitch += dy * 0.01;
        surfaceState.pitch = Math.max(-1.2, Math.min(1.2, surfaceState.pitch));
        surfaceState.lastX = e.clientX;
        surfaceState.lastY = e.clientY;
        draw();
    };
    canvas.onwheel = function(e) {
        e.preventDefault();
        surfaceState.zoom *= e.deltaY > 0 ? 0.9 : 1.1;
        surfaceState.zoom = Math.max(0.3, Math.min(3, surfaceState.zoom));
        draw();
    };

    dataSelect.onchange = draw;
    resetBtn.onclick = function() {
        surfaceState.yaw = -0.6; surfaceState.pitch = 0.5; surfaceState.zoom = 1.0;
        draw();
    };

    draw();
}
