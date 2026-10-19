# Implementation Plan: VE Table Tuning Web App

## Overview

Implement a zero-dependency, browser-only single-page application that parses a MoTeC M1 CSV log and a VE table CSV, bins log samples into the nearest RPM/MAP cell, computes per-cell correction percentages, and produces two downloadable CSVs. All heavy computation runs in a Web Worker. The app is launched by opening `index.html` directly — no build step, no npm.

## Tasks

- [x] 1. Project scaffold
  - Create the flat directory structure: `index.html`, `app.js`, `worker.js`, `styles.css` at the project root
  - Create the `tests/` directory with empty placeholder files: `tests/index.html`, `tests/test-log-parser.js`, `tests/test-ve-parser.js`, `tests/test-bin-assigner.js`, `tests/test-correction-calculator.js`, `tests/test-hit-counter.js`, `tests/test-output-builder.js`, `tests/test-properties.js`
  - Add a top-level `README.md` describing how to open the app and run tests
  - _Requirements: 1.6_

- [x] 2. `formatScientific` helper and `VE_Parser`
  - [x] 2.1 Implement `formatScientific(value)` in `worker.js`
    - Call `value.toExponential(17)` then reformat to MoTeC style: lowercase `e`, sign always present on exponent, 2-digit exponent (e.g., `"5.72041153907775879e+01"`)
    - Export / expose the function so tests can import it directly
    - _Requirements: 8.3_
  - [x]* 2.2 Write property test for `formatScientific` (Property 1)
    - **Property 1: Scientific notation round-trip**
    - Use `fc.float()` → `formatScientific` → `parseFloat` → assert `Math.abs(result - original) <= 1e-9`
    - Tag: `// Feature: ve-table-tuning-webapp, Property 1: Scientific notation round-trip`
    - **Validates: Requirements 3.6, 8.3, 8.6**
  - [x] 2.3 Implement `parseVETable(text)` in `worker.js`
    - Validate row 0 has `M1` / `v2` (strip quotes and whitespace); throw descriptive error if not
    - Extract RPM breakpoints from row 4 (fields 1+), parsed as float, rounded to int; store raw strings in `rpmRawStrings`
    - Extract MAP breakpoints from col 0 of rows 5+, parsed as float, rounded to int; store raw strings in `mapRawStrings`
    - Extract VE values from cols 1+ of rows 5+; throw on non-numeric cells; store raw strings in `valueRawStrings`
    - Return a `VETable` object matching the data model in the design
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [ ]* 2.4 Write unit tests for `VE_Parser` in `tests/test-ve-parser.js`
    - Valid M1 v2 file parses correctly; wrong header throws; non-numeric cell throws; grid is 24 rows × 20 cols
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - [ ]* 2.5 Write property test for `VE_Parser` round-trip (Property 2)
    - **Property 2: VE table parse round-trip**
    - Generate arbitrary 24×20 float grids, serialise to M1 v2 CSV, parse with `parseVETable`, assert all values within 1e-9
    - Tag: `// Feature: ve-table-tuning-webapp, Property 2: VE table parse round-trip`
    - **Validates: Requirements 3.6, 8.6**

