/**
 * worker.js — Worker thread: all heavy computation.
 * Contains: VE_Parser, Log_Parser, Bin_Assigner, Hit_Counter,
 *           Correction_Calculator, Output_Builder, and the onmessage handler.
 * Implemented in tasks 2–8.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum number of samples a cell must have to be included in the output.
 * A cell is above threshold only when count is STRICTLY MORE THAN 50.
 * Cells with exactly 50 samples are below threshold and are excluded.
 */
const HIT_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// formatScientific — Task 2.1
// ---------------------------------------------------------------------------

/**
 * Formats a number as MoTeC-style scientific notation with 17 significant digits.
 *
 * MoTeC format: lowercase 'e', sign always present on exponent (+ or -),
 * exponent is always at least 2 digits (zero-padded if needed).
 *
 * Example: 57.2041153907775879 → "5.72041153907775879e+01"
 *
 * @param {number} value
 * @returns {string}
 */
function formatScientific(value) {
    // toExponential(17) gives 17 digits after the decimal point (18 significant digits total),
    // lowercase 'e', and a sign on the exponent. However, the exponent may be only 1 digit
    // (e.g. "1.23456789012345678e+1") — we need to zero-pad it to at least 2 digits.
    const raw = value.toExponential(17);

    // Split on 'e' — the mantissa part is already correct.
    const eIdx = raw.indexOf('e');
    const mantissa = raw.slice(0, eIdx);   // e.g. "5.72041153907775879"
    const expPart  = raw.slice(eIdx + 1);  // e.g. "+1" or "-9" or "+01"

    // expPart always starts with '+' or '-' from toExponential.
    const sign    = expPart[0];            // '+' or '-'
    const digits  = expPart.slice(1);      // e.g. "1" or "01" or "100"

    // Zero-pad to at least 2 digits.
    const paddedExp = digits.length < 2 ? digits.padStart(2, '0') : digits;

    return `${mantissa}e${sign}${paddedExp}`;
}

// ---------------------------------------------------------------------------
// findNearestBreakpoint — Task 4.1
// ---------------------------------------------------------------------------

/**
 * Returns the index of the breakpoint nearest to `value`.
 *
 * Algorithm: linear scan tracking minimum |value - breakpoints[i]|.
 * On a tie (equal distance), the lower index wins (first minimum found is kept).
 *
 * @param {number} value        — the RPM or MAP value to bin
 * @param {number[]} breakpoints — sorted ascending array of breakpoints
 * @returns {number}            — index of the nearest breakpoint, or -1 if value is NaN
 */
function findNearestBreakpoint(value, breakpoints) {
    if (Number.isNaN(value)) {
        return -1;
    }

    let bestIdx = 0;
    let bestDist = Math.abs(value - breakpoints[0]);

    for (let i = 1; i < breakpoints.length; i++) {
        const dist = Math.abs(value - breakpoints[i]);
        // Strictly less than: on a tie we keep the lower index (first minimum found).
        if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
        }
    }

    return bestIdx;
}

// ---------------------------------------------------------------------------
// Hit_Counter — Task 4.4
// ---------------------------------------------------------------------------

/**
 * Creates a fresh AccumulatorGrid with all cells initialised to { count: 0, correctionSum: 0 }.
 *
 * The grid is indexed as cells[mapIdx][rpmIdx], where:
 *   - mapIdx  ranges from 0 to mapBreakpoints.length - 1
 *   - rpmIdx  ranges from 0 to rpmBreakpoints.length - 1
 *
 * @param {number[]} mapBreakpoints  — MAP axis breakpoints (rows)
 * @param {number[]} rpmBreakpoints  — RPM axis breakpoints (columns)
 * @returns {{ mapBreakpoints: number[], rpmBreakpoints: number[], cells: Array<Array<{count: number, correctionSum: number}>> }}
 */
function createAccumulatorGrid(mapBreakpoints, rpmBreakpoints) {
    const cells = [];
    for (let mapIdx = 0; mapIdx < mapBreakpoints.length; mapIdx++) {
        const row = [];
        for (let rpmIdx = 0; rpmIdx < rpmBreakpoints.length; rpmIdx++) {
            row.push({ count: 0, correctionSum: 0, clTrimSum: 0, lambdaErrSum: 0 });
        }
        cells.push(row);
    }
    return { mapBreakpoints, rpmBreakpoints, cells };
}

/**
 * Accumulates one valid sample into the grid cell at [mapIdx][rpmIdx].
 *
 * Adds `weight` (default 1) to the cell's count and the weighted correction to its correctionSum. A sample
 * between breakpoints is shared between neighbouring cells by interpolation weight (see axisWeights).
 *
 * @param {{ cells: Array<Array<{count: number, correctionSum: number}>> }} grid
 * @param {number} mapIdx    — row index
 * @param {number} rpmIdx    — column index
 * @param {number} correction — per-sample correction value to accumulate
 */
function accumulateSample(grid, mapIdx, rpmIdx, correction, clTrimAvg, weight, lambdaError) {
    const w = weight === undefined ? 1 : weight;
    const cell = grid.cells[mapIdx][rpmIdx];
    cell.count += w;
    cell.correctionSum += correction * w;
    cell.clTrimSum += (clTrimAvg || 0) * w;
    cell.lambdaErrSum += (lambdaError || 0) * w;
}

// ---------------------------------------------------------------------------
// parseVETable — Task 2.3
// ---------------------------------------------------------------------------

/**
 * Splits a single CSV line into fields, stripping surrounding double-quotes
 * and leading/trailing whitespace from each field.
 *
 * This is a simple split-on-comma approach that handles the M1 v2 format
 * where fields are either bare or fully quoted (no embedded commas in quotes).
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
    return line.split(',').map(field => {
        const trimmed = field.trim();
        // Strip surrounding double-quotes if present.
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            return trimmed.slice(1, -1);
        }
        return trimmed;
    });
}

/**
 * Parses an M1 v2 format VE table CSV and returns a VETable object.
 *
 * Expected format (0-indexed rows):
 *   Row 0: M1,v2
 *   Row 1: Body,<unit>
 *   Row 2: Cols,rpm,Eng Speed
 *   Row 3: Rows,kPa,Inlet Man Pres
 *   Row 4: <empty label>,<RPM breakpoints as quoted scientific-notation floats>
 *   Row 5+: <MAP breakpoint>,<VE values as quoted scientific-notation floats>
 *
 * @param {string} text  — full CSV text
 * @returns {{
 *   rpmBreakpoints:  number[],
 *   mapBreakpoints:  number[],
 *   values:          number[][],
 *   rpmRawStrings:   string[],
 *   mapRawStrings:   string[],
 *   valueRawStrings: string[][],
 * }}
 * @throws {Error} on format validation failures or non-numeric cells
 */
