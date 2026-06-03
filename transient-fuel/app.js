/**
 * transient-fuel/app.js — UI controller for Transient Fuel Analyzer
 */

var logInput = document.getElementById('log-input');
var ffTableInput = document.getElementById('ff-table-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorContainer = document.getElementById('error-container');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');

logInput.addEventListener('change', function() {
    var file = logInput.files[0];
    document.getElementById('log-filename').textContent = file ? file.name : 'No file selected';
    analyzeBtn.disabled = !file;
});

ffTableInput.addEventListener('change', function() {
    var file = ffTableInput.files[0];
    document.getElementById('ff-filename').textContent = file ? file.name : 'No file selected';
});

analyzeBtn.addEventListener('click', function() {
    var file = logInput.files[0];
    if (!file) return;

    analyzeBtn.disabled = true;
    errorContainer.hidden = true;
    resultsSection.hidden = true;
    progressSection.hidden = false;

    var ffFile = ffTableInput.files[0] || null;
    var settings = {
        mapRateThreshold: parseInt(document.getElementById('map-rate-threshold').value, 10) || 200,
        minMapChange: parseInt(document.getElementById('min-map-change').value, 10) || 15,
        lambdaTarget: parseFloat(document.getElementById('lambda-target').value) || 1.0,
        ffScale: parseFloat(document.getElementById('ff-scale').value) || 100,
        ffOffset: parseFloat(document.getElementById('ff-offset').value) || 0,
    };

    // Read log file (and optionally FF table)
    var filesToRead = [];
    if (file.name.toLowerCase().endsWith('.ld')) {
        filesToRead.push({ key: 'log', file: file, mode: 'binary' });
    } else {
        filesToRead.push({ key: 'log', file: file, mode: 'text' });
    }
    if (ffFile) filesToRead.push({ key: 'ff', file: ffFile, mode: 'text' });

    var fileResults = {};
    var remaining = filesToRead.length;
    filesToRead.forEach(function(item) {
        var reader = new FileReader();
        reader.onload = function() {
            fileResults[item.key] = reader.result;
            remaining--;
            if (remaining === 0) runAnalysis(file, fileResults, settings);
        };
        reader.onerror = function() {
            progressSection.hidden = true;
            errorContainer.textContent = 'Could not read: ' + item.file.name;
            errorContainer.hidden = false;
            analyzeBtn.disabled = false;
        };
        if (item.mode === 'binary') reader.readAsArrayBuffer(item.file);
        else reader.readAsText(item.file);
    });
});

function runAnalysis(logFile, files, settings) {
    try {
        var result;
        if (logFile.name.toLowerCase().endsWith('.ld')) {
            result = analyzeTransientsLd(files.log, settings);
        } else {
            result = analyzeTransients(files.log, settings);
        }

        // If fuel film table was provided, compute corrections
        if (files.ff) {
            result.ffTable = parseFuelFilmTable(files.ff);
            result.ffCorrected = computeFuelFilmCorrections(result, settings);
        }

        progressSection.hidden = true;
        renderResults(result);
        analyzeBtn.disabled = false;
    } catch (err) {
        progressSection.hidden = true;
        errorContainer.textContent = err.message;
        errorContainer.hidden = false;
        analyzeBtn.disabled = false;
    }
}

function renderResults(result) {
    resultsSection.hidden = false;
    renderSummary(result);
    renderTipInTable(result.tipIns);
    renderTipOutTable(result.tipOuts);
    renderRecommendations(result.recommendations);
    if (result.ffCorrected) {
        renderCorrectedTable(result.ffTable, result.ffCorrected);
    }
}

function renderSummary(r) {
    var c = document.getElementById('summary-content');
    c.innerHTML = '<div class="summary-grid">' +
        stat(r.totalEvents, 'Total Events') +
        stat(r.tipInCount, 'Tip-In Events') +
        stat(r.tipOutCount, 'Tip-Out Events') +
        stat(r.avgLeanSpike.toFixed(1) + '%', 'Avg Lean Spike') +
        stat(r.avgRichOvershoot.toFixed(1) + '%', 'Avg Rich Overshoot') +
        stat(Math.round(r.avgRecoveryTime) + 'ms', 'Avg Recovery Time') +
        '</div>';
}

function stat(value, label) {
    return '<div class="summary-stat"><span class="stat-value">' + value + '</span><span class="stat-label">' + label + '</span></div>';
}

function renderTipInTable(events) {
    var c = document.getElementById('tipin-content');
    if (events.length === 0) { c.innerHTML = '<p style="color:#888;">No tip-in events detected.</p>'; return; }

    var html = '<table class="event-table"><thead><tr><th>Time</th><th>RPM</th><th>MAP Change</th><th>Rate</th><th>Lean Spike</th><th>Rich Overshoot</th><th>Recovery</th></tr></thead><tbody>';
    var limit = Math.min(events.length, 30);
    for (var i = 0; i < limit; i++) {
        var e = events[i];
        var cls = e.leanSpike > 10 ? 'severity-high' : e.leanSpike > 5 ? 'severity-med' : 'severity-low';
        html += '<tr><td>' + e.time.toFixed(2) + 's</td><td>' + e.rpm + '</td><td>' + e.mapFrom + '→' + e.mapTo + ' kPa</td><td>' + e.mapRate + ' kPa/s</td><td class="' + cls + '">' + e.leanSpike.toFixed(1) + '%</td><td>' + e.richOvershoot.toFixed(1) + '%</td><td>' + e.recoveryTime + 'ms</td></tr>';
    }
    html += '</tbody></table>';
    if (events.length > limit) html += '<p style="color:#888;font-size:0.8rem;">Showing top ' + limit + ' of ' + events.length + ' events.</p>';
    c.innerHTML = html;
}

