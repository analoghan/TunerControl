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
    var parsed = isLd ? parseLdFile(data, null) : parseCsv(data);
    return dcAnalyze(parsed.columnNames, isLd ? parsed.data : parsed.data, {
        warn: parseFloat(document.getElementById('warn-threshold').value) || 80,
        crit: parseFloat(document.getElementById('critical-threshold').value) || 90
    });
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
    var warn = result.warn, crit = result.crit;
    function cls(v) { return v > crit ? 'severity-high' : v > warn ? 'severity-med' : 'severity-low'; }

    document.getElementById('summary-content').innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">' +
        stat('<span class="' + cls(result.sustainedPeak) + '">' + result.sustainedPeak.toFixed(1) + '%</span>', 'Peak held 0.3 s') +
        stat(result.sustainedPeakRpm === null ? '—' : Math.round(result.sustainedPeakRpm) + ' RPM', 'At RPM') +
        stat((result.runningSeconds / 60).toFixed(1) + ' min', 'Engine running') +
        stat(result.secondsAboveWarn.toFixed(1) + ' s', 'Time > ' + warn + '%') +
        stat(result.secondsAboveCrit.toFixed(1) + ' s', 'Time > ' + crit + '%') +
        stat(Math.round(result.maxRpm) + ' RPM' + (result.maxMap !== null ? ' / ' + Math.round(result.maxMap) + ' kPa' : ''), 'Highest reached') +
        (result.window ? stat(Math.round(result.window) + '°', 'Injection window (implied)') : '') +
        '</div>';

    var html = '<table class="event-table"><thead><tr><th>RPM Band</th><th>Time</th><th>95th %ile</th><th>Held 0.3 s</th><th>MAP at held peak</th><th>Highest sample</th><th>Status</th></tr></thead><tbody>';
    result.bins.forEach(function (b) {
        var c = cls(b.sustained), status = b.sustained > crit ? 'CRITICAL' : b.sustained > warn ? 'WARNING' : 'OK';
        html += '<tr><td>' + b.min + '–' + b.max + '</td><td>' + b.seconds.toFixed(1) + ' s</td><td>' + b.p95.toFixed(1) + '%</td><td class="' + c + '">' +
            b.sustained.toFixed(1) + '%</td><td>' + (b.sustainedMap === null ? '—' : Math.round(b.sustainedMap) + ' kPa') + '</td><td>' + b.peak.toFixed(1) + '%' +
            '</td><td class="' + c + '">' + status + '</td></tr>';
    });
    document.getElementById('rpm-table-content').innerHTML = html + '</tbody></table>';

    var ev = document.getElementById('events-content');
    if (!result.episodes.length) {
        ev.innerHTML = '<p style="color:#4caf50;">No stretch of 0.3 s or more above ' + warn + '%.</p>';
    } else {
        html = '<table class="event-table"><thead><tr><th>Time</th><th>Duration</th><th>Peak</th><th>RPM</th><th>MAP</th><th>Severity</th></tr></thead><tbody>';
        result.episodes.forEach(function (e) {
            var c = e.critical ? 'severity-high' : 'severity-med';
            html += '<tr><td>' + e.time.toFixed(1) + ' s</td><td>' + e.duration.toFixed(1) + ' s</td><td class="' + c + '">' + e.peak.toFixed(1) + '%</td><td>' +
                Math.round(e.rpm) + '</td><td>' + (e.map === null ? '—' : Math.round(e.map) + ' kPa') + '</td><td class="' + c + '">' + (e.critical ? 'CRITICAL' : 'WARNING') + '</td></tr>';
        });
        ev.innerHTML = html + '</tbody></table>' + (result.episodeCount > result.episodes.length ? '<p class="section-desc">Showing the ' + result.episodes.length + ' highest of ' + result.episodeCount + '.</p>' : '');
    }

    document.getElementById('recommendations-content').innerHTML = result.recommendations.map(function (r) {
        return '<div class="rec-item rec-' + r.severity + '">' + r.text + '</div>';
    }).join('');
}

function stat(value, label) {
    return '<div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;"><span style="display:block;font-size:1.1rem;font-weight:700;">' + value + '</span><span style="display:block;font-size:0.7rem;color:#888;margin-top:3px;">' + label + '</span></div>';
}
