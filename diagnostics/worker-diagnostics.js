/**
 * worker-diagnostics.js — Cross-Tool Diagnostics Worker.
 * Parses a MoTeC log and performs unified analysis across fueling, knock,
 * fuel pressure, and idle domains to identify correlated root causes.
 *
 * This file is loaded inline (not as a Web Worker) — the app.js creates
 * a worker from it using a Blob URL.
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

function runCrossDiagnostics(columnNames, data) {
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
    var leanCount = 0, richCount = 0, totalLambdaSamples = 0;
    var leanWithLowPW = 0, leanWithLowPressure = 0, leanWithKnock = 0;
    var clTrimB1Sum = 0, clTrimB1Count = 0;
    var clTrimB2Sum = 0, clTrimB2Count = 0;
    var lowPWCount = 0;
    var knockEvents = 0;
    var knockWithLean = 0;
    var pressureBelowAimCount = 0;
    var pressureSamples = 0;

    var lambdaIdx = ch.lambda_b1 !== -1 ? ch.lambda_b1 : (ch.lambda_avg !== -1 ? ch.lambda_avg : -1);

    for (var i = 0; i < n; i++) {
        var rpm = ch.rpm !== -1 ? data[i][ch.rpm] : NaN;
        var lambda = lambdaIdx !== -1 ? data[i][lambdaIdx] : NaN;
        var pw = ch.inj_pw !== -1 ? data[i][ch.inj_pw] : NaN;
        var press = ch.fuel_press !== -1 ? data[i][ch.fuel_press] : NaN;
        var pressAim = ch.fuel_press_aim !== -1 ? data[i][ch.fuel_press_aim] : NaN;
        var map = ch.map !== -1 ? data[i][ch.map] : NaN;

        // Lambda analysis
        if (!isNaN(lambda) && lambda > 0) {
            totalLambdaSamples++;
            var isLean = lambda > 1.06;
            var isRich = lambda < 0.92;
            if (isLean) {
                leanCount++;
                if (!isNaN(pw) && pw < 0.8) leanWithLowPW++;
                if (!isNaN(press) && !isNaN(pressAim) && (press - pressAim) < -0.05) leanWithLowPressure++;
            }
            if (isRich) richCount++;
        }

        // CL trim
        if (ch.cl_trim_b1 !== -1) {
            var t1 = data[i][ch.cl_trim_b1];
            if (!isNaN(t1)) { clTrimB1Sum += t1; clTrimB1Count++; }
        }
        if (ch.cl_trim_b2 !== -1) {
            var t2 = data[i][ch.cl_trim_b2];
            if (!isNaN(t2)) { clTrimB2Sum += t2; clTrimB2Count++; }
        }

        // Low PW
        if (!isNaN(pw) && pw > 0.05 && pw < 0.8) lowPWCount++;

        // Fuel pressure
        if (!isNaN(press) && !isNaN(pressAim)) {
            pressureSamples++;
            if ((press - pressAim) < -0.02) pressureBelowAimCount++;
        }

        // Knock detection (any cylinder > 5%)
        var hasKnock = false;
        for (var cyl = 1; cyl <= 8; cyl++) {
            var kIdx = ch['knock_cyl_' + cyl];
            if (kIdx !== -1) {
                var kLevel = data[i][kIdx];
                if (!isNaN(kLevel) && kLevel > 5) {
                    hasKnock = true;
                    break;
                }
            }
        }
        if (hasKnock) {
            knockEvents++;
            if (!isNaN(lambda) && lambda > 1.06) knockWithLean++;
        }
    }

    // --- Build Summary ---
    summary.totalSamples = n;
    summary.duration = n > 0 ? (data[n-1][0] - data[0][0]).toFixed(1) + 's' : '0s';
    summary.leanEvents = leanCount;
    summary.knockEvents = knockEvents;
    summary.pressureBelowAim = pressureSamples > 0 ? Math.round(pressureBelowAimCount / pressureSamples * 100) : 0;
    summary.lowPWSamples = lowPWCount;

    var clTrimB1Mean = clTrimB1Count > 0 ? clTrimB1Sum / clTrimB1Count : null;
    var clTrimB2Mean = clTrimB2Count > 0 ? clTrimB2Sum / clTrimB2Count : null;

    // --- Generate Cross-Correlated Findings ---

    // Finding: Lean spikes correlated with low PW (XDI instability)
    if (leanCount > 10 && leanWithLowPW > 0) {
        var pct = (leanWithLowPW / leanCount * 100).toFixed(0);
        if (pct > 30) {
            findings.push({
                severity: 'critical',
                title: 'Lean Spikes Caused by XDI Instability',
                body: pct + '% of lean events (' + leanWithLowPW + '/' + leanCount + ') coincide with injector pulse width below 0.8ms. The injectors are operating in the instability zone where fuel delivery becomes erratic.',
                action: 'Reduce fuel pressure aim at idle/light load to force longer pulse widths, or increase idle airflow to raise PW above 0.8ms.'
            });
        }
    }

    // Finding: Lean spikes correlated with low fuel pressure
    if (leanCount > 10 && leanWithLowPressure > 0) {
        var pct = (leanWithLowPressure / leanCount * 100).toFixed(0);
        if (pct > 20) {
            findings.push({
                severity: 'critical',
                title: 'Lean Spikes Correlated with Fuel Pressure Drop',
                body: pct + '% of lean events (' + leanWithLowPressure + '/' + leanCount + ') occur when fuel pressure is below aim. The HPFP cannot maintain target pressure during these conditions.',
                action: 'Check HPFP capacity. If pressure drops at high RPM/load, the pump may be at its limit. Consider reducing pressure aim or upgrading the pump.'
            });
        }
    }

    // Finding: Knock events correlated with lean condition
    if (knockEvents > 5 && knockWithLean > 0) {
        var pct = (knockWithLean / knockEvents * 100).toFixed(0);
        if (pct > 15) {
            findings.push({
                severity: 'critical',
                title: 'Knock Events Correlated with Lean Fueling',
                body: pct + '% of knock events (' + knockWithLean + '/' + knockEvents + ') occur simultaneously with lean lambda (>1.06). The engine is knocking because it\'s running lean — fix fueling before pulling timing.',
                action: 'Address the lean condition first (check VE table, fuel pressure, injector PW). Pulling timing alone will not solve knock caused by lean fueling.'
            });
        }
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

    // Finding: Low PW time without lean spikes (marginal but not failing)
    if (lowPWCount > 0 && leanWithLowPW === 0 && totalLambdaSamples > 0) {
        var lowPWPct = (lowPWCount / totalLambdaSamples * 100).toFixed(1);
        if (lowPWPct > 5) {
            findings.push({
                severity: 'info',
                title: 'Operating Near XDI Instability Zone',
                body: lowPWPct + '% of samples have PW below 0.8ms but no lean spikes detected yet. The system is marginal — small changes in conditions could trigger instability.',
                action: 'Monitor closely. Consider preemptively reducing fuel pressure aim at idle to increase PW margin.'
            });
        }
    }

    // Finding: Fuel pressure consistently below aim
    if (pressureSamples > 100) {
        var belowPct = (pressureBelowAimCount / pressureSamples * 100);
        if (belowPct > 15) {
            findings.push({
                severity: 'warning',
                title: 'Fuel Pressure Tracking Issue',
                body: belowPct.toFixed(0) + '% of samples show fuel pressure below aim. The HPFP is struggling to maintain target pressure.',
                action: 'Check Error vs RPM and Error vs Duty Cycle in the DI Fuel Pressure tool to determine if this is a capacity issue (high RPM/duty) or a control issue (all conditions).'
            });
        }
    }

    // Finding: Knock events present
    if (knockEvents > 0 && knockWithLean === 0) {
        findings.push({
            severity: 'warning',
            title: 'Knock Events Detected (Not Lean-Related)',
            body: knockEvents + ' knock events detected with normal fueling. This is timing-related knock — the ignition advance is too aggressive for the current conditions.',
            action: 'Use the Knock Analyzer RPM × Load grid to identify which cells need timing reduction. Start with 1-2° and re-log.'
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

// ---------------------------------------------------------------------------
// .ld Binary Parser (simplified)
// ---------------------------------------------------------------------------

function readString(view, offset, length) {
    var bytes = [];
    for (var i = 0; i < length; i++) {
        var b = view.getUint8(offset + i);
        if (b === 0) break;
        bytes.push(b);
    }
    return String.fromCharCode.apply(null, bytes).trim();
}

function decodeFloat16(h) {
    var sign = (h >> 15) & 1;
    var exp = (h >> 10) & 0x1f;
    var frac = h & 0x3ff;
    if (exp === 0) return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
    if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);
    return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

var LD_NAME_MAP = {
    'Engine.Speed': 'Engine Speed',
    'Inlet.Manifold.Pressure': 'Inlet Manifold Pressure',
    'Exhaust.Lambda.Bank 1': 'Exhaust Lambda Bank 1',
    'Exhaust.Lambda.Bank 2': 'Exhaust Lambda Bank 2',
    'Exhaust.Lambda': 'Exhaust Lambda',
    'Throttle.Position': 'Throttle Position',
    'Fuel.Pressure.Direct.Bank 1': 'Fuel Pressure Direct Bank 1',
    'Fuel.Pressure.Direct.Bank 1.Aim': 'Fuel Pressure Direct Bank 1 Aim',
    'Coolant.Temperature': 'Coolant Temperature',
    'Fuel.Mixture Aim': 'Fuel Mixture Aim',
};

function normalizeLdName(name, unit) {
    if (LD_NAME_MAP[name]) return LD_NAME_MAP[name];
    if (name === 'Fuel.Cylinder 1.Primary.Output.P' && unit === 'ms') return 'Fuel Cylinder 1 Primary Output Pulse Width 1';
    if (name === 'Fuel.Closed Loop.Control.Bank 1.' && unit === '%Trim') return 'Fuel Closed Loop Control Bank 1 Trim';
    if (name === 'Fuel.Closed Loop.Control.Bank 2.' && unit === '%Trim') return 'Fuel Closed Loop Control Bank 2 Trim';
    return name.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

function parseLdFile(buffer, onProgress) {
    var view = new DataView(buffer);
    var metaPtr = view.getUint32(8, true);
    var numChanns = view.getUint32(86, true);
    if (metaPtr === 0 || numChanns === 0) throw new Error('Invalid .ld file');

    var channels = [];
    var ptr = metaPtr;
    for (var ch = 0; ch < numChanns && ptr !== 0; ch++) {
        if (ptr + 124 > buffer.byteLength) break;
        var nextPtr = view.getUint32(ptr + 4, true);
        var chanDataPtr = view.getUint32(ptr + 8, true);
        var nData = view.getUint32(ptr + 12, true);
        var dtypeA = view.getUint16(ptr + 18, true);
        var dtypeVal = view.getUint16(ptr + 20, true);
        var freq = view.getUint16(ptr + 22, true);
        var shift = view.getInt16(ptr + 24, true);
        var mul = view.getInt16(ptr + 26, true);
        var scale = view.getInt16(ptr + 28, true);
        var dec = view.getInt16(ptr + 30, true);
        var name = readString(view, ptr + 32, 32);
        var shortName = readString(view, ptr + 64, 8);

        var bytesPerSample = 0, dataType = null;
        if (dtypeA === 0x07) { if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'float16'; } else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'float32'; } }
        else if (dtypeA === 0 || dtypeA === 0x03 || dtypeA === 0x05) { if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'int16'; } else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'int32'; } }

        channels.push({ name: name, shortName: shortName, freq: freq, dataPtr: chanDataPtr, nData: nData, dataType: dataType, bytesPerSample: bytesPerSample, shift: shift, mul: mul, scale: scale, dec: dec });
        ptr = nextPtr;
    }

    if (channels.length === 0) throw new Error('No channels in .ld file');

    var maxFreq = 0;
    for (var i = 0; i < channels.length; i++) if (channels[i].freq > maxFreq) maxFreq = channels[i].freq;
    var baseSamples = 0;
    for (var i = 0; i < channels.length; i++) if (channels[i].freq === maxFreq) { baseSamples = channels[i].nData; break; }

    var columnNames = ['Time'];
    var channelData = [];
    var timeArr = new Float64Array(baseSamples);
    var dt = 1.0 / maxFreq;
    for (var t = 0; t < baseSamples; t++) timeArr[t] = t * dt;
    channelData.push(timeArr);

    for (var ci = 0; ci < channels.length; ci++) {
        var chan = channels[ci];
        columnNames.push(normalizeLdName(chan.name, chan.shortName));
        var rawData = new Float64Array(chan.nData);
        if (chan.dataType && chan.bytesPerSample > 0) {
            var offset = chan.dataPtr;
            for (var s = 0; s < chan.nData; s++) {
                if (offset + chan.bytesPerSample > buffer.byteLength) break;
                if (chan.dataType === 'float32') rawData[s] = view.getFloat32(offset, true);
                else if (chan.dataType === 'float16') rawData[s] = decodeFloat16(view.getUint16(offset, true));
                else if (chan.dataType === 'int16') rawData[s] = view.getInt16(offset, true);
                else if (chan.dataType === 'int32') rawData[s] = view.getInt32(offset, true);
                offset += chan.bytesPerSample;
            }
        }
        var transformed = new Float64Array(rawData.length);
        var decFactor = Math.pow(10, -chan.dec);
        for (var s = 0; s < rawData.length; s++) transformed[s] = (rawData[s] / chan.scale * decFactor + chan.shift) * chan.mul;

        if (chan.freq === maxFreq) { channelData.push(transformed); }
        else {
            var ratio = maxFreq / chan.freq;
            var upsampled = new Float64Array(baseSamples);
            for (var u = 0; u < baseSamples; u++) upsampled[u] = transformed[Math.min(Math.floor(u / ratio), transformed.length - 1)];
            channelData.push(upsampled);
        }
        if (onProgress) onProgress(ci + 1, channels.length);
    }

    var numCols = columnNames.length;
    var data = new Array(baseSamples);
    for (var r = 0; r < baseSamples; r++) {
        var row = new Array(numCols);
        for (var c = 0; c < numCols; c++) row[c] = channelData[c][r];
        data[r] = row;
    }
    return { columnNames: columnNames, data: data };
}

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
        var diagnostics = runCrossDiagnostics(columnNames, data);

        self.postMessage({ type: 'progress', phase: 'Complete', percent: 100 });
        self.postMessage({ type: 'result', diagnostics: diagnostics });

    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error' });
    }
};
