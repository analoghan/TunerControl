# Requirements Document

## Introduction

This document specifies the requirements for the Injector Characterization feature of the TunerControl web application. The feature provides a browser-based tool that replicates the functionality of the Python script `motec_injector_analysis.py`, enabling users to perform lean spike analysis, injector pulsewidth stability analysis, DI fuel pressure analysis, injection timing analysis, and closed-loop fuel trim analysis on MoTeC M1 CSV log data — all without leaving the browser. A new landing page provides navigation between the existing VE Table tool and the new Injector Characterization tool.

## Glossary

- **Landing_Page**: The root `index.html` file that serves as the application entry point with navigation to all analysis tools
- **Injector_Page**: The `injector/index.html` page that hosts the injector characterization analysis tool
- **Analysis_Worker**: The Web Worker (`injector/worker.js`) that performs all heavy CSV parsing and analysis computation off the main thread
- **UI_Controller**: The main-thread JavaScript (`injector/app.js`) that manages file input, worker lifecycle, and result rendering
- **Chart_Renderer**: The module (`injector/charts.js`) that draws analysis charts on HTML5 Canvas elements
- **Channel_Resolver**: The algorithm that maps logical channel names to MoTeC CSV column headers via case-insensitive matching
- **MoTeC_CSV**: A CSV file exported from MoTeC M1 ECU logging software, containing metadata rows, a header row starting with "Time", a units row, and numeric data rows
- **Lean_Spike**: A data sample where the exhaust lambda value exceeds 1.06
- **XDI_Instability_Zone**: Injector pulsewidth values below 0.8 ms where direct injection atomization degrades
- **dBTDC**: Degrees Before Top Dead Centre (compression stroke) — the unit for injection timing
- **dMPa**: DecaMegaPascal — the unit MoTeC uses for DI fuel pressure (multiply by 100 to get bar)

## Requirements

### Requirement 1: Landing Page Navigation

**User Story:** As a tuner, I want a landing page that provides clear navigation to all available analysis tools, so that I can quickly access the tool I need.

#### Acceptance Criteria

1. WHEN a user opens the root `index.html`, THE Landing_Page SHALL display navigation cards linking to the VE Table tool and the Injector Characterization tool
2. THE Landing_Page SHALL use relative paths (`ve-table/index.html` and `injector/index.html`) for navigation links so that the application works via file:// protocol
3. THE Landing_Page SHALL display a title, brief description of the application, and a visual card for each available tool
4. THE Landing_Page SHALL require zero JavaScript to function — navigation is achieved through standard HTML anchor elements

### Requirement 2: File Structure Reorganization

**User Story:** As a developer, I want the existing VE Table tool relocated to a `ve-table/` subdirectory, so that the project structure supports multiple tools cleanly.

#### Acceptance Criteria

1. WHEN the reorganization is complete, THE existing VE Table tool SHALL be fully functional at `ve-table/index.html` with all asset paths updated
2. THE existing test harness SHALL continue to function with updated paths referencing the `ve-table/` subdirectory
3. THE root `index.html` SHALL be the new Landing_Page, not the VE Table tool

### Requirement 3: MoTeC CSV File Input

**User Story:** As a tuner, I want to select a MoTeC M1 CSV log file from my local machine, so that I can analyze injector behavior from my logged data.

#### Acceptance Criteria

1. WHEN a user selects a file with a `.csv` extension, THE UI_Controller SHALL enable the Analyze button
2. WHEN a user selects a file without a `.csv` extension, THE UI_Controller SHALL display an error message and keep the Analyze button disabled
3. WHEN a user clicks the Analyze button, THE UI_Controller SHALL read the file contents using the FileReader API and pass the text to the Analysis_Worker

### Requirement 4: MoTeC CSV Parsing

**User Story:** As a tuner, I want the tool to automatically detect and parse the MoTeC M1 CSV format, so that I do not need to manually prepare my log files.

#### Acceptance Criteria

1. WHEN the Analysis_Worker receives log text, THE Analysis_Worker SHALL scan the first 25 lines to locate the header row whose first field is "Time"
2. IF the header row is not found within the first 25 lines, THEN THE Analysis_Worker SHALL post an error message indicating the file format is unrecognized
3. WHEN the header row is located, THE Analysis_Worker SHALL identify the first numeric data row by scanning rows after the header for a row whose first field parses as a number
4. THE Analysis_Worker SHALL parse all data rows into numeric arrays, treating non-numeric values as NaN

### Requirement 5: Channel Resolution

**User Story:** As a tuner, I want the tool to automatically map MoTeC channel names to the analysis functions, so that I do not need to manually configure column mappings.

#### Acceptance Criteria

