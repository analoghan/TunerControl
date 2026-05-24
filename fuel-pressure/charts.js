/**
 * charts.js — Chart.js-based chart rendering module for DI Fuel Pressure Deep Dive.
 * Uses Chart.js 4.x with chartjs-plugin-zoom for interactive charts.
 *
 * Provides 7 render functions called by app.js:
 *   - renderPressureAimTimeline(canvas, chartData)
 *   - renderErrorTimeline(canvas, chartData)
 *   - renderErrorVsRpm(canvas, chartData)
 *   - renderErrorVsDuty(canvas, chartData)
 *   - renderErrorVsFlow(canvas, chartData)
 *   - renderTransientOverlay(canvas, chartData)
 *   - renderErrorHistogram(canvas, chartData)
 */

// ---------------------------------------------------------------------------
// Register zoom plugin
// ---------------------------------------------------------------------------

(function() {
    if (typeof ChartZoom !== 'undefined' && typeof Chart !== 'undefined') {
        try { Chart.register(ChartZoom); } catch(e) { /* already registered */ }
    }
})();

// ---------------------------------------------------------------------------
// Color Palette (dark theme)
// ---------------------------------------------------------------------------

var FP_COLORS = {
    background:     '#1a2744',
    text:           '#e0e0e0',
    gridlines:      '#2a3a5e',
    pressure:       '#ffb74d',
    aim:            '#90a4ae',
    error:          '#4a9eff',
    toleranceFill:  'rgba(76, 175, 80, 0.15)',
    toleranceLine:  'rgba(76, 175, 80, 0.5)',
    overshoot:      '#ff6b7a',
    undershoot:     '#ff6b7a',
    transientUp:    '#42a5f5',
    transientDown:  '#ef5350',
    histGood:       '#6fdc8c',
    histBad:        '#ff6b7a'
};

// ---------------------------------------------------------------------------
// Chart Instance Tracking
// ---------------------------------------------------------------------------

var _chartInstances = {};

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

function getScaleDefaults() {
    return {
        ticks: { color: FP_COLORS.text, font: { size: 10 } },
        grid: { color: FP_COLORS.gridlines }
    };
}

// ---------------------------------------------------------------------------
// 1. Pressure vs Aim Timeline
// ---------------------------------------------------------------------------

function renderPressureAimTimeline(canvas, chartData) {
    var key = 'pressureAim';
    destroyExisting(canvas, key);

    var time = chartData.time;
    var pressure = chartData.pressure;
    var aim = chartData.aim;

    // Build tolerance band arrays (aim ± 2 bar)
    var aimUpper = new Array(aim.length);
    var aimLower = new Array(aim.length);
    for (var i = 0; i < aim.length; i++) {
        aimUpper[i] = aim[i] + 2;
        aimLower[i] = aim[i] - 2;
    }

    // Build data points
    var timeLabels = time;

    var datasets = [
        {
            label: 'Tolerance Upper',
            data: aimUpper.map(function(v, i) { return { x: time[i], y: v }; }),
            borderColor: 'transparent',
            backgroundColor: 'transparent',
            pointRadius: 0,
            showLine: true,
            fill: false,
            order: 3
        },
        {
            label: 'Tolerance Band',
            data: aimLower.map(function(v, i) { return { x: time[i], y: v }; }),
            borderColor: 'transparent',
            backgroundColor: FP_COLORS.toleranceFill,
            pointRadius: 0,
            showLine: true,
            fill: '-1',
            order: 3
        },
        {
            label: 'Aim',
            data: aim.map(function(v, i) { return { x: time[i], y: v }; }),
            borderColor: FP_COLORS.aim,
            borderDash: [5, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            showLine: true,
            fill: false,
            order: 2
        },
        {
            label: 'Pressure',
            data: pressure.map(function(v, i) { return { x: time[i], y: v }; }),
            borderColor: FP_COLORS.pressure,
            borderWidth: 1.5,
            pointRadius: 0,
            showLine: true,
            fill: false,
            order: 1
        }
    ];

    _chartInstances[key] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { labels: { color: FP_COLORS.text, font: { size: 10 } } },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign({}, getScaleDefaults(), {
                    type: 'linear',
                    title: { display: true, text: 'Time (s)', color: FP_COLORS.text }
                }),
                y: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Pressure (bar)', color: FP_COLORS.text }
                })
            }
        }
    });

    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// 2. Pressure Error Timeline
