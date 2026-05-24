/**
 * charts.js — Chart.js rendering module for Injector Characterization.
 * Uses Chart.js 4.x with chartjs-plugin-zoom for interactive charts.
 *
 * Provides:
 *   - renderAllCharts(containers, chartData) — main entry point called by app.js
 *   - Individual renderers for 7 chart types
 *
 * Interactive features:
 *   - Drag-to-zoom on both axes
 *   - Double-click to reset zoom
 *   - Legend toggling (click legend items to show/hide datasets)
 */

// ---------------------------------------------------------------------------
// Plugin Registration
// ---------------------------------------------------------------------------

// chartjs-plugin-zoom auto-registers when loaded after Chart.js.
// If it didn't auto-register (e.g., loaded in wrong order), register manually.
if (typeof ChartZoom !== 'undefined' && typeof Chart !== 'undefined') {
    try { Chart.register(ChartZoom); } catch(e) { /* already registered */ }
}

// ---------------------------------------------------------------------------
// Color Palette
// ---------------------------------------------------------------------------

var CHART_COLORS = {
    lambdaB1:       '#4a9eff',
    lambdaB2:       '#ff6b7a',
    pw:             '#00c9a7',
    fuelPressure:   '#ffd54f',
    fuelPressAim:   '#a0a0b0',
    threshold:      '#dc3545',
    gridlines:      'rgba(255,255,255,0.1)',
    text:           '#cccccc'
};

// ---------------------------------------------------------------------------
// Chart Instance Tracking
// ---------------------------------------------------------------------------

var chartInstances = {};

/**
 * Destroys a previous chart instance on the given canvas key before creating a new one.
 * @param {string} key - Unique key for the chart instance
 */
function destroyChart(key) {
    if (chartInstances[key]) {
        chartInstances[key].destroy();
        chartInstances[key] = null;
    }
}

/**
 * Adds a "Reset Zoom" button next to a chart canvas if one doesn't already exist.
 * Clicking it calls chart.resetZoom().
 * @param {HTMLCanvasElement} canvas
 * @param {string} key - Chart instance key
 */
function addResetZoomButton(canvas, key) {
    var parent = canvas.parentElement;
    if (!parent) return;
    // Remove existing reset button if present
    var existing = parent.querySelector('.reset-zoom-btn');
    if (existing) existing.parentElement.removeChild(existing);

    var btn = document.createElement('button');
    btn.className = 'reset-zoom-btn';
    btn.textContent = 'Reset Zoom';
    btn.style.cssText = 'position:absolute;top:8px;right:12px;padding:3px 8px;font-size:11px;background:#0f3460;color:#e0e0e0;border:1px solid #4a9eff;border-radius:3px;cursor:pointer;z-index:10;';
    btn.onclick = function() {
        if (chartInstances[key]) {
            chartInstances[key].resetZoom();
        }
    };
    // Ensure parent is positioned for absolute button
    if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
    }
    parent.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Shared Configuration Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the shared zoom plugin configuration for all charts.
 */
function getZoomConfig() {
    return {
        zoom: {
            drag: {
                enabled: true,
                backgroundColor: 'rgba(74,158,255,0.2)'
            },
            mode: 'xy'
        },
        pan: {
            enabled: false
        }
    };
}

/**
 * Returns common dark-theme scale options.
 * @param {string} xTitle - X axis label
 * @param {string} yTitle - Y axis label
 * @param {Object} [xOpts] - Additional x-axis options
 * @param {Object} [yOpts] - Additional y-axis options
 */
function getScaleOptions(xTitle, yTitle, xOpts, yOpts) {
    var x = {
        title: { display: true, text: xTitle, color: CHART_COLORS.text },
        ticks: { color: CHART_COLORS.text },
        grid: { color: CHART_COLORS.gridlines }
    };
    var y = {
        title: { display: true, text: yTitle, color: CHART_COLORS.text },
        ticks: { color: CHART_COLORS.text },
        grid: { color: CHART_COLORS.gridlines }
    };
    if (xOpts) {
        for (var k in xOpts) { if (xOpts.hasOwnProperty(k)) x[k] = xOpts[k]; }
    }
    if (yOpts) {
        for (var k in yOpts) { if (yOpts.hasOwnProperty(k)) y[k] = yOpts[k]; }
    }
    return { x: x, y: y };
}

