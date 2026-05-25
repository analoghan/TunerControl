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
            row.push({ count: 0, correctionSum: 0 });
        }
        cells.push(row);
    }
    return { mapBreakpoints, rpmBreakpoints, cells };
}

/**
 * Accumulates one valid sample into the grid cell at [mapIdx][rpmIdx].
 *
 * Increments the cell's count by 1 and adds `correction` to its correctionSum.
 *
 * @param {{ cells: Array<Array<{count: number, correctionSum: number}>> }} grid
 * @param {number} mapIdx    — row index
 * @param {number} rpmIdx    — column index
 * @param {number} correction — per-sample correction value to accumulate
 */
function accumulateSample(grid, mapIdx, rpmIdx, correction) {
    const cell = grid.cells[mapIdx][rpmIdx];
    cell.count += 1;
    cell.correctionSum += correction;
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
 * Correction formula (Requirement 6.7):
 *   ((lambdaTarget / lambdaActual) - 1) * 100 + clTrimAvg
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
    const correction = isValid
        ? ((lambdaTarget / lambdaActual) - 1) * 100 + clTrimAvg
        : NaN;

    return { lambdaActual, clTrimAvg, correction, isValid };
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

    const { rpmIdx, mapIdx, lambdaB1Idx, lambdaB2Idx, lambdaAvgIdx, lambdaTargetIdx, clTrimB1Idx, clTrimB2Idx, coolantTempIdx, throttlePosIdx } = channelIndices;

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
            const { veText, hitThreshold, minCoolantTemp, minRunTime, minChangeAmount, scalingFactor, outlierStddev, maxTpsRate, smoothing } = msg;
            const threshold = (typeof hitThreshold === 'number' && hitThreshold >= 1) ? hitThreshold : HIT_THRESHOLD;
            const coolantThreshold = (typeof minCoolantTemp === 'number') ? minCoolantTemp : 55;
            const runTimeThreshold = (typeof minRunTime === 'number') ? minRunTime : 60;
            const changeThreshold = (typeof minChangeAmount === 'number' && minChangeAmount >= 0) ? minChangeAmount : 0;
            const scalePct = (typeof scalingFactor === 'number' && scalingFactor > 0 && scalingFactor <= 100) ? scalingFactor / 100 : 1.0;
            const outlierSigma = (typeof outlierStddev === 'number' && outlierStddev > 0) ? outlierStddev : 0;
            const tpsRateLimit = (typeof maxTpsRate === 'number' && maxTpsRate > 0) ? maxTpsRate : 0;
            const smoothingSigma = (typeof smoothing === 'number' && smoothing > 0) ? smoothing : 0;

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

            // 4. Create accumulator grid
            const grid = createAccumulatorGrid(veTable.mapBreakpoints, veTable.rpmBreakpoints);

            // 4b. Compute TPS rate of change for each sample (if TPS channel available and filter enabled)
            let tpsRates = null;
            if (tpsRateLimit > 0) {
                tpsRates = new Float64Array(samples.length);
                tpsRates[0] = 0; // First sample has no previous to compare
                for (let i = 1; i < samples.length; i++) {
                    const dt = samples[i].time - samples[i - 1].time;
                    const dTps = samples[i].throttlePos - samples[i - 1].throttlePos;
                    if (dt > 0 && !Number.isNaN(dTps)) {
                        tpsRates[i] = Math.abs(dTps / dt);
                    } else {
                        tpsRates[i] = 0;
                    }
                }
            }

            // 5. First pass: compute corrections, apply basic filters, bin into grid
            //    Also store per-sample binning info for potential second pass (outlier filtering)
            let totalSamples = 0;
            let filteredByTime = 0;
            let filteredByCoolant = 0;
            let filteredByTps = 0;
            let filteredByOutlier = 0;

            // Store binned samples for outlier filtering second pass
            const binnedSamples = []; // { mapIdx, rpmIdx, correction }

            for (let i = 0; i < samples.length; i++) {
                const sample = samples[i];

                // Filter: discard samples before minimum run time
                if (!Number.isNaN(sample.time) && sample.time < runTimeThreshold) {
                    filteredByTime++;
                    continue;
                }

                // Filter: discard samples below minimum coolant temperature
                if (!Number.isNaN(sample.coolantTemp) && sample.coolantTemp < coolantThreshold) {
                    filteredByCoolant++;
                    continue;
                }

                // Filter: discard samples where TPS is changing too fast
                if (tpsRateLimit > 0 && tpsRates !== null && tpsRates[i] > tpsRateLimit) {
                    filteredByTps++;
                    continue;
                }

                const result = computeSampleCorrection(sample);

                // Skip invalid samples
                if (!result.isValid) continue;

                // Find nearest breakpoints for RPM and MAP
                const rpmIdx = findNearestBreakpoint(sample.rpm, veTable.rpmBreakpoints);
                const mapIdx = findNearestBreakpoint(sample.map, veTable.mapBreakpoints);

                // Skip if either breakpoint lookup fails
                if (rpmIdx === -1 || mapIdx === -1) continue;

                // Accumulate the sample (first pass)
                accumulateSample(grid, mapIdx, rpmIdx, result.correction);
                binnedSamples.push({ mapIdx, rpmIdx, correction: result.correction });
                totalSamples++;
            }

            // 5b. Second pass: outlier filtering (if enabled)
            //     Recompute grid after removing samples beyond N sigma from cell mean
            let finalGrid = grid;
            if (outlierSigma > 0 && totalSamples > 0) {
                // Compute per-cell mean and stddev from first pass
                const cellMeans = [];
                const cellStddevs = [];
                for (let mapIdx = 0; mapIdx < grid.cells.length; mapIdx++) {
                    const meanRow = [];
                    const stdRow = [];
                    for (let rpmIdx = 0; rpmIdx < grid.cells[mapIdx].length; rpmIdx++) {
                        const cell = grid.cells[mapIdx][rpmIdx];
                        if (cell.count > 0) {
                            meanRow.push(cell.correctionSum / cell.count);
                        } else {
                            meanRow.push(0);
                        }
                        stdRow.push(0); // Will compute below
                    }
                    cellMeans.push(meanRow);
                    cellStddevs.push(stdRow);
                }

                // Compute variance per cell
                const cellVarianceSums = [];
                for (let mapIdx = 0; mapIdx < grid.cells.length; mapIdx++) {
                    const row = [];
                    for (let rpmIdx = 0; rpmIdx < grid.cells[mapIdx].length; rpmIdx++) {
                        row.push(0);
                    }
                    cellVarianceSums.push(row);
                }

                for (let i = 0; i < binnedSamples.length; i++) {
                    const s = binnedSamples[i];
                    const diff = s.correction - cellMeans[s.mapIdx][s.rpmIdx];
                    cellVarianceSums[s.mapIdx][s.rpmIdx] += diff * diff;
                }

                for (let mapIdx = 0; mapIdx < grid.cells.length; mapIdx++) {
                    for (let rpmIdx = 0; rpmIdx < grid.cells[mapIdx].length; rpmIdx++) {
                        const cell = grid.cells[mapIdx][rpmIdx];
                        if (cell.count > 1) {
                            cellStddevs[mapIdx][rpmIdx] = Math.sqrt(cellVarianceSums[mapIdx][rpmIdx] / cell.count);
                        }
                    }
                }

                // Second pass: rebuild grid excluding outliers
                finalGrid = createAccumulatorGrid(veTable.mapBreakpoints, veTable.rpmBreakpoints);
                totalSamples = 0;
                filteredByOutlier = 0;

                for (let i = 0; i < binnedSamples.length; i++) {
                    const s = binnedSamples[i];
                    const mean = cellMeans[s.mapIdx][s.rpmIdx];
                    const std = cellStddevs[s.mapIdx][s.rpmIdx];

                    if (std > 0 && Math.abs(s.correction - mean) > outlierSigma * std) {
                        filteredByOutlier++;
                        continue;
                    }

                    accumulateSample(finalGrid, s.mapIdx, s.rpmIdx, s.correction);
                    totalSamples++;
                }
            }

            // 6. Finalise CorrectionGrid from accumulator — compute mean, stddev, apply scaling & min change
            let cellsAboveThreshold = 0;
            const finalCells = [];

            // First compute per-cell variance for stddev display (on the final grid)
            // We need per-cell sum of squares, so let's compute from binnedSamples against final means
            const finalMeans = [];
            for (let mapIdx = 0; mapIdx < finalGrid.cells.length; mapIdx++) {
                const row = [];
                for (let rpmIdx = 0; rpmIdx < finalGrid.cells[mapIdx].length; rpmIdx++) {
                    const cell = finalGrid.cells[mapIdx][rpmIdx];
                    row.push(cell.count > 0 ? cell.correctionSum / cell.count : 0);
                }
                finalMeans.push(row);
            }

            // Compute variance sums against final grid
            const finalVarianceSums = [];
            for (let mapIdx = 0; mapIdx < finalGrid.cells.length; mapIdx++) {
                const row = [];
                for (let rpmIdx = 0; rpmIdx < finalGrid.cells[mapIdx].length; rpmIdx++) {
                    row.push(0);
                }
                finalVarianceSums.push(row);
            }

            // Iterate the binned samples that survived outlier filtering
            if (outlierSigma > 0 && totalSamples > 0) {
                // Re-iterate binnedSamples, only counting those that weren't filtered
                const cellMeansForOutlier = [];
                const cellStddevsForOutlier = [];
                for (let mapIdx = 0; mapIdx < grid.cells.length; mapIdx++) {
                    const meanRow = [];
                    const stdRow = [];
                    for (let rpmIdx = 0; rpmIdx < grid.cells[mapIdx].length; rpmIdx++) {
                        const cell = grid.cells[mapIdx][rpmIdx];
                        meanRow.push(cell.count > 0 ? cell.correctionSum / cell.count : 0);
                        stdRow.push(0);
                    }
                    cellMeansForOutlier.push(meanRow);
                    cellStddevsForOutlier.push(stdRow);
                }
                // Recompute stddevs from first pass for outlier check
                for (let i = 0; i < binnedSamples.length; i++) {
                    const s = binnedSamples[i];
                    const diff = s.correction - cellMeansForOutlier[s.mapIdx][s.rpmIdx];
                    cellStddevsForOutlier[s.mapIdx][s.rpmIdx] += diff * diff;
                }
                for (let mapIdx = 0; mapIdx < grid.cells.length; mapIdx++) {
                    for (let rpmIdx = 0; rpmIdx < grid.cells[mapIdx].length; rpmIdx++) {
                        const cell = grid.cells[mapIdx][rpmIdx];
                        if (cell.count > 1) {
                            cellStddevsForOutlier[mapIdx][rpmIdx] = Math.sqrt(cellStddevsForOutlier[mapIdx][rpmIdx] / cell.count);
                        }
                    }
                }

                for (let i = 0; i < binnedSamples.length; i++) {
                    const s = binnedSamples[i];
                    const mean = cellMeansForOutlier[s.mapIdx][s.rpmIdx];
                    const std = cellStddevsForOutlier[s.mapIdx][s.rpmIdx];
                    // Only include samples that survived outlier filter
                    if (std > 0 && Math.abs(s.correction - mean) > outlierSigma * std) {
                        continue;
                    }
                    const diff = s.correction - finalMeans[s.mapIdx][s.rpmIdx];
                    finalVarianceSums[s.mapIdx][s.rpmIdx] += diff * diff;
                }
            } else {
                // No outlier filtering — use all binned samples
                for (let i = 0; i < binnedSamples.length; i++) {
                    const s = binnedSamples[i];
                    const diff = s.correction - finalMeans[s.mapIdx][s.rpmIdx];
                    finalVarianceSums[s.mapIdx][s.rpmIdx] += diff * diff;
                }
            }

            for (let mapIdx = 0; mapIdx < finalGrid.cells.length; mapIdx++) {
                const row = [];
                for (let rpmIdx = 0; rpmIdx < finalGrid.cells[mapIdx].length; rpmIdx++) {
                    const cell = finalGrid.cells[mapIdx][rpmIdx];
                    if (cell.count > threshold) {
                        // Strictly more than threshold samples required
                        let avgCorrection = cell.correctionSum / cell.count;

                        // Apply scaling factor
                        avgCorrection = avgCorrection * scalePct;

                        // Compute standard deviation
                        const stddev = cell.count > 1
                            ? Math.sqrt(finalVarianceSums[mapIdx][rpmIdx] / cell.count)
                            : 0;

                        // Apply minimum change amount filter
                        if (changeThreshold > 0 && Math.abs(avgCorrection) < changeThreshold) {
                            row.push({ count: cell.count, correction: 0, stddev });
                        } else {
                            row.push({ count: cell.count, correction: avgCorrection, stddev });
                        }
                        cellsAboveThreshold++;
                    } else {
                        row.push({ count: cell.count, correction: null, stddev: null });
                    }
                }
                finalCells.push(row);
            }

            // 6c. Apply Gaussian smoothing to corrections (if enabled)
            if (smoothingSigma > 0 && cellsAboveThreshold > 0) {
                // Build a kernel radius based on sigma (cover 3σ in each direction)
                const radius = Math.ceil(smoothingSigma * 2);
                const numRows = finalCells.length;
                const numCols = finalCells[0] ? finalCells[0].length : 0;

                // Pre-compute Gaussian weights for the kernel
                const kernelSize = radius * 2 + 1;
                const kernel = [];
                for (let dy = -radius; dy <= radius; dy++) {
                    const kRow = [];
                    for (let dx = -radius; dx <= radius; dx++) {
                        const dist2 = dx * dx + dy * dy;
                        kRow.push(Math.exp(-dist2 / (2 * smoothingSigma * smoothingSigma)));
                    }
                    kernel.push(kRow);
                }

                // Apply smoothing: only smooth cells that are above threshold,
                // only sample from neighbors that are above threshold
                const smoothedCorrections = [];
                for (let m = 0; m < numRows; m++) {
                    const row = [];
                    for (let r = 0; r < numCols; r++) {
                        if (finalCells[m][r].correction === null) {
                            row.push(null);
                            continue;
                        }

                        let weightedSum = 0;
                        let weightTotal = 0;

                        for (let dy = -radius; dy <= radius; dy++) {
                            for (let dx = -radius; dx <= radius; dx++) {
                                const nm = m + dy;
                                const nr = r + dx;
                                if (nm < 0 || nm >= numRows || nr < 0 || nr >= numCols) continue;
                                if (finalCells[nm][nr].correction === null) continue;

                                const w = kernel[dy + radius][dx + radius];
                                weightedSum += finalCells[nm][nr].correction * w;
                                weightTotal += w;
                            }
                        }

                        if (weightTotal > 0) {
                            row.push(weightedSum / weightTotal);
                        } else {
                            row.push(finalCells[m][r].correction);
                        }
                    }
                    smoothedCorrections.push(row);
                }

                // Write smoothed values back into finalCells
                for (let m = 0; m < numRows; m++) {
                    for (let r = 0; r < numCols; r++) {
                        if (smoothedCorrections[m][r] !== null) {
                            finalCells[m][r].correction = smoothedCorrections[m][r];
                        }
                    }
                }
            }

            // 6b. Build newValuesGrid for display (original VE * (1 + correction/100))
            const newValuesGrid = [];
            for (let mapIdx = 0; mapIdx < veTable.mapBreakpoints.length; mapIdx++) {
                const row = [];
                for (let rpmIdx = 0; rpmIdx < veTable.rpmBreakpoints.length; rpmIdx++) {
                    const cell = finalCells[mapIdx][rpmIdx];
                    const originalVE = veTable.values[mapIdx][rpmIdx];
                    if (cell.correction !== null && cell.correction !== 0) {
                        row.push(originalVE * (1 + cell.correction / 100));
                    } else {
                        row.push(originalVE);
                    }
                }
                newValuesGrid.push(row);
            }

            // 7. Build output CSVs
            const { diffCsv, newValuesCsv } = buildOutputs(correctionGrid, veTable);

            // 8. Post final result
            self.postMessage({
                type: 'result',
                correctionGrid,
                diffCsv,
                newValuesCsv,
                totalSamples,
                cellsAboveThreshold,
                filteredByTime,
                filteredByCoolant,
                filteredByTps,
                filteredByOutlier,
                newValuesGrid,
            });

        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
    };
}

// Expose for Node.js / test environments while remaining safe in a browser Worker context.
if (typeof module !== 'undefined') {
    module.exports = {
        HIT_THRESHOLD,
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
    };
}
