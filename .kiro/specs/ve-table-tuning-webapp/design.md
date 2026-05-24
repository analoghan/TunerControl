# Design Document: VE Table Tuning Web App

## Overview

A single-page web application that runs entirely in the browser by opening `index.html` directly — no server, no build tools, no npm. The user uploads a MoTeC M1 CSV log file and an "Eng Efficiency Main" VE table CSV, the app processes them in the browser, and produces two downloadable CSVs: a correction-percentage difference table and a new VE table in M1 v2 format ready to import back into MoTeC.

The core challenge is handling log files that can exceed 50 MB without freezing the browser. This is solved by streaming the log file in chunks inside a Web Worker, keeping the main thread free to update the UI.

### Key Design Decisions

**Single HTML file vs multiple files**: The app uses multiple files (`index.html`, `worker.js`, `app.js`, `styles.css`) in a flat directory. A single-file approach would require inlining the Web Worker as a Blob URL, which is harder to read and test. Multiple files load fine when opened via `file://` in any modern browser.

**Web Worker for parsing**: The log parser, bin assigner, correction calculator, and output builder all run inside a dedicated Web Worker (`worker.js`). The main thread only handles UI events and rendering. This is the only reliable way to keep the UI responsive during multi-second processing of 50 MB+ files.

**No streaming API**: The FileReader API's `readAsText` is used with manual chunk splitting rather than the Streams API, because the Streams API has inconsistent `file://` support across browsers. The worker reads the entire file as text then processes it in 500,000-row batches, posting progress messages back to the main thread between batches.

---

## Architecture

```
index.html          — UI shell: file inputs, process button, progress bar, results table
styles.css          — Layout and colour-coding for the results grid
app.js              — Main thread: UI event handling, Worker lifecycle, result rendering
worker.js           — Worker thread: all heavy computation (parsing, binning, calculation, output)
```

### Data Flow

```
User selects files
      │
      ▼
app.js reads both files as text (FileReader)
      │
      ▼
app.js posts { logText, veText } to worker.js
      │
      ▼ (inside Web Worker)
┌─────────────────────────────────────────────────────────┐
│  VE_Parser.parse(veText)  →  VETable                    │
│  Log_Parser.parse(logText, progressCallback)            │
│       └─ yields LogSample[] in 500k-row batches         │
│  Bin_Assigner.assign(samples, veTable)  →  BinResult    │
│  Correction_Calculator.compute(binResult, veTable)      │
│       └─ CorrectionGrid                                 │
│  Output_Builder.build(correctionGrid, veTable)          │
│       └─ { diffCsv: string, newValuesCsv: string }      │
└─────────────────────────────────────────────────────────┘
      │
      ▼
worker.js posts results back to app.js
      │
      ▼
app.js renders colour-coded table, creates Blob download links
```

### Worker Message Protocol

Messages from main thread to worker:
```js
{ type: 'process', logText: string, veText: string }
```

Messages from worker to main thread:
```js
{ type: 'progress', rowsProcessed: number, totalRows: number }
{ type: 'warning',  message: string }
{ type: 'error',    message: string }
{ type: 'result',   correctionGrid: CorrectionGrid, diffCsv: string, newValuesCsv: string,
                    totalSamples: number, cellsAboveThreshold: number }
```

---

## Components and Interfaces

### Log_Parser

Responsible for reading a MoTeC M1 CSV export and producing an array of `LogSample` objects.

```js
/**
 * @param {string} text  — full CSV text
 * @param {function(number, number): void} onProgress  — called with (rowsProcessed, totalRows)
 * @returns {{ samples: LogSample[], channelWarnings: string[] }}
 * @throws {Error} on fatal parse errors (missing Time header, missing required channels)
 */
function parseLog(text, onProgress) { ... }
```

**Header detection**: Scans the first 25 rows looking for a row whose first field (after stripping quotes and whitespace) is exactly `"Time"`. That row index becomes `headerRow`. The row at `headerRow + 1` is the units row and is skipped. Any subsequent rows where all fields are empty strings are also skipped before the first numeric data row.

