/**
 * di-timing/app.js — DI Injection Timing Calculator for MoTeC M1
 *
 * Computes Start of Injection timing based on cam profile specs.
 * For direct injection: SOI must be after exhaust valve closes
 * and before the ignition event (with safety margin).
 */

document.getElementById('calc-btn').addEventListener('click', calculate);

function calculate() {
    // Read inputs
    var intakeDuration = parseFloat(document.getElementById('intake-duration').value) || 229;
    var exhaustDuration = parseFloat(document.getElementById('exhaust-duration').value) || 244;
    var intakeCenterline = parseFloat(document.getElementById('intake-centerline').value) || 114;
    var lsa = parseFloat(document.getElementById('lsa').value) || 118;
    var camAdvance = parseFloat(document.getElementById('cam-advance').value) || 4;
    var overlap = parseFloat(document.getElementById('overlap').value) || 0;
    var maxRpm = parseInt(document.getElementById('max-rpm').value, 10) || 7000;
    var rpmStep = parseInt(document.getElementById('rpm-step').value, 10) || 500;
    var safetyMargin = parseFloat(document.getElementById('safety-margin').value) || 15;
    var maxSpark = parseFloat(document.getElementById('max-spark').value) || 35;

    // Compute valve events in MoTeC 720° reference
    // 0° = Power stroke TDC, 180° = BDC, 360° = TDC overlap, 540° = BDC, 720° = Compression TDC
    var exhaustCenterlineBTDC = lsa + camAdvance;
    var evo720 = 360 - (exhaustCenterlineBTDC + exhaustDuration / 2);
    var evc720 = 360 - (exhaustCenterlineBTDC - exhaustDuration / 2);
    var ivo720 = 360 + (intakeCenterline - intakeDuration / 2);
    var ivc720 = 360 + (intakeCenterline + intakeDuration / 2);

    // DI injection window
    var windowStart = Math.max(evc720, ivo720); // after EVC (and IVO if later)
    var latestIgnition = 720 - maxSpark; // latest possible ignition point
    var windowEnd = latestIgnition - safetyMargin; // must finish before ignition

    // Recommended SOI: just after EVC with small buffer
    var recommendedSOI = Math.ceil(windowStart + 5);

    // Build RPM table
    var rpmPoints = [];
    for (var rpm = 0; rpm <= maxRpm; rpm += rpmStep) {
        rpmPoints.push(rpm);
    }

    // For DI, SOI timing varies with RPM because pulse width converts to more
    // crank degrees at higher RPM. The Excel calculator shows:
    // Crank degrees = (PW_ms / 1000) * (RPM / 60) * 360
    // We need SOI early enough that EOI doesn't reach into compression/ignition zone.

    // MoTeC DI programmed value convention:
    // Programmed SOI = 360 - (SOI in degrees ATDC overlap)
    // So if SOI is 43.75° ATDC overlap, programmed value = 316.25°
    // This means higher programmed values = earlier in the cycle (more advance)

    // Optimal SOI: midpoint between EVC and a reasonable point in the intake stroke
    // The Excel shows: Optimal SOI = EVC_ATDC + (some offset based on overlap)
    var evcATDC = evc720 - 360; // EVC relative to TDC overlap (positive = ATDC)
    var ivoATDC = ivo720 - 360; // IVO relative to TDC overlap (negative = BTDC)

    // Optimal SOI is just after EVC (or TDC if EVC is before TDC)
    var optimalSOI_ATDC = Math.max(evcATDC, 0) + 5; // 5° buffer after EVC or TDC

    // Programmed value for MoTeC: 360 - ATDC angle
    var programmedSOI = 360 - optimalSOI_ATDC;

    // Build RPM table with pulse-width-dependent validation
    var rpmPoints = [];
    for (var rpm = 0; rpm <= maxRpm; rpm += rpmStep) {
        rpmPoints.push(rpm);
    }

    // For each RPM, compute how many crank degrees a typical pulse width spans
    // and verify EOI doesn't hit the ignition zone
    var soiValues = [];
    var validationResults = [];
    var typicalPW = [2, 3, 4, 5, 6, 8, 10, 12]; // ms range for reference

    for (var i = 0; i < rpmPoints.length; i++) {
        var rpm = rpmPoints[i];
        soiValues.push(Math.round(programmedSOI * 10) / 10);

        // Validate at a mid-range pulse width (6ms)
        var pwMs = 6;
        var crankDegrees = rpm > 0 ? (pwMs / 1000) * (rpm / 60) * 360 : 0;
        var eoiATDC = optimalSOI_ATDC + crankDegrees;
        var eoiBeforeIgnition = (360 - eoiATDC) > (maxSpark + safetyMargin); // degrees left before TDC compression

        validationResults.push({
            rpm: rpm,
            crankDeg: crankDegrees,
            eoiATDC: eoiATDC,
            startsAfterEVC: optimalSOI_ATDC >= evcATDC,
            startsAfterTDC: optimalSOI_ATDC >= 0,
            intoCompression: eoiATDC > 180, // past BDC = compression stroke
            clearOfIgnition: eoiBeforeIgnition
        });
    }

    // Render results
    document.getElementById('results-section').hidden = false;
    renderValveEvents(evo720, evc720, ivo720, ivc720);
    renderInjectionWindow(windowStart, windowEnd, programmedSOI, optimalSOI_ATDC, evcATDC, evc720, ivo720, latestIgnition, safetyMargin);
    renderSOITable(rpmPoints, soiValues, validationResults);
    renderDiagram(evo720, evc720, ivo720, ivc720, optimalSOI_ATDC + 360, windowEnd);
    renderNotes(intakeDuration, exhaustDuration, intakeCenterline, lsa, camAdvance, overlap, windowStart, windowEnd, programmedSOI, optimalSOI_ATDC, validationResults);
}