// ---------------------------------------------------------------------------

function renderErrorTimeline(canvas, chartData) {
    var key = 'errorTimeline';
    destroyExisting(canvas, key);

    var time = chartData.time;
    var error = chartData.error;

    // Tolerance band at ±2
    var upper = time.map(function(t) { return { x: t, y: 2 }; });
    var lower = time.map(function(t) { return { x: t, y: -2 }; });

    var datasets = [
        {
            label: '+2 bar',
            data: upper,
            borderColor: 'transparent',
            backgroundColor: 'transparent',
            pointRadius: 0,
            showLine: true,
            fill: false,
            order: 3
        },
        {
            label: 'Tolerance Band',
            data: lower,
            borderColor: 'transparent',
            backgroundColor: FP_COLORS.toleranceFill,
            pointRadius: 0,
            showLine: true,
            fill: '-1',
            order: 3
        },
        {
            label: 'Error (Actual - Aim)',
            data: error.map(function(v, i) { return { x: time[i], y: v }; }),
            borderColor: FP_COLORS.error,
            borderWidth: 1.5,
            pointRadius: 0,
            showLine: true,
            fill: false,
            order: 1
        }
    ];

    _chartInstances[key] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { labels: { color: FP_COLORS.text, font: { size: 10 } } },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign({}, getScaleDefaults(), {
                    type: 'linear',
                    title: { display: true, text: 'Time (s)', color: FP_COLORS.text }
                }),
                y: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Error (bar)', color: FP_COLORS.text }
                })
            }
        }
    });

    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// 3. Error vs RPM Scatter
// ---------------------------------------------------------------------------

function renderErrorVsRpm(canvas, chartData) {
    var key = 'errorRpm';
    destroyExisting(canvas, key);

    var scatterData = chartData.errorVsRpm || [];

    _chartInstances[key] = new Chart(canvas, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Error vs RPM',
                    data: scatterData,
                    backgroundColor: 'rgba(74, 158, 255, 0.3)',
                    borderColor: 'rgba(74, 158, 255, 0.6)',
                    pointRadius: 1.5,
                    order: 1
                }
            ]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { labels: { color: FP_COLORS.text, font: { size: 10 } } },
                zoom: getZoomConfig(),
                annotation: undefined
            },
            scales: {
                x: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'RPM', color: FP_COLORS.text }
                }),
                y: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Error (bar)', color: FP_COLORS.text }
                })
            }
        }
    });

    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// 4. Error vs Injector Duty Cycle
// ---------------------------------------------------------------------------

function renderErrorVsDuty(canvas, chartData) {
    var key = 'errorDuty';
    destroyExisting(canvas, key);

    if (!chartData.errorVsDuty || chartData.errorVsDuty.length === 0) {
        showNoData(canvas, key, 'Injector duty cycle data not available');
        return;
    }

    _chartInstances[key] = new Chart(canvas, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Error vs Duty %',
                    data: chartData.errorVsDuty,
                    backgroundColor: 'rgba(255, 183, 77, 0.3)',
                    borderColor: 'rgba(255, 183, 77, 0.6)',
                    pointRadius: 1.5,
                    order: 1
                }
            ]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { labels: { color: FP_COLORS.text, font: { size: 10 } } },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Duty Cycle (%)', color: FP_COLORS.text }
                }),
                y: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Error (bar)', color: FP_COLORS.text }
                })
            }
        }
    });

    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// 5. Error vs Fuel Flow
