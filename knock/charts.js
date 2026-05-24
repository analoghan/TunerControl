/**
 * charts.js — Chart.js-based chart rendering module for Knock Analyzer.
 * Uses Chart.js 4.x with chartjs-plugin-zoom for interactive charts.
 *
 * Provides the same 5 render functions called by app.js:
 *   - renderCylinderBarChart(canvas, distribution)
 *   - renderKnockVsRpmScatter(canvas, events)
 *   - renderKnockHeatmap(canvas, heatmapData)
 *   - renderTimingVsRpmScatter(canvas, events)
 *   - renderTimingRetardTimeSeries(canvas, retardData)
 *
 * Interactive features:
 *   - Drag-to-zoom on all charts (both axes)
 *   - Double-click to reset zoom
 *   - Legend toggling for multi-dataset charts
 */

// ---------------------------------------------------------------------------
// Register zoom plugin
// ---------------------------------------------------------------------------

(function () {
    if (typeof ChartZoom !== 'undefined' && typeof Chart !== 'undefined') {
        try { Chart.register(ChartZoom); } catch(e) { /* already registered */ }
    }
})();

// ---------------------------------------------------------------------------
// Color Palette (dark theme)
// ---------------------------------------------------------------------------

var KNOCK_COLORS = {
    background:     '#1a2744',
    text:           '#e0e0e0',
    gridlines:      '#2a3a5e',
    barFill:        '#4a9eff',
    barHighlight:   '#ff6b7a',
    scatterPoint:   '#00c9a7',
    heatmapLow:     '#1a3a5e',
    heatmapHigh:    '#ff6b7a',
    timingLine:     '#ffd54f',
    retardLine:     '#ff6b7a',
};

// ---------------------------------------------------------------------------
// Chart Instance Tracking (destroy before re-render)
// ---------------------------------------------------------------------------

var _chartInstances = {};

/**
 * Destroys any existing Chart.js instance associated with the given canvas,
 * then returns the canvas for fresh use.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} key - Unique key for this chart slot
 */
function destroyExisting(canvas, key) {
    if (_chartInstances[key]) {
        _chartInstances[key].destroy();
        _chartInstances[key] = null;
    }
}

/**
 * Adds a "Reset Zoom" button to the chart's parent container.
 */
function addResetZoomButton(canvas, key) {
    var parent = canvas.parentElement;
    if (!parent) return;
    var existing = parent.querySelector('.reset-zoom-btn');
    if (existing) existing.parentElement.removeChild(existing);

    var btn = document.createElement('button');
    btn.className = 'reset-zoom-btn';
    btn.textContent = 'Reset Zoom';
    btn.style.cssText = 'position:absolute;top:8px;right:12px;padding:3px 8px;font-size:11px;background:#0f3460;color:#e0e0e0;border:1px solid #4a9eff;border-radius:3px;cursor:pointer;z-index:10;';
    btn.onclick = function() {
        if (_chartInstances[key]) {
            _chartInstances[key].resetZoom();
        }
    };
    if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
    }
    parent.appendChild(btn);
}

// ---------------------------------------------------------------------------
// Shared Chart.js Configuration Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the common zoom plugin configuration for drag-to-zoom.
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
 * Returns common scale styling for dark theme.
 */
function darkScaleOptions(titleText) {
    return {
        title: {
            display: !!titleText,
            text: titleText || '',
            color: KNOCK_COLORS.text,
            font: { size: 12 }
        },
        ticks: {
            color: KNOCK_COLORS.text,
            font: { size: 10 }
        },
        grid: {
            color: KNOCK_COLORS.gridlines
        }
    };
}

/**
 * Returns common legend configuration for dark theme.
 */
function darkLegendOptions(display) {
    return {
        display: display !== false,
        labels: {
            color: KNOCK_COLORS.text,
            font: { size: 11 }
        }
    };
}

// ---------------------------------------------------------------------------
// No-Data Helper
// ---------------------------------------------------------------------------

/**
 * Clears the canvas and draws a centered "no data" message.
 * Returns true if no-data was rendered (caller should return early).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} message
 */
function renderNoData(canvas, message) {
    var ctx = canvas.getContext('2d');
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = KNOCK_COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = KNOCK_COLORS.text;
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, canvas.width / 2, canvas.height / 2);
    ctx.restore();
}

// ---------------------------------------------------------------------------
// Helper: Interpolate between two hex colors
// ---------------------------------------------------------------------------

/**
 * Linearly interpolates between two hex color strings.
 *
 * @param {string} colorLow - Hex color for t=0
 * @param {string} colorHigh - Hex color for t=1
 * @param {number} t - Interpolation factor in [0, 1]
 * @returns {string} Interpolated rgba color string
 */