function renderValveEvents(evo, evc, ivo, ivc) {
    var container = document.getElementById('valve-events');
    container.innerHTML = '<div class="valve-grid">' +
        valveItem('EVO', evo, 'Exhaust Valve Open', evoBTDC(evo) + ' BBDC') +
        valveItem('EVC', evc, 'Exhaust Valve Close', evcDesc(evc)) +
        valveItem('IVO', ivo, 'Intake Valve Open', ivoDesc(ivo)) +
        valveItem('IVC', ivc, 'Intake Valve Close', (ivc - 540).toFixed(1) + '° ABDC') +
        '</div>';
}

function valveItem(label, value, desc, detail) {
    return '<div class="valve-item"><div class="label">' + desc + '</div><div class="value">' + value.toFixed(1) + '°</div><div class="detail">' + detail + '</div></div>';
}

function evoBTDC(evo) { return (180 - evo).toFixed(1) + '°'; }
function evcDesc(evc) {
    if (evc <= 360) return (360 - evc).toFixed(1) + '° BTDC overlap';
    return (evc - 360).toFixed(1) + '° ATDC overlap';
}
function ivoDesc(ivo) {
    if (ivo >= 360) return (ivo - 360).toFixed(1) + '° ATDC overlap';
    return (360 - ivo).toFixed(1) + '° BTDC overlap';
}

function renderInjectionWindow(windowStart, windowEnd, programmedSOI, optimalATDC, evcATDC, evc, ivo, latestIgnition, margin) {
    var windowSize = windowEnd - windowStart;
    var html = '<div class="window-info">';
    html += '<p>Exhaust valve closes at: <b>' + evc.toFixed(1) + '°</b> (' + evcATDC.toFixed(1) + '° ATDC overlap)</p>';
    html += '<p>Intake valve opens at: <b>' + ivo.toFixed(1) + '°</b></p>';
    html += '<p>Latest ignition event: <b>' + latestIgnition.toFixed(0) + '°</b> (' + (720 - latestIgnition).toFixed(0) + '° BTDC compression)</p>';
    html += '<p>Safety margin: <b>' + margin + '°</b> before ignition</p>';
    html += '<hr style="border-color:#333;margin:12px 0;">';
    html += '<p>Optimal SOI: <b class="safe">' + optimalATDC.toFixed(1) + '° ATDC</b> (intake stroke)</p>';
    html += '<p>MoTeC Programmed Value: <b class="safe">' + programmedSOI.toFixed(1) + '°</b> (enter this in Fuel Timing Primary Main)</p>';
    html += '<p>Available window: <b>' + windowSize.toFixed(0) + '°</b> of crank rotation</p>';

    if (windowSize < 100) {
        html += '<p class="warn">⚠ Narrow injection window (' + windowSize.toFixed(0) + '°). Consider split injection at high RPM/load.</p>';
    }
    if (windowSize > 250) {
        html += '<p class="safe">✓ Wide injection window — single-shot injection viable across all RPM.</p>';
    }
    html += '</div>';
    document.getElementById('injection-window').innerHTML = html;
}