function parseVETable(text) {
    // Strip null bytes that some editors/tools may leave at the end of files.
    text = text.replace(/\0/g, '');

    // Split into non-empty lines (handles \r\n and \n).
    const lines = text.split('\n')
        .map(l => l.replace(/\r$/, ''))
        .filter(l => l.trim() !== '');

    if (lines.length < 5) {
        throw new Error(
            'VE table CSV is too short: expected at least 5 rows but got ' + lines.length
        );
    }

    // --- Row 0: validate M1 / v2 header ---
    const row0 = splitCsvLine(lines[0]);
    const field0 = row0[0] !== undefined ? row0[0].trim() : '';
    const field1 = row0[1] !== undefined ? row0[1].trim() : '';
    if (field0 !== 'M1' || field1 !== 'v2') {
        throw new Error(
            `VE table CSV has unrecognised format: expected "M1" and "v2" in row 1, ` +
            `but found "${field0}" and "${field1}". ` +
            `This file does not appear to be a MoTeC M1 v2 VE table.`
        );
    }

    // --- Row 4 (0-indexed): RPM breakpoints ---
    const row4 = splitCsvLine(lines[4]);
    // Field 0 is the empty label; fields 1+ are RPM breakpoints.
    const rpmRawStrings = [];
    const rpmBreakpoints = [];
    for (let i = 1; i < row4.length; i++) {
        const raw = row4[i];
        rpmRawStrings.push(raw);
        const val = parseFloat(raw);
        if (isNaN(val)) {
            throw new Error(
                `VE table CSV: non-numeric RPM breakpoint at row 5, field ${i + 1}: "${raw}"`
            );
        }
        rpmBreakpoints.push(Math.round(val));
    }

    // --- Rows 5+ (0-indexed): MAP breakpoints and VE values ---
    const mapRawStrings = [];
    const mapBreakpoints = [];
    const values = [];
    const valueRawStrings = [];

    for (let rowIdx = 5; rowIdx < lines.length; rowIdx++) {
        const row = splitCsvLine(lines[rowIdx]);
        const mapRaw = row[0];
        mapRawStrings.push(mapRaw);

        const mapVal = parseFloat(mapRaw);
        if (isNaN(mapVal)) {
            throw new Error(
                `VE table CSV: non-numeric MAP breakpoint at row ${rowIdx + 1}, field 1: "${mapRaw}"`
            );
        }
        mapBreakpoints.push(Math.round(mapVal));

        const veRow = [];
        const veRawRow = [];
        for (let colIdx = 1; colIdx < row.length; colIdx++) {
            const raw = row[colIdx];
            veRawRow.push(raw);
            const val = parseFloat(raw);
            if (isNaN(val)) {
                throw new Error(
                    `VE table CSV: non-numeric VE value at row ${rowIdx + 1}, column ${colIdx + 1}: "${raw}"`
                );
            }
            veRow.push(val);
        }
        values.push(veRow);
        valueRawStrings.push(veRawRow);
    }

    return {
        rpmBreakpoints,
        mapBreakpoints,
        values,
        rpmRawStrings,
        mapRawStrings,
        valueRawStrings,
    };
}

// ---------------------------------------------------------------------------
// resolveChannels — Task 3.1
// ---------------------------------------------------------------------------

/**
 * Channel name constants (canonical, lowercase for matching).
 */
const CHANNEL_NAMES = {
    RPM:           'engine speed',
    MAP:           'inlet manifold pressure',
    LAMBDA_B1:     'exhaust lambda bank 1',
    LAMBDA_B2:     'exhaust lambda bank 2',
    LAMBDA_AVG:    'exhaust lambda',
    LAMBDA_TARGET: 'fuel mixture aim',
    CL_TRIM_B1:    'fuel closed loop control bank 1 trim',
    CL_TRIM_B2:    'fuel closed loop control bank 2 trim',
    COOLANT_TEMP:  'coolant temperature',
    THROTTLE_POS:  'throttle position',
    OVERRUN_STATE: 'engine overrun state',      // optional: non-zero during overrun fuel cut
    FUEL_CUT_COUNT:'fuel output cut count',     // optional: counts fuel cuts (changes when one happens; wraps at 255)
};

/**
 * Resolves the 8 known channels from an array of column name strings.
 *
 * Matching is case-insensitive and whitespace-trimmed. Lambda_Avg ("Exhaust Lambda")
 * is only used as a fallback when BOTH Lambda_B1 and Lambda_B2 are absent.
 *
 * @param {string[]} columnNames  — array of column name strings (already stripped of quotes/whitespace)
 * @returns {{
 *   rpmIdx:          number,   // 0-based column index, or -1 if not found
 *   mapIdx:          number,
 *   lambdaB1Idx:     number,
 *   lambdaB2Idx:     number,
 *   lambdaAvgIdx:    number,
 *   lambdaTargetIdx: number,
 *   clTrimB1Idx:     number,
 *   clTrimB2Idx:     number,
 *   warnings:        string[],
 * }}
 * @throws {Error} if RPM, MAP, Lambda_Target, or all lambda sources are missing
 */
