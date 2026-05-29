/**
 * haltech/ve-table/worker.js — Haltech Nexus VE Table Analyzer Worker
 *
 * Parses Haltech NSP CSV logs and VE table exports to compute per-cell
 * correction percentages, matching the MoTeC VE analysis workflow.
 *
 * Inputs:
 *   - NSP datalog CSV (multi-rate, integer-scaled values)
 *   - VE table CSV export from NSP (optional — for producing corrected table)
 *
 * Outputs:
 *   - Correction grid (% change needed per MAP×RPM cell)
 *   - New VE values (if table provided)
 *   - Hit count grid
 *   - Statistics and warnings
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var HIT_THRESHOLD = 50;
var HALTECH_NO_DATA = -2147483638;  // Sentinel for missing/invalid data
var HALTECH_NO_DATA2 = -2147483628;
var HALTECH_NO_DATA3 = -2147483614;
var HALTECH_NO_DATA4 = -2147483608;

// Scaling factors for Haltech raw integer values
var SCALE = {
    RPM: 1,           // raw = RPM
    PRESSURE: 0.1,    // raw / 10 = kPa (stored as mbar * 0.1)
    LAMBDA: 0.001,    // raw / 1000 = lambda
    PERCENT: 0.1,     // raw / 10 = %
    TEMP_K: 0.1,      // raw / 10 = Kelvin; subtract 273.15 for Celsius
};

// ---------------------------------------------------------------------------
// Haltech Log Parser
// ---------------------------------------------------------------------------

/**
 * Parses a Haltech NSP datalog CSV file.
 *
 * Format:
 *   - Header section: %DataLog% marker, then Channel/ID/Type/DisplayMaxMin blocks
 *   - Data section: starts after "Log : <date>" line
 *   - Each data row: timestamp,val1,val2,...valN (integers, empty = no update)
 *   - Multi-rate: not all channels update every row; empty fields mean "hold previous"
 *
 * @param {string} text - Raw CSV file content
 * @param {function} onProgress - Called with (rowsProcessed, totalRows)
 * @returns {Object} { channels, data, sampleCount, duration }
 */
function parseHaltechLog(text, onProgress) {
    var lines = text.split('\n');
    var channels = [];
    var dataStartLine = -1;

    // Parse header — extract channel names in order
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

    // Resolve VE-relevant channel indices
    var ch = resolveHaltechChannels(channels);

    // Parse data rows — handle multi-rate (empty = hold previous value)
    var numCols = channels.length;
    var samples = [];
    var currentValues = new Array(numCols);
    for (var c = 0; c < numCols; c++) currentValues[c] = NaN;

    var totalDataLines = lines.length - dataStartLine;
    var lastProgress = 0;

    for (var i = dataStartLine; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;

        var fields = line.split(',');
        // First field is timestamp (HH:MM:SS.mmm)
        var timestamp = fields[0];

        // Update current values where fields are non-empty
        for (var c = 0; c < numCols; c++) {
            var fieldIdx = c + 1; // +1 for timestamp column
            if (fieldIdx < fields.length && fields[fieldIdx] !== '') {
                var raw = parseInt(fields[fieldIdx], 10);
                if (!isNaN(raw)) {
                    currentValues[c] = raw;
                }
            }
        }

        // Extract a sample if we have valid RPM and MAP
        var rpmRaw = ch.rpmIdx >= 0 ? currentValues[ch.rpmIdx] : NaN;
        var mapRaw = ch.mapIdx >= 0 ? currentValues[ch.mapIdx] : NaN;

        if (!isNaN(rpmRaw) && !isNaN(mapRaw) && !isHaltechInvalid(rpmRaw) && !isHaltechInvalid(mapRaw)) {
            var sample = {
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
            };
            samples.push(sample);
        }

        // Progress
        var processed = i - dataStartLine;
        if (processed - lastProgress >= 5000 || i === lines.length - 1) {
            lastProgress = processed;
            if (onProgress) onProgress(processed, totalDataLines);
        }
    }

    return {
        channels: channels,
        channelIndices: ch,
        samples: samples,
        sampleCount: samples.length,
    };
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
    return raw * 0.1 - 273.15; // Kelvin to Celsius
}