function renderSOITable(rpmPoints, soiValues, validationResults) {
    var container = document.getElementById('soi-table');

    // Main SOI table
    var html = '<table class="soi-table"><thead><tr><th>RPM</th>';
    for (var i = 0; i < rpmPoints.length; i++) html += '<th>' + rpmPoints[i] + '</th>';
    html += '</tr></thead><tbody><tr><td style="font-weight:600;color:#b0b0b0;">SOI (°)</td>';
    for (var i = 0; i < soiValues.length; i++) html += '<td>' + soiValues[i] + '</td>';
    html += '</tr></tbody></table>';

    // Validation table (pulse width analysis at 6ms)
    html += '<h3 style="margin-top:16px;font-size:0.9rem;color:#b0b0b0;">Injection Duration Analysis (at 6ms pulse width)</h3>';
    html += '<table class="soi-table"><thead><tr><th>RPM</th><th>Crank °</th><th>EOI (°ATDC)</th><th>After EVC?</th><th>Into Compression?</th><th>Clear of Ignition?</th></tr></thead><tbody>';
    for (var i = 0; i < validationResults.length; i++) {
        var v = validationResults[i];
        if (v.rpm === 0) continue;
        html += '<tr>';
        html += '<td style="color:#b0b0b0;">' + v.rpm + '</td>';
        html += '<td>' + v.crankDeg.toFixed(1) + '°</td>';
        html += '<td>' + v.eoiATDC.toFixed(1) + '°</td>';
        html += '<td style="color:' + (v.startsAfterEVC ? '#4caf50' : '#f44336') + ';">' + (v.startsAfterEVC ? 'Yes' : 'No') + '</td>';
        html += '<td style="color:' + (v.intoCompression ? '#ff9800' : '#4caf50') + ';">' + (v.intoCompression ? 'Yes' : 'No') + '</td>';
        html += '<td style="color:' + (v.clearOfIgnition ? '#4caf50' : '#f44336') + ';">' + (v.clearOfIgnition ? 'Yes' : 'No') + '</td>';
        html += '</tr>';
    }
    html += '</tbody></table>';

    container.innerHTML = html;

    // Copy button
    document.getElementById('copy-btn').onclick = function() {
        var csv = rpmPoints.join('\t') + '\n' + soiValues.join('\t');
        navigator.clipboard.writeText(csv).catch(function() {});
        this.textContent = 'Copied!';
        var btn = this;
        setTimeout(function() { btn.textContent = 'Copy Table to Clipboard'; }, 1500);
    };
}