// ---------------------------------------------------------------------------

function renderErrorVsFlow(canvas, chartData) {
    var key = 'errorFlow';
    destroyExisting(canvas, key);

    if (!chartData.errorVsFlow || chartData.errorVsFlow.length === 0) {
        showNoData(canvas, key, 'Fuel flow data not available');
        return;
    }

    _chartInstances[key] = new Chart(canvas, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Error vs Fuel Flow',
                    data: chartData.errorVsFlow,
                    backgroundColor: 'rgba(111, 220, 140, 0.3)',
                    borderColor: 'rgba(111, 220, 140, 0.6)',
                    pointRadius: 1.5,
                    order: 1
                }
            ]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { labels: { color: FP_COLORS.text, font: { size: 10 } } },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Fuel Flow', color: FP_COLORS.text }
                }),
                y: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Error (bar)', color: FP_COLORS.text }
                })
            }
        }
    });

    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// 6. Transient Response Overlay
// ---------------------------------------------------------------------------

function renderTransientOverlay(canvas, chartData) {
    var key = 'transient';
    destroyExisting(canvas, key);

    var traces = chartData.transientEvents || [];
    if (traces.length === 0) {
        showNoData(canvas, key, 'No transient events detected');
        return;
    }

    var datasets = [];
    for (var i = 0; i < traces.length; i++) {
        var trace = traces[i];
        var color = trace.direction === 'up' ? FP_COLORS.transientUp : FP_COLORS.transientDown;
        var data = trace.time.map(function(t, idx) {
            return { x: t, y: trace.error[idx] };
        });
        datasets.push({
            label: (trace.direction === 'up' ? 'Up' : 'Down') + ' #' + (i + 1),
            data: data,
            borderColor: color,
            borderWidth: 1.2,
            pointRadius: 0,
            showLine: true,
            fill: false
        });
    }

    _chartInstances[key] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: true,
                    labels: { color: FP_COLORS.text, font: { size: 9 } }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Time from aim change (s)', color: FP_COLORS.text }
                }),
                y: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Error (bar)', color: FP_COLORS.text }
                })
            }
        }
    });

    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// 7. Error Distribution Histogram
// ---------------------------------------------------------------------------

function renderErrorHistogram(canvas, chartData) {
    var key = 'histogram';
    destroyExisting(canvas, key);

    var hist = chartData.errorHistogram;
    if (!hist || !hist.bins || hist.bins.length === 0) {
        showNoData(canvas, key, 'No error data for histogram');
        return;
    }

    var labels = hist.bins.map(function(b) { return b.toFixed(1); });
    var colors = hist.bins.map(function(b) {
        return (Math.abs(b) <= 2) ? FP_COLORS.histGood : FP_COLORS.histBad;
    });
    var borderColors = hist.bins.map(function(b) {
        return (Math.abs(b) <= 2) ? 'rgba(111, 220, 140, 0.8)' : 'rgba(255, 107, 122, 0.8)';
    });

    _chartInstances[key] = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Sample Count',
                data: hist.counts,
                backgroundColor: colors,
                borderColor: borderColors,
                borderWidth: 1
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { labels: { color: FP_COLORS.text, font: { size: 10 } } },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Error (bar)', color: FP_COLORS.text }
                }),
                y: Object.assign({}, getScaleDefaults(), {
                    title: { display: true, text: 'Count', color: FP_COLORS.text }
                })
            }
        }
    });

    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Helper: Show "no data" message in place of chart
// ---------------------------------------------------------------------------

function showNoData(canvas, key, message) {
    var parent = canvas.parentElement;
    if (!parent) return;
    canvas.style.display = 'none';
    var existing = parent.querySelector('.no-data-message');
    if (existing) existing.parentElement.removeChild(existing);
    var div = document.createElement('div');
    div.className = 'no-data-message';
    div.textContent = message;
    parent.appendChild(div);
}