function resolveChannels(columnNames) {
    // Build a lookup: normalised name → first index
    const nameToIdx = new Map();
    for (let i = 0; i < columnNames.length; i++) {
        const normalised = columnNames[i].trim().toLowerCase();
        if (!nameToIdx.has(normalised)) {
            nameToIdx.set(normalised, i);
        }
    }

    const find = (canonical) => {
        const idx = nameToIdx.get(canonical);
        return idx !== undefined ? idx : -1;
    };

    const rpmIdx          = find(CHANNEL_NAMES.RPM);
    const mapIdx          = find(CHANNEL_NAMES.MAP);
    const lambdaB1Idx     = find(CHANNEL_NAMES.LAMBDA_B1);
    const lambdaB2Idx     = find(CHANNEL_NAMES.LAMBDA_B2);
    const lambdaTargetIdx = find(CHANNEL_NAMES.LAMBDA_TARGET);
    const clTrimB1Idx     = find(CHANNEL_NAMES.CL_TRIM_B1);
    const clTrimB2Idx     = find(CHANNEL_NAMES.CL_TRIM_B2);
    const coolantTempIdx  = find(CHANNEL_NAMES.COOLANT_TEMP);
    const throttlePosIdx  = find(CHANNEL_NAMES.THROTTLE_POS);
    const overrunStateIdx = find(CHANNEL_NAMES.OVERRUN_STATE);
    const fuelCutCountIdx = find(CHANNEL_NAMES.FUEL_CUT_COUNT);

    // Lambda_Avg is only used when BOTH bank channels are absent.
    const hasBankLambda = lambdaB1Idx !== -1 || lambdaB2Idx !== -1;
    const lambdaAvgIdx  = hasBankLambda ? -1 : find(CHANNEL_NAMES.LAMBDA_AVG);

    // --- Fatal errors ---
    const errors = [];

    if (rpmIdx === -1) {
        errors.push('Required channel not found: "Engine Speed" (RPM)');
    }
    if (mapIdx === -1) {
        errors.push('Required channel not found: "Inlet Manifold Pressure" (MAP)');
    }
    if (lambdaTargetIdx === -1) {
        errors.push('Required channel not found: "Fuel Mixture Aim" (Lambda_Target)');
    }
    if (!hasBankLambda && lambdaAvgIdx === -1) {
        errors.push(
            'No lambda source found: channels "Exhaust Lambda Bank 1", ' +
            '"Exhaust Lambda Bank 2", and "Exhaust Lambda" are all absent'
        );
    }

    if (errors.length > 0) {
        throw new Error(errors.join('; '));
    }

    // --- Non-fatal warnings ---
    const warnings = [];

    if (clTrimB1Idx === -1) {
        warnings.push(
            'Optional channel not found: "Fuel Closed Loop Control Bank 1 Trim" (CL_Trim_B1) — using 0.0'
        );
    }
    if (clTrimB2Idx === -1) {
        warnings.push(
            'Optional channel not found: "Fuel Closed Loop Control Bank 2 Trim" (CL_Trim_B2) — using 0.0'
        );
    }
    if (coolantTempIdx === -1) {
        warnings.push(
            'Optional channel not found: "Coolant Temperature" — coolant temperature filter will be disabled'
        );
    }
    if (throttlePosIdx === -1) {
        warnings.push(
            'Optional channel not found: "Throttle Position" — TPS rate filter will be disabled'
        );
    }

    return {
        rpmIdx,
        mapIdx,
        lambdaB1Idx,
        lambdaB2Idx,
        lambdaAvgIdx,
        lambdaTargetIdx,
        clTrimB1Idx,
        clTrimB2Idx,
        coolantTempIdx,
        throttlePosIdx,
        overrunStateIdx,
        fuelCutCountIdx,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// parseLog — Task 3.3
// ---------------------------------------------------------------------------

/**
 * Parses a MoTeC M1 CSV log export and returns an array of LogSample objects.
 *
 * Algorithm:
 *  1. Split text into lines (handles \r\n and \n).
 *  2. Scan the first 25 lines for the header row: first field (stripped of
 *     quotes and whitespace) exactly equals "Time" (case-sensitive).
 *  3. Throw if not found.
 *  4. Skip the units row (headerRow + 1).
 *  5. Skip any subsequent rows where ALL fields are empty strings after trimming.
 *  6. Extract column names from the header row.
 *  7. Call resolveChannels() to get channel indices and warnings.
 *  8. Process data lines in batches of 500,000; call onProgress after each batch.
 *  9. Parse numeric values with parseFloat(); NaN for non-numeric/empty.
 * 10. Return { samples, channelWarnings }.
 *
 * @param {string} text  — full CSV text
 * @param {function(number, number): void} onProgress  — called with (rowsProcessed, totalRows)
 * @returns {{ samples: LogSample[], channelWarnings: string[] }}
 * @throws {Error} on fatal parse errors (missing Time header, missing required channels)
 */
function parseLog(text, onProgress) {
    const BATCH_SIZE = 500_000;

    // Strip null bytes that some editors/tools may leave at the end of files.
    text = text.replace(/\0/g, '');

    // --- Step 1: Split into lines, normalising \r\n → \n ---
    // We keep empty lines because we need to detect all-empty data rows.
    const lines = text.split('\n').map(l => l.replace(/\r$/, ''));

    // --- Step 2 & 3: Scan first 25 lines for the "Time" header row ---
    let headerRowIdx = -1;
    const scanLimit = Math.min(25, lines.length);
    for (let i = 0; i < scanLimit; i++) {
        const fields = splitCsvLine(lines[i]);
        // First field after stripping quotes and whitespace must be exactly "Time"
        if (fields[0] !== undefined && fields[0].trim() === 'Time') {
            headerRowIdx = i;
            break;
        }
    }

    if (headerRowIdx === -1) {
        throw new Error(
            'MoTeC log CSV: "Time" header row not found in the first 25 rows. ' +
            'This file does not appear to be a MoTeC M1 CSV export.'
        );
    }

    // --- Step 4: Skip units row (headerRow + 1) ---
    const unitsRowIdx = headerRowIdx + 1;

    // --- Step 5: Find first data row (skip all-empty rows after units row) ---
    let dataStartIdx = unitsRowIdx + 1;
    while (dataStartIdx < lines.length) {
        const fields = splitCsvLine(lines[dataStartIdx]);
        const allEmpty = fields.every(f => f.trim() === '');
        if (!allEmpty) break;
        dataStartIdx++;
    }

    // --- Step 6: Extract column names from header row ---
    const columnNames = splitCsvLine(lines[headerRowIdx]);

    // --- Step 7: Resolve channels ---
    const channelIndices = resolveChannels(columnNames);
    const channelWarnings = channelIndices.warnings;

    const {
        rpmIdx,
        mapIdx,
        lambdaB1Idx,
        lambdaB2Idx,
        lambdaAvgIdx,
        lambdaTargetIdx,
        clTrimB1Idx,
        clTrimB2Idx,
        coolantTempIdx,
        throttlePosIdx,
        overrunStateIdx,
        fuelCutCountIdx,
    } = channelIndices;

    // --- Step 8 & 9: Process data lines in batches ---
    const dataLines = lines.slice(dataStartIdx);
    const totalRows = dataLines.length;
    const samples = [];

    /**
     * Reads a numeric value from a pre-split fields array at the given index.
     * Returns NaN if the index is -1 (channel absent) or the value is non-numeric/empty.
     *
     * @param {string[]} fields
     * @param {number} idx
     * @returns {number}
     */
    const readNum = (fields, idx) => {
        if (idx === -1) return NaN;
        const raw = fields[idx];
        if (raw === undefined) return NaN;
        return parseFloat(raw);
    };

    let rowsProcessed = 0;

    for (let batchStart = 0; batchStart < dataLines.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, dataLines.length);

        for (let i = batchStart; i < batchEnd; i++) {
            const line = dataLines[i];

            // Skip lines that are entirely empty (trailing blank lines, etc.)
            if (line.trim() === '') continue;

            const fields = splitCsvLine(line);

            // Skip rows where all fields are empty (can appear mid-file in MoTeC exports)
            if (fields.every(f => f === '')) continue;

            const sample = {
                time:         readNum(fields, 0),
                rpm:          readNum(fields, rpmIdx),
                map:          readNum(fields, mapIdx),
                lambdaB1:     readNum(fields, lambdaB1Idx),
                lambdaB2:     readNum(fields, lambdaB2Idx),
                lambdaAvg:    readNum(fields, lambdaAvgIdx),
                lambdaTarget: readNum(fields, lambdaTargetIdx),
                clTrimB1:     readNum(fields, clTrimB1Idx),
                clTrimB2:     readNum(fields, clTrimB2Idx),
                coolantTemp:  readNum(fields, coolantTempIdx),
                throttlePos:  readNum(fields, throttlePosIdx),
                overrunState: readNum(fields, overrunStateIdx),
                fuelCutCount: readNum(fields, fuelCutCountIdx),
            };

            samples.push(sample);
        }

        rowsProcessed = batchEnd;

        // Call progress callback after each batch
        if (typeof onProgress === 'function') {
            onProgress(rowsProcessed, totalRows);
        }
    }

    return { samples, channelWarnings };
}

// ---------------------------------------------------------------------------
// computeSampleCorrection — Task 6.1
// ---------------------------------------------------------------------------

/**
 * Computes the VE correction for a single log sample.
 *
 * Lambda_Actual priority (Requirements 6.1, 6.2, 6.3):
 *   1. Both lambdaB1 and lambdaB2 are non-NaN and non-zero → average of the two.
 *   2. Exactly one of lambdaB1 / lambdaB2 is non-NaN and non-zero → use that one.
 *   3. Otherwise → use lambdaAvg.
 *
 * CL_Trim_Avg (Requirement 6.4):
 *   Mean of the non-NaN values from {clTrimB1, clTrimB2}.
 *   If both are NaN (or absent), result is 0.0.
 *
 * Valid sample (Requirements 6.5, 6.6):
 *   lambdaActual must be non-NaN and non-zero.
 *   lambdaTarget must be non-NaN and non-zero.
 *
 * Correction formula (% change to the VE table, positive = add fuel):
 *   ((1 + clTrimAvg / 100) * (lambdaActual / lambdaTarget) - 1) * 100
 *   ≈ lambda error % + closed-loop trim %.  lambdaError = (lambdaActual / lambdaTarget - 1) * 100.
 *
 * @param {{
 *   lambdaB1:     number,
 *   lambdaB2:     number,
 *   lambdaAvg:    number,
 *   lambdaTarget: number,
 *   clTrimB1:     number,
 *   clTrimB2:     number,
 * }} sample
 * @returns {{
 *   lambdaActual: number,
 *   clTrimAvg:    number,
 *   correction:   number,
 *   isValid:      boolean,
 * }}
 */
function computeSampleCorrection(sample) {
    const { lambdaB1, lambdaB2, lambdaAvg, lambdaTarget, clTrimB1, clTrimB2 } = sample;

    // --- Lambda_Actual priority ---
    const b1Valid = !Number.isNaN(lambdaB1) && lambdaB1 !== 0;
    const b2Valid = !Number.isNaN(lambdaB2) && lambdaB2 !== 0;

    let lambdaActual;
    if (b1Valid && b2Valid) {
        // Both banks valid: average them.
        lambdaActual = (lambdaB1 + lambdaB2) / 2;
    } else if (b1Valid) {
        // Only B1 valid.
        lambdaActual = lambdaB1;
    } else if (b2Valid) {
        // Only B2 valid.
        lambdaActual = lambdaB2;
    } else {
        // Neither bank valid: fall back to lambdaAvg.
        lambdaActual = lambdaAvg;
    }

    // --- CL_Trim_Avg ---
    const b1TrimValid = !Number.isNaN(clTrimB1);
    const b2TrimValid = !Number.isNaN(clTrimB2);

    let clTrimAvg;
    if (b1TrimValid && b2TrimValid) {
        clTrimAvg = (clTrimB1 + clTrimB2) / 2;
    } else if (b1TrimValid) {
        clTrimAvg = clTrimB1;
    } else if (b2TrimValid) {
        clTrimAvg = clTrimB2;
    } else {
        // Both NaN or absent.
        clTrimAvg = 0.0;
    }

    // --- Validity check ---
    const lambdaActualValid = !Number.isNaN(lambdaActual) && lambdaActual !== 0;
    const lambdaTargetValid = !Number.isNaN(lambdaTarget) && lambdaTarget !== 0;
    const isValid = lambdaActualValid && lambdaTargetValid;

    // --- Correction formula ---
    // Fuel needed scales with actual / target lambda (lean = lambda above target = more fuel). The closed-loop
    // trim was already applied to the fuel that produced this lambda, so the base table needs both.
    const lambdaError = isValid ? ((lambdaActual / lambdaTarget) - 1) * 100 : NaN;
    const correction = isValid
        ? ((1 + clTrimAvg / 100) * (lambdaActual / lambdaTarget) - 1) * 100
        : NaN;

    return { lambdaActual, clTrimAvg, lambdaError, correction, isValid };
}

// ---------------------------------------------------------------------------
// buildOutputs — Task 7.1
// ---------------------------------------------------------------------------

/**
 * Assembles the two output CSV strings from the correction grid and original VE table.
 *
 * Difference CSV (Requirements 7.1–7.6):
 *   - Header row: empty field + RPM breakpoints as integers.
 *   - One data row per MAP breakpoint (ascending order).
 *   - Cells above threshold: correction rounded to 2 decimal places.
 *   - Cells at or below threshold: empty string.
 *
 * New Values CSV (Requirements 8.1–8.6):
 *   - Rows 1–4: M1 v2 header (M1,v2 / Body,% / Cols,rpm,Eng Speed / Rows,kPa,Inlet Man Pres).
 *   - Row 5: reproduces rpmRawStrings exactly (empty first field).
 *   - Data rows: mapRawStrings[i] for col 0.
 *     - Above-threshold cells: original_VE * (1 + correction / 100) formatted with formatScientific.
 *     - Below-threshold cells: reproduce valueRawStrings exactly.
 *
 * @param {{
 *   mapBreakpoints: number[],
 *   rpmBreakpoints: number[],
 *   cells: Array<Array<{ count: number, correction: number | null }>>,
 *   totalSamples: number,
 *   cellsAboveThreshold: number,
 * }} correctionGrid
 * @param {{
 *   rpmBreakpoints: number[],
 *   mapBreakpoints: number[],
 *   values: number[][],
 *   rpmRawStrings: string[],
 *   mapRawStrings: string[],
 *   valueRawStrings: string[][],
 * }} veTable
 * @returns {{ diffCsv: string, newValuesCsv: string }}
 */
function buildOutputs(correctionGrid, veTable) {
    // --- Difference CSV ---
    const diffRows = [];

    // Header row: empty + RPM breakpoints as integers
    const diffHeader = [''].concat(correctionGrid.rpmBreakpoints.map(bp => String(bp)));
    diffRows.push(diffHeader.join(','));

    // Data rows: one per MAP breakpoint
    for (let mapIdx = 0; mapIdx < correctionGrid.mapBreakpoints.length; mapIdx++) {
        const row = [String(correctionGrid.mapBreakpoints[mapIdx])];
        for (let rpmIdx = 0; rpmIdx < correctionGrid.rpmBreakpoints.length; rpmIdx++) {
            const cell = correctionGrid.cells[mapIdx][rpmIdx];
            if (cell.correction !== null) {
                // Above threshold: round to 2 decimal places
                row.push(cell.correction.toFixed(2));
            } else {
                // Below threshold: empty string
                row.push('');
            }
        }
        diffRows.push(row.join(','));
    }

    const diffCsv = diffRows.join('\n');

    // --- New Values CSV ---
    const newRows = [];

    // Rows 1–4: M1 v2 header
    newRows.push('M1,v2');
    newRows.push('Body,%');
    newRows.push('Cols,rpm,Eng Speed');
    newRows.push('Rows,kPa,Inlet Man Pres');

    // Row 5: empty first field + rpmRawStrings exactly
    const rpmRow = [''].concat(veTable.rpmRawStrings);
    newRows.push(rpmRow.join(','));

    // Data rows: MAP breakpoint + VE values
    for (let mapIdx = 0; mapIdx < veTable.mapBreakpoints.length; mapIdx++) {
        const row = [veTable.mapRawStrings[mapIdx]];
        for (let rpmIdx = 0; rpmIdx < veTable.rpmBreakpoints.length; rpmIdx++) {
            const cell = correctionGrid.cells[mapIdx][rpmIdx];
            if (cell.correction !== null && cell.correction !== 0) {
                // Above threshold with actual change: compute new VE value and format
                const originalVE = veTable.values[mapIdx][rpmIdx];
                const newVE = originalVE * (1 + cell.correction / 100);
                row.push(formatScientific(newVE));
            } else {
                // Below threshold or zeroed out: reproduce original string exactly
                row.push(veTable.valueRawStrings[mapIdx][rpmIdx]);
            }
        }
        newRows.push(row.join(','));
    }

    const newValuesCsv = newRows.join('\n');

    return { diffCsv, newValuesCsv };
}

// ---------------------------------------------------------------------------
// MoTeC .ld Binary Parser
// ---------------------------------------------------------------------------

/**
 * Maps .ld dot-separated channel names to the CSV-style names used by resolveChannels.
 */
const LD_NAME_MAP = {
    'Engine.Speed':                          'Engine Speed',
    'Inlet.Manifold.Pressure':               'Inlet Manifold Pressure',
    'Exhaust.Lambda.Bank 1':                 'Exhaust Lambda Bank 1',
    'Exhaust.Lambda.Bank 2':                 'Exhaust Lambda Bank 2',
    'Exhaust.Lambda':                        'Exhaust Lambda',
    'Throttle.Position':                     'Throttle Position',
    'Fuel.Pressure.Direct.Bank 1':           'Fuel Pressure Direct Bank 1',
    'Fuel.Pressure.Direct.Bank 1.Aim':       'Fuel Pressure Direct Bank 1 Aim',
    'Coolant.Temperature':                   'Coolant Temperature',
    'Inlet.Air.Temperature':                 'Inlet Air Temperature',
    'Fuel.Mixture Aim':                      'Fuel Mixture Aim',
};

function normalizeLdChannelNameWithUnit(ldName, unit) {
    if (LD_NAME_MAP[ldName]) {
        return LD_NAME_MAP[ldName];
    }
    if (ldName === 'Fuel.Cylinder 1.Primary.Output.P' && unit === 'ms') {
        return 'Fuel Cylinder 1 Primary Output Pulse Width 1';
    }
    if (ldName === 'Fuel.Cylinder 1.Primary.Output.P' && unit === 'dBTDC') {
        return 'Fuel Cylinder 1 Primary Output Pulse Angle 1';
    }
    if (ldName === 'Fuel.Closed Loop.Control.Bank 1.' && unit === '%Trim') {
        return 'Fuel Closed Loop Control Bank 1 Trim';
    }
    if (ldName === 'Fuel.Closed Loop.Control.Bank 2.' && unit === '%Trim') {
        return 'Fuel Closed Loop Control Bank 2 Trim';
    }
    return ldName.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

function readString(view, offset, length) {
    const bytes = [];
    for (let i = 0; i < length; i++) {
        const b = view.getUint8(offset + i);
        if (b === 0) break;
        bytes.push(b);
    }
    return String.fromCharCode.apply(null, bytes).trim();
}

function decodeFloat16(h) {
    const sign = (h >> 15) & 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    if (exp === 0) {
        return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
    } else if (exp === 31) {
        return frac ? NaN : (sign ? -Infinity : Infinity);
    }
    return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function readChannelData(buffer, chan) {
    if (!chan.dataType || chan.bytesPerSample === 0) {
        return new Float64Array(chan.nData);
    }
    const result = new Float64Array(chan.nData);
    const view = new DataView(buffer);
    let offset = chan.dataPtr;
    for (let i = 0; i < chan.nData; i++) {
        if (offset + chan.bytesPerSample > buffer.byteLength) break;
        switch (chan.dataType) {
            case 'float32': result[i] = view.getFloat32(offset, true); break;
            case 'float16': result[i] = decodeFloat16(view.getUint16(offset, true)); break;
            case 'int16':   result[i] = view.getInt16(offset, true); break;
            case 'int32':   result[i] = view.getInt32(offset, true); break;
            default:        result[i] = 0;
        }
        offset += chan.bytesPerSample;
    }
    return result;
}

/**
 * Parses a MoTeC .ld binary file and returns column names and row-based data
 * in the same format as the CSV parser output.
 *
 * @param {ArrayBuffer} buffer - The raw .ld file contents
 * @param {function} progressCallback - Called with (channelsProcessed, totalChannels)
 * @returns {{columnNames: string[], data: number[][]}}
 */
function parseLdFile(buffer, progressCallback) {
    const view = new DataView(buffer);
    const metaPtr = view.getUint32(8, true);
    const numChanns = view.getUint32(86, true);

    if (metaPtr === 0 || numChanns === 0) {
        throw new Error('Invalid .ld file: no channel metadata found');
    }

    const CHAN_HEADER_SIZE = 124;
    const channels = [];
    let ptr = metaPtr;

    for (let ch = 0; ch < numChanns && ptr !== 0; ch++) {
        if (ptr + CHAN_HEADER_SIZE > buffer.byteLength) break;
        const nextPtr = view.getUint32(ptr + 4, true);
        const chanDataPtr = view.getUint32(ptr + 8, true);
        const nData = view.getUint32(ptr + 12, true);
        const dtypeA = view.getUint16(ptr + 18, true);
        const dtypeVal = view.getUint16(ptr + 20, true);
        const freq = view.getUint16(ptr + 22, true);
        const shift = view.getInt16(ptr + 24, true);
        const mul = view.getInt16(ptr + 26, true);
        const scale = view.getInt16(ptr + 28, true);
        const dec = view.getInt16(ptr + 30, true);
        const name = readString(view, ptr + 32, 32);
        const shortName = readString(view, ptr + 64, 8);
        const unit = readString(view, ptr + 72, 12);

        let bytesPerSample = 0, dataType = null;
        if (dtypeA === 0x07) {
            if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'float16'; }
            else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'float32'; }
        } else if (dtypeA === 0 || dtypeA === 0x03 || dtypeA === 0x05) {
            if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'int16'; }
            else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'int32'; }
        }

        channels.push({ name, shortName, unit, freq, dataPtr: chanDataPtr, nData, dataType, bytesPerSample, shift, mul, scale, dec });
        ptr = nextPtr;
    }

    if (channels.length === 0) {
        throw new Error('No channels found in .ld file');
    }

    let maxFreq = 0;
    for (let i = 0; i < channels.length; i++) {
        if (channels[i].freq > maxFreq) maxFreq = channels[i].freq;
    }

    let baseSamples = 0;
    for (let i = 0; i < channels.length; i++) {
        if (channels[i].freq === maxFreq) { baseSamples = channels[i].nData; break; }
    }
    if (baseSamples === 0) {
        throw new Error('Could not determine sample count from .ld file');
    }

    const columnNames = ['Time'];
    const channelData = [];
    const timeArr = new Float64Array(baseSamples);
    const dt = 1.0 / maxFreq;
    for (let t = 0; t < baseSamples; t++) { timeArr[t] = t * dt; }
    channelData.push(timeArr);

    for (let ci = 0; ci < channels.length; ci++) {
        const chan = channels[ci];
        const normalizedName = normalizeLdChannelNameWithUnit(chan.name, chan.shortName);
        columnNames.push(normalizedName);

        const rawData = readChannelData(buffer, chan);
        const transformed = new Float64Array(rawData.length);
        const decFactor = Math.pow(10, -chan.dec);
        for (let s = 0; s < rawData.length; s++) {
            transformed[s] = (rawData[s] / chan.scale * decFactor + chan.shift) * chan.mul;
        }

        if (chan.freq === maxFreq) {
            channelData.push(transformed);
        } else {
            const ratio = maxFreq / chan.freq;
            const upsampled = new Float64Array(baseSamples);
            for (let u = 0; u < baseSamples; u++) {
                const srcIdx = Math.min(Math.floor(u / ratio), transformed.length - 1);
                upsampled[u] = transformed[srcIdx];
            }
            channelData.push(upsampled);
        }

        if (progressCallback) { progressCallback(ci + 1, channels.length); }
    }

    return { columnNames, data: null, baseSamples, channelData };
}

