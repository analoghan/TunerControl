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

var ffFromPkg = null;   // fuel film table read from a selected .m1pkg (null for CSV or no file)

ffTableInput.addEventListener('change', function() {
    var file = ffTableInput.files[0];
    var label = document.getElementById('ff-filename');
    ffFromPkg = null;
    errorContainer.hidden = true;
    if (!file || !file.name.toLowerCase().endsWith('.m1pkg')) {
        label.textContent = file ? file.name : 'No file selected';
        return;
    }
    // Read the table and the scale/offset/time-constant settings from the tune package.
    label.textContent = 'Reading ' + file.name + '…';
    var reader = new FileReader();
    reader.onload = function() {
        if (ffTableInput.files[0] !== file) return; // a different file was picked meanwhile
        try {
            var film = m1pkgFuelFilm(parseM1Pkg(reader.result));
            ffFromPkg = film.table;
            applyTuneSettings(film);
            label.textContent = file.name + ' — ' + (film.tuneName || 'tune') + ', Fuel Film Primary Main (' +
                film.table.breakpoints.length + ' sites); scale, offset and time constants filled from the tune' +
                (film.notes.length ? '. ' + film.notes.join(' ') : '');
        } catch (err) {
            label.textContent = 'No file selected';
            ffTableInput.value = '';
            errorContainer.textContent = 'Could not read the fuel film table from "' + file.name + '": ' + err.message;
            errorContainer.hidden = false;
        }
    };
    reader.onerror = function() {
        label.textContent = 'No file selected';
        errorContainer.textContent = 'Could not read: ' + file.name;
        errorContainer.hidden = false;
    };
    reader.readAsArrayBuffer(file);
});