function renderTipOutTable(events) {
    var c = document.getElementById('tipout-content');
    if (events.length === 0) { c.innerHTML = '<p style="color:#888;">No tip-out events detected.</p>'; return; }

    var html = '<table class="event-table"><thead><tr><th>Time</th><th>RPM</th><th>MAP Change</th><th>Rate</th><th>Rich Overshoot</th><th>Recovery</th></tr></thead><tbody>';
    var limit = Math.min(events.length, 30);
    for (var i = 0; i < limit; i++) {
        var e = events[i];
        var cls = e.richOvershoot > 10 ? 'severity-high' : e.richOvershoot > 5 ? 'severity-med' : 'severity-low';
        html += '<tr><td>' + e.time.toFixed(2) + 's</td><td>' + e.rpm + '</td><td>' + e.mapFrom + '→' + e.mapTo + ' kPa</td><td>' + e.mapRate + ' kPa/s</td><td class="' + cls + '">' + e.richOvershoot.toFixed(1) + '%</td><td>' + e.recoveryTime + 'ms</td></tr>';
    }
    html += '</tbody></table>';
    if (events.length > limit) html += '<p style="color:#888;font-size:0.8rem;">Showing top ' + limit + ' of ' + events.length + ' events.</p>';
    c.innerHTML = html;
}

function renderRecommendations(recs) {
    var c = document.getElementById('recommendations-content');
    var html = '';
    recs.forEach(function(r) {
        html += '<div class="rec-item rec-' + r.severity + '">' + r.text + '</div>';
    });
    c.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Fuel Film Table Parsing & Correction
// ---------------------------------------------------------------------------

function parseFuelFilmTable(csvText) {
    var lines = csvText.split(/\r?\n/);
    // M1 v2 format: header rows then breakpoints row then data row
    // Line 0: M1,v2
    // Line 1: Body,ul
    // Line 2: Cols,kPa,Inlet Man Pres
    // Line 3: ,bp1,bp2,bp3,...  (MAP breakpoints)
    // Line 4: "0",val1,val2,val3,...  (values)

    var breakpoints = [];
    var values = [];

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;
        var fields = line.split(',').map(function(f) { return f.trim().replace(/^"|"$/g, ''); });

        // Breakpoints row: first field is empty, rest are numbers
        if (fields[0] === '' && fields.length > 2 && !isNaN(parseFloat(fields[1]))) {
            for (var f = 1; f < fields.length; f++) {
                var v = parseFloat(fields[f]);
                if (!isNaN(v)) breakpoints.push(v);
            }
        }
        // Data row: first field is "0" or a number, rest are values
        else if (breakpoints.length > 0 && fields.length > 2 && !isNaN(parseFloat(fields[1]))) {
            var isDataRow = !isNaN(parseFloat(fields[0])) || fields[0] === '0';
            if (isDataRow) {
                for (var f = 1; f < fields.length; f++) {
                    var v = parseFloat(fields[f]);
                    if (!isNaN(v)) values.push(v);
                }
            }
        }
    }

    if (breakpoints.length === 0 || values.length === 0) {
        throw new Error('Could not parse Fuel Film Primary table. Expected M1 v2 CSV format.');
    }

    return { breakpoints: breakpoints, values: values };
}