function interpolateColor(colorLow, colorHigh, t) {
    var rL = parseInt(colorLow.slice(1, 3), 16);
    var gL = parseInt(colorLow.slice(3, 5), 16);
    var bL = parseInt(colorLow.slice(5, 7), 16);

    var rH = parseInt(colorHigh.slice(1, 3), 16);
    var gH = parseInt(colorHigh.slice(3, 5), 16);
    var bH = parseInt(colorHigh.slice(5, 7), 16);

    var r = Math.round(rL + (rH - rL) * t);
    var g = Math.round(gL + (gH - gL) * t);
    var b = Math.round(bL + (bH - bL) * t);

    return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// ---------------------------------------------------------------------------
// Chart Renderer: Per-Cylinder Knock Count Bar Chart
// ---------------------------------------------------------------------------

/**
 * Renders a bar chart showing knock event counts per cylinder.
 * Highlights the worst (highest count) cylinder in red.
 *
 * @param {HTMLCanvasElement} canvas - Target canvas element
 * @param {Object} distribution - CylinderDistribution object
 *   {counts: number[8], percentages: number[8], total: number, ranking: number[]}
 */
function renderCylinderBarChart(canvas, distribution) {
    var key = 'cylinder-bar';
    destroyExisting(canvas, key);

    if (!distribution || distribution.total === 0) {
        renderNoData(canvas, 'No knock events detected');
        return;
    }

    // Find the highest-count cylinder for highlighting
    var maxCount = 0;
    var highestIdx = 0;
    for (var i = 0; i < distribution.counts.length; i++) {
        if (distribution.counts[i] > maxCount) {
            maxCount = distribution.counts[i];
            highestIdx = i;
        }
    }

    // Build bar colors array
    var barColors = [];
    for (var i = 0; i < distribution.counts.length; i++) {
        barColors.push(i === highestIdx ? KNOCK_COLORS.barHighlight : KNOCK_COLORS.barFill);
    }

    // Build labels
    var labels = [];
    for (var i = 0; i < 8; i++) {
        labels.push('Cyl ' + (i + 1));
    }

    var chart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Knock Events',
                data: distribution.counts,
                backgroundColor: barColors,
                borderWidth: 0
            }]
        },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            plugins: {
                legend: darkLegendOptions(false),
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            var idx = context.dataIndex;
                            var count = distribution.counts[idx];
                            var pct = distribution.percentages[idx].toFixed(1);
                            return count + ' events (' + pct + '%)';
                        }
                    }
                },
                zoom: getZoomConfig(),
                datalabels: false
            },
            scales: {
                x: Object.assign(darkScaleOptions('Cylinder'), {
                    border: { color: KNOCK_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('Event Count'), {
                    beginAtZero: true,
                    border: { color: KNOCK_COLORS.gridlines }
                })
            },
            // Custom plugin to draw percentage labels above bars
            animation: {
                onComplete: function () {
                    var chartInstance = this;
                    var ctx2 = chartInstance.ctx;
                    ctx2.save();
                    ctx2.font = '10px sans-serif';
                    ctx2.fillStyle = KNOCK_COLORS.text;
                    ctx2.textAlign = 'center';
                    ctx2.textBaseline = 'bottom';
                    var meta = chartInstance.getDatasetMeta(0);
                    for (var i = 0; i < meta.data.length; i++) {
                        var bar = meta.data[i];
                        var pct = distribution.percentages[i].toFixed(1) + '%';
                        ctx2.fillText(pct, bar.x, bar.y - 4);
                    }
                    ctx2.restore();
                }
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Chart Renderer: Knock Level vs RPM Scatter
// ---------------------------------------------------------------------------

/**
 * Renders a scatter plot of Knock Level (%) vs Engine Speed (RPM).
 *
 * @param {HTMLCanvasElement} canvas - Target canvas element
 * @param {Array<{rpm: number|null, knockLevel: number}>} events - KnockEvent array
 */
function renderKnockVsRpmScatter(canvas, events) {
    var key = 'knock-rpm-scatter';
    destroyExisting(canvas, key);

    if (!events || events.length === 0) {
        renderNoData(canvas, 'No knock events available for visualization');
        return;
    }

    // Filter events with valid RPM
    var dataPoints = [];
    for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        if (evt.rpm !== null && evt.rpm !== undefined) {
            dataPoints.push({ x: evt.rpm, y: evt.knockLevel });
        }
    }

    if (dataPoints.length === 0) {
        renderNoData(canvas, 'No knock events with valid RPM data');
        return;
    }

    var chart = new Chart(canvas, {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'Knock Events',
                data: dataPoints,
                backgroundColor: KNOCK_COLORS.scatterPoint,
                pointRadius: 3,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            plugins: {
                legend: darkLegendOptions(true),
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            return 'RPM: ' + context.parsed.x.toFixed(0) + ', Knock: ' + context.parsed.y.toFixed(1) + '%';
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Engine Speed (RPM)'), {
                    min: 0,
                    max: 7500,
                    border: { color: KNOCK_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('Knock Level (%)'), {
                    min: 0,
                    max: 100,
                    border: { color: KNOCK_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Chart Renderer: Knock Heatmap (RPM × Load) — Bubble Chart Approach
// ---------------------------------------------------------------------------

/**
 * Renders an RPM × Load heatmap using a bubble chart.
 * Bubble size and color represent knock event count per cell.
 *
 * @param {HTMLCanvasElement} canvas - The canvas element to render into
 * @param {Object} heatmapData - Heatmap data object
 *   {rpmBins: number[], loadBins: number[], counts: number[][]}
 */
function renderKnockHeatmap(canvas, heatmapData) {
    var key = 'knock-heatmap';
    destroyExisting(canvas, key);

    if (!heatmapData || !heatmapData.counts) {
        renderNoData(canvas, 'No knock events available for visualization');
        return;
    }

    var numRpmBins = heatmapData.counts.length;
    var numLoadBins = heatmapData.counts[0].length;

    // Find maximum count
    var maxCount = 0;
    for (var i = 0; i < numRpmBins; i++) {
        for (var j = 0; j < numLoadBins; j++) {
            if (heatmapData.counts[i][j] > maxCount) {
                maxCount = heatmapData.counts[i][j];
            }
        }
    }

    if (maxCount === 0) {
        renderNoData(canvas, 'No knock events available for visualization');
        return;
    }

    // Build bubble data points (only non-zero cells)
    var bubbleData = [];
    var bubbleColors = [];
    var maxRadius = 12;

    for (var ri = 0; ri < numRpmBins; ri++) {
        for (var li = 0; li < numLoadBins; li++) {
            var count = heatmapData.counts[ri][li];
            if (count === 0) continue;

            // Center of each bin
            var rpmCenter = (heatmapData.rpmBins[ri] + heatmapData.rpmBins[ri + 1]) / 2;
            var loadCenter = (heatmapData.loadBins[li] + heatmapData.loadBins[li + 1]) / 2;

            // Radius proportional to count (sqrt scale for area perception)
            var r = Math.max(2, Math.sqrt(count / maxCount) * maxRadius);

            bubbleData.push({ x: rpmCenter, y: loadCenter, r: r });

            // Color intensity based on count
            var t = count / maxCount;
            bubbleColors.push(interpolateColor(KNOCK_COLORS.heatmapLow, KNOCK_COLORS.heatmapHigh, t));
        }
    }

    var chart = new Chart(canvas, {
        type: 'bubble',
        data: {
            datasets: [{
                label: 'Knock Events',
                data: bubbleData,
                backgroundColor: bubbleColors,
                borderColor: 'rgba(255,255,255,0.2)',
                borderWidth: 0.5
            }]
        },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            plugins: {
                legend: darkLegendOptions(true),
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            var raw = context.raw;
                            // Reverse-lookup count from radius
                            var rNorm = raw.r / maxRadius;
                            var approxCount = Math.round(rNorm * rNorm * maxCount);
                            return 'RPM: ' + raw.x.toFixed(0) + ', Load: ' + raw.y.toFixed(0) + ' kPa, Count: ~' + approxCount;
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Engine Speed (RPM)'), {
                    min: heatmapData.rpmBins[0],
                    max: heatmapData.rpmBins[heatmapData.rpmBins.length - 1],
                    border: { color: KNOCK_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('Inlet Manifold Pressure (kPa)'), {
                    min: heatmapData.loadBins[0],
                    max: heatmapData.loadBins[heatmapData.loadBins.length - 1],
                    border: { color: KNOCK_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Chart Renderer: Ignition Timing vs RPM Scatter (color by knock level)
// ---------------------------------------------------------------------------

/**
 * Renders a scatter plot of Ignition Timing (dBTDC) vs Engine Speed (RPM).
 * Point color indicates knock level intensity.
 *
 * @param {HTMLCanvasElement} canvas - The canvas element to render into
 * @param {Array<{rpm: number|null, ignTiming: number|null, knockLevel: number}>} events - KnockEvent array
 */
function renderTimingVsRpmScatter(canvas, events) {
    var key = 'timing-rpm-scatter';
    destroyExisting(canvas, key);

    // Filter events that have both rpm and ignTiming
    var validEvents = [];
    if (events && events.length > 0) {
        for (var i = 0; i < events.length; i++) {
            var ev = events[i];
            if (ev.rpm != null && ev.ignTiming != null) {
                validEvents.push(ev);
            }
        }
    }

    if (validEvents.length === 0) {
        renderNoData(canvas, 'No data available');
        return;
    }

    // Find knock level range for color interpolation
    var knockMin = Infinity, knockMax = -Infinity;
    for (var i = 0; i < validEvents.length; i++) {
        var kl = validEvents[i].knockLevel;
        if (kl < knockMin) knockMin = kl;
        if (kl > knockMax) knockMax = kl;
    }

    // Build data points with per-point colors
    var dataPoints = [];
    var pointColors = [];
    for (var i = 0; i < validEvents.length; i++) {
        var evt = validEvents[i];
        dataPoints.push({ x: evt.rpm, y: evt.ignTiming });

        var t = 0;
        if (knockMax > knockMin) {
            t = (evt.knockLevel - knockMin) / (knockMax - knockMin);
        }
        pointColors.push(interpolateColor(KNOCK_COLORS.scatterPoint, KNOCK_COLORS.barHighlight, t));
    }

    var chart = new Chart(canvas, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Low Knock Level',
                    data: [],
                    backgroundColor: KNOCK_COLORS.scatterPoint,
                    pointRadius: 4
                },
                {
                    label: 'High Knock Level',
                    data: [],
                    backgroundColor: KNOCK_COLORS.barHighlight,
                    pointRadius: 4
                },
                {
                    label: 'Timing Events',
                    data: dataPoints,
                    backgroundColor: pointColors,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    showLine: false
                }
            ]
        },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            plugins: {
                legend: Object.assign(darkLegendOptions(true), {
                    labels: {
                        color: KNOCK_COLORS.text,
                        font: { size: 11 },
                        filter: function (item) {
                            // Only show the legend color indicators, not the data dataset
                            return item.datasetIndex < 2;
                        }
                    }
                }),
                tooltip: {
                    filter: function (item) {
                        return item.datasetIndex === 2;
                    },
                    callbacks: {
                        label: function (context) {
                            var idx = context.dataIndex;
                            var evt = validEvents[idx];
                            return 'RPM: ' + evt.rpm.toFixed(0) + ', Timing: ' + evt.ignTiming.toFixed(1) + '°, Knock: ' + evt.knockLevel.toFixed(1) + '%';
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Engine Speed (RPM)'), {
                    border: { color: KNOCK_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('Ignition Timing (dBTDC)'), {
                    border: { color: KNOCK_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Chart Renderer: Timing Retard Time Series
// ---------------------------------------------------------------------------

/**
 * Renders a line chart of timing compensation (retard) over time.
 *
 * @param {HTMLCanvasElement} canvas - The canvas element to render into
 * @param {Object|null} retardData - { time: number[], values: number[] } or null
 */
function renderTimingRetardTimeSeries(canvas, retardData) {
    var key = 'timing-retard-ts';
    destroyExisting(canvas, key);

    if (!retardData || !retardData.time || !retardData.values ||
        retardData.time.length === 0 || retardData.values.length === 0) {
        renderNoData(canvas, 'Timing compensation data not available');
        return;
    }

    // Build data points
    var dataPoints = [];
    for (var i = 0; i < retardData.time.length; i++) {
        var t = retardData.time[i];
        var v = retardData.values[i];
        if (!isNaN(t) && !isNaN(v)) {
            dataPoints.push({ x: t, y: v });
        }
    }

    if (dataPoints.length === 0) {
        renderNoData(canvas, 'Timing compensation data not available');
        return;
    }

    var chart = new Chart(canvas, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Timing Compensation',
                data: dataPoints,
                borderColor: KNOCK_COLORS.retardLine,
                backgroundColor: 'rgba(255,107,122,0.1)',
                borderWidth: 1.5,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: true,
                tension: 0
            }]
        },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            parsing: false,
            plugins: {
                legend: darkLegendOptions(true),
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            return 'Time: ' + context.parsed.x.toFixed(2) + 's, Retard: ' + context.parsed.y.toFixed(2) + '°';
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Time (s)'), {
                    type: 'linear',
                    border: { color: KNOCK_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('Timing Compensation (dBTDC)'), {
                    border: { color: KNOCK_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}