/**
 * Creates a threshold/reference line dataset rendered as a flat line.
 * Uses only 2 data points (start and end of x-range).
 * @param {string} label - Legend label
 * @param {number} yValue - The constant Y value for the line
 * @param {number} xMin - Start of x-range
 * @param {number} xMax - End of x-range
 * @param {string} color - Line color
 * @param {number[]} [dash] - Border dash pattern
 */
function makeThresholdDataset(label, yValue, xMin, xMax, color, dash) {
    return {
        label: label,
        data: [{ x: xMin, y: yValue }, { x: xMax, y: yValue }],
        showLine: true,
        pointRadius: 0,
        borderColor: color,
        borderWidth: 1.5,
        borderDash: dash || [6, 4],
        fill: false,
        order: 10
    };
}

/**
 * Creates a vertical threshold/reference line dataset.
 * @param {string} label - Legend label
 * @param {number} xValue - The constant X value for the line
 * @param {number} yMin - Start of y-range
 * @param {number} yMax - End of y-range
 * @param {string} color - Line color
 * @param {number[]} [dash] - Border dash pattern
 */
function makeVerticalThresholdDataset(label, xValue, yMin, yMax, color, dash) {
    return {
        label: label,
        data: [{ x: xValue, y: yMin }, { x: xValue, y: yMax }],
        showLine: true,
        pointRadius: 0,
        borderColor: color,
        borderWidth: 1.5,
        borderDash: dash || [6, 4],
        fill: false,
        order: 10
    };
}

// ---------------------------------------------------------------------------
// Individual Chart Renderers
// ---------------------------------------------------------------------------

/**
 * Renders the Lambda time series chart.
 * Line chart: Lambda B1 and/or B2 over time, with threshold lines at 1.06 and 1.0.
 */
function renderLambdaTimeSeries(canvas, data) {
    destroyChart('lambdaTs');

    var time = data.time;
    var tMin = time[0];
    var tMax = time[time.length - 1];

    var datasets = [];

    if (data.lambdaB1) {
        var b1Data = [];
        for (var i = 0; i < data.lambdaB1.length; i++) {
            if (!isNaN(data.lambdaB1[i])) {
                b1Data.push({ x: time[i], y: data.lambdaB1[i] });
            }
        }
        datasets.push({
            label: 'Lambda B1',
            data: b1Data,
            showLine: true,
            borderColor: CHART_COLORS.lambdaB1,
            backgroundColor: CHART_COLORS.lambdaB1,
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            order: 1
        });
    }

    if (data.lambdaB2) {
        var b2Data = [];
        for (var i = 0; i < data.lambdaB2.length; i++) {
            if (!isNaN(data.lambdaB2[i])) {
                b2Data.push({ x: time[i], y: data.lambdaB2[i] });
            }
        }
        datasets.push({
            label: 'Lambda B2',
            data: b2Data,
            showLine: true,
            borderColor: CHART_COLORS.lambdaB2,
            backgroundColor: CHART_COLORS.lambdaB2,
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            order: 2
        });
    }

    // Threshold lines
    datasets.push(makeThresholdDataset('Lean threshold (1.06)', 1.06, tMin, tMax, CHART_COLORS.threshold));
    datasets.push(makeThresholdDataset('Stoich (1.0)', 1.0, tMin, tMax, 'rgba(200,200,200,0.5)'));

    chartInstances['lambdaTs'] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                zoom: getZoomConfig(),
                legend: { labels: { color: CHART_COLORS.text } }
            },
            scales: getScaleOptions('Time (s)', 'Lambda')
        }
    });
    addResetZoomButton(canvas, 'lambdaTs');
}

/**
 * Renders the Injector Pulsewidth time series chart.
 * Line chart: PW over time, with 0.8ms threshold.
 */