/** Fills the scale, offset and time-constant inputs with the values read from a tune package. */
function applyTuneSettings(film) {
    function set(id, value, dps) {
        if (typeof value === 'number' && isFinite(value)) document.getElementById(id).value = +value.toFixed(dps);
    }
    set('ff-scale', film.ffScale, 1);
    set('ff-offset', film.ffOffset, 2);
    set('fast-pct', film.timeConstants.fastPct, 1);
    set('fast-increase', film.timeConstants.fastIncrease, 3);
    set('fast-decrease', film.timeConstants.fastDecrease, 3);
    set('slow-increase', film.timeConstants.slowIncrease, 3);
    set('slow-decrease', film.timeConstants.slowDecrease, 3);
}

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
        minMapChange: parseInt(document.getElementById('min-map-change').value, 10) || 20,
        mapWindow: parseInt(document.getElementById('map-window').value, 10) || 500,
        lambdaTarget: parseFloat(document.getElementById('lambda-target').value) || 1.0,
        ffScale: parseFloat(document.getElementById('ff-scale').value) || 100,
        ffOffset: parseFloat(document.getElementById('ff-offset').value) || 0,
        currentTimeConstants: {
            fastPct: parseFloat(document.getElementById('fast-pct').value) || 30,
            fastIncrease: parseFloat(document.getElementById('fast-increase').value) || 0.2,
            fastDecrease: parseFloat(document.getElementById('fast-decrease').value) || 0.3,
            slowIncrease: parseFloat(document.getElementById('slow-increase').value) || 0.5,
            slowDecrease: parseFloat(document.getElementById('slow-decrease').value) || 0.3,
        },
    };

    // Read log file (and optionally FF table)
    var filesToRead = [];
    if (file.name.toLowerCase().endsWith('.ld')) {
        filesToRead.push({ key: 'log', file: file, mode: 'binary' });
    } else {
        filesToRead.push({ key: 'log', file: file, mode: 'text' });
    }
    if (ffFile && !ffFromPkg) filesToRead.push({ key: 'ff', file: ffFile, mode: 'text' });

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
        if (ffFromPkg || files.ff) {
            result.ffTable = ffFromPkg || parseFuelFilmTable(files.ff);
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
        var leanCls = e.leanSpike > 10 ? 'severity-high' : e.leanSpike > 5 ? 'severity-med' : 'severity-low';
        var richCls = e.richOvershoot > 10 ? 'severity-high' : e.richOvershoot > 5 ? 'severity-med' : 'severity-low';
        var recCls = e.recoveryTime > 800 ? 'severity-high' : e.recoveryTime > 500 ? 'severity-med' : 'severity-low';
        html += '<tr><td>' + e.time.toFixed(2) + 's</td><td>' + e.rpm + '</td><td>' + e.mapFrom + '→' + e.mapTo + ' kPa</td><td>' + e.mapRate + ' kPa/s</td><td class="' + leanCls + '">' + e.leanSpike.toFixed(1) + '%</td><td class="' + richCls + '">' + e.richOvershoot.toFixed(1) + '%</td><td class="' + recCls + '">' + e.recoveryTime + 'ms</td></tr>';
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
        var richCls = e.richOvershoot > 10 ? 'severity-high' : e.richOvershoot > 5 ? 'severity-med' : 'severity-low';
        var recCls = e.recoveryTime > 800 ? 'severity-high' : e.recoveryTime > 500 ? 'severity-med' : 'severity-low';
        html += '<tr><td>' + e.time.toFixed(2) + 's</td><td>' + e.rpm + '</td><td>' + e.mapFrom + '→' + e.mapTo + ' kPa</td><td>' + e.mapRate + ' kPa/s</td><td class="' + richCls + '">' + e.richOvershoot.toFixed(1) + '%</td><td class="' + recCls + '">' + e.recoveryTime + 'ms</td></tr>';
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
    var leanSpikesPerBin = []; // store lean spikes per breakpoint for analysis
    for (var i = 0; i < corrections.length; i++) { corrections[i] = 0; eventCounts[i] = 0; leanSpikesPerBin.push([]); }

    for (var e = 0; e < tipIns.length; e++) {
        var evt = tipIns[e];
        if (evt.leanSpike <= 2) continue;

        var bestIdx = 0;
        var bestDist = Math.abs(evt.mapTo - ffTable.breakpoints[0]);
        for (var b = 1; b < ffTable.breakpoints.length; b++) {
            var dist = Math.abs(evt.mapTo - ffTable.breakpoints[b]);
            if (dist < bestDist) { bestDist = dist; bestIdx = b; }
        }

        var currentEffective = ffTable.values[bestIdx] * scale + offset;
        var correctionPct = Math.min(evt.leanSpike / 100, 0.25);
        var additionalNeeded = currentEffective * correctionPct;

        if (currentEffective < 5) {
            additionalNeeded = Math.min(evt.leanSpike * 0.5, 15);
        }

        corrections[bestIdx] += additionalNeeded;
        eventCounts[bestIdx]++;
        leanSpikesPerBin[bestIdx].push(evt.leanSpike);
    }

    // Average corrections and apply with damping
    for (var i = 0; i < corrected.length; i++) {
        if (eventCounts[i] > 0) {
            var avgCorrection = corrections[i] / eventCounts[i];
            corrected[i] = ffTable.values[i] + avgCorrection * 0.75;
            if (corrected[i] < 0) corrected[i] = 0;
            var maxIncrease = ffTable.values[i] * 0.5;
            if (maxIncrease > 0 && (corrected[i] - ffTable.values[i]) > maxIncrease) {
                corrected[i] = ffTable.values[i] + maxIncrease;
            }
            corrected[i] = Math.round(corrected[i] * 10) / 10;
        }
    }

    // --- Scale vs Offset vs Cell analysis ---
    // Determine whether the error pattern suggests changing scale, offset, or individual cells
    var scaleOffsetAdvice = analyzeScaleVsOffset(ffTable, leanSpikesPerBin, eventCounts, scale, offset);

    return {
        breakpoints: ffTable.breakpoints,
        original: ffTable.values,
        corrected: corrected,
        corrections: corrections.map(function(c, i) { return eventCounts[i] > 0 ? Math.round(c / eventCounts[i] * 10) / 10 : 0; }),
        eventCounts: eventCounts,
        scaleOffsetAdvice: scaleOffsetAdvice,
    };
}

/**
 * Analyzes whether lean spikes correlate with table values (scale issue),
 * are constant across zones (offset issue), or are localized (cell issue).
 */