// ---------------------------------------------------------------------------
// Channel Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves VE-relevant channels from the Haltech channel name list.
 * Matching is case-insensitive with fallback candidates.
 */
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

    // Validate required channels
    if (result.rpmIdx === -1) throw new Error('Required channel "RPM" not found in log.');
    if (result.mapIdx === -1) throw new Error('Required channel "Manifold Pressure" or "Fuel - Load (MAP)" not found.');
    if (result.targetLambdaIdx === -1) throw new Error('Required channel "Target Lambda" not found.');
    if (result.wb1Idx === -1 && result.wb2Idx === -1 && result.wbOverallIdx === -1) {
        throw new Error('No wideband lambda channel found (need "Wideband O2 Bank 1/2" or "Wideband O2 Overall").');
    }

    // Warnings for optional channels
    if (result.stftB1Idx === -1) result.warnings.push('Short Term Fuel Trim Bank 1 not found — using 0.');
    if (result.ltftB1Idx === -1) result.warnings.push('Long Term Fuel Trim Bank 1 not found — using 0.');
    if (result.coolantIdx === -1) result.warnings.push('Coolant Temperature not found — temp filter disabled.');

    return result;
}

// ---------------------------------------------------------------------------
// VE Table Parser
// ---------------------------------------------------------------------------

/**
 * Parses a Haltech NSP VE table CSV export.
 *
 * Format:
 *   AxisChannel1: <id>
 *   AxisBehaviour1: <n>
 *   AxisValues1:,<val1>,<val2>,...  (MAP breakpoints in mbar)
 *   AxisChannel2: <id>
 *   AxisBehaviour2: <n>
 *   AxisValues2:,<val1>,<val2>,...  (RPM breakpoints)
 *   TableUnits: <n>
 *   CellValues:
 *   <row0 values>
 *   <row1 values>
 *   ...
 *
 * @param {string} text - Raw VE table CSV content
 * @returns {Object} { mapBreakpoints, rpmBreakpoints, values (2D), rawValues }
 */
function parseHaltechVETable(text) {
    var lines = text.split('\n');
    var mapBreakpoints = [];
    var rpmBreakpoints = [];
    var values = [];
    var inCellValues = false;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();

        if (line.startsWith('AxisValues1:')) {
            // MAP axis (rows) — values in mbar, convert to kPa
            var parts = line.split(',');
            for (var p = 1; p < parts.length; p++) {
                var v = parseFloat(parts[p]);
                if (!isNaN(v)) mapBreakpoints.push(v * 0.1); // mbar -> kPa
            }
        } else if (line.startsWith('AxisValues2:')) {
            // RPM axis (columns)
            var parts = line.split(',');
            for (var p = 1; p < parts.length; p++) {
                var v = parseFloat(parts[p]);
                if (!isNaN(v)) rpmBreakpoints.push(v);
            }
        } else if (line.startsWith('CellValues:')) {
            inCellValues = true;
        } else if (inCellValues && line !== '') {
            // Parse a row of VE values
            var fields = line.split(',');
            var row = [];
            for (var f = 0; f < fields.length; f++) {
                var v = parseFloat(fields[f]);
                if (!isNaN(v)) row.push(v / 10.0); // VE stored as value * 10
            }
            if (row.length > 0) values.push(row);
        }
    }

    if (mapBreakpoints.length === 0 || rpmBreakpoints.length === 0) {
        throw new Error('Could not parse VE table axes. Expected AxisValues1 (MAP) and AxisValues2 (RPM).');
    }
    if (values.length === 0) {
        throw new Error('No VE cell values found after CellValues: marker.');
    }

    return {
        mapBreakpoints: mapBreakpoints,
        rpmBreakpoints: rpmBreakpoints,
        values: values,
    };
}

// ---------------------------------------------------------------------------
// Correction Calculator
// ---------------------------------------------------------------------------

/**
 * Computes the VE correction for a single sample.
 *
 * Formula: correction = (targetLambda / actualLambda - 1) * 100 + totalTrim
 *
 * A positive correction means the VE table is too low (engine running lean).
 * A negative correction means the VE table is too high (engine running rich).
 *
 * @param {Object} sample - Parsed log sample
 * @returns {Object} { correction, lambdaActual, totalTrim, isValid }
 */