function renderPWTimeSeries(canvas, data) {
    destroyChart('pwTs');

    var time = data.time;
    var tMin = time[0];
    var tMax = time[time.length - 1];
    var pw = data.injPW;

    var pwData = [];
    for (var i = 0; i < pw.length; i++) {
        if (!isNaN(pw[i])) {
            pwData.push({ x: time[i], y: pw[i] });
        }
    }

    var datasets = [
        {
            label: 'Inj PW',
            data: pwData,
            showLine: true,
            borderColor: CHART_COLORS.pw,
            backgroundColor: CHART_COLORS.pw,
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            order: 1
        },
        makeThresholdDataset('XDI threshold (0.8 ms)', 0.8, tMin, tMax, CHART_COLORS.threshold)
    ];

    chartInstances['pwTs'] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                zoom: getZoomConfig(),
                legend: { labels: { color: CHART_COLORS.text } }
            },
            scales: getScaleOptions('Time (s)', 'Pulse Width (ms)')
        }
    });
    addResetZoomButton(canvas, 'pwTs');
}

/**
 * Renders the Lambda vs PW scatter chart.
 * Scatter: PW (x) vs Lambda (y), color by lean/rich.
 */
function renderLambdaVsPWScatter(canvas, data) {
    destroyChart('lambdaPwScatter');

    var pw = data.injPW;
    var lambda = data.lambdaB1 || data.lambdaB2;
    if (!pw || !lambda) return;

    var leanData = [];
    var richData = [];
    var pwMin = Infinity, pwMax = -Infinity;
    var lamMin = Infinity, lamMax = -Infinity;

    for (var i = 0; i < pw.length; i++) {
        var p = pw[i];
        var l = lambda[i];
        if (isNaN(p) || isNaN(l)) continue;
        if (p < pwMin) pwMin = p;
        if (p > pwMax) pwMax = p;
        if (l < lamMin) lamMin = l;
        if (l > lamMax) lamMax = l;

        if (l > 1.06) {
            leanData.push({ x: p, y: l });
        } else {
            richData.push({ x: p, y: l });
        }
    }

    if (pwMin === Infinity) return;

    var datasets = [
        {
            label: 'Lambda \u2264 1.06',
            data: richData,
            backgroundColor: 'rgba(74, 158, 255, 0.3)',
            borderColor: 'rgba(74, 158, 255, 0.8)',
            pointRadius: 1.5,
            order: 2
        },
        {
            label: 'Lambda > 1.06 (lean)',
            data: leanData,
            backgroundColor: 'rgba(220, 53, 69, 0.3)',
            borderColor: 'rgba(220, 53, 69, 0.8)',
            pointRadius: 1.5,
            order: 1
        },
        makeThresholdDataset('Lean threshold (1.06)', 1.06, pwMin, pwMax, CHART_COLORS.threshold),
        makeVerticalThresholdDataset('XDI threshold (0.8 ms)', 0.8, lamMin, lamMax, CHART_COLORS.threshold)
    ];

    chartInstances['lambdaPwScatter'] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                zoom: getZoomConfig(),
                legend: { labels: { color: CHART_COLORS.text } }
            },
            scales: getScaleOptions('Pulse Width (ms)', 'Lambda')
        }
    });
    addResetZoomButton(canvas, 'lambdaPwScatter');
}

/**
 * Renders the Fuel Pressure time series chart.
 * Line chart: Fuel pressure + aim over time, 150 bar threshold.
 */
function renderFuelPressureTimeSeries(canvas, data) {
    destroyChart('fuelPressureTs');

    var time = data.time;
    var tMin = time[0];
    var tMax = time[time.length - 1];
    var press = data.fuelPressDI;

    var pressData = [];
    for (var i = 0; i < press.length; i++) {
        if (!isNaN(press[i])) {
            pressData.push({ x: time[i], y: press[i] });
        }
    }

    var datasets = [
        {
            label: 'Fuel Pressure',
            data: pressData,
            showLine: true,
            borderColor: CHART_COLORS.fuelPressure,
            backgroundColor: CHART_COLORS.fuelPressure,
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            order: 1
        }
    ];

    if (data.fuelPressDIAim) {
        var aimData = [];
        for (var i = 0; i < data.fuelPressDIAim.length; i++) {
            if (!isNaN(data.fuelPressDIAim[i])) {
                aimData.push({ x: time[i], y: data.fuelPressDIAim[i] });
            }
        }
        datasets.push({
            label: 'Pressure Aim',
            data: aimData,
            showLine: true,
            borderColor: CHART_COLORS.fuelPressAim,
            backgroundColor: CHART_COLORS.fuelPressAim,
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            order: 2
        });
    }

    datasets.push(makeThresholdDataset('Low threshold (150 bar)', 150, tMin, tMax, CHART_COLORS.threshold));

    chartInstances['fuelPressureTs'] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                zoom: getZoomConfig(),
                legend: { labels: { color: CHART_COLORS.text } }
            },
            scales: getScaleOptions('Time (s)', 'Pressure (bar)')
        }
    });
    addResetZoomButton(canvas, 'fuelPressureTs');
}

