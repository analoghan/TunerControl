# Implementation Plan: Knock Analyzer

## Overview

This plan implements the Knock Analyzer tool in incremental steps: first adding the navigation card and page skeleton, then building the analysis worker with parsing (copied from injector/worker.js) and knock-specific computation, followed by the UI controller and chart renderer, and finally wiring everything together. Each step builds on the previous and ends with integrated, testable code.

## Tasks

- [x] 1. Create knock tool page structure and landing page link
  - [x] 1.1 Create `knock/index.html` page structure
    - HTML page with file input (.csv/.ld), Analyze button, threshold input (default 5%, step 0.1), progress bar, report section, and 5 chart canvas containers
    - Link to `knock/styles.css` for page-specific styles
    - Include `<script>` tags for `knock/app.js` and `knock/charts.js`
    - Navigation link back to landing page
    - _Requirements: 11.1, 11.5, 12.1, 12.2, 12.3_

  - [x] 1.2 Create `knock/styles.css` with page-specific styles
    - Dark theme consistent with TunerControl (dark background, light text)
    - Style file input area, threshold input, progress bar, report sections, chart containers
    - Responsive layout for chart grid
    - Diagnostic message styling (warning vs healthy indicators)
    - _Requirements: 10.2, 11.1_

  - [x] 1.3 Add Knock Analyzer navigation card to root `index.html`
    - Add a new card linking to `knock/index.html`
    - Title: "Knock Analyzer"
    - Description: "Per-cylinder knock event detection, operating condition correlation, and timing adjustment recommendations from MoTeC log data."
    - _Requirements: 11.6_

- [x] 2. Implement knock worker — file parsing and channel resolution
  - [x] 2.1 Create `knock/worker.js` with CSV and .ld parsing
    - Copy parsing infrastructure from `injector/worker.js`: `detectHeaderRow`, `findDataStart`, `parseDataRows`, `parseLdFile`, `readChannelData`, `decodeFloat16`, `normalizeLdChannelNameWithUnit`
    - Set up `self.onmessage` handler accepting `{type: 'analyze', logText}` and `{type: 'analyze_ld', buffer}` messages
    - Post `{type: 'progress', phase, percent}` during parsing
    - Post `{type: 'error', message}` for format errors (empty file, no header, invalid .ld)
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 12.1_

  - [x] 2.2 Implement knock-specific channel resolution in `knock/worker.js`
    - Define `CHANNEL_MAP` with logical names mapped to MoTeC column name candidates: `knock_cyl_1` through `knock_cyl_8` (pattern "Ignition Cylinder N Knock Level"), `ign_timing`, `ign_timing_comp`, `rpm`, `map`, `tps`, `gear`, `coolant_temp`
    - Implement `resolveChannels(columnNames)` → `{ resolved: {}, warnings: [] }`
    - Generate warnings for each missing knock channel (1–8)
    - Allow analysis to proceed with partial knock channels or missing optional channels
    - _Requirements: 1.4, 2.6_

  - [x]* 2.3 Write property test for missing channel warning correctness
    - **Property 10: Missing channel warning correctness**
    - **Validates: Requirements 1.4**

- [x] 3. Implement knock worker — event detection and cylinder distribution
  - [x] 3.1 Implement `classifyKnockEvents(data, channels, threshold)` in `knock/worker.js`
    - Iterate all data rows; for each cylinder with a resolved channel, classify sample as KnockEvent if knockLevel > threshold
    - Associate each event with timestamp, cylinderIndex, knockLevel, rpm, load, ignTiming, ignTimingComp, tps, gear (null if channel unavailable)
    - _Requirements: 2.2, 2.4, 2.6_

  - [x] 3.2 Implement `computeCylinderDistribution(events)` in `knock/worker.js`
    - Compute per-cylinder counts (index 0 = cyl 1, through index 7 = cyl 8)
    - Compute percentages rounded to 1 decimal place
    - Compute total event count
    - Compute ranking sorted by count descending, ascending cylinder index tie-breaker
    - _Requirements: 3.1, 3.2, 3.4_

  - [x]* 3.3 Write property test for knock event classification correctness
    - **Property 1: Knock event classification correctness**
    - **Validates: Requirements 2.2**

  - [x]* 3.4 Write property test for knock event data association integrity
    - **Property 2: Knock event data association integrity**
    - **Validates: Requirements 2.4, 2.6**

  - [x]* 3.5 Write property test for per-cylinder distribution invariants
    - **Property 3: Per-cylinder distribution invariants**
    - **Validates: Requirements 3.1, 3.2, 3.4**