**Channel resolution**: After extracting column names, resolves each required channel by case-insensitive, whitespace-trimmed name matching (see Requirement 4). Throws on missing required channels; emits warnings for missing optional channels (CL trim banks).

**Chunked processing**: After locating the data start row, splits the remaining text into lines and processes them in batches of 500,000. After each batch, calls `onProgress(rowsProcessed, totalRows)`. This allows the worker to post progress messages without blocking.

**Numeric parsing**: Uses `parseFloat()` which handles scientific notation natively. Non-numeric or empty strings become `NaN`.

---

### VE_Parser

Reads an M1 v2 format VE table CSV and produces a `VETable` object.

```js
/**
 * @param {string} text  — full CSV text
 * @returns {VETable}
 * @throws {Error} on format validation failures or non-numeric cells
 */
function parseVETable(text) { ... }
```

**Format validation**: Checks that row 0 has `M1` in field 0 and `v2` in field 1 (after stripping quotes/whitespace). Throws a descriptive error if not.

**Breakpoint extraction**: Row 4 (0-indexed) is the column-header row. Fields 1+ are RPM breakpoints — parsed as floats and rounded to the nearest integer. Rows 5+ have MAP breakpoints in field 0 (parsed as float, rounded to int) and VE values in fields 1+.

**Precision preservation**: The original quoted scientific-notation strings for RPM breakpoints and VE values are stored alongside the parsed floats. This allows `Output_Builder` to reproduce the exact original strings for cells that are not corrected, satisfying the round-trip requirement.

---

### Bin_Assigner

Maps each log sample's RPM and MAP values to the nearest breakpoint indices.

```js
/**
 * @param {number} value  — the RPM or MAP value to bin
 * @param {number[]} breakpoints  — sorted ascending array of breakpoints
 * @returns {number}  — index into breakpoints array, or -1 if value is NaN
 */
function findNearestBreakpoint(value, breakpoints) { ... }
```

**Algorithm**: Linear scan (acceptable for 20 or 24 breakpoints). For each breakpoint, compute `|value - breakpoint[i]|`. Track the minimum distance and its index. On a tie (equal distance to two adjacent breakpoints), the lower index wins because the breakpoints are sorted ascending and the scan proceeds left-to-right, keeping the first minimum found.

**NaN handling**: If `value` is `NaN`, returns `-1` immediately. The caller skips samples with index `-1`.

---

### Hit_Counter

Maintains a 24×20 grid of per-cell sample counts and accumulated correction values.

```js
/**
 * Initialises a fresh accumulator grid.
 * @returns {AccumulatorGrid}
 */
function createAccumulatorGrid(mapBreakpoints, rpmBreakpoints) { ... }

/**
 * Accumulates one valid sample into the grid.
 * @param {AccumulatorGrid} grid
 * @param {number} mapIdx   — row index (0-23)
 * @param {number} rpmIdx   — column index (0-19)
 * @param {number} correction  — the per-sample correction value
 */
function accumulateSample(grid, mapIdx, rpmIdx, correction) { ... }
```

The grid stores `{ count: number, correctionSum: number }` per cell. The final `Correction_%` for a cell is `correctionSum / count` when `count > HIT_THRESHOLD`.

---

### Correction_Calculator

Computes the per-sample correction value and determines Lambda_Actual and CL_Trim_Avg.

```js
/**
 * @param {LogSample} sample
 * @returns {{ lambdaActual: number, clTrimAvg: number, correction: number, isValid: boolean }}
 */
function computeSampleCorrection(sample) { ... }
```

**Lambda_Actual logic**:
1. If both `lambdaB1` and `lambdaB2` are non-NaN and non-zero: `(lambdaB1 + lambdaB2) / 2`
2. Else if exactly one is non-NaN and non-zero: use that one
3. Else: use `lambdaAvg`

