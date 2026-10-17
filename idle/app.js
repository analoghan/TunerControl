/**
 * idle/app.js — UI Controller for the Idle Behavior Analyzer page.
 * Manages file input, worker lifecycle, progress display, and report rendering.
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
var tuneIdle = null;          // m1pkgIdle() of the chosen tune, or null
var tunePicked = false, storedTunes = [];

// ---------------------------------------------------------------------------
// Tune (optional): a .m1pkg or a stored tune, suggested from the log's ECU serial and time
// ---------------------------------------------------------------------------

var pkgInput = document.getElementById('pkg-input'), tuneSelect = document.getElementById('tune-select');
var tuneHint = document.getElementById('tune-hint'), tuneStatus = document.getElementById('tune-status');

function setTune(idle, sourceLabel) {
    tuneIdle = idle;
    if (!idle) {
        tuneStatus.textContent = 'No tune chosen: the idle is judged from the log alone. With the tune, the integral limits and the Feed Forward Main cells the idle used are checked too.';
        return;
    }
    var bits = [];
    if (idle.integralMin !== null) bits.push('Integral ' + idle.integralMin + ' to ' + idle.integralMax + ' %');
    if (idle.pGain !== null) bits.push('proportional ' + idle.pGain + ' % per rpm');
    if (idle.feedForward) bits.push('Feed Forward Main ' + idle.feedForward.aim.length + ' × ' + idle.feedForward.coolant.length + ' sites');
    if (idle.aimMain) bits.push('Idle Aim Main ' + idle.aimMain.values.map(Math.round).join('/') + ' rpm');
    tuneStatus.textContent = sourceLabel + ': ' + (idle.tuneName || 'tune') + '. ' + bits.join(', ') + '.' + (idle.notes.length ? ' ' + idle.notes.join(' ') : '');
}

pkgInput.addEventListener('change', function () {
    var file = pkgInput.files[0];
    if (!file) return;
    tunePicked = true;
    tuneSelect.value = '';
    tuneHint.textContent = '';
    file.arrayBuffer().then(function (buf) { setTune(m1pkgIdle(parseM1Pkg(buf)), 'Tune file ' + file.name); }).catch(function (err) {
        setTune(null);
        showErrorBanner('Could not read the idle settings from ' + file.name + ': ' + err.message);
    });
});

function useStoredTune(id, hint, suggested) {
    if (!id) { setTune(null); tuneHint.textContent = ''; return Promise.resolve(); }
    tuneSelect.value = id;
    tuneHint.textContent = 'Loading…';
    return tsLoad(id).then(function (pkg) {
        if (tuneSelect.value !== id) return;
        pkgInput.value = '';
        setTune(m1pkgIdle(pkg), 'Stored tune');
        tuneHint.textContent = hint || '';
        tuneHint.classList.toggle('suggested', !!suggested);
    }).catch(function (err) {
        setTune(null);
        tuneHint.textContent = '';
        showErrorBanner('Could not read the idle settings from the stored tune: ' + err.message);
    });
}

tuneSelect.addEventListener('change', function () {
    tunePicked = !!tuneSelect.value;
    useStoredTune(tuneSelect.value, '', false);
});

function suggestStoredTune(file) {
    if (!storedTunes.length || tunePicked || typeof tsLogInfo === 'undefined') return;
    tsLogInfo(file).then(function (info) {
        var sug = tsSuggest(storedTunes, info);
        if (sug.tune) return useStoredTune(sug.tune.id, sug.reason, true);
        tuneHint.textContent = sug.reason;
        tuneHint.classList.remove('suggested');
    });
}

if (typeof tsInit !== 'undefined') {
    tsInit().then(tsList).then(function (list) {
        storedTunes = list;
        if (!list.length) return;
        list.forEach(function (t) {
            var o = document.createElement('option');
            o.value = t.id;
            o.textContent = tsLabel(t);
            tuneSelect.appendChild(o);
        });
        document.getElementById('tune-row').hidden = false;
        if (selectedFile) suggestStoredTune(selectedFile);
    }).catch(function () { /* no stored tunes: the file input still works */ });
}

// ---------------------------------------------------------------------------
// File Input Handling
// ---------------------------------------------------------------------------

