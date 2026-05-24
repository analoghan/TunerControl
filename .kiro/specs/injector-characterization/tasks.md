# Implementation Plan: Injector Characterization

## Overview

This plan implements the Injector Characterization feature in incremental steps: first reorganizing the file structure, then building the analysis worker with its pure computation functions, followed by the UI controller and chart renderer, and finally wiring everything together. Each step builds on the previous and ends with integrated, testable code.

## Tasks

- [x] 1. Reorganize file structure and create landing page
  - [x] 1.1 Move existing VE Table tool files to `ve-table/` subdirectory
    - Create `ve-table/` directory
    - Move `index.html` → `ve-table/index.html`
    - Move `app.js` → `ve-table/app.js`
    - Move `worker.js` → `ve-table/worker.js`
    - Move `styles.css` → `ve-table/styles.css`
    - Update any internal references within `ve-table/index.html` (script/link paths should now be relative to `ve-table/`)
    - _Requirements: 2.1, 2.3_

  - [x] 1.2 Update test harness paths for VE Table relocation
    - Update `tests/index.html` to reference `../ve-table/worker.js` instead of `../worker.js`
    - Update any script src paths in test files that reference the moved files
    - Verify existing tests still load correctly
    - _Requirements: 2.2_

  - [x] 1.3 Create root landing page (`index.html`)
    - Create new `index.html` at project root with application title and description
    - Add navigation cards linking to `ve-table/index.html` and `injector/index.html`
    - Use only relative paths and standard HTML anchor elements
    - No JavaScript required for navigation
    - Style with inline or minimal CSS for card layout
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Implement injector analysis worker — CSV parsing and channel resolution
  - [x] 2.1 Create `injector/worker.js` with CSV header detection and data parsing
    - Implement `detectHeaderRow(lines)` — scan first 25 lines for "Time" header
    - Implement `findDataStart(lines, headerRowIdx)` — find first numeric data row
    - Implement `parseDataRows(lines, dataStart, numCols, progressCallback)` — parse all data rows into numeric arrays, posting progress messages
    - Set up `self.onmessage` handler accepting `{type: 'analyze', logText}` messages
    - Post `{type: 'progress', rowsProcessed, totalRows}` during parsing
    - Post `{type: 'error', message}` for format errors
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 16.1_

  - [x] 2.2 Implement channel resolution in `injector/worker.js`
    - Define `CHANNEL_MAP` constant with all logical channel names and their MoTeC CSV candidates
    - Implement `resolveInjectorChannels(columnNames)` with case-insensitive matching
    - Throw error if "Engine Speed" (rpm) is not found
    - Throw error if no lambda source is available
    - Generate warnings for missing optional channels
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x]* 2.3 Write property test for header row detection
    - **Property 2: Header Row Detection**
    - **Validates: Requirements 4.1, 4.2**

  - [x]* 2.4 Write property test for channel resolution
    - **Property 5: Channel Resolution Case-Insensitivity and Completeness**
    - **Validates: Requirements 5.1, 5.4**

  - [x]* 2.5 Write property test for progress monotonicity
    - **Property 6: Progress Monotonicity**
    - **Validates: Requirements 6.2, 6.3**

- [x] 3. Implement injector analysis worker — statistics utilities
  - [x] 3.1 Implement statistics helper functions in `injector/worker.js`
    - Implement `computeMean(values)` — arithmetic mean
    - Implement `computeMedian(sortedArray)` — median value
    - Implement `computePercentile(sortedArray, p)` — linear interpolation percentile
    - Implement `computeStdDev(values)` — population standard deviation
    - Implement `assignRPMBin(rpm)` — assign RPM value to bin index using RPM_BINS boundaries
    - Define `THRESHOLDS` constant, `RPM_BINS`, and `RPM_LABELS`
    - _Requirements: 7.4, 8.1, 9.2, 10.1, 11.1_

  - [x]* 3.2 Write property tests for statistics utilities
    - **Property 11: Percentile Monotonicity**
    - **Property 12: Standard Deviation Non-Negativity**
    - **Validates: Requirements 8.1, 9.2, 10.1, 11.1**

- [x] 4. Implement injector analysis worker — lean spike analysis
  - [x] 4.1 Implement `analyzeLeanSpikes(data, channels)` in `injector/worker.js`
    - Count samples where lambda > 1.06 as lean spike events
    - Categorize lean events by bank (both-banks, only-B1, only-B2) when both banks available
    - Distribute lean spikes across RPM bins using `assignRPMBin`
    - Count lean spikes coinciding with PW < 0.8 ms
    - Generate diagnostic messages interpreting patterns
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x]* 4.2 Write property test for lean spike count accuracy
    - **Property 7: Lean Spike Count Accuracy**
    - **Validates: Requirement 7.1**

  - [x]* 4.3 Write property test for bank categorization partition
    - **Property 8: Bank Categorization Partition**
    - **Validates: Requirements 7.2, 7.3**

  - [x]* 4.4 Write property test for RPM bin distribution
    - **Property 9: RPM Bin Distribution Completeness**
    - **Validates: Requirement 7.4**

  - [x]* 4.5 Write property test for low-PW lean spike correlation
    - **Property 10: Low-PW Lean Spike Correlation**
    - **Validates: Requirement 7.5**

