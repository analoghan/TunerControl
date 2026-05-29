/**
 * haltech/ve-table/worker.js — Haltech Nexus VE Table Analyzer Worker
 *
 * Stage 1: High-priority features
 *   - Configurable filters (hit threshold, coolant temp, min run time, min change)
 *   - Scaling factor (conservative correction application)
 *   - Outlier filtering (two-pass sigma-based)
 *   - TPS rate-of-change filter (steady-state only)
 *   - Per-cell standard deviation (confidence indicator)
 *
 * Inputs:
 *   - NSP datalog CSV (multi-rate, integer-scaled values)
 *   - VE table CSV export from NSP (optional)
 *   - Filter settings object
 *
 * Outputs:
 *   - Correction grid with stddev per cell
 *   - New VE values (if table provided)
 *   - Hit count grid
 *   - Detailed filter statistics
 */

// ---------------------------------------------------------------------------
// Constants & Defaults
// ---------------------------------------------------------------------------

var DEFAULT_SETTINGS = {
    hitThreshold: 50,
    minCoolantTemp: 55,    // degrees C
    minRunTime: 60,        // seconds from log start
    minChangeAmount: 0,    // % — zero out corrections smaller than this
    scalingFactor: 100,    // % — apply this fraction of the correction
    outlierSigma: 0,       // 0 = disabled, 2-3 = typical
    maxTpsRate: 0,         // %/s — 0 = disabled, 30-100 = typical
    smoothing: 0,          // Gaussian sigma — 0 = disabled, 1-3 = typical
};

var HALTECH_NO_DATA = -2147483638;
var HALTECH_NO_DATA2 = -2147483628;
var HALTECH_NO_DATA3 = -2147483614;
var HALTECH_NO_DATA4 = -2147483608;

var SCALE = {
    RPM: 1,
    PRESSURE: 0.1,
    LAMBDA: 0.001,
    PERCENT: 0.1,
    TEMP_K: 0.1,
};

// ---------------------------------------------------------------------------
// Haltech Log Parser
// ---------------------------------------------------------------------------

function parseHaltechLog(text, onProgress) {
    var lines = text.split('\n');
    var channels = [];
    var dataStartLine = -1;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith('Channel :')) {
            channels.push(line.split(':')[1].trim());
        } else if (line.startsWith('Log :')) {
            dataStartLine = i + 1;
            break;
        }
    }

    if (dataStartLine === -1) {
        throw new Error('Could not find data section in Haltech log. Expected "Log :" marker.');
    }

    var ch = resolveHaltechChannels(channels);
    var numCols = channels.length;
    var samples = [];
    var currentValues = new Array(numCols);
    for (var c = 0; c < numCols; c++) currentValues[c] = NaN;

    var totalDataLines = lines.length - dataStartLine;
    var lastProgress = 0;
    var firstTimestamp = null;

    for (var i = dataStartLine; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;

        var fields = line.split(',');
        var timestamp = fields[0];

        // Parse timestamp to seconds for run-time filtering
        var timeSec = parseTimestamp(timestamp);
        if (firstTimestamp === null && !isNaN(timeSec)) firstTimestamp = timeSec;
        var elapsed = !isNaN(timeSec) && firstTimestamp !== null ? timeSec - firstTimestamp : 0;

        for (var c = 0; c < numCols; c++) {
            var fieldIdx = c + 1;
            if (fieldIdx < fields.length && fields[fieldIdx] !== '') {
                var raw = parseInt(fields[fieldIdx], 10);
                if (!isNaN(raw)) currentValues[c] = raw;
            }
        }

        var rpmRaw = ch.rpmIdx >= 0 ? currentValues[ch.rpmIdx] : NaN;
        var mapRaw = ch.mapIdx >= 0 ? currentValues[ch.mapIdx] : NaN;

        if (!isNaN(rpmRaw) && !isNaN(mapRaw) && !isHaltechInvalid(rpmRaw) && !isHaltechInvalid(mapRaw)) {
            samples.push({
                time: elapsed,
                rpm: rpmRaw * SCALE.RPM,
                map: mapRaw * SCALE.PRESSURE,
                lambdaB1: getScaledValue(currentValues, ch.wb1Idx, SCALE.LAMBDA),
                lambdaB2: getScaledValue(currentValues, ch.wb2Idx, SCALE.LAMBDA),
                lambdaTarget: getScaledValue(currentValues, ch.targetLambdaIdx, SCALE.LAMBDA),
                stftB1: getScaledValue(currentValues, ch.stftB1Idx, SCALE.PERCENT),
                stftB2: getScaledValue(currentValues, ch.stftB2Idx, SCALE.PERCENT),
                ltftB1: getScaledValue(currentValues, ch.ltftB1Idx, SCALE.PERCENT),
                ltftB2: getScaledValue(currentValues, ch.ltftB2Idx, SCALE.PERCENT),
                coolant: ch.coolantIdx >= 0 ? getScaledTemp(currentValues[ch.coolantIdx]) : NaN,
                tps: getScaledValue(currentValues, ch.tpsIdx, SCALE.PERCENT),
                fuelLoad: getScaledValue(currentValues, ch.fuelLoadIdx, SCALE.PRESSURE),
            });
        }

        var processed = i - dataStartLine;
        if (processed - lastProgress >= 5000 || i === lines.length - 1) {
            lastProgress = processed;
            if (onProgress) onProgress(processed, totalDataLines);
        }
    }

    return { channels: channels, channelIndices: ch, samples: samples, sampleCount: samples.length };
}