- [x] 3. `Log_Parser` and channel resolver
  - [x] 3.1 Implement channel resolver in `worker.js`
    - Case-insensitive, whitespace-trimmed matching for all 8 channels (Engine Speed, Inlet Manifold Pressure, Exhaust Lambda Bank 1, Exhaust Lambda Bank 2, Exhaust Lambda, Fuel Mixture Aim, Fuel Closed Loop Control Bank 1 Trim, Fuel Closed Loop Control Bank 2 Trim)
    - Throw on missing required channels (RPM, MAP, lambda source, Lambda_Target); emit warnings for missing CL trim banks
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13_
  - [ ]* 3.2 Write property test for channel resolver (Property 10)
    - **Property 10: Channel name resolution is case-insensitive**
    - Generate random-cased versions of each required channel name; assert resolver matches to the correct logical channel
    - Tag: `// Feature: ve-table-tuning-webapp, Property 10: Channel name resolution is case-insensitive`
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8**
  - [x] 3.3 Implement `parseLog(text, onProgress)` in `worker.js`
    - Scan first 25 rows for the `"Time"` header row (case-sensitive, strip quotes/whitespace); throw if not found
    - Skip units row and any all-empty rows before first numeric data row
    - Invoke channel resolver; collect `channelWarnings[]`
    - Process data lines in batches of 500,000; call `onProgress(rowsProcessed, totalRows)` after each batch
    - Parse numeric values with `parseFloat()`; treat non-numeric / empty as `NaN`
    - Return `{ samples: LogSample[], channelWarnings: string[] }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  - [ ]* 3.4 Write unit tests for `Log_Parser` in `tests/test-log-parser.js`
    - "Time" header at row 0, row 12, row 24; missing header throws; units row skipped; blank rows after units row skipped; scientific-notation values parsed correctly
    - _Requirements: 2.1, 2.2, 2.4, 2.5_
  - [ ]* 3.5 Write unit tests for channel resolver in `tests/test-log-parser.js`
    - All 8 channels present; RPM missing throws; MAP missing throws; both lambda banks absent with Avg present; both lambda banks absent with Avg also absent throws; CL trim B1 missing emits warning; CL trim B2 missing emits warning
    - _Requirements: 4.9, 4.10, 4.11, 4.12_

- [x] 4. `Bin_Assigner` and `Hit_Counter`
  - [x] 4.1 Implement `findNearestBreakpoint(value, breakpoints)` in `worker.js`
    - Return `-1` immediately for `NaN` input
    - Linear scan; track minimum `|value - breakpoints[i]|`; on tie keep lower index (first minimum found)
    - _Requirements: 5.1, 5.2, 5.5_
  - [x]* 4.2 Write property test for `Bin_Assigner` (Property 3)
    - **Property 3: Nearest-breakpoint assignment is minimal distance**
    - Use `fc.float()` + sorted `fc.array(fc.integer(), { minLength: 1 })`; assert returned index minimises distance and tie-breaks to lower index
    - Tag: `// Feature: ve-table-tuning-webapp, Property 3: Nearest-breakpoint assignment is minimal distance`
    - **Validates: Requirements 5.1, 5.2**
  - [x]* 4.3 Write unit tests for `Bin_Assigner` in `tests/test-bin-assigner.js`
    - Value exactly on a breakpoint; value exactly between two breakpoints (tie → lower); value below minimum; value above maximum; NaN input returns -1
    - _Requirements: 5.1, 5.2, 5.5_
  - [x] 4.4 Implement `createAccumulatorGrid` and `accumulateSample` in `worker.js`
    - `createAccumulatorGrid(mapBreakpoints, rpmBreakpoints)` returns a 2-D array of `{ count: 0, correctionSum: 0 }` cells
    - `accumulateSample(grid, mapIdx, rpmIdx, correction)` increments `count` and adds to `correctionSum`
    - _Requirements: 5.3, 5.4_
  - [x]* 4.5 Write property test for `Hit_Counter` (Property 4)
    - **Property 4: Hit count conservation**
    - Generate arbitrary arrays of valid `{ rpm, map }` samples; accumulate; assert `sum(all cell counts) === validSamples.length`
    - Tag: `// Feature: ve-table-tuning-webapp, Property 4: Hit count conservation`
    - **Validates: Requirements 5.3, 5.4**
  - [x]* 4.6 Write unit tests for `Hit_Counter` in `tests/test-hit-counter.js`
    - Exactly 50 samples in a cell (below threshold); exactly 51 samples (above threshold); grid initialises to all zeros
    - _Requirements: 5.3, 5.4_

