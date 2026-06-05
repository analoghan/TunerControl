/**
 * duty-cycle/app.js — Injector Duty Cycle Monitor
 */

var logInput = document.getElementById('log-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorContainer = document.getElementById('error-container');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');

logInput.addEventListener('change', function() {
    document.getElementById('log-filename').textContent = logInput.files[0] ? logInput.files[0].name : 'No file selected';
    analyzeBtn.disabled = !logInput.files[0];
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
            var result = analyzeDutyCycle(reader.result, file.name.toLowerCase().endsWith('.ld'));
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
    if (file.name.toLowerCase().endsWith('.ld')) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
});

function analyzeDutyCycle(data, isLd) {
    var warnThreshold = parseFloat(document.getElementById('warn-threshold').value) || 80;
    var critThreshold = parseFloat(document.getElementById('critical-threshold').value) || 90;

    var columnNames, rows;
    if (isLd) {
        var parsed = parseLdFile(data, null);
        columnNames = parsed.columnNames;
        rows = parsed.data;
    } else {
        var p = parseCsv(data);
        columnNames = p.columnNames;
        rows = p.data;
    }

    var colLower = columnNames.map(function(n) { return n.toLowerCase().trim(); });
    var timeIdx = colLower.indexOf('time');
    var rpmIdx = findIdx(colLower, ['engine speed']);
    var dcPriIdx = findIdx(colLower, ['fuel injector primary duty cycle']);
    var dcSecIdx = findIdx(colLower, ['fuel injector secondary duty cycle']);
    var mapIdx = findIdx(colLower, ['inlet manifold pressure']);
    var tpsIdx = findIdx(colLower, ['throttle position']);

    if (rpmIdx === -1) throw new Error('Engine Speed channel not found.');
    if (dcPriIdx === -1 && dcSecIdx === -1) throw new Error('No injector duty cycle channel found. Need "Fuel Injector Primary Duty Cycle" or "Fuel Injector Secondary Duty Cycle".');

    var dcIdx = dcPriIdx >= 0 ? dcPriIdx : dcSecIdx;
    var hasSecondary = dcSecIdx >= 0 && dcPriIdx >= 0;

    // Analyze by RPM bins (500 RPM wide)
    var rpmBins = [];
    for (var b = 0; b < 16; b++) {
        rpmBins.push({ min: b * 500, max: (b + 1) * 500, peakDC: 0, avgDC: 0, sumDC: 0, count: 0, peakTime: 0, peakMAP: 0 });
    }

    var events = [];
    var peakOverall = 0;
    var peakRpm = 0;
    var totalSamples = 0;
    var samplesAboveWarn = 0;
    var samplesAboveCrit = 0;

    for (var i = 0; i < rows.length; i++) {
        var rpm = rows[i][rpmIdx];
        var dc = rows[i][dcIdx];
        if (isNaN(rpm) || isNaN(dc) || rpm < 300) continue;

        totalSamples++;
        var binIdx = Math.min(Math.floor(rpm / 500), 15);
        rpmBins[binIdx].sumDC += dc;
        rpmBins[binIdx].count++;
        if (dc > rpmBins[binIdx].peakDC) {
            rpmBins[binIdx].peakDC = dc;
            rpmBins[binIdx].peakTime = timeIdx >= 0 ? rows[i][timeIdx] : i;
            rpmBins[binIdx].peakMAP = mapIdx >= 0 ? rows[i][mapIdx] : 0;
        }

        if (dc > peakOverall) { peakOverall = dc; peakRpm = rpm; }
        if (dc > warnThreshold) samplesAboveWarn++;
        if (dc > critThreshold) samplesAboveCrit++;

        // Log events above warning threshold
        if (dc > warnThreshold && (events.length === 0 || rows[i][timeIdx] - events[events.length - 1].time > 0.5)) {
            events.push({
                time: timeIdx >= 0 ? rows[i][timeIdx] : i,
                rpm: Math.round(rpm),
                dc: Math.round(dc * 10) / 10,
                map: mapIdx >= 0 ? Math.round(rows[i][mapIdx]) : 0,
                isCritical: dc > critThreshold,
            });
        }
    }

    // Compute averages
    for (var b = 0; b < rpmBins.length; b++) {
        if (rpmBins[b].count > 0) rpmBins[b].avgDC = rpmBins[b].sumDC / rpmBins[b].count;
    }

    // Compute DI timing headroom: at peak duty cycle, how much of the injection window is used?
    // Crank degrees of injection = DC% * 720° (for 4-stroke)
    // Available window for DI (exhaust close to compression) ≈ 300-350° typically
    var peakCrankDeg = peakOverall / 100 * 720;
    var diWindowUsed = peakCrankDeg / 330 * 100; // assume 330° window

    // Recommendations
    var recs = [];
    if (peakOverall > critThreshold) {
        recs.push({ severity: 'critical', text: 'Peak duty cycle of ' + peakOverall.toFixed(1) + '% at ' + Math.round(peakRpm) + ' RPM exceeds the critical threshold (' + critThreshold + '%). The injector is at or beyond capacity. Risk of fuel starvation under sustained load. Consider: (1) larger injectors, (2) higher fuel pressure to reduce pulse width, (3) supplemental port injection if on DI-only.' });
    } else if (peakOverall > warnThreshold) {
        recs.push({ severity: 'warning', text: 'Peak duty cycle of ' + peakOverall.toFixed(1) + '% at ' + Math.round(peakRpm) + ' RPM is approaching the limit (' + warnThreshold + '% warning threshold). Headroom is limited — adding boost, advancing timing, or increasing RPM could push beyond injector capacity.' });
    } else {
        recs.push({ severity: 'good', text: 'Peak duty cycle of ' + peakOverall.toFixed(1) + '% is well within limits. Injector headroom is adequate for the current tune.' });
    }

    if (diWindowUsed > 85) {
        recs.push({ severity: 'warning', text: 'DI timing window usage: ' + diWindowUsed.toFixed(0) + '% of available crank angle window at peak. The injection event is consuming most of the available DI window (EVC to compression). At higher RPM or load, the ECU may need to truncate the injection or inject into compression.' });
    }

    if (hasSecondary) {
        recs.push({ severity: 'info', text: 'Secondary injector duty cycle channel detected. This analysis covers the primary injectors. Run a separate analysis selecting the secondary channel if staged injection is active.' });
    }

    return {
        totalSamples: totalSamples,
        peakDC: peakOverall,
        peakRpm: peakRpm,
        samplesAboveWarn: samplesAboveWarn,
        samplesAboveCrit: samplesAboveCrit,
        warnPct: totalSamples > 0 ? (samplesAboveWarn / totalSamples * 100) : 0,
        critPct: totalSamples > 0 ? (samplesAboveCrit / totalSamples * 100) : 0,
        diWindowUsed: diWindowUsed,
        rpmBins: rpmBins,
        events: events.sort(function(a, b) { return b.dc - a.dc; }).slice(0, 30),
        recommendations: recs,
    };
}

