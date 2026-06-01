/**
 * transient-fuel/app.js — UI controller for Transient Fuel Analyzer
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
            var settings = {
                mapRateThreshold: parseInt(document.getElementById('map-rate-threshold').value, 10) || 200,
                minMapChange: parseInt(document.getElementById('min-map-change').value, 10) || 15,
                lambdaTarget: parseFloat(document.getElementById('lambda-target').value) || 1.0,
            };

            var result = analyzeTransients(reader.result, settings);
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
    reader.readAsText(file);
});

function renderResults(result) {
    resultsSection.hidden = false;
    renderSummary(result);
    renderTipInTable(result.tipIns);
    renderTipOutTable(result.tipOuts);
    renderRecommendations(result.recommendations);
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