/**
 * Renders the PW Histogram chart.
 * Bar chart: PW distribution histogram with 0.8ms threshold line.
 */
function renderPWHistogram(canvas, data) {
    destroyChart('pwHistogram');

    var pw = data.injPW;
    if (!pw || pw.length === 0) return;

    // Find min/max PW
    var pwMin = Infinity, pwMax = -Infinity;
    var validCount = 0;
    for (var i = 0; i < pw.length; i++) {
        var v = pw[i];
        if (isNaN(v)) continue;
        if (v < pwMin) pwMin = v;
        if (v > pwMax) pwMax = v;
        validCount++;
    }

    if (validCount === 0 || pwMin === pwMax) return;

    // Compute histogram bins (~50 bins)
    var numBins = 50;
    var binWidth = (pwMax - pwMin) / numBins;
    var bins = new Array(numBins).fill(0);
    var binLabels = [];

    for (var i = 0; i < numBins; i++) {
        var binCenter = pwMin + (i + 0.5) * binWidth;
        binLabels.push(binCenter.toFixed(2));
    }

    for (var i = 0; i < pw.length; i++) {
        var val = pw[i];
        if (isNaN(val)) continue;
        var binIdx = Math.floor((val - pwMin) / binWidth);
        if (binIdx >= numBins) binIdx = numBins - 1;
        if (binIdx < 0) binIdx = 0;
        bins[binIdx]++;
    }

    // Determine which bin the 0.8ms threshold falls in
    var thresholdBinIdx = Math.floor((0.8 - pwMin) / binWidth);

    // Color bars: below threshold in red-tinted, above in teal
    var barColors = [];
    for (var i = 0; i < numBins; i++) {
        if (i <= thresholdBinIdx && 0.8 >= pwMin && 0.8 <= pwMax) {
            barColors.push('rgba(220, 53, 69, 0.6)');
        } else {
            barColors.push(CHART_COLORS.pw);
        }
    }

    // Find max count for threshold line y-range
    var maxCount = 0;
    for (var i = 0; i < bins.length; i++) {
        if (bins[i] > maxCount) maxCount = bins[i];
    }

    var datasets = [
        {
            label: 'PW Distribution',
            data: bins,
            backgroundColor: barColors,
            borderColor: barColors,
            borderWidth: 1
        }
    ];

    chartInstances['pwHistogram'] = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: binLabels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                zoom: getZoomConfig(),
                legend: { labels: { color: CHART_COLORS.text } },
                annotation: undefined
            },
            scales: {
                x: {
                    title: { display: true, text: 'Pulse Width (ms)', color: CHART_COLORS.text },
                    ticks: {
                        color: CHART_COLORS.text,
                        maxTicksLimit: 10,
                        callback: function(value, index) {
                            // Show fewer labels
                            if (index % Math.ceil(numBins / 10) === 0) {
                                return binLabels[index];
                            }
                            return '';
                        }
                    },
                    grid: { color: CHART_COLORS.gridlines }
                },
                y: {
                    title: { display: true, text: 'Count', color: CHART_COLORS.text },
                    ticks: { color: CHART_COLORS.text },
                    grid: { color: CHART_COLORS.gridlines },
                    beginAtZero: true
                }
            }
        }
    });
    addResetZoomButton(canvas, 'pwHistogram');
}

/**
 * Renders the Lambda-RPM Density chart.
 * Bubble chart where each bubble represents a density cell.
 * Size = sqrt-scaled density, color = intensity from dark blue to yellow/white.
 */