/**
 * Converts parsed .ld data into LogSample objects compatible with the VE analysis pipeline.
 * Uses resolveChannels to find the required channels, then builds samples row by row.
 *
 * @param {ArrayBuffer} buffer - The raw .ld file contents
 * @param {function} onProgress - Called with (rowsProcessed, totalRows)
 * @returns {{ samples: LogSample[], channelWarnings: string[] }}
 */
function parseLdLog(buffer, onProgress) {
    const parsed = parseLdFile(buffer, (channelsProcessed, totalChannels) => {
        // Progress during channel parsing (first phase)
    });

    const { columnNames, baseSamples, channelData } = parsed;

    // Resolve channels using the same function as CSV parsing
    const channelIndices = resolveChannels(columnNames);
    const channelWarnings = channelIndices.warnings;

    const { rpmIdx, mapIdx, lambdaB1Idx, lambdaB2Idx, lambdaAvgIdx, lambdaTargetIdx, clTrimB1Idx, clTrimB2Idx, coolantTempIdx, throttlePosIdx,
            overrunStateIdx, fuelCutCountIdx } = channelIndices;

    // Build samples from channel data arrays
    // channelData[0] is the Time array (generated during parseLdFile)
    const samples = [];
    const BATCH_SIZE = 500000;

    for (let batchStart = 0; batchStart < baseSamples; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, baseSamples);

        for (let i = batchStart; i < batchEnd; i++) {
            const sample = {
                time:         channelData[0][i],
                rpm:          rpmIdx !== -1 ? channelData[rpmIdx][i] : NaN,
                map:          mapIdx !== -1 ? channelData[mapIdx][i] : NaN,
                lambdaB1:     lambdaB1Idx !== -1 ? channelData[lambdaB1Idx][i] : NaN,
                lambdaB2:     lambdaB2Idx !== -1 ? channelData[lambdaB2Idx][i] : NaN,
                lambdaAvg:    lambdaAvgIdx !== -1 ? channelData[lambdaAvgIdx][i] : NaN,
                lambdaTarget: lambdaTargetIdx !== -1 ? channelData[lambdaTargetIdx][i] : NaN,
                clTrimB1:     clTrimB1Idx !== -1 ? channelData[clTrimB1Idx][i] : NaN,
                clTrimB2:     clTrimB2Idx !== -1 ? channelData[clTrimB2Idx][i] : NaN,
                coolantTemp:  coolantTempIdx !== -1 ? channelData[coolantTempIdx][i] : NaN,
                throttlePos:  throttlePosIdx !== -1 ? channelData[throttlePosIdx][i] : NaN,
                overrunState: overrunStateIdx !== -1 ? channelData[overrunStateIdx][i] : NaN,
                fuelCutCount: fuelCutCountIdx !== -1 ? channelData[fuelCutCountIdx][i] : NaN,
            };
            samples.push(sample);
        }

        if (onProgress) {
            onProgress(batchEnd, baseSamples);
        }
    }

    return { samples, channelWarnings };
}