1. WHEN column headers are extracted, THE Channel_Resolver SHALL perform case-insensitive matching against the predefined channel name candidates
2. IF the "Engine Speed" channel is not found, THEN THE Analysis_Worker SHALL post an error message specifying the missing required channel
3. IF no lambda channel (Bank 1, Bank 2, or Average) is found, THEN THE Analysis_Worker SHALL post an error message specifying that no lambda source is available
4. WHEN optional channels are not found, THE Channel_Resolver SHALL record a warning message for each missing optional channel and continue analysis without those sections

### Requirement 6: Analysis Progress Reporting

**User Story:** As a tuner, I want to see parsing progress for large log files, so that I know the tool is working and can estimate completion time.

#### Acceptance Criteria

1. WHILE the Analysis_Worker is parsing data rows, THE Analysis_Worker SHALL post progress messages with `rowsProcessed` and `totalRows` values
2. THE progress messages SHALL have strictly increasing `rowsProcessed` values
3. THE `rowsProcessed` value SHALL never exceed `totalRows`
4. WHEN the UI_Controller receives a progress message, THE UI_Controller SHALL update a visible progress indicator

### Requirement 7: Lean Spike Analysis

**User Story:** As a tuner, I want to identify lean spike events and understand their distribution across RPM ranges and cylinder banks, so that I can diagnose fueling issues.

#### Acceptance Criteria

1. WHEN analysis is performed, THE Analysis_Worker SHALL count all samples where the lambda value exceeds 1.06 as lean spike events
2. WHEN both Bank 1 and Bank 2 lambda channels are available, THE Analysis_Worker SHALL categorize lean events as both-banks-lean, only-Bank-1-lean, or only-Bank-2-lean
3. WHEN both bank categorization is performed, THE sum of both-banks-lean, only-Bank-1-lean, and only-Bank-2-lean SHALL equal the total lean event count
4. THE Analysis_Worker SHALL distribute lean spike events across RPM bins: <800, 800-1.2k, 1.2-1.5k, 1.5-2k, 2-2.5k, 2.5-3k, 3-4k, 4-5.5k, 5.5k+
5. WHEN injector pulsewidth data is available, THE Analysis_Worker SHALL count lean spikes that coincide with pulsewidth below 0.8 ms
6. THE Analysis_Worker SHALL generate diagnostic messages interpreting the lean spike patterns (bank distribution, low-PW correlation)

### Requirement 8: Injector Pulsewidth Stability Analysis

**User Story:** As a tuner, I want to understand injector pulsewidth statistics and identify instability risk, so that I can adjust injector characterization tables.

#### Acceptance Criteria

1. WHEN the injector PW channel is available, THE Analysis_Worker SHALL compute min, max, mean, median, standard deviation, 5th percentile, and 1st percentile of all PW values above 0.05 ms
2. THE Analysis_Worker SHALL count and report the percentage of PW samples below the 0.8 ms instability threshold
3. WHEN the 5th percentile PW is below 0.7 ms, THE Analysis_Worker SHALL generate a severe instability diagnostic
4. WHEN the 5th percentile PW is between 0.7 ms and 0.8 ms, THE Analysis_Worker SHALL generate a possible instability diagnostic
5. WHEN the 5th percentile PW is at or above 0.8 ms, THE Analysis_Worker SHALL generate a healthy status diagnostic

### Requirement 9: DI Fuel Pressure Analysis

**User Story:** As a tuner, I want to analyze direct injection fuel pressure behavior and its correlation with lean spikes, so that I can identify high-pressure fuel pump issues.

#### Acceptance Criteria

1. WHEN the DI fuel pressure channel is available, THE Analysis_Worker SHALL convert raw dMPa values to bar by multiplying by 100
2. THE Analysis_Worker SHALL compute pressure statistics (min, max, mean, standard deviation) in bar units
3. THE Analysis_Worker SHALL count samples where fuel pressure falls below 150 bar
4. WHEN the fuel pressure aim channel is available, THE Analysis_Worker SHALL compute the mean and standard deviation of the pressure error (actual minus aim)
5. WHEN the pressure aim channel is available and samples with greater than 20 bar error exceed 1000, THE Analysis_Worker SHALL generate an HPFP diagnostic warning
6. WHEN lambda data is available, THE Analysis_Worker SHALL compute mean fuel pressure during lean spike events and compare it to overall mean pressure
7. WHEN mean fuel pressure during lean spikes is more than 10 bar below overall mean, THE Analysis_Worker SHALL generate a fuel delivery diagnostic

### Requirement 10: Injection Timing Analysis

**User Story:** As a tuner, I want to analyze injection timing distribution relative to the optimal intake stroke window, so that I can identify timing-related atomization issues.

#### Acceptance Criteria