- [x] 4. Implement knock worker — binning, heatmap, and timing correlation
  - [x] 4.1 Implement bin assignment utilities in `knock/worker.js`
    - Implement `assignRpmBin(rpm)` — 500 RPM bins, 0–7500, clamped
    - Implement `assignLoadBin(kpa)` — 10 kPa bins, 0–250, clamped
    - _Requirements: 4.3, 4.4_

  - [x] 4.2 Implement `computeHeatmapBins(events)` in `knock/worker.js`
    - Build 2D count array [rpmBinIdx][loadBinIdx]
    - Return rpmBins boundaries, loadBins boundaries, and counts matrix
    - _Requirements: 4.2, 4.3, 4.4_

  - [x] 4.3 Implement `computeTimingCorrelation(events)` in `knock/worker.js`
    - Compute mean and max ignition timing per RPM bin
    - Compute mean and max ignition timing per cylinder
    - Include event count per group
    - _Requirements: 5.2, 5.3_

  - [x]* 4.4 Write property test for bin assignment correctness
    - **Property 4: Bin assignment correctness**
    - **Validates: Requirements 4.3, 4.4**

  - [x]* 4.5 Write property test for statistical aggregation correctness
    - **Property 5: Statistical aggregation correctness**
    - **Validates: Requirements 5.2, 5.3**

- [x] 5. Implement knock worker — retard stats, worst conditions, recommendations, and diagnostics
  - [x] 5.1 Implement `computeTimingRetardStats(data, channels, events)` in `knock/worker.js`
    - Compute non-zero count of timing compensation samples
    - Compute maximum timing retard value
    - Compute mean timing retard during knock events
    - Build time series arrays for chart rendering
    - Return null if timing compensation channel unavailable
    - _Requirements: 6.2, 6.3, 6.4, 6.5_

  - [x] 5.2 Implement `identifyWorstConditions(events)` in `knock/worker.js`
    - Identify RPM bin with highest knock event count (lowest index tie-break)
    - Identify load bin with highest knock event count (lowest index tie-break)
    - Identify gear with highest knock event count when gear data available
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 5.3 Implement `computeTimingRecommendations(distribution)` in `knock/worker.js`
    - Compute proportional timing reduction per cylinder relative to min-count cylinder
    - Scale: `(count - minCount) / (maxCount - minCount) * 5`
    - Cap at 5 degrees maximum
    - Cylinder with fewest events gets 0 degrees
    - Return empty array if total events is zero
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

  - [x] 5.4 Implement `generateDiagnostics(distribution, worstConditions, retardStats)` in `knock/worker.js`
    - Generate message for cylinder with highest knock percentage
    - Generate message for worst RPM band
    - Generate message for worst load range
    - Generate "no knock events" message when total is zero
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x]* 5.5 Write property test for timing retard statistics correctness
    - **Property 6: Timing retard statistics correctness**
    - **Validates: Requirements 6.2, 6.3, 6.4**

  - [x]* 5.6 Write property test for maximum-count bin identification
    - **Property 7: Maximum-count bin identification**
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [x]* 5.7 Write property test for timing recommendation proportionality and cap
    - **Property 8: Timing recommendation proportionality and cap**
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [x] 6. Implement knock worker — downsampling and message flow wiring
  - [x] 6.1 Implement `downsampleForChart(data, maxPoints)` in `knock/worker.js`
    - Compute downsample step = max(1, floor(data.length / maxPoints))
    - Preserve min, max, and mean within tolerance
    - Cap output at 150,000 points
    - _Requirements: 10.5_

  - [x] 6.2 Wire complete worker message flow in `knock/worker.js`
    - Connect `self.onmessage` to call parse → resolveChannels → classifyKnockEvents → all analysis functions in sequence
    - Handle `{type: 'reanalyze', threshold}` by recomputing from cached parsed data
    - Post final `{type: 'result', analysis, chartData}` message
    - Wrap in try/catch to post `{type: 'error', message}` on unexpected failures
    - _Requirements: 2.3, 11.2, 11.4, 12.3_

  - [x] 6.3 Implement utility functions: `computeMean`, `computeMax`, `computeMedian`
    - Pure helper functions used by analysis modules
    - _Requirements: 5.2, 6.3, 6.4_

  - [x]* 6.4 Write property test for downsampling preserves statistical distribution
    - **Property 9: Downsampling preserves statistical distribution**
    - **Validates: Requirements 10.5**