// ---------------------------------------------------------------------------
// VE analysis pipeline
// ---------------------------------------------------------------------------

/** Plausible measured lambda; readings outside this (free air, fuel cut, sensor faults) are ignored. */
const LAMBDA_MIN_VALID = 0.6;
const LAMBDA_MAX_VALID = 1.4;
/** Seconds after overrun or a fuel cut during which lambda still reads the cut (sensor transport delay). */
const FUEL_CUT_HOLDOFF_S = 1.0;
/**
 * Steady-state limits over the steady-state window: total MAP and throttle variation allowed. RPM is not
 * limited — a full-throttle pull sweeps RPM quickly but fuels steadily; MAP and throttle changes are what
 * bring in transient (wall-wetting) fuelling.
 */
const STEADY_MAP_SPAN_KPA = 10;
const STEADY_TPS_SPAN = 10;

/** Why analyzeVE left a sample out (settings.reasons); 0 = used. */
const VE_REASON = { USED: 0, RUN_TIME: 1, COOLANT: 2, FUEL_CUT: 3, DECEL: 4, TPS_RATE: 5, NOT_STEADY: 6, MIN_MAP: 7, LAMBDA: 8,
                    NO_DATA: 9, OUTLIER: 10 };

/**
 * Prepares an axis for interpolation weights: breakpoints in ascending order with their original indices
 * (M1 exports MAP highest first).
 */
