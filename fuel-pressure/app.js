/**
 * fuel-pressure/app.js — UI Controller for the DI Fuel Pressure Deep Dive page.
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
        tunePicker.suggest(file);
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

function createFuelPressureWorker() {
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

        worker = createFuelPressureWorker();
        worker.onmessage = handleWorkerMessage;
        worker.onerror = function(err) {
            progressSection.hidden = true;
            showErrorBanner('An unexpected error occurred during analysis. Please try again.');
            analyzeBtn.disabled = false;
            if (worker) { worker.terminate(); worker = null; }
        };

        if (isLD) {
            lastRunFile = selectedFile;
            lastRunInfo = { file: selectedFile, rail: tuneRail, tuneId: tuneRail ? tuneId : null };
            logPanelReady = null;
            worker.postMessage({ type: 'analyze_ld', buffer: reader.result, rail: tuneRail });
        } else {
            lastRunFile = selectedFile;
            lastRunInfo = { file: selectedFile, rail: tuneRail, tuneId: tuneRail ? tuneId : null };
            logPanelReady = null;
            worker.postMessage({ type: 'analyze', logText: reader.result, rail: tuneRail });
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
    renderRailControl(analysis.railControl, analysis.tuneName);
    if (typeof rsSaveControl === 'function' && lastRunInfo) {
        var run = lastRunInfo;
        rsSaveControl(document.getElementById('history-save'), function () {
            return rsLogFacts(run.file).then(function (facts) {
                return Object.assign({ tool: 'fuel-pressure', tuneId: run.tuneId, tuneName: run.rail ? run.rail.tuneName : null, settings: null },
                    facts, rbFuelPressure(analysis, run.rail));
            });
        });
    }
    renderErrorGrid(analysis.errorGrid);
    renderAimSteps(analysis.transientEvents);
    renderPressurePwImpact(analysis.pressurePwImpact);
    renderDiagnostics(analysis);
}

// ---------------------------------------------------------------------------
// Channel Mapping Rendering
// ---------------------------------------------------------------------------

function renderChannelMapping(channelMapping) {
    clearElement(channelInfoEl);
    if (!channelMapping) return;

    var channelLabels = {
        fuel_press: 'Fuel Pressure',
        fuel_press_aim: 'Fuel Pressure Aim',
        fuel_press_control: 'Fuel Pressure Control',
        rpm: 'Engine Speed',
        inj_duty: 'Injector Duty Cycle',
        fuel_flow: 'Fuel Flow',
        fuel_volume: 'Fuel Volume',
        throttle_pedal: 'Throttle Pedal'
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

    addStat(grid, analysis.meanError.toFixed(2) + ' bar', 'Mean Error', '');
    addStat(grid, analysis.meanAbsError.toFixed(2) + ' bar', 'Mean |Error|', '');
    addStat(grid, analysis.maxOvershoot.toFixed(1) + ' bar', 'Max Overshoot',
        analysis.maxOvershoot > 5 ? 'stat-warning' : '');
    addStat(grid, analysis.maxUndershoot.toFixed(1) + ' bar', 'Max Undershoot',
        analysis.maxUndershoot < -5 ? 'stat-warning' : '');
    addStat(grid, analysis.pctWithinTolerance.toFixed(1) + '%', 'Within \u00B12 bar',
        analysis.pctWithinTolerance > 95 ? 'stat-healthy' : (analysis.pctWithinTolerance < 80 ? 'stat-warning' : ''));
    addStat(grid, analysis.transientEvents.length.toString(), 'Aim Steps', '');
    if (analysis.pump) {
        addStat(grid, analysis.pump.maxControl + '%', 'Highest Pump Control', '');
        addStat(grid, analysis.pump.pctUndershootAtLimit + '%', 'Undershoot With Pump Near Max',
            analysis.pump.likelyLimited ? 'stat-warning' : '');
    }

    content.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Tune (rail pressure aim table and control gains)
// ---------------------------------------------------------------------------

var tuneRail = null, tuneId = null;
var lastRunInfo = null;   // { file, rail, tuneId } of the shown results, for the tuning history

var tunePicker = tsPicker({
    pkgInput: document.getElementById('pkg-input'), select: document.getElementById('tune-select'), row: document.getElementById('tune-row'),
    hint: document.getElementById('tune-hint'), status: document.getElementById('tune-status'), extract: m1pkgRail,
    none: 'No tune chosen: choose one for advice on the rail pressure control gains and aim table.', what: 'the rail pressure settings',
    describe: function (rail) {
        return 'Proportional Gain ' + rail.pGainPctPerBar + ' %/bar, Integral Gain ' + rail.iGainPctPerBarS + ' %/(bar·s)' +
            (rail.aim ? ', aim table ' + rail.aim.rpm.length + ' rpm × ' + rail.aim.volume.length + ' fuel volume sites' : '') +
            '.' + (rail.notes.length ? ' ' + rail.notes.join(' ') : '');
    },
    onError: function (msg) { showErrorBanner(msg); },
    onChange: function (rail, id) { tuneRail = rail; tuneId = id; }
});

var RAIL_SEVERITY_CLASS = { warning: 'rail-warning', info: 'rail-info', good: 'rail-good' };

function renderRailControl(rc, tuneName) {
    var block = document.getElementById('report-rail'), content = document.getElementById('rail-content');
    block.hidden = !rc;
    if (!rc) return;
    var html = '';
    if (!tuneName) {
        html += '<p class="section-note">Choose the tune that was in the ECU (above) to see the current gains and the errors mapped onto the ' +
            'Fuel Pressure Direct Aim table. The kinds of error below do not need it.</p>';
    } else {
        html += '<p class="section-note">Tune ' + fpEsc(tuneName) + (rc.gains ? ': Proportional Gain ' + rc.gains.p + ' %/bar, Integral Gain ' + rc.gains.i +
            ' %/(bar·s)' + (rc.gains.margin !== null ? ', margin ' + rc.gains.margin + ' bar' : '') : '') + '.' +
            (rc.volumeFactor ? ' The aim table reproduces the logged aim to within ' + rc.aimMatch + ' bar (median), using the logged fuel volume × ' +
                rc.volumeFactor + ' as fuel volume per cycle.' : '') + '</p>';
    }
    html += rc.advice.map(function (a) { return '<div class="rail-advice ' + (RAIL_SEVERITY_CLASS[a.severity] || '') + '">' + fpEsc(a.text) + '</div>'; }).join('');
    html += '<h3>Kinds of error</h3><table class="fp-table"><thead><tr><th>Kind</th><th>Time</th><th>Episodes</th><th>Average</th><th>Share of situation</th></tr></thead><tbody>';
    Object.keys(rc.classes).forEach(function (k) {
        var c = rc.classes[k];
        if (!c.seconds) return;
        html += '<tr><td style="text-align:left">' + fpEsc(c.label) + '</td><td>' + c.seconds + ' s</td><td>' + c.episodes + '</td><td>' + c.meanEpisode +
            ' s</td><td>' + c.share + '% of ' + (c.context === 'running' ? 'running' : 'aim ' + c.context) + '</td></tr>';
    });
    html += '</tbody></table><p class="section-note">Errors count beyond the larger of 2 bar and 5% of the aim, for at least 0.3 s. Time with the ' +
        'aim steady ' + rc.context.steady + ' s, rising ' + rc.context.rising + ' s, falling ' + rc.context.falling + ' s.</p>';
    if (rc.cells && tuneRail && tuneRail.aim) {
        var aim = tuneRail.aim;
        html += '<h3>Error by Fuel Pressure Direct Aim cell</h3><p class="section-note">Mean error (bar) and share within ±2 bar at each aim table ' +
            'site (nearest), with the table\'s aim below. Cells with under 1 s of data are faded.</p><div class="fp-scroll"><table class="fp-table">' +
            '<thead><tr><th>RPM \\ µl/cycle</th>' + aim.volume.map(function (v) { return '<th>' + v + '</th>'; }).join('') + '</tr></thead><tbody>';
        for (var r = aim.rpm.length - 1; r >= 0; r--) {
            html += '<tr><th>' + Math.round(aim.rpm[r]) + '</th>';
            rc.cells[r].forEach(function (c, v) {
                var tableAim = aim.values[r][v];
                if (!c) { html += '<td class="empty"><small>' + Math.round(tableAim) + '</small></td>'; return; }
                if (c.thin) { html += '<td class="thin" title="' + c.seconds + ' s of data"><small>' + Math.round(tableAim) + '</small></td>'; return; }
                var cls = c.pctWithin >= 95 ? 'good' : c.pctWithin < 80 ? 'bad' : 'warn';
                html += '<td class="' + cls + '" title="' + c.seconds + ' s; mostly: ' + fpEsc(c.main ? rc.classes[c.main].label : 'on aim') + '">' +
                    (c.meanError > 0 ? '+' : '') + c.meanError.toFixed(1) + '<br><small>' + c.pctWithin + '% · ' + Math.round(tableAim) + ' bar</small></td>';
            });
            html += '</tr>';
        }
        html += '</tbody></table></div>';
    }
    content.innerHTML = html;
}

var lastRunFile = null;                      // the log of the shown results, for the log panel
var logPanel = null, logPanelReady = null;

function fpEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function renderErrorGrid(grid) {
    var block = document.getElementById('report-grid'), content = document.getElementById('grid-content');
    block.hidden = !grid;
    if (!grid) return;
    var html = '<table class="fp-table"><thead><tr><th>MAP \\ RPM</th>' + grid.rpmLabels.map(function (l) { return '<th>' + l + '</th>'; }).join('') +
        '</tr></thead><tbody>';
    for (var m = grid.mapLabels.length - 1; m >= 0; m--) {
        html += '<tr><th>' + grid.mapLabels[m] + ' kPa</th>';
        grid.cells[m].forEach(function (c) {
            if (!c) { html += '<td class="empty"></td>'; return; }
            var cls = c.pctWithin >= 95 ? 'good' : c.pctWithin < 80 ? 'bad' : 'warn';
            html += '<td class="' + cls + '" title="' + c.samples + ' samples, worst undershoot ' + c.worstUnder + ' bar">' +
                (c.meanError > 0 ? '+' : '') + c.meanError.toFixed(1) + '<br><small>' + c.pctWithin + '%</small></td>';
        });
        html += '</tr>';
    }
    content.innerHTML = html + '</tbody></table>';
}

function renderAimSteps(events) {
    var block = document.getElementById('report-transients'), content = document.getElementById('transients-content');
    block.hidden = !events || !events.length;
    document.getElementById('log-panel').hidden = true;
    if (!events || !events.length) return;
    var html = '<table class="fp-table clickable"><thead><tr><th>Time</th><th>Aim</th><th>Change</th><th>Worst error</th><th>Settled</th></tr></thead><tbody>';
    events.forEach(function (e, i) {
        html += '<tr data-i="' + i + '" title="Show in the log"><td>' + e.startTime.toFixed(2) + ' s</td><td>' + Math.round(e.aimFrom) + ' → ' +
            Math.round(e.aimTo) + ' bar</td><td>' + (e.direction === 'up' ? '+' : '−') + Math.round(e.aimChange) + ' bar</td><td>' +
            (e.maxError > 0 ? '+' : '') + e.maxError.toFixed(1) + ' bar</td><td>' + (e.settled ? Math.round(e.settleTime * 1000) + ' ms' : 'not within 5 s') +
            '</td></tr>';
    });
    content.innerHTML = html + '</tbody></table>';
    content.querySelectorAll('tbody tr').forEach(function (tr) {
        tr.onclick = function () { showStepInLog(events, events[+tr.dataset.i]); };
    });
}

function showStepInLog(events, evt) {
    if (typeof LogPanel === 'undefined' || !lastRunFile) return;
    var el = document.getElementById('log-panel');
    el.hidden = false;
    if (!logPanel) logPanel = new LogPanel(el, { preset: 'fuel-pressure', storageKey: 'fuel-pressure', showVe: false, showTf: false });
    if (!logPanelReady) {
        logPanelReady = logPanel.open(lastRunFile).then(function () {
            logPanel.setMarkers(events.map(function (e) {
                return { t: e.startTime, t1: e.endTime, color: e.direction === 'up' ? '#4dd0e1' : '#ffb74d', fill: 'rgba(255,255,255,0.05)',
                         label: 'aim ' + (e.direction === 'up' ? '+' : '−') + Math.round(e.aimChange) + ' bar' };
            }));
        });
    }
    logPanelReady.then(function () { logPanel.zoomTo(evt.startTime - 1.5, evt.endTime + 2); }).catch(function () { logPanelReady = null; });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
// Pressure → PW Impact Rendering
// ---------------------------------------------------------------------------

function renderPressurePwImpact(pwImpact) {
    var block = document.getElementById('report-pw-impact');
    var content = document.getElementById('pw-impact-content');
    if (!content || !block) return;
    clearElement(content);

    if (!pwImpact || !pwImpact.byRpm || pwImpact.byRpm.length === 0) {
        block.hidden = true;
        return;
    }

    block.hidden = false;

    var desc = document.createElement('p');
    desc.style.cssText = 'color:#b0b0b0;font-size:0.9rem;margin-bottom:12px;';
    desc.textContent = 'When fuel pressure drops below aim, injector pulse width must increase to deliver the same fuel mass (PW \u221D 1/\u221Apressure). This table shows the implied PW increase needed at each RPM range during undershoot events (' + pwImpact.totalUndershootSamples.toLocaleString() + ' samples).';
    content.appendChild(desc);

    var table = document.createElement('table');
    table.className = 'summary-table';
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.85rem;';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var headers = ['RPM', 'Samples', 'Avg PW Increase', 'Max PW Increase'];
    for (var h = 0; h < headers.length; h++) {
        var th = document.createElement('th');
        th.style.cssText = 'padding:6px 10px;border:1px solid #333;background:#222;color:#fff;text-align:center;';
        th.textContent = headers[h];
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = 0; i < pwImpact.byRpm.length; i++) {
        var row = pwImpact.byRpm[i];
        var tr = document.createElement('tr');

        var tdRpm = document.createElement('td');
        tdRpm.style.cssText = 'padding:6px 10px;border:1px solid #333;text-align:center;color:#ccc;';
        tdRpm.textContent = row.rpm;
        tr.appendChild(tdRpm);

        var tdSamples = document.createElement('td');
        tdSamples.style.cssText = 'padding:6px 10px;border:1px solid #333;text-align:center;color:#ccc;';
        tdSamples.textContent = row.samples.toLocaleString();
        tr.appendChild(tdSamples);

        var tdAvg = document.createElement('td');
        tdAvg.style.cssText = 'padding:6px 10px;border:1px solid #333;text-align:center;font-weight:600;';
        tdAvg.style.color = row.avgPwIncrease > 5 ? '#f44336' : row.avgPwIncrease > 2 ? '#ff9800' : '#4caf50';
        tdAvg.textContent = '+' + row.avgPwIncrease.toFixed(1) + '%';
        tr.appendChild(tdAvg);

        var tdMax = document.createElement('td');
        tdMax.style.cssText = 'padding:6px 10px;border:1px solid #333;text-align:center;font-weight:600;';
        tdMax.style.color = row.maxPwIncrease > 10 ? '#f44336' : row.maxPwIncrease > 5 ? '#ff9800' : '#4caf50';
        tdMax.textContent = '+' + row.maxPwIncrease.toFixed(1) + '%';
        tr.appendChild(tdMax);

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    content.appendChild(table);

    var note = document.createElement('p');
    note.style.cssText = 'color:#666;font-size:0.8rem;font-style:italic;margin-top:8px;';
    note.textContent = 'The M1 lengthens the pulse itself from the measured rail pressure (Fuel Injector Primary Differential Pressure), so undershoot is compensated as long as the injector data is right and the longer pulse still ends in time — check the latest end of injection in the DI Injection Timing tool.';
    content.appendChild(note);
}

// ---------------------------------------------------------------------------
// Diagnostics Rendering
// ---------------------------------------------------------------------------

function renderDiagnostics(analysis) {
    var content = document.getElementById('diagnostics-content');
    if (!content) return;
    clearElement(content);

    var messages = analysis.diagnostics || [];

    if (messages.length === 0) {
        var div = document.createElement('div');
        div.className = 'diagnostic diagnostic-healthy';
        div.textContent = 'No significant issues detected.';
        content.appendChild(div);
        return;
    }

    for (var i = 0; i < messages.length; i++) {
        var div = document.createElement('div');
        var msg = messages[i];
        var severity = 'warning';
        if (msg.indexOf('tracks aim well') !== -1) {
            severity = 'healthy';
        } else if (msg.indexOf('Significant') !== -1 || msg.indexOf('Worst') !== -1) {
            severity = 'severe';
        }
        div.className = 'diagnostic diagnostic-' + severity;
        div.textContent = msg;
        content.appendChild(div);
    }
}

// ---------------------------------------------------------------------------
// Chart Rendering
// ---------------------------------------------------------------------------

function renderCharts(chartData, analysis) {
    // Show charts section BEFORE rendering so Chart.js can measure dimensions
    chartsSection.hidden = false;

    var pressureAimCanvas = document.getElementById('chart-pressure-aim');
    var errorTimelineCanvas = document.getElementById('chart-error-timeline');
    var errorRpmCanvas = document.getElementById('chart-error-rpm');
    var errorDutyCanvas = document.getElementById('chart-error-duty');
    var errorFlowCanvas = document.getElementById('chart-error-flow');
    var transientCanvas = document.getElementById('chart-transient');
    var histogramCanvas = document.getElementById('chart-error-histogram');

    renderPressureAimTimeline(pressureAimCanvas, chartData);
    renderErrorTimeline(errorTimelineCanvas, chartData);
    renderErrorVsRpm(errorRpmCanvas, chartData);
    renderErrorVsDuty(errorDutyCanvas, chartData);
    renderErrorVsFlow(errorFlowCanvas, chartData);
    renderTransientOverlay(transientCanvas, chartData);
    renderErrorHistogram(histogramCanvas, chartData);
}

// ---------------------------------------------------------------------------
// Rendering Helpers
// ---------------------------------------------------------------------------

function clearElement(el) {
    while (el.firstChild) {
        el.removeChild(el.firstChild);
    }
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

csvInput.addEventListener('change', handleFileSelect);
analyzeBtn.addEventListener('click', function() {
    clearErrorBanner();
    handleAnalyzeClick();
});