function parseTimestamp(ts) {
    // Format: HH:MM:SS.mmm
    var parts = ts.split(':');
    if (parts.length < 3) return NaN;
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var s = parseFloat(parts[2]);
    if (isNaN(h) || isNaN(m) || isNaN(s)) return NaN;
    return h * 3600 + m * 60 + s;
}

function isHaltechInvalid(val) {
    return val === HALTECH_NO_DATA || val === HALTECH_NO_DATA2 ||
           val === HALTECH_NO_DATA3 || val === HALTECH_NO_DATA4;
}

function getScaledValue(values, idx, scale) {
    if (idx < 0) return NaN;
    var raw = values[idx];
    if (isNaN(raw) || isHaltechInvalid(raw)) return NaN;
    return raw * scale;
}

function getScaledTemp(raw) {
    if (isNaN(raw) || isHaltechInvalid(raw)) return NaN;
    return raw * 0.1 - 273.15;
}

// ---------------------------------------------------------------------------
// Channel Resolution
// ---------------------------------------------------------------------------

function resolveHaltechChannels(channelNames) {
    var nameToIdx = {};
    for (var i = 0; i < channelNames.length; i++) {
        var n = channelNames[i].toLowerCase().trim();
        if (!(n in nameToIdx)) nameToIdx[n] = i;
    }
    function find(candidates) {
        for (var c = 0; c < candidates.length; c++) {
            var idx = nameToIdx[candidates[c].toLowerCase()];
            if (idx !== undefined) return idx;
        }
        return -1;
    }

    var result = {
        rpmIdx: find(['RPM', 'Engine Speed']),
        mapIdx: find(['Fuel - Load (MAP)', 'Manifold Pressure', 'MAP']),
        wb1Idx: find(['Wideband O2 Bank 1', 'Wideband O2 1']),
        wb2Idx: find(['Wideband O2 Bank 2', 'Wideband O2 2']),
        wbOverallIdx: find(['Wideband O2 Overall']),
        targetLambdaIdx: find(['Target Lambda']),
        stftB1Idx: find(['O2 Control Bank 1 Short Term Fuel Trim']),
        stftB2Idx: find(['O2 Control Bank 2 Short Term Fuel Trim']),
        ltftB1Idx: find(['O2 Control Bank 1 Long Term Fuel Trim']),
        ltftB2Idx: find(['O2 Control Bank 2 Long Term Fuel Trim']),
        coolantIdx: find(['Coolant Temperature']),
        tpsIdx: find(['Drive By Wire Throttle 1 Position', 'Throttle Position']),
        fuelLoadIdx: find(['Fuel - Load (MAP)']),
        warnings: [],
    };

    if (result.rpmIdx === -1) throw new Error('Required channel "RPM" not found in log.');
    if (result.mapIdx === -1) throw new Error('Required channel "Manifold Pressure" or "Fuel - Load (MAP)" not found.');
    if (result.targetLambdaIdx === -1) throw new Error('Required channel "Target Lambda" not found.');
    if (result.wb1Idx === -1 && result.wb2Idx === -1 && result.wbOverallIdx === -1) {
        throw new Error('No wideband lambda channel found.');
    }
    if (result.stftB1Idx === -1) result.warnings.push('Short Term Fuel Trim Bank 1 not found — using 0.');
    if (result.ltftB1Idx === -1) result.warnings.push('Long Term Fuel Trim Bank 1 not found — using 0.');
    if (result.coolantIdx === -1) result.warnings.push('Coolant Temperature not found — temp filter disabled.');
    if (result.tpsIdx === -1) result.warnings.push('Throttle Position not found — TPS rate filter disabled.');
    return result;
}