- [x] 5. Implement injector analysis worker — PW stability, fuel pressure, timing, and closed-loop analyses
  - [x] 5.1 Implement `analyzePWStability(data, channels)` in `injector/worker.js`
    - Filter PW values > 0.05 ms (exclude off events)
    - Compute min, max, mean, median, stdDev, 5th percentile, 1st percentile
    - Count and report percentage below 0.8 ms threshold
    - Generate diagnostics based on 5th percentile thresholds (severe < 0.7, possible 0.7-0.8, healthy >= 0.8)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 5.2 Implement `analyzeFuelPressure(data, channels)` in `injector/worker.js`
    - Convert dMPa to bar (multiply by 100)
    - Compute pressure statistics (min, max, mean, std) in bar
    - Count samples below 150 bar
    - Compute pressure error vs aim when aim channel available
    - Generate HPFP diagnostic when >1000 samples exceed 20 bar error
    - Compute mean pressure during lean spikes and compare to overall mean
    - Generate fuel delivery diagnostic when lean-spike pressure is >10 bar below overall
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 5.3 Implement `analyzeInjectionTiming(data, channels)` in `injector/worker.js`
    - Compute timing statistics (min, max, mean) in dBTDC
    - Count samples in optimal window (240-320 dBTDC)
    - Count samples in compression stroke zone (< 180 dBTDC)
    - Generate compression stroke diagnostic when >5% in compression
    - Compute mean/median timing during lean spikes
    - Generate late-timing diagnostic when mean lean-spike timing < 240 dBTDC
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x] 5.4 Implement `analyzeClosedLoop(data, channels)` in `injector/worker.js`
    - Compute mean, std, min, max for each available bank trim channel
    - Generate rich/lean diagnostic when |mean| > 5%
    - Generate inconsistent fueling diagnostic when std > 4%
    - _Requirements: 11.1, 11.2, 11.3_

  - [x]* 5.5 Write property test for PW diagnostic thresholds
    - **Property 13: PW Diagnostic Threshold Accuracy**
    - **Validates: Requirements 8.3, 8.4, 8.5**

  - [x]* 5.6 Write property test for pressure unit conversion
    - **Property 14: Pressure Unit Conversion**
    - **Validates: Requirements 9.1, 13.3**

  - [x]* 5.7 Write property test for fuel pressure diagnostic thresholds
    - **Property 15: Fuel Pressure Diagnostic Thresholds**
    - **Validates: Requirements 9.5, 9.7**

  - [x]* 5.8 Write property test for timing window classification
    - **Property 16: Timing Window Classification**
    - **Validates: Requirements 10.2, 10.3**

  - [x]* 5.9 Write property test for timing diagnostic thresholds
    - **Property 17: Timing Diagnostic Thresholds**
    - **Validates: Requirements 10.4, 10.6**

  - [x]* 5.10 Write property test for closed-loop trim diagnostics
    - **Property 18: Closed-Loop Trim Diagnostics**
    - **Validates: Requirements 11.2, 11.3**

- [x] 6. Implement data downsampling and wire worker message flow
  - [x] 6.1 Implement `downsampleForCharts(data, channels, maxPoints)` in `injector/worker.js`
    - Compute downsampleStep = max(1, floor(data.length / maxPoints))
    - Build ChartData object with uniformly downsampled arrays (max 150,000 points)
    - Convert fuel pressure from dMPa to bar in chart data output
    - Include time, lambdaB1, lambdaB2, injPW, fuelPressDI, fuelPressDIAim, rpm, injTiming arrays
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 6.2 Wire complete worker message flow in `injector/worker.js`
    - Connect `self.onmessage` handler to call all analysis functions in sequence
    - Post final `{type: 'result', analyses, chartData}` message
    - Wrap in try/catch to post `{type: 'error', message}` on unexpected failures
    - _Requirements: 15.2, 16.1_

  - [x]* 6.3 Write property test for downsample bound
    - **Property 19: Downsample Bound**
    - **Validates: Requirements 13.1, 13.2**