function renderLambdaRPMDensity(canvas, data) {
    destroyChart('lambdaRpmDensity');

    var rpm = data.rpm;
    var lambda = data.lambdaB1 || data.lambdaB2;
    if (!rpm || !lambda) return;

    // Compute data ranges
    var rpmMin = Infinity, rpmMax = -Infinity;
    var lamMin = Infinity, lamMax = -Infinity;
    for (var i = 0; i < rpm.length; i++) {
        var r = rpm[i];
        var l = lambda[i];
        if (isNaN(r) || isNaN(l)) continue;
        if (r < rpmMin) rpmMin = r;
        if (r > rpmMax) rpmMax = r;
        if (l < lamMin) lamMin = l;
        if (l > lamMax) lamMax = l;
    }

    if (rpmMin === Infinity) return;

    // Grid dimensions for density
    var gridCols = 30;
    var gridRows = 20;
    var grid = [];
    for (var gi = 0; gi < gridRows; gi++) {
        grid.push(new Array(gridCols).fill(0));
    }

    var rpmRange = rpmMax - rpmMin;
    var lamRange = lamMax - lamMin;
    if (rpmRange === 0) rpmRange = 1;
    if (lamRange === 0) lamRange = 0.1;

    var maxDensity = 0;
    for (var i = 0; i < rpm.length; i++) {
        var rv = rpm[i];
        var lv = lambda[i];
        if (isNaN(rv) || isNaN(lv)) continue;

        var col = Math.floor(((rv - rpmMin) / rpmRange) * gridCols);
        var row = Math.floor(((lv - lamMin) / lamRange) * gridRows);

        if (col < 0) col = 0;
        if (col >= gridCols) col = gridCols - 1;
        if (row < 0) row = 0;
        if (row >= gridRows) row = gridRows - 1;

        grid[row][col]++;
        if (grid[row][col] > maxDensity) maxDensity = grid[row][col];
    }

    if (maxDensity === 0) return;

    // Build bubble data
    var bubbleData = [];
    var rpmStep = rpmRange / gridCols;
    var lamStep = lamRange / gridRows;
    var maxRadius = 12;

    for (var row = 0; row < gridRows; row++) {
        for (var col = 0; col < gridCols; col++) {
            var count = grid[row][col];
            if (count === 0) continue;

            var norm = count / maxDensity;
            var rVal = rpmMin + (col + 0.5) * rpmStep;
            var lVal = lamMin + (row + 0.5) * lamStep;
            var radius = Math.sqrt(norm) * maxRadius;

            bubbleData.push({
                x: rVal,
                y: lVal,
                r: radius,
                _norm: norm
            });
        }
    }

    // Color function: dark blue → cyan → yellow → white
    function densityColor(norm) {
        var red, green, blue;
        if (norm < 0.25) {
            red = 0;
            green = 0;
            blue = Math.round(80 + norm * 4 * 175);
        } else if (norm < 0.5) {
            var t1 = (norm - 0.25) * 4;
            red = 0;
            green = Math.round(t1 * 255);
            blue = 255;
        } else if (norm < 0.75) {
            var t2 = (norm - 0.5) * 4;
            red = Math.round(t2 * 255);
            green = 255;
            blue = Math.round(255 * (1 - t2));
        } else {
            var t3 = (norm - 0.75) * 4;
            red = 255;
            green = 255;
            blue = Math.round(t3 * 255);
        }
        return 'rgb(' + red + ',' + green + ',' + blue + ')';
    }

    // Assign colors per point
    var bgColors = [];
    for (var i = 0; i < bubbleData.length; i++) {
        bgColors.push(densityColor(bubbleData[i]._norm));
    }

    var datasets = [
        {
            label: 'Density',
            data: bubbleData,
            backgroundColor: bgColors,
            borderColor: bgColors,
            borderWidth: 0
        }
    ];

    chartInstances['lambdaRpmDensity'] = new Chart(canvas, {
        type: 'bubble',
        data: { datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                zoom: getZoomConfig(),
                legend: { labels: { color: CHART_COLORS.text } }
            },
            scales: getScaleOptions('RPM', 'Lambda')
        }
    });
    addResetZoomButton(canvas, 'lambdaRpmDensity');
}

/**
 * Renders the Timing vs RPM scatter chart.
 * Scatter: RPM vs Timing with reference lines at 240, 320, 180 dBTDC.
 */