function makeAxis(breakpoints) {
    const order = breakpoints.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    return { values: order.map(o => o[0]), index: order.map(o => o[1]) };
}

/**
 * Interpolation weights of a value on an axis, the way M1 reads a table: the two surrounding breakpoints
 * share the sample in proportion to how close it is (outside the axis the end breakpoint takes it all).
 * Returns [[breakpointIndex, weight], ...] or null for NaN.
 */
function axisWeights(value, axis) {
    if (Number.isNaN(value)) return null;
    const v = axis.values, n = v.length;
    if (n === 1 || value <= v[0]) return [[axis.index[0], 1]];
    if (value >= v[n - 1]) return [[axis.index[n - 1], 1]];
    let k = 0;
    while (k < n - 2 && value >= v[k + 1]) k++;
    const f = (value - v[k]) / (v[k + 1] - v[k]);
    const out = [];
    if (f < 1) out.push([axis.index[k], 1 - f]);
    if (f > 0) out.push([axis.index[k + 1], f]);
    return out;
}

/**
 * Runs the VE correction analysis on parsed log samples.
 *
 * settings: { hitThreshold, minCoolantTemp, minRunTime, minChangeAmount, scalingFactor, outlierStddev,
 *             maxTpsRate, smoothing, minMapForCorrection, decelFilterEnabled, steadyWindowMs, lambdaDelayMs }
 * Returns { correctionGrid, newValuesGrid, totalSamples, cellsAboveThreshold, filteredBy… }.
 */