- [x] 5. Checkpoint — core computation modules
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. `Correction_Calculator`
  - [x] 6.1 Implement `computeSampleCorrection(sample)` in `worker.js`
    - Lambda_Actual priority: both B1 and B2 non-NaN and non-zero → average; exactly one valid → use it; otherwise → `lambdaAvg`
    - CL_Trim_Avg: mean of non-NaN values from `{clTrimB1, clTrimB2}`; both NaN → `0.0`
    - Valid sample: `lambdaActual` non-NaN and non-zero; `lambdaTarget` non-NaN and non-zero
    - Correction formula: `((lambdaTarget / lambdaActual) - 1) * 100 + clTrimAvg`
    - Return `{ lambdaActual, clTrimAvg, correction, isValid }`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_
  - [ ]* 6.2 Write property test for correction formula (Property 5)
    - **Property 5: Correction formula correctness**
    - Generate arrays of `{ lt, la, cl }` tuples (minLength: 51) assigned to the same cell; assert computed `Correction_%` equals arithmetic mean of per-sample formula
    - Tag: `// Feature: ve-table-tuning-webapp, Property 5: Correction formula correctness`
    - **Validates: Requirements 6.7**
  - [ ]* 6.3 Write property test for Lambda_Actual priority (Property 6)
    - **Property 6: Lambda_Actual priority rule**
    - Use `fc.oneof(fc.float(), fc.constant(NaN), fc.constant(0))` for B1, B2, Avg; assert priority rule holds for all combinations
    - Tag: `// Feature: ve-table-tuning-webapp, Property 6: Lambda_Actual priority rule`
    - **Validates: Requirements 6.1, 6.2, 6.3**
  - [ ]* 6.4 Write property test for CL_Trim_Avg (Property 7)
    - **Property 7: CL_Trim_Avg handles NaN correctly**
    - Use `fc.oneof(fc.float(), fc.constant(NaN))` for B1 and B2; assert result equals mean of non-NaN values or `0.0` when both NaN
    - Tag: `// Feature: ve-table-tuning-webapp, Property 7: CL_Trim_Avg handles NaN correctly`
    - **Validates: Requirements 6.4**
  - [ ]* 6.5 Write unit tests for `Correction_Calculator` in `tests/test-correction-calculator.js`
    - Both banks valid; only B1 valid; only B2 valid; both NaN (use Avg); lambdaActual zero (invalid); lambdaTarget zero (invalid); both trim channels NaN (CL_Trim_Avg = 0)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 7. `Output_Builder`
  - [x] 7.1 Implement `buildOutputs(correctionGrid, veTable)` in `worker.js`
    - Difference CSV: header row (empty + RPM breakpoints as integers); one data row per MAP breakpoint; correction rounded to 2 decimal places; empty string for below-threshold cells
    - New Values CSV: 4-row M1 v2 header; row 5 reproduces `rpmRawStrings` exactly; data rows use `mapRawStrings` for col 0; above-threshold cells: `original_VE * (1 + correction / 100)` formatted with `formatScientific`; below-threshold cells: reproduce `valueRawStrings` exactly
    - Return `{ diffCsv: string, newValuesCsv: string }`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [ ]* 7.2 Write property test for `Output_Builder` round-trip (Property 8)
    - **Property 8: New values CSV round-trip**
    - Generate arbitrary correction grids and VE tables; call `buildOutputs`; parse `newValuesCsv` with `parseVETable`; assert above-threshold cells within 1e-9 of `original * (1 + correction/100)` and below-threshold cells within 1e-9 of originals
    - Tag: `// Feature: ve-table-tuning-webapp, Property 8: New values CSV round-trip`
    - **Validates: Requirements 8.3, 8.4, 8.6**
  - [ ]* 7.3 Write unit tests for `Output_Builder` in `tests/test-output-builder.js`
    - Difference CSV header row correct; empty cell for below-threshold; M1 v2 header rows in New Values CSV; original string preserved for below-threshold cell
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.4_

- [x] 8. Worker message handling and orchestration
  - [x] 8.1 Implement the `onmessage` handler in `worker.js`
    - Accept `{ type: 'process', logText, veText }`
    - Wrap entire processing pipeline in `try/catch`; post `{ type: 'error', message }` on any thrown error
    - Call `parseVETable(veText)` → `VETable`
    - Call `parseLog(logText, onProgress)` where `onProgress` posts `{ type: 'progress', rowsProcessed, totalRows }`
    - Forward `channelWarnings` as individual `{ type: 'warning', message }` messages
    - Iterate samples: call `computeSampleCorrection`, skip invalid samples, call `findNearestBreakpoint` for RPM and MAP (skip if either returns -1), call `accumulateSample`
    - Finalise `CorrectionGrid` from accumulator (apply `HIT_THRESHOLD = 50`; `correction = correctionSum / count` when `count > 50`, else `null`)
    - Call `buildOutputs(correctionGrid, veTable)`
    - Post `{ type: 'result', correctionGrid, diffCsv, newValuesCsv, totalSamples, cellsAboveThreshold }`
    - _Requirements: 2.7, 5.3, 5.4, 6.7, 6.8, 9.2_
  - [x] 8.2 Define `HIT_THRESHOLD = 50` constant at the top of `worker.js`
    - _Requirements: 6.7, 6.8_