function computeFuelFilmCorrections(result, settings) {
    var ffTable = result.ffTable;
    var scale = (settings.ffScale || 100) / 100;
    var offset = settings.ffOffset || 0;
    var tipIns = result.tipIns;

    var corrected = ffTable.values.slice();
    var corrections = new Array(ffTable.breakpoints.length);
    var eventCounts = new Array(ffTable.breakpoints.length);
    for (var i = 0; i < corrections.length; i++) { corrections[i] = 0; eventCounts[i] = 0; }

    for (var e = 0; e < tipIns.length; e++) {
        var evt = tipIns[e];
        if (evt.leanSpike <= 2) continue; // ignore negligible spikes (<2%)

        // Find the nearest MAP breakpoint to the event's destination MAP
        var bestIdx = 0;
        var bestDist = Math.abs(evt.mapTo - ffTable.breakpoints[0]);
        for (var b = 1; b < ffTable.breakpoints.length; b++) {
            var dist = Math.abs(evt.mapTo - ffTable.breakpoints[b]);
            if (dist < bestDist) { bestDist = dist; bestIdx = b; }
        }

        // Correction logic:
        // The lean spike tells us the % lambda error during the transient.
        // This corresponds roughly to the % underfueling during that moment.
        // The fuel film table value should increase proportionally to cover that deficit.
        //
        // Conservative approach: increase by (leanSpike% / 100) * current_value
        // This means a 10% lean spike on a cell with 100 ul adds 10 ul.
        // Cap the per-event correction at 25% of the current value to prevent
        // single outlier events from dominating.
        var currentEffective = ffTable.values[bestIdx] * scale + offset;
        var correctionPct = Math.min(evt.leanSpike / 100, 0.25); // cap at 25% per event
        var additionalNeeded = currentEffective * correctionPct;

        // For very low cells (near zero), use a minimum proportional to MAP change
        // A 50 kPa MAP change might need ~5-10 ul base fuel film
        if (currentEffective < 5) {
            additionalNeeded = Math.min(evt.leanSpike * 0.5, 15); // conservative for empty cells
        }

        corrections[bestIdx] += additionalNeeded;
        eventCounts[bestIdx]++;
    }

    // Average the corrections per breakpoint and apply (with damping)
    for (var i = 0; i < corrected.length; i++) {
        if (eventCounts[i] > 0) {
            var avgCorrection = corrections[i] / eventCounts[i];
            // Apply only 75% of the computed correction (conservative iteration)
            corrected[i] = ffTable.values[i] + avgCorrection * 0.75;
            if (corrected[i] < 0) corrected[i] = 0;
            // Cap maximum increase at 50% of original value per iteration
            var maxIncrease = ffTable.values[i] * 0.5;
            if (maxIncrease > 0 && (corrected[i] - ffTable.values[i]) > maxIncrease) {
                corrected[i] = ffTable.values[i] + maxIncrease;
            }
            corrected[i] = Math.round(corrected[i] * 10) / 10;
        }
    }

    return {
        breakpoints: ffTable.breakpoints,
        original: ffTable.values,
        corrected: corrected,
        corrections: corrections.map(function(c, i) { return eventCounts[i] > 0 ? Math.round(c / eventCounts[i] * 10) / 10 : 0; }),
        eventCounts: eventCounts,
    };
}

function renderCorrectedTable(ffTable, corrected) {
    var section = document.getElementById('corrected-table-section');
    section.hidden = false;
    var container = document.getElementById('corrected-table-content');

    var html = '<table class="event-table"><thead><tr><th>MAP (kPa)</th>';
    for (var i = 0; i < corrected.breakpoints.length; i++) {
        html += '<th>' + corrected.breakpoints[i] + '</th>';
    }
    html += '</tr></thead><tbody>';

    // Original row
    html += '<tr><td style="font-weight:600;color:#888;">Original (ul)</td>';
    for (var i = 0; i < corrected.original.length; i++) {
        html += '<td style="color:#888;">' + corrected.original[i].toFixed(1) + '</td>';
    }
    html += '</tr>';

    // Corrected row
    html += '<tr><td style="font-weight:600;color:#4caf50;">Corrected (ul)</td>';
    for (var i = 0; i < corrected.corrected.length; i++) {
        var changed = Math.abs(corrected.corrected[i] - corrected.original[i]) > 0.5;
        var cls = changed ? 'color:#4caf50;font-weight:600;' : 'color:#ccc;';
        html += '<td style="' + cls + '">' + corrected.corrected[i].toFixed(1) + '</td>';
    }
    html += '</tr>';

    // Change row
    html += '<tr><td style="font-weight:600;color:#ff9800;">Change (ul)</td>';
    for (var i = 0; i < corrected.corrections.length; i++) {
        var val = corrected.corrections[i];
        var cls = val > 0 ? 'color:#ff9800;' : 'color:#666;';
        html += '<td style="' + cls + '">' + (val > 0 ? '+' : '') + val.toFixed(1) + '</td>';
    }
    html += '</tr>';

    // Event count row
    html += '<tr><td style="font-weight:600;color:#666;">Events</td>';
    for (var i = 0; i < corrected.eventCounts.length; i++) {
        html += '<td style="color:#666;">' + corrected.eventCounts[i] + '</td>';
    }
    html += '</tr>';

    html += '</tbody></table>';
    container.innerHTML = html;

    // Build corrected CSV for download
    var csvLines = [
        'M1,v2',
        'Body,ul',
        'Cols,kPa,Inlet Man Pres',
        ',' + corrected.breakpoints.map(function(v) { return formatSci(v); }).join(','),
        '"0",' + corrected.corrected.map(function(v) { return formatSci(v); }).join(',')
    ];
    var correctedCsv = csvLines.join('\r\n');

    document.getElementById('download-ff-btn').onclick = function() {
        var blob = new Blob([correctedCsv], { type: 'text/csv' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'Fuel_Film_Prim_Main_Corrected.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };
    document.getElementById('copy-ff-btn').onclick = function() {
        navigator.clipboard.writeText(correctedCsv).catch(function(){});
        this.textContent = 'Copied!';
        var btn = this;
        setTimeout(function() { btn.textContent = 'Copy to Clipboard'; }, 1500);
    };
}

function formatSci(value) {
    // MoTeC M1 v2 format: 17 decimal places, e notation
    return '"' + value.toExponential(17) + '"';
}