function analyzeVE(samples, veTable, settings) {
    settings = settings || {};
    const num = (v, ok, dflt) => (typeof v === 'number' && ok(v) ? v : dflt);
    const threshold = num(settings.hitThreshold, v => v >= 1, HIT_THRESHOLD);
    const coolantThreshold = num(settings.minCoolantTemp, () => true, 55);
    const runTimeThreshold = num(settings.minRunTime, () => true, 60);
    const changeThreshold = num(settings.minChangeAmount, v => v >= 0, 0);
    const scalePct = num(settings.scalingFactor, v => v > 0 && v <= 100, 100) / 100;
    const outlierSigma = num(settings.outlierStddev, v => v > 0, 0);
    const tpsRateLimit = num(settings.maxTpsRate, v => v > 0, 0);
    const smoothingSigma = num(settings.smoothing, v => v > 0, 0);
    const minMapFilter = num(settings.minMapForCorrection, v => v > 0, 0);
    const decelFilter = settings.decelFilterEnabled !== false;
    const steadyWindow = num(settings.steadyWindowMs, v => v >= 0, 300) / 1000;
    const lambdaDelay = num(settings.lambdaDelayMs, v => v >= 0, 0) / 1000;

    const n = samples.length;
    const filtered = { time: 0, coolant: 0, fuelCut: 0, decel: 0, tps: 0, steady: 0, minMap: 0, lambda: 0, outlier: 0 };
    // Optional per-sample outputs (for the Log Viewer): why each sample was left out (VE_REASON codes, 0 = used)
    // and the correction of each used sample.
    const reasons = settings.reasons || null, corrections = settings.corrections || null;
    const skip = (i, key, code) => { filtered[key]++; if (reasons) reasons[i] = code; };

    // Measured lambda lags the fuelling that caused it: pair each sample with lambda read lambdaDelay later.
    const lambdaAt = new Array(n);
    for (let i = 0, j = 0; i < n; i++) {
        if (lambdaDelay > 0) {
            if (j < i) j = i;
            while (j < n - 1 && samples[j].time < samples[i].time + lambdaDelay) j++;
            lambdaAt[i] = samples[j].time >= samples[i].time + lambdaDelay - 1e-9 ? samples[j] : null;
        } else {
            lambdaAt[i] = samples[i];
        }
    }

    // Time of the most recent overrun / fuel cut: Engine Overrun State ≠ 0, or Fuel Output Cut Count changing
    // (an 8-bit counter, so it can wrap; M1 logs it slowly, so overrun state and the lambda check do most of the work).
    const lastCut = new Float64Array(n).fill(-Infinity);
    for (let i = 0; i < n; i++) {
        const s = samples[i], prev = i > 0 ? samples[i - 1] : null;
        const cut = (!Number.isNaN(s.overrunState) && s.overrunState !== 0) ||
            (prev && !Number.isNaN(s.fuelCutCount) && !Number.isNaN(prev.fuelCutCount) && s.fuelCutCount !== prev.fuelCutCount);
        lastCut[i] = cut ? s.time : (i > 0 ? lastCut[i - 1] : -Infinity);
    }

    const mapAxis = makeAxis(veTable.mapBreakpoints), rpmAxis = makeAxis(veTable.rpmBreakpoints);
    const grid = createAccumulatorGrid(veTable.mapBreakpoints, veTable.rpmBreakpoints);
    const binned = [];   // { mapIdx, rpmIdx, w, correction, clTrimAvg, lambdaError }

    for (let i = 0; i < n; i++) {
        const s = samples[i], prev = i > 0 ? samples[i - 1] : null;
        const dt = prev ? s.time - prev.time : 0;

        if (!Number.isNaN(s.time) && s.time < runTimeThreshold) { skip(i, 'time', VE_REASON.RUN_TIME); continue; }
        if (!Number.isNaN(s.coolantTemp) && s.coolantTemp < coolantThreshold) { skip(i, 'coolant', VE_REASON.COOLANT); continue; }
        if (s.time - lastCut[i] < FUEL_CUT_HOLDOFF_S) { skip(i, 'fuelCut', VE_REASON.FUEL_CUT); continue; }

        if (decelFilter) {
            const mapRate = dt > 0 && !Number.isNaN(s.map - prev.map) ? (s.map - prev.map) / dt : 0;
            const tps = s.throttlePos;
            if (!Number.isNaN(tps) && ((tps < 1 && mapRate < -50) || (tps < 0.5 && !Number.isNaN(s.map) && s.map < 40))) {
                skip(i, 'decel', VE_REASON.DECEL); continue;
            }
        }
        if (tpsRateLimit > 0 && dt > 0 && !Number.isNaN(s.throttlePos - prev.throttlePos) &&
            Math.abs((s.throttlePos - prev.throttlePos) / dt) > tpsRateLimit) { skip(i, 'tps', VE_REASON.TPS_RATE); continue; }

        // Steady state: MAP and RPM roughly constant over the preceding window.
        if (steadyWindow > 0) {
            let minMap = s.map, maxMap = s.map, minTps = s.throttlePos, maxTps = s.throttlePos, k = i - 1;
            for (; k >= 0 && s.time - samples[k].time <= steadyWindow; k--) {
                const o = samples[k];
                if (o.map < minMap) minMap = o.map;
                if (o.map > maxMap) maxMap = o.map;
                if (o.throttlePos < minTps) minTps = o.throttlePos;
                if (o.throttlePos > maxTps) maxTps = o.throttlePos;
            }
            if (s.time - samples[0].time < steadyWindow) { skip(i, 'steady', VE_REASON.NOT_STEADY); continue; }   // not enough history yet
            if (maxMap - minMap > STEADY_MAP_SPAN_KPA || maxTps - minTps > STEADY_TPS_SPAN) { skip(i, 'steady', VE_REASON.NOT_STEADY); continue; }
        }

        if (minMapFilter > 0 && !Number.isNaN(s.map) && s.map < minMapFilter) { skip(i, 'minMap', VE_REASON.MIN_MAP); continue; }

        const lam = lambdaAt[i];
        if (!lam) { skip(i, 'lambda', VE_REASON.LAMBDA); continue; }
        const result = computeSampleCorrection(Object.assign({}, s, {
            lambdaB1: lam.lambdaB1, lambdaB2: lam.lambdaB2, lambdaAvg: lam.lambdaAvg
        }));
        if (!result.isValid) { if (reasons) reasons[i] = VE_REASON.NO_DATA; continue; }
        if (result.lambdaActual < LAMBDA_MIN_VALID || result.lambdaActual > LAMBDA_MAX_VALID) { skip(i, 'lambda', VE_REASON.LAMBDA); continue; }

        const mw = axisWeights(s.map, mapAxis), rw = axisWeights(s.rpm, rpmAxis);
        if (!mw || !rw) { if (reasons) reasons[i] = VE_REASON.NO_DATA; continue; }
        if (corrections) corrections[i] = result.correction;
        mw.forEach(([mapIdx, wm]) => rw.forEach(([rpmIdx, wr]) => {
            const w = wm * wr;
            accumulateSample(grid, mapIdx, rpmIdx, result.correction, result.clTrimAvg, w, result.lambdaError);
            binned.push({ i, mapIdx, rpmIdx, w, correction: result.correction, clTrimAvg: result.clTrimAvg, lambdaError: result.lambdaError });
        }));
    }

    // Weighted mean and standard deviation per cell.
    function cellStats(g, entries) {
        const means = g.cells.map(row => row.map(c => (c.count > 0 ? c.correctionSum / c.count : 0)));
        const varSum = g.cells.map(row => row.map(() => 0));
        entries.forEach(e => { const d = e.correction - means[e.mapIdx][e.rpmIdx]; varSum[e.mapIdx][e.rpmIdx] += e.w * d * d; });
        const sd = g.cells.map((row, m) => row.map((c, r) => (c.count > 0 ? Math.sqrt(varSum[m][r] / c.count) : 0)));
        return { means, sd };
    }

    // Outlier filtering (optional): drop contributions beyond N σ of their cell's mean.
    let finalGrid = grid, kept = binned;
    if (outlierSigma > 0 && binned.length) {
        const st = cellStats(grid, binned);
        finalGrid = createAccumulatorGrid(veTable.mapBreakpoints, veTable.rpmBreakpoints);
        kept = [];
        let removedWeight = 0;
        binned.forEach(e => {
            const sd = st.sd[e.mapIdx][e.rpmIdx];
            if (sd > 0 && Math.abs(e.correction - st.means[e.mapIdx][e.rpmIdx]) > outlierSigma * sd) {
                removedWeight += e.w;
                if (reasons) reasons[e.i] = VE_REASON.OUTLIER;
                return;
            }
            accumulateSample(finalGrid, e.mapIdx, e.rpmIdx, e.correction, e.clTrimAvg, e.w, e.lambdaError);
            kept.push(e);
        });
        filtered.outlier = Math.round(removedWeight);
    }
    const final = cellStats(finalGrid, kept);

    // Per-cell results: scaled mean correction for cells with enough (weighted) samples.
    let cellsAboveThreshold = 0;
    const finalCells = finalGrid.cells.map((row, m) => row.map((cell, r) => {
        if (cell.count > threshold) {
            cellsAboveThreshold++;
            return { count: Math.round(cell.count), correction: (cell.correctionSum / cell.count) * scalePct,
                     stddev: final.sd[m][r], clTrimAvg: cell.clTrimSum / cell.count, lambdaError: cell.lambdaErrSum / cell.count };
        }
        return { count: Math.round(cell.count), correction: null, stddev: null, clTrimAvg: null, lambdaError: null };
    }));

    // Smoothing (optional) across cells that have corrections, before the minimum-change cut-off.
    if (smoothingSigma > 0 && cellsAboveThreshold > 0) {
        const radius = Math.ceil(smoothingSigma * 2), rows = finalCells.length, cols = finalCells[0].length;
        const smoothed = finalCells.map((row, m) => row.map((c, r) => {
            if (c.correction === null) return null;
            let sum = 0, wsum = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const nm = m + dy, nr = r + dx;
                    if (nm < 0 || nm >= rows || nr < 0 || nr >= cols || finalCells[nm][nr].correction === null) continue;
                    const w = Math.exp(-(dx * dx + dy * dy) / (2 * smoothingSigma * smoothingSigma));
                    sum += finalCells[nm][nr].correction * w; wsum += w;
                }
            }
            return wsum > 0 ? sum / wsum : c.correction;
        }));
        finalCells.forEach((row, m) => row.forEach((c, r) => { if (smoothed[m][r] !== null) c.correction = smoothed[m][r]; }));
    }
    if (changeThreshold > 0) {
        finalCells.forEach(row => row.forEach(c => {
            if (c.correction !== null && Math.abs(c.correction) < changeThreshold) c.correction = 0;
        }));
    }

    const totalSamples = Math.round(kept.reduce((s, e) => s + e.w, 0));
    const newValuesGrid = veTable.mapBreakpoints.map((_, m) => veTable.rpmBreakpoints.map((__, r) => {
        const c = finalCells[m][r], ve = veTable.values[m][r];
        return c.correction !== null && c.correction !== 0 ? ve * (1 + c.correction / 100) : ve;
    }));

    return {
        correctionGrid: { mapBreakpoints: veTable.mapBreakpoints, rpmBreakpoints: veTable.rpmBreakpoints, cells: finalCells,
                          totalSamples, cellsAboveThreshold },
        newValuesGrid, totalSamples, cellsAboveThreshold,
        filteredByTime: filtered.time, filteredByCoolant: filtered.coolant, filteredByFuelCut: filtered.fuelCut,
        filteredByDecel: filtered.decel, filteredByTps: filtered.tps, filteredBySteady: filtered.steady,
        filteredByMinMap: filtered.minMap, filteredByLambda: filtered.lambda, filteredByOutlier: filtered.outlier,
    };
}