function handleFileSelect(event) {
    var file = csvInput.files[0] || null;
    clearErrorBanner();

    if (worker) {
        worker.terminate();
        worker = null;
    }
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
        suggestStoredTune(file);
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

function createIdleWorker() {
    var workerUrl = new URL('worker.js', window.location.href).href;
    var blob = new Blob(['importScripts("' + workerUrl + '");'], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

function handleAnalyzeClick() {
    if (!selectedFile) return;

    analyzeBtn.disabled = true;
    fileError.hidden = true;
    reportSection.hidden = true;
    chartsSection.hidden = true;
    collectedWarnings = [];

    progressSection.hidden = false;
    progressBarFill.style.width = '0%';
    progressPct.textContent = '0%';
    progressPhase.textContent = '';

    var progressTrack = progressBarFill.parentElement;
    if (progressTrack) {
        progressTrack.setAttribute('aria-valuenow', '0');
    }

    var isLD = selectedFile.name.toLowerCase().endsWith('.ld');

    var reader = new FileReader();
    reader.onload = function() {
        if (worker) {
            worker.terminate();
            worker = null;
        }

        worker = createIdleWorker();
        worker.onmessage = handleWorkerMessage;
        worker.onerror = function(err) {
            progressSection.hidden = true;
            showErrorBanner('An unexpected error occurred during analysis. Please try again.');
            analyzeBtn.disabled = false;
            if (worker) { worker.terminate(); worker = null; }
        };

        if (isLD) {
            worker.postMessage({ type: 'analyze_ld', buffer: reader.result, tune: tuneIdle });
        } else {
            worker.postMessage({ type: 'analyze', logText: reader.result, tune: tuneIdle });
        }
    };

    reader.onerror = function() {
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
            renderCharts(data.chartData, data.analysis);
            analyzeBtn.disabled = false;
            if (worker) { worker.terminate(); worker = null; }
            break;

        case 'error':
            progressSection.hidden = true;
            showErrorBanner(data.message);
            analyzeBtn.disabled = false;
            if (worker) { worker.terminate(); worker = null; }
            break;
    }
}

// ---------------------------------------------------------------------------
// Progress Display
// ---------------------------------------------------------------------------

function updateProgress(phase, percent) {
    var pct = Math.max(0, Math.min(100, Math.round(percent)));
    progressBarFill.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    progressPhase.textContent = phase || '';

    var progressTrack = progressBarFill.parentElement;
    if (progressTrack) {
        progressTrack.setAttribute('aria-valuenow', String(pct));
    }
}

// ---------------------------------------------------------------------------
// Error Display
// ---------------------------------------------------------------------------

function showErrorBanner(message) {
    var existing = document.querySelector('.error-banner');
    if (existing) {
        existing.parentElement.removeChild(existing);
    }

    var banner = document.createElement('div');
    banner.className = 'error-banner';
    banner.setAttribute('role', 'alert');
    banner.textContent = message;

    var fileSection = csvInput.closest('.file-section');
    if (fileSection && fileSection.nextElementSibling) {
        fileSection.parentElement.insertBefore(banner, fileSection.nextElementSibling);
    } else {
        document.querySelector('.app-container').appendChild(banner);
    }
}

function clearErrorBanner() {
    var existing = document.querySelector('.error-banner');
    if (existing) {
        existing.parentElement.removeChild(existing);
    }
}

// ---------------------------------------------------------------------------
// Report Rendering
// ---------------------------------------------------------------------------

function renderReport(analysis) {
    clearErrorBanner();
    reportSection.hidden = false;

    renderChannelMapping(analysis.channelMapping);
    renderWarnings(analysis.channelWarnings);
    renderSummary(analysis);
    renderDiagnostics(analysis);
    renderSteadyIdle(analysis.steadyIdle);
    renderCoolantCorrelation(analysis.coolantTempCorrelation);
}

// ---------------------------------------------------------------------------
// Channel Mapping Rendering
// ---------------------------------------------------------------------------

function renderChannelMapping(channelMapping) {
    clearElement(channelInfoEl);
    if (!channelMapping) return;

    var channelLabels = {
        rpm: 'Engine Speed',
        idle_aim: 'Idle Aim',
        tps: 'Throttle Pedal',
        vehicle_speed: 'Vehicle Speed',
        map: 'Inlet Manifold Pressure',
        coolant_temp: 'Coolant Temperature',
        idle_mass_flow: 'Idle Mass Flow',
        idle_mass_flow_ff: 'Idle Mass Flow FF',
        clutch_pos: 'Clutch Position'
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

function renderWarnings(channelWarnings) {
    var allWarnings = collectedWarnings.concat(channelWarnings || []);
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
// Summary Rendering
// ---------------------------------------------------------------------------

function renderSummary(analysis) {
    var content = document.getElementById('summary-content');
    if (!content) return;
    clearElement(content);

    var grid = document.createElement('div');
    grid.className = 'summary-grid';

    // Total decel events
    addStat(grid, analysis.totalDecelEvents, 'Returns to Idle', '');
    if (analysis.skippedEvents) addStat(grid, analysis.skippedEvents, 'Gear Changes (left out)', '');
    // Hang events
    var hangPct = analysis.totalDecelEvents > 0
        ? (analysis.hangEvents / analysis.totalDecelEvents * 100).toFixed(0) + '%'
        : '0%';
    addStat(grid, analysis.hangEvents + ' (' + hangPct + ')', 'Idle Hangs',
        analysis.hangEvents > 0 ? 'stat-warning' : 'stat-healthy');

    // Normal events
    addStat(grid, analysis.normalEvents, 'Normal Settles', 'stat-healthy');
    // Avg settle time
    addStat(grid, analysis.avgSettleTime.toFixed(1) + 's', 'Avg Settle Time', '');
    // Worst settle time
    addStat(grid, analysis.worstSettleTime.toFixed(1) + 's', 'Worst Settle Time',
        analysis.worstSettleTime > 5 ? 'stat-warning' : '');
    // Avg hang RPM
    if (analysis.hangEvents > 0) {
        addStat(grid, Math.round(analysis.avgHangRpm) + ' RPM', 'Avg Hang RPM', 'stat-warning');
    }

    content.appendChild(grid);
}

function addStat(container, value, label, extraClass) {
    var div = document.createElement('div');
    div.className = 'summary-stat' + (extraClass ? ' ' + extraClass : '');

    var valSpan = document.createElement('span');
    valSpan.className = 'stat-value';
    valSpan.textContent = value;

    var labelSpan = document.createElement('span');
    labelSpan.className = 'stat-label';
    labelSpan.textContent = label;

    div.appendChild(valSpan);
    div.appendChild(labelSpan);
    container.appendChild(div);
}

// ---------------------------------------------------------------------------
// Diagnostics Rendering
// ---------------------------------------------------------------------------

function renderDiagnostics(analysis) {
    var content = document.getElementById('diagnostics-content');
    if (!content) return;
    clearElement(content);

    var messages = [];

    if (analysis.totalDecelEvents === 0) {
        messages.push({ text: 'No returns to idle in this log (pedal off' + (analysis.channelMapping.clutch_pos ? ', clutch in' : '') +
            ', from more than 500 rpm above the Idle Aim down to it).', severity: 'warning' });
    } else {
        if (analysis.hangEvents === 0) {
            messages.push({
                text: 'No idle hang detected in ' + analysis.totalDecelEvents + ' return' + (analysis.totalDecelEvents === 1 ? '' : 's') + ' to idle.',
                severity: 'healthy'
            });
        } else {
            var pct = (analysis.hangEvents / analysis.totalDecelEvents * 100).toFixed(0);
            messages.push({
                text: 'Idle hang detected in ' + analysis.hangEvents + ' of ' +
                      analysis.totalDecelEvents + ' returns to idle (' + pct + '%).',
                severity: 'severe'
            });
        }

        if (analysis.worstSettleTime > 5) {
            messages.push({
                text: 'Worst settle time is ' + analysis.worstSettleTime.toFixed(1) +
                      's — consider reviewing idle control parameters.',
                severity: 'warning'
            });
        }

        if (analysis.avgSettleTime > 3) {
            messages.push({
                text: 'Average settle time (' + analysis.avgSettleTime.toFixed(1) +
                      's) is elevated — idle mass flow feed forward may need adjustment.',
                severity: 'warning'
            });
        }

        // Coolant correlation insight
        var cold = analysis.coolantTempCorrelation.cold;
        var warm = analysis.coolantTempCorrelation.warm;
        if (cold.events > 0 && cold.hangs / cold.events > 0.5) {
            messages.push({
                text: 'High hang rate when cold (' + cold.hangs + '/' + cold.events +
                      ') — cold start idle calibration may need attention.',
                severity: 'warning'
            });
        }

        // Mass flow diagnostics (Item 10)
        if (analysis.massFlowDiagnostics) {
            var mfd = analysis.massFlowDiagnostics;
            if (mfd.diagnosis) {
                messages.push({ text: mfd.diagnosis, severity: 'warning' });
            }
            if (mfd.hangFeedForward !== null && mfd.normalFeedForward !== null && analysis.hangEvents > 0) {
                messages.push({
                    text: 'Idle Mass Flow during hangs: ' + (mfd.hangMassFlow === null ? 'N/A' : mfd.hangMassFlow + ' %') +
                          ' (feed forward ' + mfd.hangFeedForward + ' %). Other returns to idle: ' +
                          (mfd.normalMassFlow === null ? 'N/A' : mfd.normalMassFlow + ' %') + ' (feed forward ' + mfd.normalFeedForward + ' %).',
                    severity: 'info'
                });
            }
        }

        // Decel rate diagnostics (Item 11)
        if (analysis.decelRates) {
            var dr = analysis.decelRates;
            if (dr.avgNormalRate > 0) {
                messages.push({
                    text: 'Average RPM decay rate: ' + dr.avgNormalRate + ' RPM/s (normal events)' +
                          (dr.avgHangRate > 0 ? ', ' + dr.avgHangRate + ' RPM/s (hang events)' : '') + '.',
                    severity: 'info'
                });
            }
            if (dr.avgHangRate > 0 && dr.avgNormalRate > 0 && dr.avgHangRate < dr.avgNormalRate * 0.5) {
                messages.push({
                    text: 'Hang events have significantly slower RPM decay (' + dr.avgHangRate +
                          ' vs ' + dr.avgNormalRate + ' RPM/s) — decel dashpot rate may be too conservative.',
                    severity: 'warning'
                });
            }
        }
    }

    for (var i = 0; i < messages.length; i++) {
        var div = document.createElement('div');
        div.className = 'diagnostic diagnostic-' + messages[i].severity;
        div.textContent = messages[i].text;
        content.appendChild(div);
    }
}

// ---------------------------------------------------------------------------
// Steady Idle Rendering
// ---------------------------------------------------------------------------

function renderSteadyIdle(steady) {
    var content = document.getElementById('steady-content');
    if (!content) return;
    clearElement(content);
    if (!steady) return;
    if (steady.rpm) {
        var grid = document.createElement('div');
        grid.className = 'summary-grid';
        function range(s, unit, dp) { return s ? s.p50.toFixed(dp) + unit + ' (' + s.p10.toFixed(dp) + '–' + s.p90.toFixed(dp) + ')' : '—'; }
        addStat(grid, steady.seconds.toFixed(0) + ' s', 'Steady Idle', '');
        addStat(grid, range(steady.rpm, '', 0), 'Engine Speed (10–90 %)', '');
        addStat(grid, range(steady.aim, '', 0), 'Idle Aim', '');
        addStat(grid, (steady.rpmAboveAim.p50 >= 0 ? '+' : '') + steady.rpmAboveAim.p50.toFixed(0) + ' rpm', 'Above Aim (median)',
            Math.abs(steady.rpmAboveAim.p50) > 30 ? 'stat-warning' : 'stat-healthy');
        if (steady.massFlowMinusFF) addStat(grid, (steady.massFlowMinusFF.p50 >= 0 ? '+' : '') + steady.massFlowMinusFF.p50.toFixed(1) + ' %', 'Idle Mass Flow − Feed Forward', '');
        if (steady.map) addStat(grid, range(steady.map, ' kPa', 0), 'Manifold Pressure', '');
        if (steady.ignition) addStat(grid, range(steady.ignition, '°', 1), 'Ignition Timing', '');
        if (steady.coolant) addStat(grid, steady.coolant.p50.toFixed(0) + ' °C', 'Coolant', '');
        if (steady.integral) addStat(grid, steady.integral.p50.toFixed(1) + ' %', 'Idle integral (from the tune)', steady.integralAtMin >= 0.5 || steady.integralAtMax >= 0.5 ? 'stat-warning' : '');
        if (steady.ffMain) addStat(grid, steady.ffMain.p50.toFixed(1) + ' % + ' + steady.ffCompensation.p50.toFixed(1) + ' %', 'Feed forward: Main + compensations', '');
        content.appendChild(grid);
    }
    steady.diags.forEach(function (d) {
        var div = document.createElement('div');
        div.className = 'diagnostic diagnostic-' + (d.severity === 'good' ? 'healthy' : d.severity);
        div.textContent = d.text;
        content.appendChild(div);
    });
    if (steady.ffCells && steady.ffCells.length) {
        var table = document.createElement('table'), head = '<thead><tr><th>Feed Forward Main cell</th><th class="num">Share of steady idle</th>' +
            '<th class="num">Value</th><th class="num">With the controller\'s change</th></tr></thead>';
        table.className = 'ff-cells';
        table.innerHTML = head + '<tbody>' + steady.ffCells.map(function (k) {
            return '<tr><td>Idle Aim ' + Math.round(k.aim) + ' rpm' + (k.coolant !== null ? ', coolant ' + k.coolant + ' °C' : '') + '</td><td class="num">' +
                Math.round(k.share * 100) + ' %</td><td class="num">' + k.value.toFixed(1) + ' %</td><td class="num">' + k.suggested.toFixed(1) + ' %</td></tr>';
        }).join('') + '</tbody>';
        content.appendChild(table);
    }
}

// ---------------------------------------------------------------------------
// Coolant Correlation Rendering
// ---------------------------------------------------------------------------

function renderCoolantCorrelation(correlation) {
    var content = document.getElementById('coolant-content');
    if (!content) return;
    clearElement(content);

    if (!correlation) {
        renderUnavailable(content, 'Coolant temperature data not available.');
        return;
    }

    var total = correlation.cold.events + correlation.warm.events + correlation.hot.events;
    if (total === 0) {
        renderUnavailable(content, 'No coolant temperature data available for correlation.');
        return;
    }

    var table = document.createElement('table');
    table.className = 'coolant-table';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['Temp Range', 'Events', 'Hangs', 'Hang Rate'];
    for (var h = 0; h < headers.length; h++) {
        var th = document.createElement('th');
        th.textContent = headers[h];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var ranges = [
        { label: 'Cold (< 60\u00B0C)', data: correlation.cold },
        { label: 'Warm (60-85\u00B0C)', data: correlation.warm },
        { label: 'Hot (> 85\u00B0C)', data: correlation.hot }
    ];

    for (var r = 0; r < ranges.length; r++) {
        var tr = document.createElement('tr');
        var range = ranges[r];

        var tdLabel = document.createElement('td');
        tdLabel.textContent = range.label;
        tr.appendChild(tdLabel);

        var tdEvents = document.createElement('td');
        tdEvents.textContent = range.data.events;
        tr.appendChild(tdEvents);

        var tdHangs = document.createElement('td');
        tdHangs.textContent = range.data.hangs;
        tr.appendChild(tdHangs);

        var tdRate = document.createElement('td');
        var rate = range.data.events > 0
            ? (range.data.hangs / range.data.events * 100).toFixed(0) + '%'
            : 'N/A';
        tdRate.textContent = rate;
        tr.appendChild(tdRate);

        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    content.appendChild(table);
}

// ---------------------------------------------------------------------------
// Chart Rendering
// ---------------------------------------------------------------------------

function renderCharts(chartData, analysis) {
    // Show charts section BEFORE rendering so Chart.js can measure dimensions
    chartsSection.hidden = false;

    var rpmTimelineCanvas = document.getElementById('chart-rpm-timeline');
    var decelOverlayCanvas = document.getElementById('chart-decel-overlay');
    var settleDistCanvas = document.getElementById('chart-settle-dist');
    var mapEventsCanvas = document.getElementById('chart-map-events');
    var massFlowCanvas = document.getElementById('chart-mass-flow');

    renderRpmTimeline(rpmTimelineCanvas, chartData, analysis.events);
    renderDecelOverlay(decelOverlayCanvas, analysis.events);
    renderSettleDistribution(settleDistCanvas, analysis.events);
    renderMapEvents(mapEventsCanvas, analysis.events);
    renderMassFlowComparison(massFlowCanvas, analysis.events);
}

// ---------------------------------------------------------------------------
// Rendering Helpers
// ---------------------------------------------------------------------------

function clearElement(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

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
analyzeBtn.addEventListener('click', function() {
    clearErrorBanner();
    handleAnalyzeClick();
});