// ---------------------------------------------------------------------------
// VE Table Parser
// ---------------------------------------------------------------------------

function parseHaltechVETable(text) {
    var lines = text.split('\n');
    var mapBreakpoints = [];
    var rpmBreakpoints = [];
    var values = [];
    var inCellValues = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith('AxisValues1:')) {
            var parts = line.split(',');
            for (var p = 1; p < parts.length; p++) {
                var v = parseFloat(parts[p]);
                if (!isNaN(v)) mapBreakpoints.push(v * 0.1);
            }
        } else if (line.startsWith('AxisValues2:')) {
            var parts = line.split(',');
            for (var p = 1; p < parts.length; p++) {
                var v = parseFloat(parts[p]);
                if (!isNaN(v)) rpmBreakpoints.push(v);
            }
        } else if (line.startsWith('CellValues:')) {
            inCellValues = true;
        } else if (inCellValues && line !== '') {
            var fields = line.split(',');
            var row = [];
            for (var f = 0; f < fields.length; f++) {
                var v = parseFloat(fields[f]);
                if (!isNaN(v)) row.push(v / 10.0);
            }
            if (row.length > 0) values.push(row);
        }
    }

    if (mapBreakpoints.length === 0 || rpmBreakpoints.length === 0) {
        throw new Error('Could not parse VE table axes.');
    }
    if (values.length === 0) {
        throw new Error('No VE cell values found after CellValues: marker.');
    }
    return { mapBreakpoints: mapBreakpoints, rpmBreakpoints: rpmBreakpoints, values: values };
}

// ---------------------------------------------------------------------------
// Correction Calculator
// ---------------------------------------------------------------------------

function computeCorrection(sample) {
    var b1Valid = !isNaN(sample.lambdaB1) && sample.lambdaB1 > 0.5 && sample.lambdaB1 < 2.0;
    var b2Valid = !isNaN(sample.lambdaB2) && sample.lambdaB2 > 0.5 && sample.lambdaB2 < 2.0;

    var lambdaActual;
    if (b1Valid && b2Valid) { lambdaActual = (sample.lambdaB1 + sample.lambdaB2) / 2; }
    else if (b1Valid) { lambdaActual = sample.lambdaB1; }
    else if (b2Valid) { lambdaActual = sample.lambdaB2; }
    else { return { correction: NaN, lambdaActual: NaN, totalTrim: 0, isValid: false }; }

    var targetValid = !isNaN(sample.lambdaTarget) && sample.lambdaTarget > 0.5 && sample.lambdaTarget < 2.0;
    if (!targetValid) { return { correction: NaN, lambdaActual: lambdaActual, totalTrim: 0, isValid: false }; }

    var stftB1 = !isNaN(sample.stftB1) ? sample.stftB1 : 0;
    var stftB2 = !isNaN(sample.stftB2) ? sample.stftB2 : 0;
    var ltftB1 = !isNaN(sample.ltftB1) ? sample.ltftB1 : 0;
    var ltftB2 = !isNaN(sample.ltftB2) ? sample.ltftB2 : 0;
    var stft, ltft;
    if (b1Valid && b2Valid) { stft = (stftB1 + stftB2) / 2; ltft = (ltftB1 + ltftB2) / 2; }
    else if (b1Valid) { stft = stftB1; ltft = ltftB1; }
    else { stft = stftB2; ltft = ltftB2; }

    var totalTrim = stft + ltft;
    // VE correction: (actual/target - 1) is positive when lean (need more VE/fuel),
    // negative when rich (need less VE/fuel). Trim is added to capture what the
    // ECU is already compensating for.
    var correction = ((lambdaActual / sample.lambdaTarget) - 1) * 100 + totalTrim;
    return { correction: correction, lambdaActual: lambdaActual, totalTrim: totalTrim, isValid: true };
}