// ---------------------------------------------------------------------------
// onmessage handler — Task 8.1
// ---------------------------------------------------------------------------

/**
 * Web Worker message handler.
 *
 * Accepts:
 *   { type: 'process', logText: string, veText: string, hitThreshold?: number }
 *   { type: 'process_ld', logBuffer: ArrayBuffer, veText: string, hitThreshold?: number }
 *
 * Posts back:
 *   { type: 'progress', rowsProcessed, totalRows }  — during log parsing
 *   { type: 'warning',  message }                   — for each channel warning
 *   { type: 'error',    message }                   — on any thrown error
 *   { type: 'result',   correctionGrid, diffCsv, newValuesCsv, totalSamples, cellsAboveThreshold }
 */
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = function (e) {
        const msg = e.data;
        if (!msg || (msg.type !== 'process' && msg.type !== 'process_ld')) return;

        try {
            const { veText, hitThreshold, minCoolantTemp, minRunTime, minChangeAmount, scalingFactor, outlierStddev, maxTpsRate, smoothing, minMapForCorrection, decelFilterEnabled, steadyWindowMs, lambdaDelayMs } = msg;
            // 1. Parse VE table
            const veTable = parseVETable(veText);

            // 2. Parse log with progress reporting
            const onProgress = (rowsProcessed, totalRows) => {
                self.postMessage({ type: 'progress', rowsProcessed, totalRows });
            };

            let samples, channelWarnings;
            if (msg.type === 'process_ld') {
                // Parse .ld binary log
                const result = parseLdLog(msg.logBuffer, onProgress);
                samples = result.samples;
                channelWarnings = result.channelWarnings;
            } else {
                // Parse CSV text log
                const result = parseLog(msg.logText, onProgress);
                samples = result.samples;
                channelWarnings = result.channelWarnings;
            }

            // 3. Forward channel warnings
            for (let i = 0; i < channelWarnings.length; i++) {
                self.postMessage({ type: 'warning', message: channelWarnings[i] });
            }

            // 4. Analyse
            const analysis = analyzeVE(samples, veTable, {
                hitThreshold, minCoolantTemp, minRunTime, minChangeAmount, scalingFactor, outlierStddev, maxTpsRate,
                smoothing, minMapForCorrection, decelFilterEnabled, steadyWindowMs, lambdaDelayMs
            });
            const correctionGrid = analysis.correctionGrid;

            // 7. Build output CSVs
            const { diffCsv, newValuesCsv } = buildOutputs(correctionGrid, veTable);

            // 8. Post final result
            self.postMessage(Object.assign({ type: 'result', diffCsv, newValuesCsv }, analysis));

        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
    };
}

// Expose for Node.js / test environments while remaining safe in a browser Worker context.
if (typeof module !== 'undefined') {
    module.exports = {
        HIT_THRESHOLD,
        VE_REASON,
        formatScientific,
        findNearestBreakpoint,
        createAccumulatorGrid,
        accumulateSample,
        parseVETable,
        resolveChannels,
        parseLog,
        parseLdFile,
        parseLdLog,
        computeSampleCorrection,
        buildOutputs,
        analyzeVE,
        axisWeights,
        makeAxis,
    };
}