function renderDiagram(evo, evc, ivo, ivc, soi, windowEnd) {
    var container = document.getElementById('valve-diagram');
    container.innerHTML = '<canvas id="timing-canvas" width="800" height="200"></canvas>';
    var canvas = document.getElementById('timing-canvas');
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var margin = 50;
    var barY = 80;
    var barH = 30;

    // Scale: 0-720° maps to margin...(w-margin)
    function xPos(deg) { return margin + (deg / 720) * (w - 2 * margin); }

    // Background
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);

    // Stroke labels
    ctx.fillStyle = '#555';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    var strokes = [
        { start: 0, end: 180, label: 'Power' },
        { start: 180, end: 360, label: 'Exhaust' },
        { start: 360, end: 540, label: 'Intake' },
        { start: 540, end: 720, label: 'Compression' }
    ];
    strokes.forEach(function(s) {
        var x1 = xPos(s.start), x2 = xPos(s.end);
        ctx.fillStyle = '#222';
        ctx.fillRect(x1, 20, x2 - x1, h - 40);
        ctx.strokeStyle = '#333';
        ctx.strokeRect(x1, 20, x2 - x1, h - 40);
        ctx.fillStyle = '#666';
        ctx.fillText(s.label, (x1 + x2) / 2, 16);
    });

    // TDC/BDC markers
    ctx.fillStyle = '#444';
    ctx.font = '9px sans-serif';
    [0, 180, 360, 540, 720].forEach(function(deg) {
        ctx.fillText(deg + '°', xPos(deg), h - 5);
    });

    // Exhaust valve open (red bar)
    ctx.fillStyle = 'rgba(244, 67, 54, 0.4)';
    ctx.fillRect(xPos(evo), barY - 35, xPos(evc) - xPos(evo), 25);
    ctx.fillStyle = '#f44336';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Exhaust Valve Open', (xPos(evo) + xPos(evc)) / 2, barY - 40);

    // Intake valve open (blue bar)
    ctx.fillStyle = 'rgba(33, 150, 243, 0.4)';
    ctx.fillRect(xPos(ivo), barY + 5, xPos(ivc) - xPos(ivo), 25);
    ctx.fillStyle = '#2196f3';
    ctx.fillText('Intake Valve Open', (xPos(ivo) + xPos(ivc)) / 2, barY + 45);

    // DI injection window (green bar)
    ctx.fillStyle = 'rgba(76, 175, 80, 0.5)';
    ctx.fillRect(xPos(soi), barY + 40, xPos(windowEnd) - xPos(soi), 20);
    ctx.fillStyle = '#4caf50';
    ctx.font = '10px bold sans-serif';
    ctx.fillText('DI Injection Window', (xPos(soi) + xPos(windowEnd)) / 2, barY + 75);

    // SOI marker
    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xPos(soi), barY - 35);
    ctx.lineTo(xPos(soi), barY + 60);
    ctx.stroke();
    ctx.fillStyle = '#4caf50';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SOI ' + soi + '°', xPos(soi) + 3, barY + 68);

    // Ignition marker
    ctx.strokeStyle = '#ff9800';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xPos(windowEnd), barY - 35);
    ctx.lineTo(xPos(windowEnd), barY + 60);
    ctx.stroke();
    ctx.fillStyle = '#ff9800';
    ctx.textAlign = 'right';
    ctx.fillText('Latest EOI ' + windowEnd + '°', xPos(windowEnd) - 3, barY + 68);
}

function renderNotes(intDur, exhDur, intCL, lsa, advance, overlap, winStart, winEnd, programmedSOI, optimalATDC, validationResults) {
    var notes = [];
    notes.push('<b>MoTeC Setup:</b> Set Fuel Timing Primary Edge to "Start of Injection". Enter <b>' + programmedSOI.toFixed(1) + '°</b> across all RPM breakpoints as starting value.');
    notes.push('<b>Reference convention:</b> MoTeC DI programmed value = 360 - (SOI degrees ATDC overlap). Higher values = earlier injection (more advance into exhaust stroke).');
    notes.push('<b>Optimal SOI:</b> ' + optimalATDC.toFixed(1) + '° ATDC overlap — just after exhaust valve closes, fuel enters as intake valve opens.');

    // Check if any RPM points have issues
    var compressionIssues = validationResults.filter(function(v) { return v.intoCompression && v.rpm > 0; });
    if (compressionIssues.length > 0) {
        notes.push('<b>Note:</b> At 6ms pulse width, injection extends into the compression stroke above ' + compressionIssues[0].rpm + ' RPM. This is normal for DI — fuel can be injected up to ~10-15° before ignition.');
    }

    var clearanceIssues = validationResults.filter(function(v) { return !v.clearOfIgnition && v.rpm > 0; });
    if (clearanceIssues.length > 0) {
        notes.push('<b>⚠ Warning:</b> At 6ms pulse width, EOI approaches the ignition zone above ' + clearanceIssues[0].rpm + ' RPM. Consider split injection or verify actual pulse width at these RPMs.');
    }

    notes.push('<b>Tuning tip:</b> After VE table is dialed in, try adjusting SOI ±10-20° and watch for lambda changes. Richer without VE change = more efficient injection point found.');
    notes.push('<b>Split injection:</b> For high-load conditions, some DI systems split into two events (intake + compression). The primary SOI covers the main intake-stroke event.');
    notes.push('<b>Cam specs:</b> Intake ' + intDur + '°/' + exhDur + '° duration @ .050", ' + intCL + '° ICL, ' + lsa + '°+' + advance + '° LSA, ' + overlap + '° overlap.');

    var html = '<ul class="notes-list">';
    notes.forEach(function(n) { html += '<li>' + n + '</li>'; });
    html += '</ul>';
    document.getElementById('notes-content').innerHTML = html;
}

// Auto-calculate on page load with defaults
document.addEventListener('DOMContentLoaded', calculate);
