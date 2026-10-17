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
    var parsed = isLd ? parseLdFile(data, null) : parseCsvLog(data);
    return ccAnalyze(parsed.columnNames, parsed.data, { currentGain: parseFloat(document.getElementById('current-gain').value) });
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
// Rendering
// ---------------------------------------------------------------------------

function renderResults(result) {
    resultsSection.hidden = false;
    var pct = function (v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; };
    var a = document.getElementById('analysis-content'), rec = document.getElementById('recommendation-content');
    a.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;">' +
        stat(result.steps.length, 'Aim steps found') + stat(result.usable, 'Usable (closed loop off, steady)') +
        (result.usable ? stat(pct(result.signal), 'Tracking error (median)') + stat(isNaN(result.iat) ? '—' : result.iat.toFixed(0) + ' °C', 'Inlet air temp during test') +
            stat(pct(result.baseError), 'Lambda vs aim before the steps') : '') +
        (result.currentGain !== null ? stat(result.currentGain + ' °C', 'Current gain') : '') + '</div>';

    var html = '';
    if (!result.steps.length) {
        html = '<div class="rec-item rec-info"><b>No step test in this log.</b> Fuel Mixture Aim never jumps by 0.03 or more and holds — in normal driving it ' +
            'moves gradually with load. To test the gain: turn closed loop off (or zero its trim limits), idle the warm engine, change the aim at the idle ' +
            'site from 1.00 to 0.90 and hold 5–10 s, then back to 1.00; repeat two or three times while logging lambda, Fuel Mixture Aim and the ' +
            'closed-loop trims.</div>';
    } else if (!result.usable) {
        var reasons = {};
        result.steps.forEach(function (st) { st.rejected.forEach(function (w) { var k = w.replace(/ \(.*\)/, ''); reasons[k] = (reasons[k] || 0) + 1; }); });
        html = '<div class="rec-item rec-warning"><b>None of the ' + result.steps.length + ' aim steps can be used:</b> ' + Object.keys(reasons).map(function (k) {
            return k + ' (' + reasons[k] + ')'; }).join(', ') + '. The test needs closed loop off and a steady idle, so lambda only answers the aim change.</div>';
    } else {
        var n = result.usable + ' usable step' + (result.usable === 1 ? '' : 's'), err = Math.abs(result.signal * 100).toFixed(1) + '%';
        if (result.direction === 'ok') {
            html = '<div class="rec-item rec-good"><b>The gain looks right.</b> Lambda followed the aim changes to within ' + err + ' (' + n + ').</div>';
        } else {
            var raise = result.direction === 'raise';
            html = '<div class="rec-item rec-warning"><b>' + (raise ? 'Raise' : 'Lower') + ' the charge cooling gain.</b> On a rich step lambda went ' +
                (raise ? 'less rich' : 'richer') + ' than the aim change asked for — by ' + err + ' (' + n + '). ' + (raise
                    ? 'The model under-estimates how much the fuel cools the charge, so it under-fuels.'
                    : 'The model over-estimates how much the fuel cools the charge, so it over-fuels.') +
                (result.nextGain !== undefined ? ' Try <b>' + result.nextGain + ' °C</b> (from ' + result.currentGain + ' °C)' : ' Change it about 2 °C') +
                ' and repeat the step; keep going until lambda tracks within about 0.01.</div>';
        }
        if (!result.consistent) html += '<div class="rec-item rec-info">The steps disagree (some point each way) — repeat the test with a steadier idle before changing the gain.</div>';
        if (result.usable < 2) html += '<div class="rec-item rec-info">Only one usable step: repeat it at least once to confirm.</div>';
        if (Math.abs(result.baseError) > 0.03) {
            html += '<div class="rec-item rec-info">Before the steps lambda was ' + pct(result.baseError) + ' from the aim: tune the idle VE first (the training does VE at idle before the gain); ' +
                'this result compares the change, so it still holds, but a large base error makes the test less reliable.</div>';
        }
        if (!isNaN(result.iat)) html += '<div class="rec-item rec-info">The gain table runs on inlet air temperature: this test sets the value near ' + result.iat.toFixed(0) +
            ' °C. Check again with hot air (the training checks at high inlet air temperatures too).</div>';
    }
    if (!result.trimsLogged) html += '<div class="rec-item rec-info">The closed-loop trims are not logged, so the tool cannot confirm closed loop was off.</div>';
    rec.innerHTML = html;

    var ev = document.getElementById('events-content');
    if (!result.steps.length) { ev.innerHTML = '<p style="color:#888;">No aim steps.</p>'; return; }
    html = '<table class="event-table"><thead><tr><th>Time</th><th>Aim</th><th>Lambda before → after</th><th>Tracking</th><th>RPM</th><th>IAT</th><th>Used?</th></tr></thead><tbody>';
    result.steps.forEach(function (st) {
        var used = !st.rejected.length, c = !used ? '' : Math.abs(st.gainSignal) > 0.03 ? 'severity-high' : Math.abs(st.gainSignal) > CC_OK ? 'severity-med' : 'severity-low';
        html += '<tr><td>' + st.time.toFixed(1) + ' s</td><td>' + st.from.toFixed(3) + ' → ' + st.to.toFixed(3) + '</td><td>' +
            (isNaN(st.base.lambda) ? '—' : st.base.lambda.toFixed(3)) + ' → ' + (isNaN(st.after.lambda) ? '—' : st.after.lambda.toFixed(3)) + '</td><td class="' + c + '">' +
            (used ? pct(st.tracking) : '—') + '</td><td>' + (isNaN(st.after.rpm) ? '—' : Math.round(st.after.rpm)) + '</td><td>' +
            (isNaN(st.after.iat) ? '—' : st.after.iat.toFixed(0) + ' °C') + '</td><td>' + (used ? 'Yes' : 'No — ' + st.rejected.join('; ')) + '</td></tr>';
    });
    ev.innerHTML = html + '</tbody></table>';
}

function stat(value, label) {
    return '<div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;"><span style="display:block;font-size:1.2rem;font-weight:700;color:#fff;">' + value + '</span><span style="display:block;font-size:0.7rem;color:#888;margin-top:3px;">' + label + '</span></div>';
}