- [x] 7. Checkpoint - Ensure worker logic is complete and testable
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Create injector page HTML and UI controller
  - [x] 8.1 Create `injector/index.html` page structure
    - HTML page with file input, Analyze button, progress bar, report section, and chart canvas containers
    - Link to `injector/styles.css` for page-specific styles
    - Include `<script>` tags for `injector/app.js` and `injector/charts.js`
    - 7 canvas elements for chart panels
    - Navigation link back to landing page
    - _Requirements: 12.1, 14.1, 17.1, 17.2_

  - [x] 8.2 Create `injector/styles.css` with page-specific styles
    - Style file input area, progress bar, report sections, chart containers
    - Responsive layout for chart grid
    - Diagnostic message styling (warning vs healthy indicators)
    - _Requirements: 14.3_

  - [x] 8.3 Implement `injector/app.js` — UI controller
    - Implement `handleFileSelect(event)` — validate .csv extension, enable/disable Analyze button, show error for non-CSV
    - Implement `handleAnalyzeClick()` — read file via FileReader, create worker, post message
    - Implement `createInjectorWorker()` — use Blob URL pattern for file:// compatibility
    - Implement `handleWorkerMessage(event)` — dispatch progress, result, warning, error messages
    - Implement `updateProgress(rowsProcessed, totalRows)` — update progress bar
    - Implement `renderReport(analyses)` — render structured HTML report with sections for each analysis module
    - Use `textContent` or DOM element creation for rendering (never innerHTML with user data)
    - Display channel mapping info and warnings
    - Render diagnostics with visual indicators (warning vs healthy)
    - Terminate worker after result or error
    - Allow re-analysis without page refresh after errors
    - _Requirements: 3.1, 3.2, 3.3, 6.4, 14.1, 14.2, 14.3, 14.4, 15.1, 15.2, 15.3, 15.4, 16.2, 16.3_

  - [x]* 8.4 Write property test for file extension validation
    - **Property 1: File Extension Validation**
    - **Validates: Requirements 3.1, 3.2**

- [x] 9. Implement chart renderer
  - [x] 9.1 Create `injector/charts.js` — canvas chart rendering module
    - Implement `renderAllCharts(containers, chartData)` — entry point that calls individual renderers
    - Implement canvas utility functions: axis drawing, gridlines, legends, DPI scaling
    - _Requirements: 12.3, 12.4, 17.3_

  - [x] 9.2 Implement time-series chart renderers
    - Implement `renderLambdaTimeSeries(canvas, data)` — lambda over time with threshold lines at 1.06 and 1.0, lean spike fill
    - Implement `renderPWTimeSeries(canvas, data)` — PW over time with 0.8 ms threshold line
    - Implement `renderFuelPressureTimeSeries(canvas, data)` — pressure over time with 150 bar threshold, aim overlay
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 9.3 Implement scatter, histogram, and density chart renderers
    - Implement `renderLambdaVsPWScatter(canvas, data)` — scatter with colour mapping by lambda value
    - Implement `renderPWHistogram(canvas, data)` — histogram with bin counting and threshold line
    - Implement `renderLambdaRPMDensity(canvas, data)` — 2D density heatmap
    - Implement `renderTimingVsRPMScatter(canvas, data)` — scatter with timing window reference lines (240, 320, 180 dBTDC)
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [x] 10. Integration and final wiring
  - [x] 10.1 Wire chart rendering into UI controller flow
    - Connect `renderReport` and `renderAllCharts` calls in `handleWorkerMessage` result handler
    - Ensure charts render after report section is populated
    - Handle cases where chart data arrays are null (missing channels)
    - _Requirements: 12.1, 14.1_

  - [x] 10.2 Add error handling and worker lifecycle management
    - Implement `worker.onerror` handler for unexpected crashes
    - Display generic error banner on worker crash
    - Ensure worker is terminated on completion, error, or new analysis
    - Allow file re-selection and re-analysis without page refresh
    - _Requirements: 15.3, 15.4, 16.3_

  - [x]* 10.3 Write integration tests for full analysis pipeline
    - Create small MoTeC CSV fixture file for testing
    - Test worker message sequence: progress messages followed by one result
    - Verify all 5 analysis sections produce expected results for known data
    - Verify chart data arrays respect downsample bound
    - _Requirements: 4.1, 7.1, 8.1, 9.1, 10.1, 11.1, 13.1_

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
- The Python script `analysis/motec_injector_analysis.py` serves as the reference implementation for analysis logic

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.2"] },
    { "id": 4, "tasks": ["2.4", "2.5", "4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3", "4.4", "4.5", "5.1", "5.2", "5.3", "5.4"] },
    { "id": 6, "tasks": ["5.5", "5.6", "5.7", "5.8", "5.9", "5.10", "6.1"] },
    { "id": 7, "tasks": ["6.2", "6.3"] },
    { "id": 8, "tasks": ["8.1", "8.2"] },
    { "id": 9, "tasks": ["8.3", "8.4", "9.1"] },
    { "id": 10, "tasks": ["9.2", "9.3"] },
    { "id": 11, "tasks": ["10.1", "10.2"] },
    { "id": 12, "tasks": ["10.3"] }
  ]
}
```