**CL_Trim_Avg logic**: Average of non-NaN values from `{clTrimB1, clTrimB2}`. If both are NaN or absent, result is `0.0`.

**Valid sample**: `lambdaActual` must be non-NaN and non-zero; `lambdaTarget` must be non-NaN and non-zero.

**Correction formula**: `((lambdaTarget / lambdaActual) - 1) * 100 + clTrimAvg`

---

### Output_Builder

Assembles the two output CSV strings from the correction grid and original VE table.

```js
/**
 * @param {CorrectionGrid} grid
 * @param {VETable} veTable
 * @returns {{ diffCsv: string, newValuesCsv: string }}
 */
function buildOutputs(grid, veTable) { ... }
```

**Difference CSV**: Plain CSV with no M1 header. First row: empty field + RPM breakpoints as integers. Subsequent rows: MAP breakpoint + correction values rounded to 2 decimal places (empty string for cells below threshold).

**New Values CSV**: M1 v2 format. First 4 rows are the fixed header. Row 5 reproduces the original RPM breakpoint strings exactly (from `veTable.rpmRawStrings`). Data rows: MAP breakpoint as original string + VE values. For cells above threshold: `original_VE * (1 + correction / 100)` formatted as scientific notation with 17 significant digits (matching MoTeC's format). For cells below threshold: original VE string reproduced exactly.

**Scientific notation formatting**: Uses `value.toExponential(17)` then reformats to match MoTeC's style: `"5.72041153907775879e+01"` (lowercase `e`, sign always present, 2-digit exponent). A helper function `formatScientific(value)` handles this consistently.

---

## Data Models

### LogSample

```js
/**
 * One row of data from the MoTeC log, with channels resolved by name.
 * All values are numbers; NaN indicates a missing or unparseable value.
 */
{
  rpm:          number,   // Engine Speed
  map:          number,   // Inlet Manifold Pressure (kPa)
  lambdaB1:     number,   // Exhaust Lambda Bank 1 (NaN if channel absent)
  lambdaB2:     number,   // Exhaust Lambda Bank 2 (NaN if channel absent)
  lambdaAvg:    number,   // Exhaust Lambda (NaN if channel absent)
  lambdaTarget: number,   // Fuel Mixture Aim
  clTrimB1:     number,   // Fuel Closed Loop Control Bank 1 Trim (NaN if absent)
  clTrimB2:     number,   // Fuel Closed Loop Control Bank 2 Trim (NaN if absent)
}
```

### VETable

```js
{
  rpmBreakpoints:  number[],    // 20 integers, ascending
  mapBreakpoints:  number[],    // 24 integers, ascending
  values:          number[][],  // [mapIdx][rpmIdx], full-precision floats
  rpmRawStrings:   string[],    // original quoted scientific-notation strings from row 5
  mapRawStrings:   string[],    // original quoted scientific-notation strings from col 0
  valueRawStrings: string[][],  // original quoted scientific-notation strings for each cell
}
```

### AccumulatorGrid

```js
{
  mapBreakpoints: number[],   // 24 values
  rpmBreakpoints: number[],   // 20 values
  cells: Array<Array<{        // [mapIdx][rpmIdx]
    count:         number,    // valid samples accumulated
    correctionSum: number,    // sum of per-sample correction values
  }>>,
}
```

### CorrectionGrid

```js
{
  mapBreakpoints: number[],
  rpmBreakpoints: number[],
  cells: Array<Array<{        // [mapIdx][rpmIdx]
    count:       number,
    correction:  number | null,  // null if count <= HIT_THRESHOLD
  }>>,
  totalSamples:         number,
  cellsAboveThreshold:  number,
}
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Scientific notation round-trip

*For any* floating-point number, formatting it as scientific notation with `formatScientific()` and then parsing the result with `parseFloat()` should produce a value whose absolute difference from the original is no greater than `1e-9`.

**Validates: Requirements 3.6, 8.3, 8.6**

---

### Property 2: VE table parse round-trip

*For any* valid VE table (with arbitrary floating-point VE values, RPM breakpoints, and MAP breakpoints), serialising it to M1 v2 CSV format and then parsing the result with `VE_Parser` should produce VE values whose absolute difference from the originals is no greater than `1e-9`.

**Validates: Requirements 3.6, 8.6**

---

### Property 3: Nearest-breakpoint assignment is minimal distance

*For any* numeric value and any sorted ascending array of breakpoints, the index returned by `findNearestBreakpoint` should minimise `|value - breakpoints[index]|`. On a tie, the lower index (lower breakpoint value) should be selected.

**Validates: Requirements 5.1, 5.2**

---

### Property 4: Hit count conservation

*For any* list of valid log samples (non-NaN RPM and MAP), the sum of all cell counts in the resulting `AccumulatorGrid` should equal the number of valid samples in the input list.

**Validates: Requirements 5.3, 5.4**

---

### Property 5: Correction formula correctness

*For any* list of valid `(lambdaTarget, lambdaActual, clTrimAvg)` tuples assigned to the same cell (where `lambdaActual != 0` and `lambdaTarget != 0`), the computed `Correction_%` for that cell should equal the arithmetic mean of `((lambdaTarget / lambdaActual) - 1) * 100 + clTrimAvg` across all tuples.

**Validates: Requirements 6.7**

---

### Property 6: Lambda_Actual priority rule

*For any* combination of `(lambdaB1, lambdaB2, lambdaAvg)` values (including NaN and zero), the computed `lambdaActual` should follow the priority: average of both banks when both are valid > single valid bank > `lambdaAvg`. Specifically: if both B1 and B2 are non-NaN and non-zero, `lambdaActual = (B1 + B2) / 2`; if exactly one is valid, `lambdaActual = that one`; otherwise `lambdaActual = lambdaAvg`.

**Validates: Requirements 6.1, 6.2, 6.3**

---

### Property 7: CL_Trim_Avg handles NaN correctly

*For any* pair `(clTrimB1, clTrimB2)` where each may be a number or NaN, `CL_Trim_Avg` should equal the mean of the non-NaN values, or `0.0` if both are NaN.

**Validates: Requirements 6.4**

---

### Property 8: New values CSV round-trip

*For any* correction grid and VE table, the `newValuesCsv` string produced by `Output_Builder` when parsed by `VE_Parser` should yield VE values that differ from the computed new values (`original * (1 + correction/100)`) by no more than `1e-9` for cells above the threshold, and differ from the original VE values by no more than `1e-9` for cells at or below the threshold.

**Validates: Requirements 8.3, 8.4, 8.6**

---

### Property 9: Cell colour class reflects sign

*For any* correction value, the CSS class assigned to the results table cell should be `"positive"` (green) when the correction is strictly greater than zero, `"negative"` (red) when strictly less than zero, and `"below-threshold"` (grey) when the cell has no correction (null).

**Validates: Requirements 10.3, 10.4**

---

### Property 10: Channel name resolution is case-insensitive

*For any* casing of a required channel name (e.g., `"engine speed"`, `"ENGINE SPEED"`, `"Engine Speed"`), the channel resolver should match it to the correct logical channel.

**Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8**

---

## Error Handling

All fatal errors are thrown as `Error` objects from within the worker. The worker's `onerror` handler and `try/catch` around the main processing function catch these and post `{ type: 'error', message }` back to the main thread. The main thread displays the message in a red error banner and re-enables the Process button.

Non-fatal warnings (missing CL trim channels) are collected during processing and posted as `{ type: 'warning', message }` messages before the final result. The main thread accumulates these and displays them in a yellow warning banner above the results table.

### Error Taxonomy

| Condition | Type | Source |
|---|---|---|
| File cannot be read by FileReader | Fatal | app.js |
| Non-.csv file extension selected | Fatal | app.js |
| "Time" header not found in first 25 rows | Fatal | Log_Parser |
| VE table does not start with M1/v2 | Fatal | VE_Parser |
| Required channel missing (RPM, MAP, lambda, lambda target) | Fatal | Log_Parser |
| Lambda_Avg also absent when B1/B2 absent | Fatal | Log_Parser |
| Lambda_Target absent | Fatal | Log_Parser |
| Non-numeric VE cell | Fatal | VE_Parser |
| Zero cells above Hit_Threshold after processing | Warning | app.js (post-processing) |
| CL_Trim_B1 or CL_Trim_B2 absent | Warning | Log_Parser |

### Error Display

Errors replace the progress bar with a red banner. Warnings appear as yellow banners stacked above the results table. Multiple warnings are all shown (not just the first). The Process button is re-enabled after any terminal state (success or error).

---

## Testing Strategy

### Property-Based Testing Library

**[fast-check](https://github.com/dubzzz/fast-check)** (loaded from CDN in the test HTML file). Each property test runs a minimum of 100 iterations.

Tag format for each test: `// Feature: ve-table-tuning-webapp, Property N: <property text>`

### Unit Tests (example-based)

Specific scenarios that complement the property tests:

- Log parser: "Time" header at row 0, row 12, row 24; missing header; units row skipped; blank rows after units row skipped
- VE parser: valid M1 v2 file; wrong header; non-numeric cell; 24×20 grid dimensions
- Channel resolver: all 8 required channels present; RPM missing; MAP missing; both lambda banks absent with Avg present; both lambda banks absent with Avg also absent; CL trim B1 missing (warning); CL trim B2 missing (warning)
- Bin assigner: value exactly on a breakpoint; value exactly between two breakpoints (tie → lower); value below minimum breakpoint; value above maximum breakpoint; NaN input
- Correction calculator: both banks valid; only B1 valid; only B2 valid; both NaN (use Avg); lambdaActual zero (invalid sample); lambdaTarget zero (invalid sample); both trim channels NaN (CL_Trim_Avg = 0)
- Hit counter: exactly 50 samples in a cell (below threshold); exactly 51 samples (above threshold)
- Output builder: Difference CSV header row; empty cell for below-threshold; M1 v2 header rows in New Values CSV; original string preserved for below-threshold cell

### Property Tests

Each property listed in the Correctness Properties section is implemented as a single fast-check property test:

**Property 1** — `fc.float()` → `formatScientific` → `parseFloat` → `Math.abs(result - original) <= 1e-9`

**Property 2** — `fc.array(fc.float(), ...)` for a 24×20 grid → serialize to M1 v2 CSV → parse with `parseVETable` → all values within 1e-9

**Property 3** — `fc.float()` + `fc.array(fc.integer(), { minLength: 1 })` (sorted) → `findNearestBreakpoint` → verify minimality and tie-breaking

**Property 4** — `fc.array(fc.record({ rpm: fc.float(), map: fc.float() }))` → filter valid → accumulate → `sum(all cell counts) === validSamples.length`

**Property 5** — `fc.array(fc.record({ lt: fc.float({ min: 0.01 }), la: fc.float({ min: 0.01 }), cl: fc.float() }), { minLength: 51 })` → compute mean correction → compare to `Correction_Calculator` output

**Property 6** — `fc.record({ b1: fc.oneof(fc.float(), fc.constant(NaN), fc.constant(0)), b2: ..., avg: ... })` → verify priority rule

**Property 7** — `fc.record({ b1: fc.oneof(fc.float(), fc.constant(NaN)), b2: ... })` → verify CL_Trim_Avg

**Property 8** — `fc.record({ veTable: ..., correctionGrid: ... })` → `buildOutputs` → `parseVETable` → verify round-trip within 1e-9

**Property 9** — `fc.oneof(fc.float({ min: 0.001 }), fc.float({ max: -0.001 }), fc.constant(null))` → verify CSS class

**Property 10** — `fc.string()` mapped to random-cased versions of each channel name → verify resolver matches

### Test File Structure

```
tests/
  index.html          — loads fast-check from CDN, runs all tests, reports pass/fail
  test-log-parser.js
  test-ve-parser.js
  test-bin-assigner.js
  test-correction-calculator.js
  test-hit-counter.js
  test-output-builder.js
  test-properties.js  — all 10 property-based tests
```

Tests run by opening `tests/index.html` in a browser. No build step required.

---

## UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  VE Table Tuning Tool                                           │
├─────────────────────────────────────────────────────────────────┤
│  MoTeC Log CSV:    [Choose File]  filename.csv                  │
│  VE Table CSV:     [Choose File]  Eng Efficiency Main.csv       │
│                                                                 │
│                    [  Process  ]                                │
├─────────────────────────────────────────────────────────────────┤
│  ⚠ Warning: CL Trim Bank 2 channel not found, using 0.0        │  ← yellow banner
├─────────────────────────────────────────────────────────────────┤
│  ████████████████░░░░  68%  Processing rows 340,000 / 500,000  │  ← progress bar
├─────────────────────────────────────────────────────────────────┤
│  Processed 487,234 samples · 42 cells above threshold           │
│                                                                 │
│  [Download VE_Difference.csv]  [Download VE_New_Values.csv]     │
│                                                                 │
│  Correction % (green = add fuel, red = remove fuel)             │
│  ┌──────┬──────┬──────┬──────┬ ... ┬──────┐                    │
│  │  MAP │    0 │  500 │  750 │ ... │ 8000 │                    │
│  ├──────┼──────┼──────┼──────┼ ... ┼──────┤                    │
│  │  280 │      │      │      │     │      │  ← grey (no data)  │
│  │  260 │      │      │      │     │      │                    │
│  │  ... │      │ +2.3 │ -1.1 │     │      │  ← green / red     │
│  │   10 │      │      │      │     │      │                    │
│  └──────┴──────┴──────┴──────┴ ... ┴──────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

### Colour Coding

| Condition | Background | Text |
|---|---|---|
| `correction > 0` | `#c8e6c9` (light green) | `#1b5e20` (dark green) |
| `correction < 0` | `#ffcdd2` (light red) | `#b71c1c` (dark red) |
| `correction == 0` (exactly) | `#fff9c4` (light yellow) | `#333` |
| Below threshold | `#eeeeee` (grey) | — (empty) |

The results table is horizontally scrollable on narrow screens. MAP breakpoints are row headers (left column), RPM breakpoints are column headers (top row), matching the MoTeC table orientation.

### Streaming / Chunked Parsing Detail

The Web Worker receives the full file text as a string (posted from the main thread after `FileReader.readAsText`). It then:

1. Splits the text into lines using `text.split('\n')` (handles both `\r\n` and `\n` via trimming).
2. Locates the header row by scanning the first 25 lines.
3. Processes data lines in batches of 500,000, calling `self.postMessage({ type: 'progress', ... })` after each batch. Because the worker runs on a separate thread, these messages are delivered to the main thread asynchronously without blocking the UI.
4. After all batches, runs bin assignment and correction calculation (these are O(n) passes over the already-parsed samples array, fast enough to not need further chunking).
5. Builds output CSVs and posts the final result.

**Memory note**: For a 50 MB log file, the parsed `LogSample[]` array will be roughly 50–100 MB in the worker's heap (8 numeric fields × 8 bytes × ~1M rows). This is within the typical 512 MB–2 GB worker heap limit on modern browsers. If memory becomes a concern in practice, the accumulation step can be folded into the parsing loop so individual `LogSample` objects are not retained.

### Output CSV Download

```js
function downloadCsv(csvString, filename) {
  const blob = new Blob([csvString], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
```

Download buttons are only shown after successful processing with at least one cell above the threshold. The `VE_New_Values.csv` button is not shown if no cells were processed (per Requirement 8.5).