function analyzeScaleVsOffset(ffTable, leanSpikesPerBin, eventCounts, scale, offset) {
    // Get average lean spike per bin (only bins with data)
    var binsWithData = [];
    for (var i = 0; i < ffTable.breakpoints.length; i++) {
        if (eventCounts[i] > 2 && leanSpikesPerBin[i].length > 0) {
            var avgSpike = leanSpikesPerBin[i].reduce(function(a, b) { return a + b; }, 0) / leanSpikesPerBin[i].length;
            var effectiveValue = ffTable.values[i] * scale + offset;
            binsWithData.push({ idx: i, map: ffTable.breakpoints[i], avgSpike: avgSpike, value: effectiveValue });
        }
    }

    if (binsWithData.length < 2) {
        return { type: 'cells', message: 'Not enough data across multiple MAP zones to determine scale vs offset. Adjust individual cells based on the corrected table above.' };
    }

    // Check if lean spikes are proportional to table values (= scale issue)
    // Compute correlation between effective_value and lean_spike
    var n = binsWithData.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (var i = 0; i < n; i++) {
        var x = binsWithData[i].value;
        var y = binsWithData[i].avgSpike;
        sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x; sumY2 += y * y;
    }
    var correlation = (n * sumXY - sumX * sumY) / (Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)) || 1);

    // Check if lean spikes are roughly constant (= offset issue)
    var avgSpike = sumY / n;
    var spikeVariance = 0;
    for (var i = 0; i < n; i++) {
        var diff = binsWithData[i].avgSpike - avgSpike;
        spikeVariance += diff * diff;
    }
    var spikeStdDev = Math.sqrt(spikeVariance / n);
    var coeffOfVariation = avgSpike > 0 ? spikeStdDev / avgSpike : 999;

    // Decision logic
    if (correlation > 0.7 && n >= 3) {
        // Lean spikes correlate with table values → scale issue
        // Compute suggested scale: avgSpike% tells us how much more compensation is needed
        var avgPctError = avgSpike / 100; // e.g., 10% → 0.10
        var suggestedScale = Math.round((scale * (1 + avgPctError)) * 100);
        return {
            type: 'scale',
            message: 'Lean spikes are proportional to current table values (correlation ' + correlation.toFixed(2) + '). This suggests the table shape is correct but the overall magnitude is too low. Consider increasing the Fuel Film Scale from ' + Math.round(scale * 100) + '% to approximately ' + suggestedScale + '% — this adjusts all cells proportionally without changing the table shape.',
            suggestedScale: suggestedScale
        };
    } else if (coeffOfVariation < 0.4 && n >= 3) {
        // Lean spikes are roughly constant across zones → offset issue
        // Compute suggested offset increase
        // Average lean spike of X% on an average effective value means we need ~X% more volume
        var avgEffective = sumX / n;
        var additionalOffset = Math.round(avgEffective * (avgSpike / 100));
        var suggestedOffset = offset + additionalOffset;
        return {
            type: 'offset',
            message: 'Lean spikes are roughly constant across MAP zones (avg ' + avgSpike.toFixed(1) + '% ± ' + spikeStdDev.toFixed(1) + '%). This suggests a flat fuel deficit regardless of load — consistent with an offset issue. Consider increasing the Fuel Film Offset from ' + offset + ' ul to approximately ' + suggestedOffset + ' ul. This adds a fixed amount of compensation at every MAP point without changing the table values.',
            suggestedOffset: suggestedOffset
        };
    } else {
        // Localized — different zones have different issues
        var worstZone = binsWithData.sort(function(a, b) { return b.avgSpike - a.avgSpike; })[0];
        return {
            type: 'cells',
            message: 'Lean spikes vary by MAP zone (not proportional, not constant). The errors are localized to specific operating regions. Adjust individual table cells using the corrected values above. The worst zone is around ' + worstZone.map + ' kPa with ' + worstZone.avgSpike.toFixed(1) + '% avg lean spike.'
        };
    }
}

function renderCorrectedTable(ffTable, corrected) {
    var section = document.getElementById('corrected-table-section');
    section.hidden = false;
    var container = document.getElementById('corrected-table-content');

    var html = '';

    // Scale vs Offset vs Cell recommendation
    if (corrected.scaleOffsetAdvice) {
        var advice = corrected.scaleOffsetAdvice;
        var adviceClass = advice.type === 'scale' ? 'rec-warning' : advice.type === 'offset' ? 'rec-info' : 'rec-good';
        html += '<div class="rec-item ' + adviceClass + '" style="margin-bottom:16px;">';
        html += '<b>Strategy recommendation (' + advice.type.toUpperCase() + '):</b> ' + advice.message;
        html += '</div>';
    }

    html += '<table class="event-table"><thead><tr><th>MAP (kPa)</th>';
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