// ---------------------------------------------------------------------------
// Grid Accumulator
// ---------------------------------------------------------------------------

function createGrid(mapBreakpoints, rpmBreakpoints) {
    var cells = [];
    for (var m = 0; m < mapBreakpoints.length; m++) {
        var row = [];
        for (var r = 0; r < rpmBreakpoints.length; r++) {
            row.push({ count: 0, correctionSum: 0, trimSum: 0 });
        }
        cells.push(row);
    }
    return { mapBreakpoints: mapBreakpoints, rpmBreakpoints: rpmBreakpoints, cells: cells };
}

function findNearest(value, breakpoints) {
    if (isNaN(value)) return -1;
    var bestIdx = 0;
    var bestDist = Math.abs(value - breakpoints[0]);
    for (var i = 1; i < breakpoints.length; i++) {
        var dist = Math.abs(value - breakpoints[i]);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    return bestIdx;
}

// ---------------------------------------------------------------------------
// Main Analysis Pipeline (with all high-priority features)
// ---------------------------------------------------------------------------

function runVEAnalysis(logText, veTableText, settings, onProgress) {
    var s = settings || {};
    var hitThreshold = typeof s.hitThreshold === 'number' ? s.hitThreshold : DEFAULT_SETTINGS.hitThreshold;
    var minCoolantTemp = typeof s.minCoolantTemp === 'number' ? s.minCoolantTemp : DEFAULT_SETTINGS.minCoolantTemp;
    var minRunTime = typeof s.minRunTime === 'number' ? s.minRunTime : DEFAULT_SETTINGS.minRunTime;
    var minChangeAmount = typeof s.minChangeAmount === 'number' ? s.minChangeAmount : DEFAULT_SETTINGS.minChangeAmount;
    var scalingFactor = typeof s.scalingFactor === 'number' ? s.scalingFactor / 100 : 1.0;
    var outlierSigma = typeof s.outlierSigma === 'number' ? s.outlierSigma : DEFAULT_SETTINGS.outlierSigma;
    var maxTpsRate = typeof s.maxTpsRate === 'number' ? s.maxTpsRate : DEFAULT_SETTINGS.maxTpsRate;
    var smoothing = typeof s.smoothing === 'number' ? s.smoothing : DEFAULT_SETTINGS.smoothing;

    // 1. Parse VE table
    var veTable = null;
    var mapBreakpoints, rpmBreakpoints;
    if (veTableText) {
        veTable = parseHaltechVETable(veTableText);
        mapBreakpoints = veTable.mapBreakpoints;
        rpmBreakpoints = veTable.rpmBreakpoints;
    } else {
        mapBreakpoints = [10,15,20,25,30,35,40,45,50,55,60,70,80,90,100,106.3,120,140,160,180,200,220,240,260,280,300];
        rpmBreakpoints = [0,500,750,1000,1250,1500,1750,2000,2500,3000,3500,4000,4500,5000,5500,6000,6500,7000,7500,8000];
    }

    // 2. Parse log
    var logData = parseHaltechLog(logText, function(done, total) {
        if (onProgress) onProgress('Parsing log...', 5 + Math.round(done / total * 25));
    });
    if (logData.samples.length < 100) {
        throw new Error('Not enough valid samples (' + logData.samples.length + '). Need at least 100.');
    }

    // 3. Compute TPS rates for transient filtering
    var tpsRates = null;
    if (maxTpsRate > 0) {
        tpsRates = new Array(logData.samples.length);
        tpsRates[0] = 0;
        for (var i = 1; i < logData.samples.length; i++) {
            var dt = logData.samples[i].time - logData.samples[i-1].time;
            var dTps = logData.samples[i].tps - logData.samples[i-1].tps;
            tpsRates[i] = (dt > 0 && !isNaN(dTps)) ? Math.abs(dTps / dt) : 0;
        }
    }

    // 4. First pass: filter, compute corrections, bin into grid
    if (onProgress) onProgress('Computing corrections (pass 1)...', 35);
    var grid = createGrid(mapBreakpoints, rpmBreakpoints);
    var binnedSamples = []; // for outlier second pass
    var filterStats = { total: logData.samples.length, byRunTime: 0, byCoolant: 0, byTpsRate: 0, byLambda: 0, byOutlier: 0, valid: 0 };

    for (var i = 0; i < logData.samples.length; i++) {
        var sample = logData.samples[i];

        // Filter: min run time
        if (sample.time < minRunTime) { filterStats.byRunTime++; continue; }

        // Filter: min coolant temp
        if (!isNaN(sample.coolant) && sample.coolant < minCoolantTemp) { filterStats.byCoolant++; continue; }

        // Filter: TPS rate of change
        if (maxTpsRate > 0 && tpsRates && tpsRates[i] > maxTpsRate) { filterStats.byTpsRate++; continue; }

        // Filter: RPM too low
        if (sample.rpm < 400) continue;

        // Compute correction
        var result = computeCorrection(sample);
        if (!result.isValid) { filterStats.byLambda++; continue; }

        // Bin into grid
        var loadValue = !isNaN(sample.fuelLoad) ? sample.fuelLoad : sample.map;
        var mapIdx = findNearest(loadValue, mapBreakpoints);
        var rpmIdx = findNearest(sample.rpm, rpmBreakpoints);
        if (mapIdx < 0 || rpmIdx < 0) continue;

        grid.cells[mapIdx][rpmIdx].count++;
        grid.cells[mapIdx][rpmIdx].correctionSum += result.correction;
        grid.cells[mapIdx][rpmIdx].trimSum += result.totalTrim;
        binnedSamples.push({ mapIdx: mapIdx, rpmIdx: rpmIdx, correction: result.correction, trim: result.totalTrim });
        filterStats.valid++;

        if (i % 10000 === 0 && onProgress) {
            onProgress('Pass 1...', 35 + Math.round(i / logData.samples.length * 20));
        }
    }

    // 5. Outlier filtering (two-pass) if enabled
    var finalGrid = grid;
    if (outlierSigma > 0 && binnedSamples.length > 0) {
        if (onProgress) onProgress('Outlier filtering (pass 2)...', 60);

        // Compute per-cell mean and stddev from first pass
        var numMap = mapBreakpoints.length;
        var numRpm = rpmBreakpoints.length;
        var cellMeans = [];
        var cellStddevs = [];
        for (var m = 0; m < numMap; m++) {
            var meanRow = [];
            var stdRow = [];
            for (var r = 0; r < numRpm; r++) {
                var cell = grid.cells[m][r];
                meanRow.push(cell.count > 0 ? cell.correctionSum / cell.count : 0);
                stdRow.push(0);
            }
            cellMeans.push(meanRow);
            cellStddevs.push(stdRow);
        }

        // Compute variance
        var varianceSums = [];
        for (var m = 0; m < numMap; m++) {
            var row = [];
            for (var r = 0; r < numRpm; r++) row.push(0);
            varianceSums.push(row);
        }
        for (var i = 0; i < binnedSamples.length; i++) {
            var bs = binnedSamples[i];
            var diff = bs.correction - cellMeans[bs.mapIdx][bs.rpmIdx];
            varianceSums[bs.mapIdx][bs.rpmIdx] += diff * diff;
        }
        for (var m = 0; m < numMap; m++) {
            for (var r = 0; r < numRpm; r++) {
                var cnt = grid.cells[m][r].count;
                if (cnt > 1) cellStddevs[m][r] = Math.sqrt(varianceSums[m][r] / cnt);
            }
        }

        // Second pass: rebuild grid excluding outliers
        finalGrid = createGrid(mapBreakpoints, rpmBreakpoints);
        filterStats.valid = 0;
        for (var i = 0; i < binnedSamples.length; i++) {
            var bs = binnedSamples[i];
            var mean = cellMeans[bs.mapIdx][bs.rpmIdx];
            var std = cellStddevs[bs.mapIdx][bs.rpmIdx];
            if (std > 0 && Math.abs(bs.correction - mean) > outlierSigma * std) {
                filterStats.byOutlier++;
                continue;
            }
            finalGrid.cells[bs.mapIdx][bs.rpmIdx].count++;
            finalGrid.cells[bs.mapIdx][bs.rpmIdx].correctionSum += bs.correction;
            finalGrid.cells[bs.mapIdx][bs.rpmIdx].trimSum += bs.trim;
            filterStats.valid++;
        }
    }

    // 6. Compute per-cell stddev on final grid
    if (onProgress) onProgress('Computing statistics...', 70);
    var finalVariance = [];
    for (var m = 0; m < mapBreakpoints.length; m++) {
        var row = [];
        for (var r = 0; r < rpmBreakpoints.length; r++) row.push(0);
        finalVariance.push(row);
    }
    var finalMeans = [];
    for (var m = 0; m < mapBreakpoints.length; m++) {
        var row = [];
        for (var r = 0; r < rpmBreakpoints.length; r++) {
            var cell = finalGrid.cells[m][r];
            row.push(cell.count > 0 ? cell.correctionSum / cell.count : 0);
        }
        finalMeans.push(row);
    }

    // Re-iterate binned samples (only those that survived outlier filter)
    if (outlierSigma > 0 && binnedSamples.length > 0) {
        // Need to re-check which survived
        var numMap = mapBreakpoints.length;
        var numRpm = rpmBreakpoints.length;
        var cellMeans2 = [];
        var cellStddevs2 = [];
        for (var m = 0; m < numMap; m++) {
            var mr = []; var sr = [];
            for (var r = 0; r < numRpm; r++) {
                var c = grid.cells[m][r];
                mr.push(c.count > 0 ? c.correctionSum / c.count : 0);
                sr.push(0);
            }
            cellMeans2.push(mr); cellStddevs2.push(sr);
        }
        var vs2 = [];
        for (var m = 0; m < numMap; m++) { var rr = []; for (var r = 0; r < numRpm; r++) rr.push(0); vs2.push(rr); }
        for (var i = 0; i < binnedSamples.length; i++) {
            var bs = binnedSamples[i];
            var d = bs.correction - cellMeans2[bs.mapIdx][bs.rpmIdx];
            vs2[bs.mapIdx][bs.rpmIdx] += d * d;
        }
        for (var m = 0; m < numMap; m++) {
            for (var r = 0; r < numRpm; r++) {
                var cnt = grid.cells[m][r].count;
                if (cnt > 1) cellStddevs2[m][r] = Math.sqrt(vs2[m][r] / cnt);
            }
        }
        for (var i = 0; i < binnedSamples.length; i++) {
            var bs = binnedSamples[i];
            var mean = cellMeans2[bs.mapIdx][bs.rpmIdx];
            var std = cellStddevs2[bs.mapIdx][bs.rpmIdx];
            if (std > 0 && Math.abs(bs.correction - mean) > outlierSigma * std) continue;
            var diff = bs.correction - finalMeans[bs.mapIdx][bs.rpmIdx];
            finalVariance[bs.mapIdx][bs.rpmIdx] += diff * diff;
        }
    } else {
        for (var i = 0; i < binnedSamples.length; i++) {
            var bs = binnedSamples[i];
            var diff = bs.correction - finalMeans[bs.mapIdx][bs.rpmIdx];
            finalVariance[bs.mapIdx][bs.rpmIdx] += diff * diff;
        }
    }

    // 7. Build final result grid with scaling, min change, and stddev
    if (onProgress) onProgress('Building outputs...', 80);
    var resultCells = [];
    var cellsAboveThreshold = 0;
    var totalCorrMag = 0;
    var maxCorr = 0;
    var minCorr = 0;

    for (var m = 0; m < mapBreakpoints.length; m++) {
        var row = [];
        for (var r = 0; r < rpmBreakpoints.length; r++) {
            var cell = finalGrid.cells[m][r];
            if (cell.count > hitThreshold) {
                var avgCorr = cell.correctionSum / cell.count;
                var avgTrim = cell.trimSum / cell.count;
                var stddev = cell.count > 1 ? Math.sqrt(finalVariance[m][r] / cell.count) : 0;

                // Apply scaling factor
                var scaledCorr = avgCorr * scalingFactor;

                // Apply min change amount (noise gate)
                if (minChangeAmount > 0 && Math.abs(scaledCorr) < minChangeAmount) {
                    scaledCorr = 0;
                }

                row.push({ count: cell.count, correction: scaledCorr, stddev: stddev, clTrimAvg: avgTrim, rawCorrection: avgCorr });
                cellsAboveThreshold++;
                totalCorrMag += Math.abs(scaledCorr);
                if (scaledCorr > maxCorr) maxCorr = scaledCorr;
                if (scaledCorr < minCorr) minCorr = scaledCorr;
            } else {
                row.push({ count: cell.count, correction: null, stddev: null, clTrimAvg: null, rawCorrection: null });
            }
        }
        resultCells.push(row);
    }

    // 8. Apply Gaussian smoothing (if enabled)
    if (smoothing > 0 && cellsAboveThreshold > 0) {
        var radius = Math.ceil(smoothing * 2);
        var numRows = resultCells.length;
        var numCols2 = resultCells[0] ? resultCells[0].length : 0;

        // Pre-compute Gaussian kernel
        var kernel = [];
        for (var dy = -radius; dy <= radius; dy++) {
            var kRow = [];
            for (var dx = -radius; dx <= radius; dx++) {
                kRow.push(Math.exp(-(dx*dx + dy*dy) / (2 * smoothing * smoothing)));
            }
            kernel.push(kRow);
        }

        // Apply smoothing only to cells above threshold, sampling only from above-threshold neighbors
        var smoothed = [];
        for (var m = 0; m < numRows; m++) {
            var sRow = [];
            for (var r = 0; r < numCols2; r++) {
                if (resultCells[m][r].correction === null) { sRow.push(null); continue; }
                var wSum = 0, wTotal = 0;
                for (var dy = -radius; dy <= radius; dy++) {
                    for (var dx = -radius; dx <= radius; dx++) {
                        var nm = m + dy, nr = r + dx;
                        if (nm < 0 || nm >= numRows || nr < 0 || nr >= numCols2) continue;
                        if (resultCells[nm][nr].correction === null) continue;
                        var w = kernel[dy + radius][dx + radius];
                        wSum += resultCells[nm][nr].correction * w;
                        wTotal += w;
                    }
                }
                sRow.push(wTotal > 0 ? wSum / wTotal : resultCells[m][r].correction);
            }
            smoothed.push(sRow);
        }

        // Write smoothed values back
        for (var m = 0; m < numRows; m++) {
            for (var r = 0; r < numCols2; r++) {
                if (smoothed[m][r] !== null) resultCells[m][r].correction = smoothed[m][r];
            }
        }

        // Recompute stats after smoothing
        totalCorrMag = 0; maxCorr = 0; minCorr = 0;
        for (var m = 0; m < numRows; m++) {
            for (var r = 0; r < numCols2; r++) {
                var c = resultCells[m][r];
                if (c.correction !== null) {
                    totalCorrMag += Math.abs(c.correction);
                    if (c.correction > maxCorr) maxCorr = c.correction;
                    if (c.correction < minCorr) minCorr = c.correction;
                }
            }
        }
    }

    // 9. Build output CSVs
    var diffRows = ['MAP \\ RPM,' + rpmBreakpoints.map(function(v){return Math.round(v);}).join(',')];
    var hitRows = ['MAP \\ RPM,' + rpmBreakpoints.map(function(v){return Math.round(v);}).join(',')];
    var stddevRows = ['MAP \\ RPM,' + rpmBreakpoints.map(function(v){return Math.round(v);}).join(',')];

    for (var m = 0; m < mapBreakpoints.length; m++) {
        var dRow = [mapBreakpoints[m].toFixed(1)];
        var hRow = [mapBreakpoints[m].toFixed(1)];
        var sRow = [mapBreakpoints[m].toFixed(1)];
        for (var r = 0; r < rpmBreakpoints.length; r++) {
            var c = resultCells[m][r];
            dRow.push(c.correction !== null ? c.correction.toFixed(2) : '');
            hRow.push(String(c.count));
            sRow.push(c.stddev !== null ? c.stddev.toFixed(2) : '');
        }
        diffRows.push(dRow.join(','));
        hitRows.push(hRow.join(','));
        stddevRows.push(sRow.join(','));
    }

    // New VE values CSV
    var newValuesCsv = null;
    if (veTable) {
        var newRows = [];
        newRows.push('AxisValues1:,' + veTable.mapBreakpoints.map(function(v){return Math.round(v*10);}).join(','));
        newRows.push('AxisValues2:,' + veTable.rpmBreakpoints.map(function(v){return Math.round(v);}).join(','));
        newRows.push('CellValues:');
        for (var m = 0; m < veTable.mapBreakpoints.length; m++) {
            var row = [];
            for (var r = 0; r < veTable.rpmBreakpoints.length; r++) {
                var origVE = veTable.values[m] && veTable.values[m][r] !== undefined ? veTable.values[m][r] : 0;
                var c = resultCells[m] && resultCells[m][r] ? resultCells[m][r] : null;
                if (c && c.correction !== null && c.correction !== 0) {
                    row.push(Math.round(origVE * (1 + c.correction / 100) * 10));
                } else {
                    row.push(Math.round(origVE * 10));
                }
            }
            newRows.push(row.join(','));
        }
        newValuesCsv = newRows.join('\n');
    }

    return {
        diffCsv: diffRows.join('\n'),
        hitCsv: hitRows.join('\n'),
        stddevCsv: stddevRows.join('\n'),
        newValuesCsv: newValuesCsv,
        grid: { mapBreakpoints: mapBreakpoints, rpmBreakpoints: rpmBreakpoints, cells: resultCells },
        stats: { cellsAboveThreshold: cellsAboveThreshold, totalCells: mapBreakpoints.length * rpmBreakpoints.length, avgCorrection: cellsAboveThreshold > 0 ? totalCorrMag / cellsAboveThreshold : 0, maxCorrection: maxCorr, minCorrection: minCorr },
        filterStats: filterStats,
        logStats: { totalSamples: logData.samples.length, channelWarnings: logData.channelIndices.warnings },
        settings: { hitThreshold: hitThreshold, minCoolantTemp: minCoolantTemp, minRunTime: minRunTime, minChangeAmount: minChangeAmount, scalingFactor: scalingFactor * 100, outlierSigma: outlierSigma, maxTpsRate: maxTpsRate, smoothing: smoothing },
    };
}

// ---------------------------------------------------------------------------
// Worker Message Handler
// ---------------------------------------------------------------------------

self.onmessage = function(event) {
    var msg = event.data;
    if (!msg || msg.type !== 'analyze') return;

    try {
        self.postMessage({ type: 'progress', phase: 'Starting analysis...', percent: 5 });

        var result = runVEAnalysis(msg.logText, msg.veTableText || null, msg.settings || {}, function(phase, pct) {
            self.postMessage({ type: 'progress', phase: phase, percent: pct });
        });

        self.postMessage({ type: 'progress', phase: 'Complete', percent: 100 });
        self.postMessage({
            type: 'result',
            diffCsv: result.diffCsv,
            hitCsv: result.hitCsv,
            stddevCsv: result.stddevCsv,
            newValuesCsv: result.newValuesCsv,
            stats: result.stats,
            filterStats: result.filterStats,
            logStats: result.logStats,
            grid: result.grid,
            settings: result.settings,
        });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error during analysis.' });
    }
};
