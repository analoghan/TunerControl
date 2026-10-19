/**
 * worker-diagnostics.js — Cross-Tool Diagnostics Worker.
 * Parses a MoTeC log and performs unified analysis across fueling, knock,
 * fuel pressure, and idle domains to identify correlated root causes.
 *
 * app.js creates the worker from a Blob that importScripts injector/worker.js first (for its lean-episode analysis,
 * analyzeLeanSpikes) and this file last, so this file's message handler wins.
 */

// ---------------------------------------------------------------------------
// Channel Resolution
// ---------------------------------------------------------------------------

const DIAG_CHANNEL_MAP = {
    rpm:              ['Engine Speed'],
    map:              ['Inlet Manifold Pressure'],
    lambda_b1:        ['Exhaust Lambda Bank 1'],
    lambda_b2:        ['Exhaust Lambda Bank 2'],
    lambda_avg:       ['Exhaust Lambda'],
    lambda_target:    ['Fuel Mixture Aim'],
    cl_trim_b1:       ['Fuel Closed Loop Control Bank 1 Trim'],
    cl_trim_b2:       ['Fuel Closed Loop Control Bank 2 Trim'],
    inj_pw:           ['Fuel Cylinder 1 Primary Output Pulse Width 1'],
    fuel_press:       ['Fuel Pressure Direct Bank 1'],
    fuel_press_aim:   ['Fuel Pressure Direct Bank 1 Aim'],
    tps:              ['Throttle Position', 'Throttle Pedal'],
    coolant_temp:     ['Coolant Temperature'],
    knock_cyl_1:      ['Ignition Cylinder 1 Knock Level'],
    knock_cyl_2:      ['Ignition Cylinder 2 Knock Level'],
    knock_cyl_3:      ['Ignition Cylinder 3 Knock Level'],
    knock_cyl_4:      ['Ignition Cylinder 4 Knock Level'],
    knock_cyl_5:      ['Ignition Cylinder 5 Knock Level'],
    knock_cyl_6:      ['Ignition Cylinder 6 Knock Level'],
    knock_cyl_7:      ['Ignition Cylinder 7 Knock Level'],
    knock_cyl_8:      ['Ignition Cylinder 8 Knock Level'],
    ign_timing:       ['Ignition Timing'],
};