- [x] 9. Main thread `app.js`
  - [x] 9.1 Implement file input handling and Process button state in `app.js`
    - Validate `.csv` extension on file selection; display filename next to each input; show error and revert input if non-CSV
    - Enable Process button only when both inputs have valid CSV files; re-evaluate on every change event
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8_
  - [x] 9.2 Implement Worker lifecycle and message dispatch in `app.js`
    - On Process click: disable button, show progress bar, read both files with `FileReader.readAsText`, post `{ type: 'process', logText, veText }` to worker
    - Handle `progress` messages: update progress bar percentage and row count label
    - Handle `warning` messages: accumulate and display yellow warning banners
    - Handle `error` messages: hide progress bar, show red error banner, re-enable button
    - Handle `result` messages: hide progress bar, render results, re-enable button
    - Terminate and recreate the worker on each new processing run to reset state
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 11.1_
  - [x] 9.3 Implement result rendering and download links in `app.js`
    - Display total samples processed and cells above threshold
    - Render colour-coded 2-D summary table (MAP rows × RPM columns); apply CSS classes `positive`, `negative`, `zero`, `below-threshold` per cell
    - Show Download buttons only when at least one cell exceeded threshold; implement `downloadCsv(csvString, filename)` using Blob + `<a>` click
    - Show "no data" message when zero valid samples processed
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 7.5, 8.5, 11.5, 11.6, 11.7_
  - [ ]* 9.4 Write property test for cell colour class (Property 9)
    - **Property 9: Cell colour class reflects sign**
    - Use `fc.oneof(fc.float({ min: 0.001 }), fc.float({ max: -0.001 }), fc.constant(null))`; assert CSS class is `"positive"` for > 0, `"negative"` for < 0, `"below-threshold"` for null
    - Tag: `// Feature: ve-table-tuning-webapp, Property 9: Cell colour class reflects sign`
    - **Validates: Requirements 10.3, 10.4**

- [x] 10. UI shell and styles
  - [x] 10.1 Implement `index.html` structure
    - File input controls with labels; filename display spans; Process button (disabled by default)
    - Progress bar container with percentage label and row-count label
    - Warning banner container and error banner container
    - Results summary area: stats line, download buttons, scrollable table container
    - Load `app.js` as a module script; reference `styles.css`
    - _Requirements: 1.1, 1.2, 1.3, 9.1, 10.1, 10.5, 10.6_
  - [x] 10.2 Implement `styles.css`
    - Layout: centred single-column form, horizontally scrollable results table
    - Progress bar: filled/unfilled segments, percentage text
    - Warning banner: yellow background; error banner: red background
    - Cell colour coding: `.positive` (`#c8e6c9` bg / `#1b5e20` text), `.negative` (`#ffcdd2` bg / `#b71c1c` text), `.zero` (`#fff9c4` bg / `#333` text), `.below-threshold` (`#eeeeee` bg)
    - _Requirements: 10.3, 10.4_

- [x] 11. Test harness (`tests/index.html`)
  - Implement `tests/index.html` to load fast-check from CDN, import all test modules as ES modules, run all tests, and report pass/fail counts with individual test names
  - No build step; opens directly in a browser via `file://`
  - _Requirements: 1.6_

- [x] 12. Final checkpoint — all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- `HIT_THRESHOLD = 50` means strictly more than 50 samples required (cells with exactly 50 are below threshold)
- `formatScientific` must produce MoTeC-compatible output: lowercase `e`, sign always present, 2-digit exponent
- All computation (parsing, binning, correction, output building) lives in `worker.js`; `app.js` is UI-only
- fast-check is loaded from CDN in `tests/index.html`; no npm or build step anywhere
- Property tests run a minimum of 100 iterations each

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "4.1", "4.4"] },
    { "id": 2, "tasks": ["2.2", "2.3", "4.2", "4.3", "4.5", "4.6"] },
    { "id": 3, "tasks": ["2.4", "2.5", "3.1", "8.2"] },
    { "id": 4, "tasks": ["3.2", "3.3"] },
    { "id": 5, "tasks": ["3.4", "3.5", "6.1"] },
    { "id": 6, "tasks": ["6.2", "6.3", "6.4", "6.5", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "8.1"] },
    { "id": 8, "tasks": ["9.1", "9.2"] },
    { "id": 9, "tasks": ["9.3", "9.4", "10.1", "10.2"] },
    { "id": 10, "tasks": ["11"] }
  ]
}
```
