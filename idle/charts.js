/**
 * charts.js — Chart.js-based chart rendering module for Idle Behavior Analyzer.
 * Uses Chart.js 4.x with chartjs-plugin-zoom for interactive charts.
 *
 * Provides 5 render functions called by app.js:
 *   - renderRpmTimeline(canvas, chartData, events)
 *   - renderDecelOverlay(canvas, events)
 *   - renderSettleDistribution(canvas, events)
 *   - renderMapEvents(canvas, events)
 *   - renderMassFlowComparison(canvas, events)
 *
 * Interactive features:
 *   - Drag-to-zoom on all charts (both axes)
 *   - Double-click to reset zoom
 *   - Legend toggling for multi-dataset charts
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

var IDLE_COLORS = {
    background:     '#1a2744',
    text:           '#e0e0e0',
    gridlines:      '#2a3a5e',
    rpmLine:        '#4a9eff',
    idleAimLine:    '#ffd54f',
    normalEvent:    '#6fdc8c',
    hangEvent:      '#ff6b7a',
    mapLine:        '#00c9a7',
    massFlowLine:   '#9b59b6',
    massFlowFFLine: '#e67e22'
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

function darkScaleOptions(titleText) {
    return {
        title: {
            display: !!titleText,
            text: titleText || '',
            color: IDLE_COLORS.text,
            font: { size: 12 }
        },
        ticks: {
            color: IDLE_COLORS.text,
            font: { size: 10 }
        },
        grid: {
            color: IDLE_COLORS.gridlines
        }
    };
}

function darkLegendOptions(display) {
    return {
        display: display !== false,
        labels: {
            color: IDLE_COLORS.text,
            font: { size: 11 }
        }
    };
}

function renderNoData(canvas, message) {
    var ctx = canvas.getContext('2d');
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = IDLE_COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = IDLE_COLORS.text;
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message, canvas.width / 2, canvas.height / 2);
    ctx.restore();
}

// ---------------------------------------------------------------------------
// Chart 1: Full RPM Timeline
// ---------------------------------------------------------------------------

function renderRpmTimeline(canvas, chartData, events) {
    var key = 'rpm-timeline';
    destroyExisting(canvas, key);

    if (!chartData || !chartData.fullRpm || chartData.fullRpm.time.length === 0) {
        renderNoData(canvas, 'No RPM data available');
        return;
    }

    // Build RPM data points
    var rpmPoints = [];
    for (var i = 0; i < chartData.fullRpm.time.length; i++) {
        rpmPoints.push({ x: chartData.fullRpm.time[i], y: chartData.fullRpm.values[i] });
    }

    var datasets = [{
        label: 'RPM',
        data: rpmPoints,
        borderColor: IDLE_COLORS.rpmLine,
        backgroundColor: 'transparent',
        borderWidth: 1,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0
    }];

    // Add idle aim overlay if available
    if (chartData.fullIdleAim && chartData.fullIdleAim.time.length > 0) {
        var aimPoints = [];
        for (var i = 0; i < chartData.fullIdleAim.time.length; i++) {
            aimPoints.push({ x: chartData.fullIdleAim.time[i], y: chartData.fullIdleAim.values[i] });
        }
        datasets.push({
            label: 'Idle Aim',
            data: aimPoints,
            borderColor: IDLE_COLORS.idleAimLine,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [5, 3],
            pointRadius: 0,
            tension: 0
        });
    }

    // Add event highlight regions as scatter datasets
    if (events && events.length > 0) {
        var normalPoints = [];
        var hangPoints = [];
        for (var e = 0; e < events.length; e++) {
            var evt = events[e];
            var trace = evt.rpmTrace;
            if (!trace) continue;
            var targetArr = evt.isHang ? hangPoints : normalPoints;
            for (var p = 0; p < trace.time.length; p += 3) {
                targetArr.push({ x: trace.time[p], y: trace.values[p] });
            }
        }

        if (normalPoints.length > 0) {
            datasets.push({
                label: 'Normal Settle',
                data: normalPoints,
                backgroundColor: 'rgba(111, 220, 140, 0.3)',
                borderColor: IDLE_COLORS.normalEvent,
                pointRadius: 2,
                pointHoverRadius: 4,
                showLine: false,
                type: 'scatter'
            });
        }
        if (hangPoints.length > 0) {
            datasets.push({
                label: 'Idle Hang',
                data: hangPoints,
                backgroundColor: 'rgba(255, 107, 122, 0.3)',
                borderColor: IDLE_COLORS.hangEvent,
                pointRadius: 2,
                pointHoverRadius: 4,
                showLine: false,
                type: 'scatter'
            });
        }
    }

    var chart = new Chart(canvas, {
        type: 'line',
        data: { datasets: datasets },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            parsing: false,
            plugins: {
                legend: darkLegendOptions(true),
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' +
                                   context.parsed.y.toFixed(0) + ' RPM @ ' +
                                   context.parsed.x.toFixed(2) + 's';
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Time (s)'), {
                    type: 'linear',
                    border: { color: IDLE_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('RPM'), {
                    border: { color: IDLE_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Chart 2: Decel Event Overlay (time-aligned to t=0)
// ---------------------------------------------------------------------------

function renderDecelOverlay(canvas, events) {
    var key = 'decel-overlay';
    destroyExisting(canvas, key);

    if (!events || events.length === 0) {
        renderNoData(canvas, 'No decel events detected');
        return;
    }

    var datasets = [];

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        if (!evt.rpmTrace || evt.rpmTrace.time.length === 0) continue;

        var points = [];
        var baseTime = evt.rpmTrace.time[0];
        for (var i = 0; i < evt.rpmTrace.time.length; i++) {
            points.push({
                x: evt.rpmTrace.time[i] - baseTime,
                y: evt.rpmTrace.values[i]
            });
        }

        var color = evt.isHang ? IDLE_COLORS.hangEvent : IDLE_COLORS.normalEvent;
        var alpha = evt.isHang ? '0.7' : '0.5';

        datasets.push({
            label: (evt.isHang ? 'Hang' : 'Normal') + ' #' + (e + 1),
            data: points,
            borderColor: color,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0,
            borderDash: evt.isHang ? [] : [2, 2]
        });
    }

    // Add idle aim reference line if available from first event
    var firstWithAim = null;
    for (var e = 0; e < events.length; e++) {
        if (events[e].idleAimTrace && events[e].idleAimTrace.values.length > 0) {
            firstWithAim = events[e];
            break;
        }
    }
    if (firstWithAim) {
        var aimVal = firstWithAim.idleAimTrace.values[0];
        datasets.push({
            label: 'Idle Aim (' + Math.round(aimVal) + ' RPM)',
            data: [{ x: 0, y: aimVal }, { x: 30, y: aimVal }],
            borderColor: IDLE_COLORS.idleAimLine,
            borderWidth: 2,
            borderDash: [8, 4],
            pointRadius: 0,
            tension: 0
        });
    }

    var chart = new Chart(canvas, {
        type: 'line',
        data: { datasets: datasets },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            parsing: false,
            plugins: {
                legend: Object.assign(darkLegendOptions(true), {
                    labels: {
                        color: IDLE_COLORS.text,
                        font: { size: 10 },
                        filter: function(item) {
                            // Only show first normal, first hang, and idle aim in legend
                            var lbl = item.text;
                            if (lbl.indexOf('Idle Aim') !== -1) return true;
                            if (lbl === 'Hang #1' || lbl === 'Normal #1') return true;
                            // Show if it's the first of its type
                            return item.datasetIndex <= 1;
                        }
                    }
                }),
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' +
                                   context.parsed.y.toFixed(0) + ' RPM @ t+' +
                                   context.parsed.x.toFixed(1) + 's';
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Time from event start (s)'), {
                    type: 'linear',
                    min: 0,
                    border: { color: IDLE_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('RPM'), {
                    border: { color: IDLE_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Chart 3: Settle Time Distribution
// ---------------------------------------------------------------------------

function renderSettleDistribution(canvas, events) {
    var key = 'settle-dist';
    destroyExisting(canvas, key);

    if (!events || events.length === 0) {
        renderNoData(canvas, 'No decel events detected');
        return;
    }

    // Collect settle times, separate hang vs normal
    var normalTimes = [];
    var hangTimes = [];
    var maxTime = 0;

    for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        var st = evt.settleTime !== null ? evt.settleTime : (evt.endTime - evt.startTime);
        if (st > maxTime) maxTime = st;
        if (evt.isHang) {
            hangTimes.push(st);
        } else {
            normalTimes.push(st);
        }
    }

    // Create histogram bins (1-second bins)
    var binSize = 1;
    var numBins = Math.max(1, Math.ceil(maxTime / binSize));
    if (numBins > 30) {
        binSize = maxTime / 20;
        numBins = 20;
    }

    var normalBins = new Array(numBins).fill(0);
    var hangBins = new Array(numBins).fill(0);
    var labels = [];

    for (var b = 0; b < numBins; b++) {
        labels.push((b * binSize).toFixed(0) + '-' + ((b + 1) * binSize).toFixed(0) + 's');
    }

    for (var i = 0; i < normalTimes.length; i++) {
        var bin = Math.min(numBins - 1, Math.floor(normalTimes[i] / binSize));
        normalBins[bin]++;
    }
    for (var i = 0; i < hangTimes.length; i++) {
        var bin = Math.min(numBins - 1, Math.floor(hangTimes[i] / binSize));
        hangBins[bin]++;
    }

    var chart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Normal',
                    data: normalBins,
                    backgroundColor: IDLE_COLORS.normalEvent,
                    borderWidth: 0
                },
                {
                    label: 'Hang',
                    data: hangBins,
                    backgroundColor: IDLE_COLORS.hangEvent,
                    borderWidth: 0
                }
            ]
        },

        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            plugins: {
                legend: darkLegendOptions(true),
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + context.parsed.y + ' events';
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Settle Time'), {
                    stacked: true,
                    border: { color: IDLE_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('Event Count'), {
                    stacked: true,
                    beginAtZero: true,
                    border: { color: IDLE_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Chart 4: MAP During Events
// ---------------------------------------------------------------------------

function renderMapEvents(canvas, events) {
    var key = 'map-events';
    destroyExisting(canvas, key);

    if (!events || events.length === 0) {
        renderNoData(canvas, 'No decel events detected');
        return;
    }

    // Check if any event has MAP data
    var hasMap = false;
    for (var i = 0; i < events.length; i++) {
        if (events[i].mapTrace && events[i].mapTrace.time.length > 0) {
            hasMap = true;
            break;
        }
    }

    if (!hasMap) {
        renderNoData(canvas, 'MAP data not available');
        return;
    }

    var datasets = [];
    var normalIdx = 0;
    var hangIdx = 0;

    for (var e = 0; e < events.length; e++) {
        var evt = events[e];
        if (!evt.mapTrace || evt.mapTrace.time.length === 0) continue;

        var points = [];
        var baseTime = evt.mapTrace.time[0];
        for (var i = 0; i < evt.mapTrace.time.length; i++) {
            points.push({
                x: evt.mapTrace.time[i] - baseTime,
                y: evt.mapTrace.values[i]
            });
        }

        var color = evt.isHang ? IDLE_COLORS.hangEvent : IDLE_COLORS.normalEvent;
        var label = evt.isHang ? 'Hang #' + (++hangIdx) : 'Normal #' + (++normalIdx);

        datasets.push({
            label: label,
            data: points,
            borderColor: color,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0
        });
    }

    var chart = new Chart(canvas, {
        type: 'line',
        data: { datasets: datasets },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            parsing: false,
            plugins: {
                legend: Object.assign(darkLegendOptions(true), {
                    labels: {
                        color: IDLE_COLORS.text,
                        font: { size: 10 }
                    }
                }),
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' +
                                   context.parsed.y.toFixed(1) + ' kPa @ t+' +
                                   context.parsed.x.toFixed(1) + 's';
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Time from event start (s)'), {
                    type: 'linear',
                    min: 0,
                    border: { color: IDLE_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('MAP (kPa)'), {
                    border: { color: IDLE_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Chart 5: Mass Flow Comparison
// ---------------------------------------------------------------------------

function renderMassFlowComparison(canvas, events) {
    var key = 'mass-flow';
    destroyExisting(canvas, key);

    if (!events || events.length === 0) {
        renderNoData(canvas, 'No decel events detected');
        return;
    }

    // Check if any event has mass flow data
    var hasMassFlow = false;
    var hasMassFlowFF = false;
    for (var i = 0; i < events.length; i++) {
        if (events[i].massFlowTrace && events[i].massFlowTrace.time.length > 0) {
            hasMassFlow = true;
        }
        if (events[i].massFlowFFTrace && events[i].massFlowFFTrace.time.length > 0) {
            hasMassFlowFF = true;
        }
    }

    if (!hasMassFlow && !hasMassFlowFF) {
        renderNoData(canvas, 'Mass flow data not available');
        return;
    }

    var datasets = [];

    // Average mass flow traces for hang vs normal events
    var hangMassFlow = averageTraces(events.filter(function(e) { return e.isHang; }), 'massFlowTrace');
    var normalMassFlow = averageTraces(events.filter(function(e) { return !e.isHang; }), 'massFlowTrace');
    var hangMassFlowFF = averageTraces(events.filter(function(e) { return e.isHang; }), 'massFlowFFTrace');
    var normalMassFlowFF = averageTraces(events.filter(function(e) { return !e.isHang; }), 'massFlowFFTrace');

    if (normalMassFlow) {
        datasets.push({
            label: 'Normal - Mass Flow',
            data: normalMassFlow,
            borderColor: IDLE_COLORS.normalEvent,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0
        });
    }
    if (hangMassFlow) {
        datasets.push({
            label: 'Hang - Mass Flow',
            data: hangMassFlow,
            borderColor: IDLE_COLORS.hangEvent,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0
        });
    }

    if (normalMassFlowFF) {
        datasets.push({
            label: 'Normal - Feed Forward',
            data: normalMassFlowFF,
            borderColor: IDLE_COLORS.normalEvent,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [5, 3],
            pointRadius: 0,
            tension: 0
        });
    }
    if (hangMassFlowFF) {
        datasets.push({
            label: 'Hang - Feed Forward',
            data: hangMassFlowFF,
            borderColor: IDLE_COLORS.hangEvent,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [5, 3],
            pointRadius: 0,
            tension: 0
        });
    }

    if (datasets.length === 0) {
        renderNoData(canvas, 'Mass flow data not available');
        return;
    }

    var chart = new Chart(canvas, {
        type: 'line',
        data: { datasets: datasets },
        options: {
            responsive: true, animation: false,
            maintainAspectRatio: true,
            parsing: false,
            plugins: {
                legend: darkLegendOptions(true),
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' +
                                   context.parsed.y.toFixed(2) + ' @ t+' +
                                   context.parsed.x.toFixed(1) + 's';
                        }
                    }
                },
                zoom: getZoomConfig()
            },
            scales: {
                x: Object.assign(darkScaleOptions('Time from event start (s)'), {
                    type: 'linear',
                    min: 0,
                    border: { color: IDLE_COLORS.gridlines }
                }),
                y: Object.assign(darkScaleOptions('Mass Flow'), {
                    border: { color: IDLE_COLORS.gridlines }
                })
            }
        }
    });

    _chartInstances[key] = chart;
    addResetZoomButton(canvas, key);
}

// ---------------------------------------------------------------------------
// Helper: Average multiple event traces into a single line
// ---------------------------------------------------------------------------

function averageTraces(events, traceKey) {
    // Filter events that have the trace
    var validEvents = [];
    for (var i = 0; i < events.length; i++) {
        var trace = events[i][traceKey];
        if (trace && trace.time.length > 0) {
            validEvents.push(events[i]);
        }
    }

    if (validEvents.length === 0) return null;

    // Find the shortest duration and resample all to 100 points
    var minDuration = Infinity;
    for (var i = 0; i < validEvents.length; i++) {
        var trace = validEvents[i][traceKey];
        var duration = trace.time[trace.time.length - 1] - trace.time[0];
        if (duration < minDuration && duration > 0) minDuration = duration;
    }

    if (minDuration <= 0 || !isFinite(minDuration)) return null;

    var numPoints = 100;
    var dt = minDuration / numPoints;
    var avgValues = new Array(numPoints).fill(0);
    var counts = new Array(numPoints).fill(0);

    for (var e = 0; e < validEvents.length; e++) {
        var trace = validEvents[e][traceKey];
        var baseTime = trace.time[0];

        for (var p = 0; p < numPoints; p++) {
            var targetTime = p * dt;
            // Find closest sample
            var bestIdx = 0;
            var bestDist = Infinity;
            for (var s = 0; s < trace.time.length; s++) {
                var dist = Math.abs((trace.time[s] - baseTime) - targetTime);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = s;
                }
            }
            var val = trace.values[bestIdx];
            if (!isNaN(val)) {
                avgValues[p] += val;
                counts[p]++;
            }
        }
    }

    var result = [];
    for (var p = 0; p < numPoints; p++) {
        if (counts[p] > 0) {
            result.push({ x: p * dt, y: avgValues[p] / counts[p] });
        }
    }

    return result.length > 0 ? result : null;
}