function resolveChannels(columnNames) {
    var nameToIdx = {};
    for (var i = 0; i < columnNames.length; i++) {
        var n = columnNames[i].trim().toLowerCase();
        if (!(n in nameToIdx)) nameToIdx[n] = i;
    }
    var resolved = {};
    var keys = Object.keys(DIAG_CHANNEL_MAP);
    for (var k = 0; k < keys.length; k++) {
        var candidates = DIAG_CHANNEL_MAP[keys[k]];
        resolved[keys[k]] = -1;
        for (var c = 0; c < candidates.length; c++) {
            var idx = nameToIdx[candidates[c].toLowerCase()];
            if (idx !== undefined) { resolved[keys[k]] = idx; break; }
        }
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// CSV / LD Parsing (simplified — reuses patterns from other workers)
// ---------------------------------------------------------------------------

function splitCsvLine(line) {
    return line.split(',').map(function(f) {
        var t = f.trim();
        if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
        return t;
    });
}

function parseLogCsv(text, onProgress) {
    var lines = text.split('\n').map(function(l) { return l.replace(/\r$/, ''); });
    var headerIdx = -1;
    for (var i = 0; i < Math.min(25, lines.length); i++) {
        var f = splitCsvLine(lines[i]);
        if (f[0] && f[0].trim() === 'Time') { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Time header not found in first 25 rows');

    var columnNames = splitCsvLine(lines[headerIdx]);
    var dataStart = headerIdx + 2;
    while (dataStart < lines.length) {
        var ff = splitCsvLine(lines[dataStart]);
        if (ff[0] && ff[0].trim() !== '' && !isNaN(parseFloat(ff[0]))) break;
        dataStart++;
    }

    var numCols = columnNames.length;
    var data = [];
    for (var i = dataStart; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;
        var fields = splitCsvLine(line);
        var row = new Array(numCols);
        for (var c = 0; c < numCols; c++) {
            row[c] = c < fields.length ? parseFloat(fields[c]) : NaN;
        }
        data.push(row);
        if (data.length % 10000 === 0 && onProgress) {
            onProgress(i - dataStart, lines.length - dataStart);
        }
    }
    return { columnNames: columnNames, data: data };
}

// ---------------------------------------------------------------------------
// Cross-Domain Analysis
// ---------------------------------------------------------------------------

function runCrossDiagnostics(columnNames, data, tune) {
    var ch = resolveChannels(columnNames);
    var n = data.length;
    var findings = [];
    var summary = {};

    // Determine sample rate
    var sampleRate = 100;
    if (n > 1) {
        var dt = data[1][0] - data[0][0];
        if (dt > 0 && dt < 1) sampleRate = 1 / dt;
    }

    // --- Fueling Analysis ---
    var clTrimB1Sum = 0, clTrimB1Count = 0;
    var clTrimB2Sum = 0, clTrimB2Count = 0;
    var lowPWCount = 0;
    var knockEvents = 0;
    var knockWithLean = 0;
    var pressureBelowAimCount = 0;
    var pressureSamples = 0;

    var lambdaIdx = ch.lambda_b1 !== -1 ? ch.lambda_b1 : (ch.lambda_avg !== -1 ? ch.lambda_avg : -1);
    // Below about 1 ms a DI injector is non-linear (see injector/worker.js THRESHOLDS.SHORT_PW_MS).
    var SHORT_PW_MS = 1.0, firingCount = 0;
    // Rail pressure is logged in MPa ("dMPa" = differential MPa); 1 MPa = 10 bar. "Below aim" means more than 2 bar under.
    var MPA_TO_BAR = 10, PRESS_TOL_BAR = 2;
    // A typical M1 Knock Threshold is 20–40 % of the knock level scale; the Knock Analyzer uses the tune's own table.
    var KNOCK_LEVEL = 20;
    var knockWasOn = false;

    for (var i = 0; i < n; i++) {
        var rpm = ch.rpm !== -1 ? data[i][ch.rpm] : NaN;
        var lambda = lambdaIdx !== -1 ? data[i][lambdaIdx] : NaN;
        var pw = ch.inj_pw !== -1 ? data[i][ch.inj_pw] : NaN;
        var press = ch.fuel_press !== -1 ? data[i][ch.fuel_press] : NaN;
        var pressAim = ch.fuel_press_aim !== -1 ? data[i][ch.fuel_press_aim] : NaN;
        var map = ch.map !== -1 ? data[i][ch.map] : NaN;

        var running = !(rpm < 400);

        // CL trim: engine running with closed loop active (the trim sits at exactly 0 while it is not)
        if (ch.cl_trim_b1 !== -1 && running) {
            var t1 = data[i][ch.cl_trim_b1];
            if (!isNaN(t1) && t1 !== 0) { clTrimB1Sum += t1; clTrimB1Count++; }
        }
        if (ch.cl_trim_b2 !== -1 && running) {
            var t2 = data[i][ch.cl_trim_b2];
            if (!isNaN(t2) && t2 !== 0) { clTrimB2Sum += t2; clTrimB2Count++; }
        }

        // Injecting time in the short-pulse (non-linear) region
        if (running && !isNaN(pw) && pw > 0.05) { firingCount++; if (pw < SHORT_PW_MS) lowPWCount++; }

        // Fuel pressure
        if (!isNaN(press) && !isNaN(pressAim) && pressAim > 0 && !(rpm < 400)) {
            pressureSamples++;
            if ((press - pressAim) * MPA_TO_BAR < -PRESS_TOL_BAR) pressureBelowAimCount++;
        }

        // Knock detection: any cylinder above KNOCK_LEVEL while running; one event per stretch
        var hasKnock = false;
        for (var cyl = 1; cyl <= 8; cyl++) {
            var kIdx = ch['knock_cyl_' + cyl];
            if (kIdx !== -1) {
                var kLevel = data[i][kIdx];
                if (!isNaN(kLevel) && kLevel > KNOCK_LEVEL && !(rpm < 500)) {
                    hasKnock = true;
                    break;
                }
            }
        }
        if (hasKnock && !knockWasOn) {
            knockEvents++;
            if (!isNaN(lambda) && lambda > 1.06 && !(pw <= 0.05)) knockWithLean++;
        }
        knockWasOn = hasKnock;
    }

    // --- Lean episodes (injector/worker.js): overrun cut, injectors off without overrun, lean while fuelling ---
    var lean = null;
    if (typeof analyzeLeanSpikes === 'function') {
        try { lean = analyzeLeanSpikes(data, resolveInjectorChannels(columnNames), tune); } catch (e) { lean = null; }
    }
    var lin = null;
    if (tune && typeof analyzeLinearisation === 'function') {
        try { lin = analyzeLinearisation(data, resolveInjectorChannels(columnNames), tune); } catch (e) { lin = null; }
    }

    // --- Build Summary ---
    summary.totalSamples = n;
    summary.duration = n > 0 ? (data[n-1][0] - data[0][0]).toFixed(1) + 's' : '0s';
    summary.leanEvents = lean ? lean.fuelledCount : 0;
    summary.injectionOffEvents = lean ? lean.injectionOffCount : 0;
    summary.knockEvents = knockEvents;
    summary.pressureBelowAim = pressureSamples > 0 ? Math.round(pressureBelowAimCount / pressureSamples * 100) : 0;
    summary.shortPWPct = firingCount ? Math.round(lowPWCount / firingCount * 1000) / 10 : 0;

    var clTrimB1Mean = clTrimB1Count > 0 ? clTrimB1Sum / clTrimB1Count : null;
    var clTrimB2Mean = clTrimB2Count > 0 ? clTrimB2Sum / clTrimB2Count : null;

    // --- Generate Cross-Correlated Findings ---

    // Finding: injectors switched off without the overrun fuel cut (Minimum Volume)
    if (lean && lean.injectionOffCount >= 3) {
        findings.push({
            severity: 'warning',
            title: 'Injection Cut Without Overrun',
            body: lean.injectionOffCount + ' lean episodes are the injectors switched off without the overrun fuel cut (mostly at ' +
                injRange(lean.injectionOff, 'rpm') + ' rpm' + (injRange(lean.injectionOff, 'map') ? ', ' + injRange(lean.injectionOff, 'map') + ' kPa' : '') +
                '). Lambda then reads air. ' + (lean.tune && lean.tune.minVolume !== null ? leanMinVolumeText(lean, true)
                    : 'On an M1 this is usually Fuel Injector Primary Minimum Volume: when any cylinder\'s request falls below it, all injectors stop until every cylinder is above Minimum Volume + Hysteresis.'),
            action: 'See the Injector tool\'s Lean Episodes. Log Fuel Cylinder 1 Primary Volume to confirm; set Minimum Volume from the injector maker\'s data, raise its Hysteresis to stop the on/off cycling, and spread the fuel film decrease (longer Decrease time constants — Transient Fuel tool).'
        });
    }

    // Finding: lean while fuelling, mostly with short pulses (injector linearisation)
    if (lean && lean.fuelledCount >= 3 && lean.fuelledShortPW >= lean.fuelledCount / 2) {
        findings.push({
            severity: 'info',
            title: 'Lean at Short Pulse Widths',
            body: lean.fuelledShortPW + ' of ' + lean.fuelledCount + ' lean episodes while fuelling had pulses under ' + SHORT_PW_MS + ' ms, where a DI injector is non-linear.',
            action: 'Check Fuel Injector Primary Linearisation against the injector maker\'s small-pulse data (volume vs pulse width by rail pressure).'
        });
    }

    // Finding (with the tune): Linearisation can't cover the short-pulse region the engine spends time in
    if (lin && lin.volumes.length <= 1 && lin.shortPulsePct > 5) {
        findings.push({
            severity: 'warning',
            title: 'Linearisation Doesn\'t Cover Short Pulses',
            body: lin.shortPulsePct.toFixed(1) + ' % of injecting time is below 1 ms, but Fuel Injector Primary Linearisation' + (lin.tuneName ? ' in ' + lin.tuneName : '') +
                ' has a single Fuel Volume site, so it adds the same time to every pulse at a pressure' + (lin.atRunning ? ' (' + lin.atRunning.join(' / ') +
                ' µs at the ' + lin.runningPressure.p50.toFixed(0) + ' bar median rail pressure)' : '') + ' and cannot correct the short-pulse region.',
            action: 'Enter the injector maker\'s small-pulse data (volume against pulse width at each rail pressure) as Fuel Volume sites in Linearisation. See the Injector tool\'s Injector Settings From the Tune.'
        });
    }

    // Finding: lean while fuelling with rail pressure below aim
    if (lean && lean.fuelledLowPressure >= 3) {
        findings.push({
            severity: 'warning',
            title: 'Lean Episodes With Rail Pressure Below Aim',
            body: lean.fuelledLowPressure + ' of ' + lean.fuelledCount + ' lean episodes while fuelling had rail pressure more than 10 bar below aim.',
            action: 'Check the DI Fuel Pressure tool for where the rail falls behind (capacity at high rpm/load, or control on a rising aim).'
        });
    }

    // Finding: Knock events correlated with lean condition (more than 5 events, over 15 % of them while lean)
    var knockLeanPct = knockEvents ? Math.round(knockWithLean / knockEvents * 100) : 0;
    var knockLeanCorrelated = knockEvents > 5 && knockLeanPct > 15;
    if (knockLeanCorrelated) {
        findings.push({
            severity: 'critical',
            title: 'Knock Events Correlated with Lean Fueling',
            body: knockLeanPct + '% of knock events (' + knockWithLean + '/' + knockEvents + ') occur simultaneously with lean lambda (>1.06). The engine is knocking because it\'s running lean — fix fueling before pulling timing.',
            action: 'Address the lean condition first (check VE table, fuel pressure, injector PW). Pulling timing alone will not solve knock caused by lean fueling.'
        });
    }

    // Finding: Global CL trim bias (injector reference flow issue)
    if (clTrimB1Mean !== null && Math.abs(clTrimB1Mean) > 5) {
        var direction = clTrimB1Mean > 0 ? 'adding fuel (lean base)' : 'removing fuel (rich base)';
        findings.push({
            severity: 'warning',
            title: 'Sustained CL Trim Offset — Bank 1',
            body: 'Bank 1 closed-loop trim averages ' + clTrimB1Mean.toFixed(1) + '% — the ECU is consistently ' + direction + '. This suggests a systemic error in the fuel model rather than individual VE cell errors.',
            action: 'Check injector reference flow value and fuel pressure sensor calibration. A global trim offset usually indicates incorrect injector data or fuel pressure estimate.'
        });
    }
    if (clTrimB2Mean !== null && Math.abs(clTrimB2Mean) > 5) {
        var direction = clTrimB2Mean > 0 ? 'adding fuel (lean base)' : 'removing fuel (rich base)';
        findings.push({
            severity: 'warning',
            title: 'Sustained CL Trim Offset — Bank 2',
            body: 'Bank 2 closed-loop trim averages ' + clTrimB2Mean.toFixed(1) + '% — the ECU is consistently ' + direction + '.',
            action: 'Same as Bank 1 — check injector reference flow and fuel pressure calibration. If both banks show similar offset, it\'s definitely a systemic issue.'
        });
    }

    // Finding: Fuel pressure consistently below aim
    if (pressureSamples > 100) {
        var belowPct = (pressureBelowAimCount / pressureSamples * 100);
        if (belowPct > 15) {
            findings.push({
                severity: 'warning',
                title: 'Fuel Pressure Tracking Issue',
                body: belowPct.toFixed(0) + '% of samples (engine running) show rail pressure more than 2 bar below aim. The HPFP is struggling to maintain target pressure.',
                action: 'Check Error vs RPM and Error vs Duty Cycle in the DI Fuel Pressure tool to determine if this is a capacity issue (high RPM/duty) or a control issue (all conditions).'
            });
        }
    }

    // Finding: Knock events present but not tied to lean running (none lean, or too few / too small a share to say)
    if (knockEvents > 0 && !knockLeanCorrelated) {
        var leanNote = knockWithLean === 0 ? ' with normal fueling. This points at ignition timing — the advance is too aggressive for the conditions.'
            : ', ' + knockWithLean + ' of them while lean (lambda > 1.06) — ' + (knockEvents <= 5 ? 'too few events to tell whether fueling is the cause.'
                : 'only ' + knockLeanPct + '%, so most of it points at ignition timing.');
        findings.push({
            severity: 'warning',
            title: knockWithLean === 0 ? 'Knock Events Detected (Not Lean-Related)' : 'Knock Events Detected',
            body: knockEvents + ' knock events (knock level above 20%)' + leanNote,
            action: 'Confirm in the Knock Analyzer with your tune (it uses the tune\'s own Knock Threshold table), then use its RPM × Load grid to find which cells need timing reduction. Start with 1-2° and re-log.' +
                (knockWithLean ? ' Check the lean episodes in the Injector tool too.' : '')
        });
    }

    // Finding: Everything looks healthy
    if (findings.length === 0) {
        findings.push({
            severity: 'healthy',
            title: 'No Cross-Domain Issues Detected',
            body: 'No correlated problems found across fueling, knock, and fuel pressure domains. Individual tools may still reveal minor issues — use them for detailed analysis.',
            action: 'Continue monitoring. Log under different conditions (hot day, high load, cold start) to verify robustness.'
        });
    }

    // Sort findings by severity
    var severityOrder = { critical: 0, warning: 1, info: 2, healthy: 3 };
    findings.sort(function(a, b) { return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3); });

    return { summary: summary, findings: findings };
}

// MoTeC .ld logs are read by parseLdFile in lib/ld-parser.js, which the page loads before this worker.

// ---------------------------------------------------------------------------
// Worker Message Handler
// ---------------------------------------------------------------------------

self.onmessage = function(event) {
    var msg = event.data;
    if (!msg) return;

    try {
        var columnNames, data;

        if (msg.type === 'analyze_ld') {
            self.postMessage({ type: 'progress', phase: 'Parsing .ld file...', percent: 5 });
            var result = parseLdFile(msg.buffer, function(done, total) {
                self.postMessage({ type: 'progress', phase: 'Reading channels...', percent: 5 + Math.round(done / total * 30) });
            });
            columnNames = result.columnNames;
            data = result.data;
        } else {
            self.postMessage({ type: 'progress', phase: 'Parsing CSV...', percent: 5 });
            var result = parseLogCsv(msg.logText, function(done, total) {
                self.postMessage({ type: 'progress', phase: 'Parsing rows...', percent: 5 + Math.round(done / total * 30) });
            });
            columnNames = result.columnNames;
            data = result.data;
        }

        if (data.length === 0) {
            self.postMessage({ type: 'error', message: 'No data rows found.' });
            return;
        }

        self.postMessage({ type: 'progress', phase: 'Running cross-domain analysis...', percent: 40 });
        var diagnostics = runCrossDiagnostics(columnNames, data, msg.tune || null);

        self.postMessage({ type: 'progress', phase: 'Complete', percent: 100 });
        self.postMessage({ type: 'result', diagnostics: diagnostics });

    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error' });
    }
};