function computeCorrection(sample) {
    // Determine actual lambda (prefer bank average, fall back to individual)
    var b1Valid = !isNaN(sample.lambdaB1) && sample.lambdaB1 > 0.5 && sample.lambdaB1 < 2.0;
    var b2Valid = !isNaN(sample.lambdaB2) && sample.lambdaB2 > 0.5 && sample.lambdaB2 < 2.0;

    var lambdaActual;
    if (b1Valid && b2Valid) {
        lambdaActual = (sample.lambdaB1 + sample.lambdaB2) / 2;
    } else if (b1Valid) {
        lambdaActual = sample.lambdaB1;
    } else if (b2Valid) {
        lambdaActual = sample.lambdaB2;
    } else {
        return { correction: NaN, lambdaActual: NaN, totalTrim: 0, isValid: false };
    }

    // Target lambda validity
    var targetValid = !isNaN(sample.lambdaTarget) && sample.lambdaTarget > 0.5 && sample.lambdaTarget < 2.0;
    if (!targetValid) {
        return { correction: NaN, lambdaActual: lambdaActual, totalTrim: 0, isValid: false };
    }

    // Fuel trims (STFT + LTFT averaged across banks)
    var stft = 0;
    var ltft = 0;
    var stftB1 = !isNaN(sample.stftB1) ? sample.stftB1 : 0;
    var stftB2 = !isNaN(sample.stftB2) ? sample.stftB2 : 0;
    var ltftB1 = !isNaN(sample.ltftB1) ? sample.ltftB1 : 0;
    var ltftB2 = !isNaN(sample.ltftB2) ? sample.ltftB2 : 0;

    if (b1Valid && b2Valid) {
        stft = (stftB1 + stftB2) / 2;
        ltft = (ltftB1 + ltftB2) / 2;
    } else if (b1Valid) {
        stft = stftB1;
        ltft = ltftB1;
    } else {
        stft = stftB2;
        ltft = ltftB2;
    }

    var totalTrim = stft + ltft;

    // Correction formula: how much the VE needs to change
    var correction = ((sample.lambdaTarget / lambdaActual) - 1) * 100 + totalTrim;

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
// Filtering
// ---------------------------------------------------------------------------

/**
 * Determines if a sample should be included in the VE correction analysis.
 * Filters out transient conditions that would skew the results.
 */
function shouldIncludeSample(sample, prevSample) {
    // Must have valid RPM above idle
    if (sample.rpm < 400) return false;

    // Coolant temp filter: engine must be warm (>60°C)
    if (!isNaN(sample.coolant) && sample.coolant < 60) return false;

    // Lambda must be in a reasonable range
    // (the correction calculator will also validate, but pre-filter here)
    var b1Ok = !isNaN(sample.lambdaB1) && sample.lambdaB1 > 0.6 && sample.lambdaB1 < 1.8;
    var b2Ok = !isNaN(sample.lambdaB2) && sample.lambdaB2 > 0.6 && sample.lambdaB2 < 1.8;
    if (!b1Ok && !b2Ok) return false;

    return true;
}

// ---------------------------------------------------------------------------
// Output Builder
// ---------------------------------------------------------------------------

/**
 * Builds the correction CSV and (optionally) the new VE values CSV.
 */
function buildOutputs(grid, veTable) {
    // Correction/difference CSV
    var diffRows = [];
    var diffHeader = ['MAP \\ RPM'];
    for (var r = 0; r < grid.rpmBreakpoints.length; r++) {
        diffHeader.push(String(Math.round(grid.rpmBreakpoints[r])));
    }
    diffRows.push(diffHeader.join(','));

    var cellsAboveThreshold = 0;
    var totalCorrection = 0;
    var maxCorrection = 0;
    var minCorrection = 0;

    for (var m = 0; m < grid.mapBreakpoints.length; m++) {
        var row = [String(grid.mapBreakpoints[m].toFixed(1))];
        for (var r = 0; r < grid.rpmBreakpoints.length; r++) {
            var cell = grid.cells[m][r];
            if (cell.count > HIT_THRESHOLD) {
                var avg = cell.correctionSum / cell.count;
                row.push(avg.toFixed(2));
                cellsAboveThreshold++;
                totalCorrection += Math.abs(avg);
                if (avg > maxCorrection) maxCorrection = avg;
                if (avg < minCorrection) minCorrection = avg;
            } else {
                row.push('');
            }
        }
        diffRows.push(row.join(','));
    }

    // Hit count CSV
    var hitRows = [];
    hitRows.push(diffHeader.join(','));
    for (var m = 0; m < grid.mapBreakpoints.length; m++) {
        var row = [String(grid.mapBreakpoints[m].toFixed(1))];
        for (var r = 0; r < grid.rpmBreakpoints.length; r++) {
            row.push(String(grid.cells[m][r].count));
        }
        hitRows.push(row.join(','));
    }

    // New VE values (if table provided)
    var newValuesCsv = null;
    if (veTable) {
        var newRows = [];
        // Reproduce the Haltech format
        newRows.push('AxisValues1:,' + veTable.mapBreakpoints.map(function(v) { return Math.round(v * 10); }).join(','));
        newRows.push('AxisValues2:,' + veTable.rpmBreakpoints.map(function(v) { return Math.round(v); }).join(','));
        newRows.push('CellValues:');

        for (var m = 0; m < veTable.mapBreakpoints.length; m++) {
            var row = [];
            for (var r = 0; r < veTable.rpmBreakpoints.length; r++) {
                var originalVE = veTable.values[m] && veTable.values[m][r] !== undefined ? veTable.values[m][r] : 0;
                var cell = grid.cells[m] && grid.cells[m][r] ? grid.cells[m][r] : null;

                if (cell && cell.count > HIT_THRESHOLD) {
                    var correction = cell.correctionSum / cell.count;
                    var newVE = originalVE * (1 + correction / 100);
                    row.push(Math.round(newVE * 10)); // Back to Haltech format (VE * 10)
                } else {
                    row.push(Math.round(originalVE * 10)); // Unchanged
                }
            }
            newRows.push(row.join(','));
        }
        newValuesCsv = newRows.join('\n');
    }

    return {
        diffCsv: diffRows.join('\n'),
        hitCsv: hitRows.join('\n'),
        newValuesCsv: newValuesCsv,
        stats: {
            cellsAboveThreshold: cellsAboveThreshold,
            totalCells: grid.mapBreakpoints.length * grid.rpmBreakpoints.length,
            avgCorrection: cellsAboveThreshold > 0 ? totalCorrection / cellsAboveThreshold : 0,
            maxCorrection: maxCorrection,
            minCorrection: minCorrection,
        }
    };
}

// ---------------------------------------------------------------------------
// Main Analysis Pipeline
// ---------------------------------------------------------------------------

function runVEAnalysis(logText, veTableText, onProgress) {
    // 1. Parse VE table (if provided) to get breakpoints
    var veTable = null;
    var mapBreakpoints, rpmBreakpoints;

    if (veTableText) {
        veTable = parseHaltechVETable(veTableText);
        mapBreakpoints = veTable.mapBreakpoints;
        rpmBreakpoints = veTable.rpmBreakpoints;
    } else {
        // Default breakpoints if no table provided
        mapBreakpoints = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 106.3, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300];
        rpmBreakpoints = [0, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000];
    }

    // 2. Parse log
    var logData = parseHaltechLog(logText, function(done, total) {
        if (onProgress) onProgress('Parsing log...', 5 + Math.round(done / total * 30));
    });

    if (logData.samples.length < 100) {
        throw new Error('Not enough valid samples in log (' + logData.samples.length + '). Need at least 100.');
    }

    // 3. Create accumulator grid
    var grid = createGrid(mapBreakpoints, rpmBreakpoints);

    // 4. Process samples: filter, compute correction, accumulate
    if (onProgress) onProgress('Computing corrections...', 40);
    var validSamples = 0;
    var filteredOut = 0;
    var prevSample = null;

    for (var i = 0; i < logData.samples.length; i++) {
        var sample = logData.samples[i];

        if (!shouldIncludeSample(sample, prevSample)) {
            filteredOut++;
            prevSample = sample;
            continue;
        }

        var result = computeCorrection(sample);
        if (!result.isValid) {
            prevSample = sample;
            continue;
        }

        // Bin into grid using the load axis (fuelLoad if available, else map)
        var loadValue = !isNaN(sample.fuelLoad) ? sample.fuelLoad : sample.map;
        var mapIdx = findNearest(loadValue, mapBreakpoints);
        var rpmIdx = findNearest(sample.rpm, rpmBreakpoints);

        if (mapIdx >= 0 && rpmIdx >= 0) {
            grid.cells[mapIdx][rpmIdx].count++;
            grid.cells[mapIdx][rpmIdx].correctionSum += result.correction;
            grid.cells[mapIdx][rpmIdx].trimSum += result.totalTrim;
            validSamples++;
        }

        prevSample = sample;

        if (i % 10000 === 0 && onProgress) {
            onProgress('Processing samples...', 40 + Math.round(i / logData.samples.length * 40));
        }
    }

    // 5. Build outputs
    if (onProgress) onProgress('Building outputs...', 85);
    var outputs = buildOutputs(grid, veTable);

    return {
        diffCsv: outputs.diffCsv,
        hitCsv: outputs.hitCsv,
        newValuesCsv: outputs.newValuesCsv,
        stats: outputs.stats,
        logStats: {
            totalSamples: logData.samples.length,
            validSamples: validSamples,
            filteredOut: filteredOut,
            channelWarnings: logData.channelIndices.warnings,
        },
        grid: grid,
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

        var result = runVEAnalysis(msg.logText, msg.veTableText || null, function(phase, pct) {
            self.postMessage({ type: 'progress', phase: phase, percent: pct });
        });

        self.postMessage({ type: 'progress', phase: 'Complete', percent: 100 });
        self.postMessage({
            type: 'result',
            diffCsv: result.diffCsv,
            hitCsv: result.hitCsv,
            newValuesCsv: result.newValuesCsv,
            stats: result.stats,
            logStats: result.logStats,
            grid: result.grid,
        });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || 'Unknown error during analysis.' });
    }
};
