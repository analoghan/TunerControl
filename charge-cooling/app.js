/**
 * charge-cooling/app.js — Charge Cooling Gain Calculator
 *
 * Analyzes lambda step-test logs to determine the correct charge cooling gain.
 * The test procedure: in open loop (CL disabled), change target lambda from 1.0 to 0.9.
 * If actual lambda doesn't track the target, the charge cooling gain needs adjustment.
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorContainer = document.getElementById('error-container');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');

logInput.addEventListener('change', function() {
    var file = logInput.files[0];
    document.getElementById('log-filename').textContent = file ? file.name : 'No file selected';
    analyzeBtn.disabled = !file;
});

analyzeBtn.addEventListener('click', function() {
    var file = logInput.files[0];
    if (!file) return;

    analyzeBtn.disabled = true;
    errorContainer.hidden = true;
    resultsSection.hidden = true;
    progressSection.hidden = false;

    var reader = new FileReader();
    reader.onload = function() {
        try {
            var result = analyzeChargeCooling(reader.result, file.name.toLowerCase().endsWith('.ld'));
            progressSection.hidden = true;
            renderResults(result);
            analyzeBtn.disabled = false;
        } catch (err) {
            progressSection.hidden = true;
            errorContainer.textContent = err.message;
            errorContainer.hidden = false;
            analyzeBtn.disabled = false;
        }
    };
    reader.onerror = function() {
        progressSection.hidden = true;
        errorContainer.textContent = 'Could not read file.';
        errorContainer.hidden = false;
        analyzeBtn.disabled = false;
    };
    if (file.name.toLowerCase().endsWith('.ld')) {
        reader.readAsArrayBuffer(file);
    } else {
        reader.readAsText(file);
    }
});

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeChargeCooling(data, isLd) {
    var currentGain = parseFloat(document.getElementById('current-gain').value) || 13;
    var fuelType = document.getElementById('fuel-type').value;
    var stepTarget = parseFloat(document.getElementById('step-target').value) || 0.9;

    // Parse log
    var columnNames, rows;
    if (isLd) {
        var parsed = parseLdFile(data, null);
        columnNames = parsed.columnNames;
        rows = parsed.data;
    } else {
        var parseResult = parseCsvLog(data);
        columnNames = parseResult.columnNames;
        rows = parseResult.data;
    }

    // Resolve channels
    var colLower = columnNames.map(function(n) { return n.toLowerCase().trim(); });
    var timeIdx = colLower.indexOf('time');
    var lambdaB1Idx = findChannel(colLower, ['exhaust lambda bank 1']);
    var lambdaB2Idx = findChannel(colLower, ['exhaust lambda bank 2']);
    var lambdaAvgIdx = findChannel(colLower, ['exhaust lambda']);
    var lambdaTargetIdx = findChannel(colLower, ['fuel mixture aim']);
    var iatIdx = findChannel(colLower, ['inlet air temperature', 'airbox temperature']);
    var coolantIdx = findChannel(colLower, ['coolant temperature']);

    if (timeIdx === -1) throw new Error('Time channel not found.');
    if (lambdaTargetIdx === -1) throw new Error('Fuel Mixture Aim (lambda target) channel not found. This is required for step-test detection.');
    if (lambdaB1Idx === -1 && lambdaB2Idx === -1 && lambdaAvgIdx === -1) throw new Error('No lambda channel found.');

    // Build sample array
    var samples = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var lb1 = lambdaB1Idx >= 0 ? row[lambdaB1Idx] : NaN;
        var lb2 = lambdaB2Idx >= 0 ? row[lambdaB2Idx] : NaN;
        var lavg = lambdaAvgIdx >= 0 ? row[lambdaAvgIdx] : NaN;
        var lambda;
        if (!isNaN(lb1) && lb1 > 0.5 && !isNaN(lb2) && lb2 > 0.5) lambda = (lb1 + lb2) / 2;
        else if (!isNaN(lb1) && lb1 > 0.5) lambda = lb1;
        else if (!isNaN(lb2) && lb2 > 0.5) lambda = lb2;
        else lambda = lavg;

        samples.push({
            time: row[timeIdx],
            lambda: lambda,
            lambdaTarget: row[lambdaTargetIdx],
            iat: iatIdx >= 0 ? row[iatIdx] : NaN,
            coolant: coolantIdx >= 0 ? row[coolantIdx] : NaN,
        });
    }

    // Detect step events: find where lambda target changes significantly
    var events = detectStepEvents(samples, stepTarget);

    if (events.length === 0) {
        throw new Error('No lambda step events detected. Ensure the log contains target lambda changes from ~1.0 to ~' + stepTarget + ' (and back). Closed loop must be disabled during the test.');
    }

    // Analyze tracking accuracy
    var analysis = computeGainAnalysis(events, currentGain, fuelType, stepTarget);

    return { events: events, analysis: analysis, currentGain: currentGain, fuelType: fuelType };
}

function findChannel(colLower, candidates) {
    for (var c = 0; c < candidates.length; c++) {
        var idx = colLower.indexOf(candidates[c]);
        if (idx >= 0) return idx;
    }
    return -1;
}

function parseCsvLog(text) {
    text = text.replace(/\0/g, '').replace(/^\uFEFF/, '');
    var lines = text.split(/\r?\n/);
    var headerIdx = -1;
    for (var i = 0; i < Math.min(50, lines.length); i++) {
        var firstField = lines[i].split(',')[0].trim().replace(/^"|"$/g, '');
        if (firstField === 'Time') { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Could not find "Time" header in CSV.');

    var columnNames = lines[headerIdx].split(',').map(function(s) { return s.trim().replace(/^"|"$/g, ''); });
    var dataStart = headerIdx + 2;
    var data = [];
    for (var i = dataStart; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;
        var fields = line.split(',');
        var row = [];
        for (var f = 0; f < fields.length; f++) {
            row.push(parseFloat(fields[f].trim().replace(/^"|"$/g, '')));
        }
        data.push(row);
    }
    return { columnNames: columnNames, data: data };
}

// ---------------------------------------------------------------------------
// Step Event Detection
// ---------------------------------------------------------------------------

function detectStepEvents(samples, stepTarget) {
    var events = [];
    var baseTarget = 1.0; // assume stoich is the "home" position
    var threshold = 0.03; // 3% change in target counts as a step

    var inStep = false;
    var stepStartIdx = -1;

    for (var i = 1; i < samples.length; i++) {
        var prevTarget = samples[i - 1].lambdaTarget;
        var currTarget = samples[i].lambdaTarget;
        if (isNaN(prevTarget) || isNaN(currTarget)) continue;

        // Detect step down (from ~1.0 to ~0.9)
        if (!inStep && Math.abs(prevTarget - baseTarget) < threshold && Math.abs(currTarget - stepTarget) < threshold) {
            inStep = true;
            stepStartIdx = i;
        }
        // Detect step back up (from ~0.9 to ~1.0)
        else if (inStep && Math.abs(currTarget - baseTarget) < threshold) {
            // Measure the step event
            var stepEndIdx = i;
            var event = measureStepEvent(samples, stepStartIdx, stepEndIdx, stepTarget);
            if (event) events.push(event);
            inStep = false;
        }
    }

    // If still in a step at end of log, measure what we have
    if (inStep && stepStartIdx > 0) {
        var event = measureStepEvent(samples, stepStartIdx, samples.length - 1, stepTarget);
        if (event) events.push(event);
    }

    return events;
}

function measureStepEvent(samples, startIdx, endIdx, stepTarget) {
    // Allow 0.5s for the step to settle, then measure the average lambda
    var settleTime = 0.5;
    var startTime = samples[startIdx].time;
    var measureStart = startTime + settleTime;
    var measureEnd = samples[endIdx].time;

    if (measureEnd - measureStart < 0.5) return null; // too short to measure

    var lambdaSum = 0, lambdaCount = 0;
    var iatSum = 0, iatCount = 0;
    var targetSum = 0;

    for (var i = startIdx; i <= endIdx; i++) {
        if (samples[i].time < measureStart) continue;
        if (isNaN(samples[i].lambda) || samples[i].lambda < 0.5) continue;

        lambdaSum += samples[i].lambda;
        lambdaCount++;
        targetSum += samples[i].lambdaTarget;

        if (!isNaN(samples[i].iat)) { iatSum += samples[i].iat; iatCount++; }
    }

    if (lambdaCount < 10) return null;

    var avgLambda = lambdaSum / lambdaCount;
    var avgTarget = targetSum / lambdaCount;
    var avgIAT = iatCount > 0 ? iatSum / iatCount : NaN;
    var trackingError = avgLambda - avgTarget; // positive = leaner than target, negative = richer

    return {
        time: startTime,
        duration: (measureEnd - startTime).toFixed(1),
        targetLambda: avgTarget,
        actualLambda: avgLambda,
        trackingError: trackingError,
        trackingPct: (trackingError / avgTarget) * 100,
        iat: avgIAT,
    };
}

// ---------------------------------------------------------------------------
// Gain Analysis & Recommendation
// ---------------------------------------------------------------------------

function computeGainAnalysis(events, currentGain, fuelType, stepTarget) {
    // Average tracking error across all step events
    var totalError = 0;
    var count = 0;
    for (var i = 0; i < events.length; i++) {
        totalError += events[i].trackingError;
        count++;
    }
    var avgError = totalError / count;
    var avgErrorPct = (avgError / stepTarget) * 100;

    // Determine if gain needs adjustment
    // If actual lambda is RICHER than target (negative error): gain too LOW → increase
    // If actual lambda is LEANER than target (positive error): gain too HIGH → decrease
    var direction = avgError < -0.005 ? 'increase' : avgError > 0.005 ? 'decrease' : 'correct';

    // Estimate the gain adjustment needed
    // The charge cooling gain affects the charge temperature calculation.
    // A rough relationship: each 1°C of gain change adjusts fueling by ~0.3-0.5%
    // So if we're off by X%, we need approximately X / 0.4 degrees of gain change.
    var gainAdjustment = Math.round(Math.abs(avgErrorPct) / 0.4);

    var suggestedGain = currentGain;
    if (direction === 'increase') suggestedGain = currentGain + gainAdjustment;
    else if (direction === 'decrease') suggestedGain = Math.max(0, currentGain - gainAdjustment);

    // Expected ranges by fuel type
    var expectedRange = { petrol: [10, 25], e85: [25, 50], ethanol: [40, 70], methanol: [50, 90] };
    var range = expectedRange[fuelType] || [10, 25];

    return {
        avgError: avgError,
        avgErrorPct: avgErrorPct,
        direction: direction,
        gainAdjustment: gainAdjustment,
        suggestedGain: suggestedGain,
        expectedRange: range,
        eventCount: count,
    };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResults(result) {
    resultsSection.hidden = false;
    renderAnalysis(result);
    renderRecommendation(result);
    renderEvents(result.events);
}

function renderAnalysis(result) {
    var a = result.analysis;
    var container = document.getElementById('analysis-content');
    var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;">';
    html += stat(a.eventCount, 'Step Events Detected');
    html += stat(a.avgError.toFixed(4), 'Avg Lambda Error');
    html += stat(a.avgErrorPct.toFixed(1) + '%', 'Error as %');
    html += stat(result.currentGain + '°C', 'Current Gain');
    html += stat(a.suggestedGain + '°C', 'Suggested Gain');
    html += stat(a.expectedRange[0] + '–' + a.expectedRange[1] + '°C', 'Expected Range (' + result.fuelType + ')');
    html += '</div>';
    container.innerHTML = html;
}

function renderRecommendation(result) {
    var a = result.analysis;
    var container = document.getElementById('recommendation-content');
    var html = '';

    if (a.direction === 'correct') {
        html += '<div class="rec-item rec-good"><b>Charge cooling gain appears correct.</b> Lambda tracks the target within ±0.5% when stepping from 1.0 to ' + document.getElementById('step-target').value + '. Current value of ' + result.currentGain + '°C is appropriate.</div>';
    } else if (a.direction === 'increase') {
        html += '<div class="rec-item rec-warning"><b>Increase charge cooling gain.</b> When targeting ' + a.avgError.toFixed(3) + ' lambda richer, the actual lambda only reached ' + (parseFloat(document.getElementById('step-target').value) - a.avgError).toFixed(3) + ' — it\'s richer than the target by ' + Math.abs(a.avgErrorPct).toFixed(1) + '%. This means the ECU is delivering too much fuel because the charge cooling compensation is too low. <br><br>Suggested: increase from <b>' + result.currentGain + '°C</b> to approximately <b>' + a.suggestedGain + '°C</b>.</div>';
    } else {
        html += '<div class="rec-item rec-warning"><b>Decrease charge cooling gain.</b> When targeting richer lambda, the actual lambda didn\'t reach the target — it\'s leaner by ' + Math.abs(a.avgErrorPct).toFixed(1) + '%. This means the ECU is not delivering enough fuel because the charge cooling compensation is too high. <br><br>Suggested: decrease from <b>' + result.currentGain + '°C</b> to approximately <b>' + a.suggestedGain + '°C</b>.</div>';
    }

    // Range check
    var range = a.expectedRange;
    if (a.suggestedGain < range[0] || a.suggestedGain > range[1]) {
        html += '<div class="rec-item rec-info">Note: suggested value of ' + a.suggestedGain + '°C is outside the typical range for ' + result.fuelType + ' (' + range[0] + '–' + range[1] + '°C). This could indicate an issue with the test conditions (CL not fully disabled, IAT sensor heat soak, VE table not calibrated). Verify and re-test.</div>';
    }

    html += '<div class="rec-item rec-info"><b>Verification procedure:</b> After adjusting the gain, repeat the step test. Command 1.0 → 0.9 → 1.0 lambda in open loop. Lambda should track within ±0.01 of the target at each step. If not, adjust gain ±2°C and repeat.</div>';

    container.innerHTML = html;
}

function renderEvents(events) {
    var container = document.getElementById('events-content');
    if (events.length === 0) { container.innerHTML = '<p style="color:#888;">No events.</p>'; return; }

    var html = '<table class="event-table"><thead><tr><th>Time</th><th>Duration</th><th>Target λ</th><th>Actual λ</th><th>Error</th><th>Error %</th><th>IAT</th></tr></thead><tbody>';
    for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var errCls = Math.abs(e.trackingPct) > 3 ? 'severity-high' : Math.abs(e.trackingPct) > 1 ? 'severity-med' : 'severity-low';
        html += '<tr><td>' + e.time.toFixed(1) + 's</td><td>' + e.duration + 's</td><td>' + e.targetLambda.toFixed(3) + '</td><td>' + e.actualLambda.toFixed(3) + '</td><td class="' + errCls + '">' + (e.trackingError > 0 ? '+' : '') + e.trackingError.toFixed(3) + '</td><td class="' + errCls + '">' + (e.trackingPct > 0 ? '+' : '') + e.trackingPct.toFixed(1) + '%</td><td>' + (isNaN(e.iat) ? '—' : e.iat.toFixed(0) + '°C') + '</td></tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
}

function stat(value, label) {
    return '<div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;"><span style="display:block;font-size:1.2rem;font-weight:700;color:#fff;">' + value + '</span><span style="display:block;font-size:0.7rem;color:#888;margin-top:3px;">' + label + '</span></div>';
}