function findIdx(arr, candidates) {
    for (var c = 0; c < candidates.length; c++) { var i = arr.indexOf(candidates[c]); if (i >= 0) return i; }
    return -1;
}

function parseCsv(text) {
    text = text.replace(/\0/g, '').replace(/^\uFEFF/, '');
    var lines = text.split(/\r?\n/);
    var headerIdx = -1;
    for (var i = 0; i < Math.min(50, lines.length); i++) {
        if (lines[i].split(',')[0].trim().replace(/^"|"$/g, '') === 'Time') { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Could not find Time header.');
    var columnNames = lines[headerIdx].split(',').map(function(s) { return s.trim().replace(/^"|"$/g, ''); });
    var data = [];
    for (var i = headerIdx + 2; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        data.push(line.split(',').map(function(f) { return parseFloat(f.trim().replace(/^"|"$/g, '')); }));
    }
    return { columnNames: columnNames, data: data };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResults(result) {
    resultsSection.hidden = false;
    var warnThreshold = parseFloat(document.getElementById('warn-threshold').value) || 80;
    var critThreshold = parseFloat(document.getElementById('critical-threshold').value) || 90;

    // Summary
    var s = document.getElementById('summary-content');
    var peakCls = result.peakDC > critThreshold ? 'severity-high' : result.peakDC > warnThreshold ? 'severity-med' : 'severity-low';
    s.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">' +
        stat(result.totalSamples.toLocaleString(), 'Total Samples') +
        stat('<span class="' + peakCls + '">' + result.peakDC.toFixed(1) + '%</span>', 'Peak Duty Cycle') +
        stat(Math.round(result.peakRpm) + ' RPM', 'At RPM') +
        stat(result.samplesAboveWarn.toLocaleString(), 'Samples > ' + warnThreshold + '%') +
        stat(result.samplesAboveCrit.toLocaleString(), 'Samples > ' + critThreshold + '%') +
        stat(result.diWindowUsed.toFixed(0) + '%', 'DI Window Used (peak)') +
        '</div>';

    // RPM table
    var rt = document.getElementById('rpm-table-content');
    var html = '<table class="event-table"><thead><tr><th>RPM Band</th><th>Peak DC</th><th>Avg DC</th><th>Samples</th><th>Peak MAP</th><th>Status</th></tr></thead><tbody>';
    for (var b = 0; b < result.rpmBins.length; b++) {
        var bin = result.rpmBins[b];
        if (bin.count === 0) continue;
        var cls = bin.peakDC > critThreshold ? 'severity-high' : bin.peakDC > warnThreshold ? 'severity-med' : 'severity-low';
        var status = bin.peakDC > critThreshold ? 'CRITICAL' : bin.peakDC > warnThreshold ? 'WARNING' : 'OK';
        html += '<tr><td>' + bin.min + '–' + bin.max + '</td><td class="' + cls + '">' + bin.peakDC.toFixed(1) + '%</td><td>' + bin.avgDC.toFixed(1) + '%</td><td>' + bin.count + '</td><td>' + Math.round(bin.peakMAP) + ' kPa</td><td class="' + cls + '">' + status + '</td></tr>';
    }
    html += '</tbody></table>';
    rt.innerHTML = html;

    // Events
    var ev = document.getElementById('events-content');
    if (result.events.length === 0) {
        ev.innerHTML = '<p style="color:#4caf50;">No events exceeded the warning threshold. Injector headroom is adequate.</p>';
    } else {
        html = '<table class="event-table"><thead><tr><th>Time</th><th>RPM</th><th>Duty Cycle</th><th>MAP</th><th>Severity</th></tr></thead><tbody>';
        for (var i = 0; i < result.events.length; i++) {
            var e = result.events[i];
            var cls = e.isCritical ? 'severity-high' : 'severity-med';
            html += '<tr><td>' + e.time.toFixed(1) + 's</td><td>' + e.rpm + '</td><td class="' + cls + '">' + e.dc + '%</td><td>' + e.map + ' kPa</td><td class="' + cls + '">' + (e.isCritical ? 'CRITICAL' : 'WARNING') + '</td></tr>';
        }
        html += '</tbody></table>';
        ev.innerHTML = html;
    }

    // Recommendations
    var rc = document.getElementById('recommendations-content');
    rc.innerHTML = result.recommendations.map(function(r) {
        return '<div class="rec-item rec-' + r.severity + '">' + r.text + '</div>';
    }).join('');
}

function stat(value, label) {
    return '<div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;"><span style="display:block;font-size:1.1rem;font-weight:700;">' + value + '</span><span style="display:block;font-size:0.7rem;color:#888;margin-top:3px;">' + label + '</span></div>';
}
