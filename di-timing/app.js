/**
 * di-timing/app.js — DI Injection Timing Calculator for MoTeC M1
 *
 * Computes Start of Injection timing based on cam profile specs.
 * For direct injection: SOI must be after exhaust valve closes
 * and before the ignition event (with safety margin).
 */

// Only calculate when button is clicked — not on page load
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
    var maxSpark = parseFloat(document.getElementById('max-spark').value) || 35;
    var startLimit = parseFloat(document.getElementById('start-limit').value) || 330;
    var startMargin = parseFloat(document.getElementById('start-margin').value) || 20;
    var primaryLimit = parseFloat(document.getElementById('primary-limit').value) || 90;

    // Compute valve events in MoTeC 720° reference
    var exhaustCenterlineBTDC = lsa + camAdvance;
    var evo720 = 360 - (exhaustCenterlineBTDC + exhaustDuration / 2);
    var evc720 = 360 - (exhaustCenterlineBTDC - exhaustDuration / 2);
    var ivo720 = 360 + (intakeCenterline - intakeDuration / 2);
    var ivc720 = 360 + (intakeCenterline + intakeDuration / 2);

    // Convert valve events to dBTDC (degrees before TDC compression = 720)
    var evc_dBTDC = 720 - evc720;
    var ivo_dBTDC = 720 - ivo720;

    // MoTeC DI timing is in dBTDC:
    // - Higher dBTDC = earlier in the cycle
    // - Start Limit (330°) = earliest SOI allowed (just after EVC)
    // - Primary Limit (90°) = latest EOI allowed (must finish by this point)
    // - Table value = the SOI the ECU will use (clamped by start limit)

    // Effective start limit with margin
    var effectiveStartLimit = startLimit - startMargin; // 310° dBTDC

    // The ideal SOI should be just after EVC
    // EVC in dBTDC = 720 - evc720
    // We want SOI slightly after EVC: SOI_dBTDC = EVC_dBTDC - small_buffer
    // (lower dBTDC = later in cycle = after EVC)
    var idealSOI_dBTDC = evc_dBTDC - 5; // 5° after EVC

    // But SOI cannot exceed the start limit
    var clampedSOI_dBTDC = Math.min(idealSOI_dBTDC, effectiveStartLimit);

    // Compression stroke starts at 180° dBTDC (= 540° in 720° scale = BDC)
    var compressionStart_dBTDC = 180;

    // Build RPM table
    var rpmPoints = [];
    for (var rpm = 0; rpm <= maxRpm; rpm += rpmStep) {
        rpmPoints.push(rpm);
    }

    // For each RPM, compute the SOI that avoids compression stroke injection
    // At higher RPM, pulse width spans more crank degrees, so SOI needs to advance (higher dBTDC)
    var soiValues = [];
    var validationResults = [];
    var suggestions = [];

    for (var i = 0; i < rpmPoints.length; i++) {
        var rpm = rpmPoints[i];

        // At low RPM, use the ideal SOI (just after EVC)
        // At high RPM, advance SOI so EOI stays before compression
        // Assume a reference pulse width that scales with RPM (rough estimate)
        var refPW_ms = 4; // typical mid-load DI pulse width
        var crankDegPerMs = rpm > 0 ? (rpm / 60) * 360 / 1000 : 0;
        var refCrankDeg = refPW_ms * crankDegPerMs;

        // SOI needed to keep EOI before compression start:
        // EOI_dBTDC = SOI_dBTDC - crankDeg (EOI is later = lower dBTDC)
        // Want EOI_dBTDC >= compressionStart_dBTDC
        // So SOI_dBTDC >= compressionStart_dBTDC + crankDeg
        var minSOI_forCompression = compressionStart_dBTDC + refCrankDeg;

        // Use the higher of: ideal SOI or the RPM-adjusted minimum
        var soiForRpm = Math.max(clampedSOI_dBTDC, minSOI_forCompression);

        // Clamp to start limit
        soiForRpm = Math.min(soiForRpm, effectiveStartLimit);

        soiValues.push(Math.round(soiForRpm));

        // Validation at various pulse widths
        var maxPW_beforeCompression = compressionStart_dBTDC < soiForRpm ?
            (soiForRpm - compressionStart_dBTDC) / crankDegPerMs : 999;
        var maxPW_beforePrimaryLimit = primaryLimit < soiForRpm ?
            (soiForRpm - primaryLimit) / crankDegPerMs : 999;

        validationResults.push({
            rpm: rpm,
            soi_dBTDC: soiForRpm,
            crankDegPerMs: crankDegPerMs,
            maxPW_noCompression: rpm > 0 ? maxPW_beforeCompression : 999,
            maxPW_withinLimit: rpm > 0 ? maxPW_beforePrimaryLimit : 999,
            eoi6ms_dBTDC: soiForRpm - (6 * crankDegPerMs),
            intoCompression: rpm > 0 && (soiForRpm - 6 * crankDegPerMs) < compressionStart_dBTDC,
            exceedsPrimaryLimit: rpm > 0 && (soiForRpm - 6 * crankDegPerMs) < primaryLimit,
        });
    }

    // Check if start limit needs adjustment based on cam
    if (evc_dBTDC > startLimit) {
        suggestions.push('Your EVC is at ' + evc_dBTDC.toFixed(0) + '° dBTDC but the Injection Start Limit is ' + startLimit + '°. The start limit is already after EVC — this is correct.');
    } else if (evc_dBTDC > effectiveStartLimit) {
        suggestions.push('⚠ Your EVC is at ' + evc_dBTDC.toFixed(0) + '° dBTDC. With the ' + startMargin + '° margin, effective start is ' + effectiveStartLimit + '° which is before EVC. Consider increasing Start Limit to ' + (evc_dBTDC + startMargin + 5) + '° to ensure injection always starts after EVC.');
    }

    // Render results
    document.getElementById('results-section').hidden = false;
    renderValveEvents(evo720, evc720, ivo720, ivc720);
    renderInjectionWindow(evc_dBTDC, startLimit, startMargin, effectiveStartLimit, primaryLimit, clampedSOI_dBTDC, compressionStart_dBTDC, maxSpark);
    renderSOITable(rpmPoints, soiValues, validationResults, startLimit, primaryLimit, compressionStart_dBTDC);
    renderDiagram(evo720, evc720, ivo720, ivc720, 720 - clampedSOI_dBTDC, 720 - primaryLimit);
    renderNotes(intakeDuration, exhaustDuration, intakeCenterline, lsa, camAdvance, overlap, clampedSOI_dBTDC, startLimit, startMargin, primaryLimit, validationResults, suggestions);
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