1. WHEN the injection timing channel is available, THE Analysis_Worker SHALL compute timing statistics (min, max, mean) in dBTDC units
2. THE Analysis_Worker SHALL count and report the percentage of samples within the optimal window (240-320 dBTDC)
3. THE Analysis_Worker SHALL count and report the percentage of samples in the compression stroke zone (below 180 dBTDC)
4. WHEN more than 5% of injections occur during the compression stroke, THE Analysis_Worker SHALL generate a timing diagnostic recommending advancement
5. WHEN lambda data is available, THE Analysis_Worker SHALL compute mean and median injection timing during lean spike events
6. WHEN mean lean-spike timing is below 240 dBTDC, THE Analysis_Worker SHALL generate a diagnostic correlating late timing with lean events

### Requirement 11: Closed-Loop Fuel Trim Analysis

**User Story:** As a tuner, I want to analyze closed-loop fuel trim statistics per bank, so that I can identify base VE table errors and inconsistent fueling.

#### Acceptance Criteria

1. WHEN a closed-loop trim channel is available for a bank, THE Analysis_Worker SHALL compute mean, standard deviation, min, and max trim values for that bank
2. WHEN the absolute value of mean trim exceeds 5%, THE Analysis_Worker SHALL generate a diagnostic indicating the base VE table is running rich or lean
3. WHEN trim standard deviation exceeds 4%, THE Analysis_Worker SHALL generate a diagnostic indicating inconsistent fueling

### Requirement 12: Chart Rendering

**User Story:** As a tuner, I want to see visual charts of the analysis data, so that I can quickly identify patterns and correlations in the log data.

#### Acceptance Criteria

1. WHEN analysis completes successfully, THE Chart_Renderer SHALL render 7 chart panels: lambda time series, PW time series, lambda vs PW scatter, fuel pressure time series, PW histogram, lambda-RPM density heatmap, and timing vs RPM scatter
2. THE Chart_Renderer SHALL draw threshold reference lines on applicable charts (lambda 1.06, PW 0.8 ms, pressure 150 bar, timing window 240/320 dBTDC, compression 180 dBTDC)
3. THE Chart_Renderer SHALL render axis labels, gridlines, and legends on each chart panel
4. THE Chart_Renderer SHALL use the HTML5 Canvas 2D API with no external charting libraries

### Requirement 13: Data Downsampling for Charts

**User Story:** As a tuner, I want charts to render quickly even for large log files, so that the tool remains responsive with 50-100+ MB logs.

#### Acceptance Criteria

1. WHEN preparing chart data, THE Analysis_Worker SHALL uniformly downsample to a maximum of 150,000 points
2. THE downsampled chart data arrays SHALL never exceed 150,000 elements in length
3. THE Analysis_Worker SHALL convert fuel pressure values from dMPa to bar in the chart data output

### Requirement 14: Report Rendering

**User Story:** As a tuner, I want a structured textual report of all analysis results, so that I can read specific statistics and diagnostic messages.

#### Acceptance Criteria

1. WHEN analysis results are received, THE UI_Controller SHALL render a structured HTML report with sections for each analysis module
2. THE UI_Controller SHALL display channel mapping information and any channel resolution warnings
3. THE UI_Controller SHALL render diagnostic messages with visual indicators distinguishing warnings from healthy status
4. THE UI_Controller SHALL use `textContent` or DOM element creation for rendering — never `innerHTML` with user-provided data

### Requirement 15: Error Handling

**User Story:** As a tuner, I want clear error messages when something goes wrong, so that I can understand what happened and take corrective action.

#### Acceptance Criteria

1. IF the Analysis_Worker encounters a missing required channel, THEN THE UI_Controller SHALL display an error banner with the specific missing channel name
2. IF the CSV file format is unrecognized, THEN THE UI_Controller SHALL display an error message explaining the expected format
3. IF the Analysis_Worker crashes unexpectedly, THEN THE UI_Controller SHALL catch the error via the worker's onerror handler and display a generic error banner
4. WHEN an error is displayed, THE UI_Controller SHALL allow the user to select a new file and re-analyze without refreshing the page

### Requirement 16: Web Worker Architecture

**User Story:** As a tuner, I want the analysis to run without freezing the browser UI, so that I can continue interacting with the page during computation.

#### Acceptance Criteria

1. THE Analysis_Worker SHALL run all CSV parsing and analysis computation in a dedicated Web Worker thread
2. THE UI_Controller SHALL create the Web Worker using the Blob URL pattern for file:// protocol compatibility
3. WHEN analysis is complete or an error occurs, THE UI_Controller SHALL terminate the worker to free resources

### Requirement 17: Zero-Dependency Browser Architecture

**User Story:** As a developer, I want the application to work with zero external dependencies and no build step, so that it can be opened directly via file:// protocol.

#### Acceptance Criteria

1. THE Injector_Page SHALL function correctly when opened via file:// protocol with no web server
2. THE Injector_Page SHALL use no external CDN scripts, npm packages, or build tools for production functionality
3. THE Chart_Renderer SHALL use only the built-in HTML5 Canvas 2D API for all chart rendering
4. THE UI_Controller SHALL use only built-in browser APIs (FileReader, Web Workers, DOM) with no framework dependencies