function renderTimingVsRPMScatter(canvas, data) {
    destroyChart('timingRpmScatter');

    var rpm = data.rpm;
    var timing = data.injTiming;
    if (!rpm || !timing) return;

    var scatterData = [];
    var rpmMin = Infinity, rpmMax = -Infinity;
    var timMin = Infinity, timMax = -Infinity;

    for (var i = 0; i < rpm.length; i++) {
        var r = rpm[i];
        var t = timing[i];
        if (isNaN(r) || isNaN(t)) continue;
        if (r < rpmMin) rpmMin = r;
        if (r > rpmMax) rpmMax = r;
        if (t < timMin) timMin = t;
        if (t > timMax) timMax = t;
        scatterData.push({ x: r, y: t });
    }

    if (rpmMin === Infinity) return;

    var datasets = [
        {
            label: 'Timing',
            data: scatterData,
            backgroundColor: 'rgba(74, 158, 255, 0.3)',
            borderColor: 'rgba(74, 158, 255, 0.6)',
            pointRadius: 1.5,
            order: 1
        },
        makeThresholdDataset('Optimal top (320)', 320, rpmMin, rpmMax, 'rgba(40, 167, 69, 0.9)'),
        makeThresholdDataset('Optimal bottom (240)', 240, rpmMin, rpmMax, 'rgba(40, 167, 69, 0.9)'),
        makeThresholdDataset('Compression (180)', 180, rpmMin, rpmMax, CHART_COLORS.threshold)
    ];

    chartInstances['timingRpmScatter'] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                zoom: getZoomConfig(),
                legend: { labels: { color: CHART_COLORS.text } }
            },
            scales: getScaleOptions('RPM', 'Timing (dBTDC)')
        }
    });
    addResetZoomButton(canvas, 'timingRpmScatter');
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Renders all charts into the provided canvas containers.
 * Skips charts where required data is null/missing.
 *
 * @param {Object} containers - Object with canvas element references:
 *   {
 *     lambdaTs: HTMLCanvasElement,
 *     pwTs: HTMLCanvasElement,
 *     lambdaPwScatter: HTMLCanvasElement,
 *     fuelPressureTs: HTMLCanvasElement,
 *     pwHistogram: HTMLCanvasElement,
 *     lambdaRpmDensity: HTMLCanvasElement,
 *     timingRpmScatter: HTMLCanvasElement
 *   }
 * @param {Object} chartData - ChartData object from the worker:
 *   {
 *     time: number[],
 *     lambdaB1: number[]|null,
 *     lambdaB2: number[]|null,
 *     injPW: number[]|null,
 *     fuelPressDI: number[]|null,
 *     fuelPressDIAim: number[]|null,
 *     rpm: number[]|null,
 *     injTiming: number[]|null,
 *     downsampleStep: number
 *   }
 */
function renderAllCharts(containers, chartData) {
    if (!containers || !chartData) return;

    // Lambda Time Series — requires at least one lambda channel
    if (containers.lambdaTs && (chartData.lambdaB1 || chartData.lambdaB2)) {
        renderLambdaTimeSeries(containers.lambdaTs, chartData);
    }

    // PW Time Series — requires injector PW data
    if (containers.pwTs && chartData.injPW) {
        renderPWTimeSeries(containers.pwTs, chartData);
    }

    // Lambda vs PW Scatter — requires both lambda and PW
    if (containers.lambdaPwScatter && (chartData.lambdaB1 || chartData.lambdaB2) && chartData.injPW) {
        renderLambdaVsPWScatter(containers.lambdaPwScatter, chartData);
    }

    // Fuel Pressure Time Series — requires fuel pressure data
    if (containers.fuelPressureTs && chartData.fuelPressDI) {
        renderFuelPressureTimeSeries(containers.fuelPressureTs, chartData);
    }

    // PW Histogram — requires injector PW data
    if (containers.pwHistogram && chartData.injPW) {
        renderPWHistogram(containers.pwHistogram, chartData);
    }

    // Lambda-RPM Density — requires lambda and RPM data
    if (containers.lambdaRpmDensity && (chartData.lambdaB1 || chartData.lambdaB2) && chartData.rpm) {
        renderLambdaRPMDensity(containers.lambdaRpmDensity, chartData);
    }

    // Timing vs RPM Scatter — requires timing and RPM data
    if (containers.timingRpmScatter && chartData.injTiming && chartData.rpm) {
        renderTimingVsRPMScatter(containers.timingRpmScatter, chartData);
    }
}