function renderInjectionWindow(evc_dBTDC, startLimit, startMargin, effectiveStart, primaryLimit, soiValue, compressionStart, maxSpark) {
    var html = '<div class="window-info">';
    html += '<p>EVC: <b>' + evc_dBTDC.toFixed(0) + '° dBTDC</b></p>';
    html += '<p>Injection Start Limit: <b>' + startLimit + '° dBTDC</b> (margin: ' + startMargin + '° → effective: ' + effectiveStart + '°)</p>';
    html += '<p>Primary Limit (EOI must finish by): <b>' + primaryLimit + '° dBTDC</b></p>';
    html += '<p>Compression stroke starts at: <b>' + compressionStart + '° dBTDC</b></p>';
    html += '<hr style="border-color:#333;margin:12px 0;">';
    html += '<p>Calculated SOI: <b class="safe">' + soiValue.toFixed(0) + '° dBTDC</b></p>';
    html += '<p>Available window (SOI to compression): <b>' + (soiValue - compressionStart).toFixed(0) + '°</b> of crank rotation before compression</p>';
    html += '<p>Hard EOI limit window (SOI to Primary Limit): <b>' + (soiValue - primaryLimit).toFixed(0) + '°</b></p>';

    if (soiValue > effectiveStart) {
        html += '<p class="warn">⚠ Calculated SOI (' + soiValue.toFixed(0) + '°) exceeds effective start limit (' + effectiveStart + '°). The ECU will clamp to ' + effectiveStart + '°.</p>';
    }
    html += '</div>';
    document.getElementById('injection-window').innerHTML = html;
}