- [x] 7. Checkpoint - Ensure worker logic is complete and testable
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement UI controller
  - [x] 8.1 Implement `knock/app.js` — UI controller
    - Implement `handleFileSelect(event)` — validate .csv/.ld extension, enable/disable Analyze button
    - Implement `handleAnalyzeClick()` — read file via FileReader (text for CSV, ArrayBuffer for .ld), create worker, post message
    - Implement `createKnockWorker()` — use Blob URL pattern for file:// compatibility
    - Implement `handleWorkerMessage(event)` — dispatch progress, result, warning, error messages
    - Implement `updateProgress(phase, percent)` — update progress bar with phase label
    - Implement `renderReport(analysis)` — render channel mapping, warnings, diagnostic summary, cylinder distribution table, timing recommendations table
    - Use `textContent` or DOM element creation for rendering (never innerHTML with user data)
    - Terminate worker after result or error
    - _Requirements: 1.3, 2.5, 3.3, 3.5, 6.1, 6.5, 8.5, 9.4, 9.5, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3_

  - [x] 8.2 Implement threshold input handling in `knock/app.js`
    - Validate range 0–100, step 0.1
    - Reject non-numeric or out-of-range values, revert to previous valid value, show inline error
    - On valid change, post `{type: 'reanalyze', threshold}` to worker (debounced)
    - _Requirements: 2.1, 2.3, 2.5_

- [x] 9. Implement chart renderer
  - [x] 9.1 Create `knock/charts.js` — canvas chart rendering module
    - Implement canvas utility functions: `setupCanvas`, `computePlotArea`, `drawAxes`, `drawGridlines`, `computeNiceRange`, `mapToPlot`, `drawLegend`
    - Follow same utility pattern as `injector/charts.js`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 9.2 Implement `renderCylinderBarChart(canvas, distribution)`
    - Per-cylinder knock count bars with percentage labels
    - Handle zero-event case with message
    - _Requirements: 3.3, 3.5_

  - [x] 9.3 Implement `renderKnockVsRpmScatter(canvas, events)`
    - Knock level (y-axis, 0–100%) vs RPM (x-axis, 0–7500)
    - Handle zero-event case with message
    - _Requirements: 4.1, 4.5_

  - [x] 9.4 Implement `renderKnockHeatmap(canvas, heatmapData)`
    - RPM × Load heatmap with color intensity for event count
    - Zero-count cells rendered with no fill
    - _Requirements: 4.2, 4.5_

  - [x] 9.5 Implement `renderTimingVsRpmScatter(canvas, events)`
    - Ignition timing vs RPM with point color indicating knock level
    - _Requirements: 5.1_

  - [x] 9.6 Implement `renderTimingRetardTimeSeries(canvas, retardData)`
    - Timing compensation over time
    - Handle unavailable data with message
    - _Requirements: 6.1, 6.5_

- [x] 10. Integration and final wiring
  - [x] 10.1 Wire chart rendering into UI controller flow
    - Connect `renderReport` and chart rendering calls in `handleWorkerMessage` result handler
    - Ensure charts render after report section is populated
    - Handle null retardStats (missing timing comp channel)
    - Handle zero-event scenarios for all charts
    - _Requirements: 10.1, 12.3_

  - [x] 10.2 Add error handling and worker lifecycle management
    - Implement `worker.onerror` handler for unexpected crashes
    - Display generic error banner on worker crash
    - Ensure worker is terminated on completion, error, or new analysis
    - Allow file re-selection and re-analysis without page refresh
    - _Requirements: 11.2, 11.3, 11.4_

  - [x]* 10.3 Write integration tests for full knock analysis pipeline
    - Create small MoTeC CSV fixture with known knock events across multiple cylinders
    - Test worker message sequence: progress messages followed by one result
    - Verify cylinder distribution, heatmap bins, timing recommendations for known data
    - Verify threshold reanalysis uses cached data and produces updated results
    - _Requirements: 1.1, 2.2, 3.1, 4.3, 9.1_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses JavaScript throughout — all implementation uses vanilla JS with no build tools
- The Blob URL pattern for Web Workers ensures file:// protocol compatibility
- CSV and .ld parsing code is copied from `injector/worker.js` as a starting point
- The project uses `fast-check` for property-based testing (test file: `tests/test-knock-properties.js`)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["3.1", "4.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4", "4.2", "4.3", "4.4"] },
    { "id": 5, "tasks": ["3.5", "4.5", "5.1", "5.2", "5.3", "5.4", "6.3"] },
    { "id": 6, "tasks": ["5.5", "5.6", "5.7", "6.1"] },
    { "id": 7, "tasks": ["6.2", "6.4"] },
    { "id": 8, "tasks": ["8.1", "8.2", "9.1"] },
    { "id": 9, "tasks": ["9.2", "9.3", "9.4", "9.5", "9.6"] },
    { "id": 10, "tasks": ["10.1", "10.2"] },
    { "id": 11, "tasks": ["10.3"] }
  ]
}
```