function renderSOITable(rpmPoints, soiValues, validationResults, startLimit, primaryLimit, compressionStart) {
    var container = document.getElementById('soi-table');

    // Main SOI table (dBTDC values for MoTeC)
    var html = '<table class="soi-table"><thead><tr><th>RPM</th>';
    for (var i = 0; i < rpmPoints.length; i++) html += '<th>' + rpmPoints[i] + '</th>';
    html += '</tr></thead><tbody><tr><td style="font-weight:600;color:#b0b0b0;">SOI (° dBTDC)</td>';
    for (var i = 0; i < soiValues.length; i++) html += '<td>' + soiValues[i] + '</td>';
    html += '</tr></tbody></table>';

    // Max injection time vs RPM (before compression)
    html += '<h3 style="margin-top:20px;font-size:0.95rem;color:#fff;">Maximum Injection Time vs RPM</h3>';
    html += '<p style="font-size:0.8rem;color:#888;margin-bottom:8px;">Maximum pulse width before injection extends into the compression stroke (180° dBTDC). Exceeding this means fuel is injected during compression — avoid if possible.</p>';
    html += '<table class="soi-table"><thead><tr><th>RPM</th>';
    for (var i = 0; i < validationResults.length; i++) {
        if (validationResults[i].rpm === 0) continue;
        html += '<th>' + validationResults[i].rpm + '</th>';
    }
    html += '</tr></thead><tbody><tr><td style="font-weight:600;color:#b0b0b0;">Max PW (ms)</td>';
    for (var i = 0; i < validationResults.length; i++) {
        var v = validationResults[i];
        if (v.rpm === 0) continue;
        var maxPW = v.maxPW_noCompression;
        var cls = maxPW < 4 ? 'color:#f44336;font-weight:600;' : maxPW < 8 ? 'color:#ff9800;' : 'color:#4caf50;';
        html += '<td style="' + cls + '">' + (maxPW > 50 ? '>50' : maxPW.toFixed(1)) + '</td>';
    }
    html += '</tr><tr><td style="font-weight:600;color:#b0b0b0;">Max PW to Limit (ms)</td>';
    for (var i = 0; i < validationResults.length; i++) {
        var v = validationResults[i];
        if (v.rpm === 0) continue;
        var maxPW = v.maxPW_withinLimit;
        html += '<td style="color:#b0b0b0;">' + (maxPW > 50 ? '>50' : maxPW.toFixed(1)) + '</td>';
    }
    html += '</tr></tbody></table>';
    html += '<p style="font-size:0.75rem;color:#666;margin-top:4px;">Row 1: max PW before compression stroke. Row 2: max PW before Primary Limit (' + primaryLimit + '° dBTDC) truncates the pulse.</p>';

    // Validation at 6ms
    html += '<h3 style="margin-top:20px;font-size:0.95rem;color:#fff;">Injection Duration Analysis (at 6ms pulse width)</h3>';
    html += '<table class="soi-table"><thead><tr><th>RPM</th><th>Crank °</th><th>EOI (° dBTDC)</th><th>Into Compression?</th><th>Exceeds Primary Limit?</th></tr></thead><tbody>';
    for (var i = 0; i < validationResults.length; i++) {
        var v = validationResults[i];
        if (v.rpm === 0) continue;
        html += '<tr>';
        html += '<td style="color:#b0b0b0;">' + v.rpm + '</td>';
        html += '<td>' + (6 * v.crankDegPerMs).toFixed(1) + '°</td>';
        html += '<td>' + v.eoi6ms_dBTDC.toFixed(0) + '°</td>';
        html += '<td style="color:' + (v.intoCompression ? '#f44336' : '#4caf50') + ';font-weight:' + (v.intoCompression ? '600' : 'normal') + ';">' + (v.intoCompression ? 'YES — avoid' : 'No') + '</td>';
        html += '<td style="color:' + (v.exceedsPrimaryLimit ? '#f44336' : '#4caf50') + ';">' + (v.exceedsPrimaryLimit ? 'YES — pulse truncated' : 'No') + '</td>';
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

function renderNotes(intDur, exhDur, intCL, lsa, advance, overlap, soiValue, startLimit, startMargin, primaryLimit, validationResults, suggestions) {
    var notes = [];
    notes.push('<b>MoTeC Setup:</b> Set Fuel Timing Primary Edge to "Start of Injection". Enter <b>' + soiValue.toFixed(0) + '° dBTDC</b> across all RPM/MAP breakpoints as starting value.');
    notes.push('<b>Injection Start Limit:</b> Currently ' + startLimit + '° with ' + startMargin + '° margin (effective ' + (startLimit - startMargin) + '°). This prevents injection from starting before EVC.');
    notes.push('<b>Primary Limit:</b> Currently ' + primaryLimit + '° dBTDC. Injection will be truncated if EOI would exceed this point — engine will run lean.');
    notes.push('<b>⚠ Avoid compression stroke injection:</b> Injecting during compression risks spraying fuel into the flame front, causing misfires, detonation, and piston damage. The Max PW table shows the limit at each RPM.');

    for (var i = 0; i < suggestions.length; i++) {
        notes.push(suggestions[i]);
    }

    var compressionIssues = validationResults.filter(function(v) { return v.intoCompression && v.rpm > 0; });
    if (compressionIssues.length > 0) {
        notes.push('<b>Note:</b> At 6ms pulse width, injection extends into compression above ' + compressionIssues[0].rpm + ' RPM. Verify actual pulse width — if exceeded, consider split injection or higher fuel pressure.');
    }

    var truncationIssues = validationResults.filter(function(v) { return v.exceedsPrimaryLimit && v.rpm > 0; });
    if (truncationIssues.length > 0) {
        notes.push('<b>⚠ Warning:</b> At 6ms pulse width, the Primary Limit (' + primaryLimit + '°) would truncate injection above ' + truncationIssues[0].rpm + ' RPM. Engine will run lean at these points.');
    }

    notes.push('<b>Tuning tip:</b> After VE table is dialed in, try adjusting SOI ±10-20° and watch for lambda changes. Richer without VE change = more efficient injection point found.');
    notes.push('<b>Cam specs:</b> Intake ' + intDur + '°/' + exhDur + '° duration @ .050", ' + intCL + '° ICL, ' + lsa + '°+' + advance + '° LSA, ' + overlap + '° overlap.');

    var html = '<ul class="notes-list">';
    notes.forEach(function(n) { html += '<li>' + n + '</li>'; });
    html += '</ul>';
    document.getElementById('notes-content').innerHTML = html;
}

// Wait for user to click Calculate
