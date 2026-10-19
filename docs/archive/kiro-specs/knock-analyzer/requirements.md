# Requirements Document

## Introduction

The Knock Analyzer is a browser-based diagnostic tool for the TunerControl suite that analyzes per-cylinder knock data from MoTeC M1 ECU logs. It identifies knock events, correlates them with operating conditions (RPM, load, gear, ignition timing), and provides per-cylinder diagnostic insights and timing adjustment recommendations for the GM LT4 engine with MoTeC M142 ECU.

## Glossary

- **Knock_Analyzer**: The browser-based tool that parses MoTeC log files and performs knock event detection, correlation analysis, and visualization
- **Knock_Event**: A data sample where the knock level for a cylinder exceeds the configured Knock_Threshold
- **Knock_Threshold**: A user-configurable percentage value above which a cylinder's knock level is classified as a Knock_Event (default: 5%)
- **Knock_Level**: The per-cylinder knock intensity value (0–100%) logged by the MoTeC M142 ECU at 20 Hz
- **Timing_Retard**: The ignition timing compensation applied by the ECU in response to detected knock, measured in degrees Before Top Dead Center (dBTDC)
- **Operating_Condition**: A combination of RPM band, load range (inlet manifold pressure in kPa), and gear that characterizes the engine state during a data sample
- **Log_Parser**: The module responsible for reading MoTeC .csv and .ld file formats and extracting channel data
- **Chart_Renderer**: The module responsible for drawing HTML5 Canvas visualizations of knock analysis results
- **Web_Worker**: A background thread that performs heavy computation (parsing and analysis) without blocking the user interface
- **Heatmap**: A two-dimensional grid visualization where RPM and load define the axes and color intensity represents knock event density
- **Cylinder_Index**: An integer from 1 to 8 identifying a specific cylinder of the GM LT4 V8 engine

## Requirements

### Requirement 1: File Input and Parsing

**User Story:** As a tuner, I want to load MoTeC log files in .csv or .ld format, so that I can analyze knock data from my engine runs.

#### Acceptance Criteria

1. WHEN a user selects a file with .csv extension, THE Log_Parser SHALL parse the file using MoTeC i2 CSV export format by locating the header row containing "Time" within the first 25 rows, skipping the units row, and extracting all available channels as named columns
2. WHEN a user selects a file with .ld extension, THE Log_Parser SHALL parse the file using MoTeC binary log format and extract all available channels
3. IF a file cannot be parsed due to invalid format, THEN THE Knock_Analyzer SHALL display an error message indicating the specific parsing failure reason, including at minimum whether the file lacked a recognizable header row or contained malformed data
4. IF a parsed file does not contain at least one channel matching the pattern "Ignition Cylinder N Knock Level" (where N is 1 through 8), THEN THE Knock_Analyzer SHALL display a warning message listing each expected knock level channel name that was not found in the file
5. THE Log_Parser SHALL execute within a Web_Worker to prevent blocking the user interface during file parsing
6. IF the selected file is empty (zero bytes), THEN THE Knock_Analyzer SHALL display an error message indicating that the file contains no data

### Requirement 2: Knock Event Detection

**User Story:** As a tuner, I want to identify knock events using a configurable threshold, so that I can focus on meaningful knock occurrences rather than background noise.

#### Acceptance Criteria

1. THE Knock_Analyzer SHALL provide a user-configurable Knock_Threshold input with a default value of 5% and an allowable range of 0% to 100% in increments of 0.1%
2. WHEN a Knock_Level sample for any Cylinder_Index exceeds the Knock_Threshold (strictly greater than), THE Knock_Analyzer SHALL classify that sample as a Knock_Event
3. WHEN the user changes the Knock_Threshold value, THE Knock_Analyzer SHALL recompute all Knock_Event classifications using the new threshold within 2 seconds for logs containing up to 500,000 samples
4. THE Knock_Analyzer SHALL associate each Knock_Event with the corresponding Cylinder_Index, timestamp, RPM, inlet manifold pressure, ignition timing, timing compensation, throttle position, and gear values from the same sample
5. IF the user enters a Knock_Threshold value outside the range of 0% to 100% or a non-numeric value, THEN THE Knock_Analyzer SHALL reject the input, revert to the previous valid threshold value, and display an error message indicating the valid range
6. IF one or more associated data fields (RPM, inlet manifold pressure, ignition timing, timing compensation, throttle position, or gear) are not present in the loaded log, THEN THE Knock_Analyzer SHALL still classify Knock_Events and populate available fields while indicating unavailable fields as absent in the Knock_Event record

### Requirement 3: Per-Cylinder Knock Distribution

**User Story:** As a tuner, I want to see which cylinders knock most frequently, so that I can identify problematic cylinders that may need individual timing adjustments.

#### Acceptance Criteria

1. THE Knock_Analyzer SHALL compute the total Knock_Event count for each Cylinder_Index (1 through 8)
2. THE Knock_Analyzer SHALL compute the percentage of total Knock_Events attributed to each Cylinder_Index, rounded to 1 decimal place
3. THE Chart_Renderer SHALL display a bar chart showing Knock_Event count per Cylinder_Index with cylinder numbers on the x-axis, event count on the y-axis, and the percentage value labeled on each bar
4. THE Knock_Analyzer SHALL rank cylinders from highest to lowest Knock_Event count in the diagnostic summary, using ascending Cylinder_Index order as the tie-breaker when counts are equal
5. IF the total Knock_Event count is zero, THEN THE Chart_Renderer SHALL display the bar chart with all bars at zero height and a message indicating no knock events were detected at the current threshold

### Requirement 4: Knock Intensity vs Operating Conditions

**User Story:** As a tuner, I want to see how knock intensity relates to RPM and engine load, so that I can identify the operating regions where knock is most severe.

#### Acceptance Criteria

1. THE Chart_Renderer SHALL display a scatter plot of Knock_Level (y-axis, range 0–100%) versus Engine Speed in RPM (x-axis, range 0–7500 RPM) for all Knock_Events
2. THE Chart_Renderer SHALL display a heatmap with Engine Speed (RPM) on the x-axis and Inlet Manifold Pressure (kPa) on the y-axis, where cell color intensity represents the count of Knock_Events in each RPM-load bin, and cells with zero Knock_Events are rendered with no color fill
3. THE Knock_Analyzer SHALL divide RPM into bins of 500 RPM width from 0 to 7500 RPM for heatmap aggregation
4. THE Knock_Analyzer SHALL divide Inlet Manifold Pressure into bins of 10 kPa width from 0 to 250 kPa for heatmap aggregation
5. WHEN the total Knock_Event count is zero, THE Chart_Renderer SHALL display empty chart areas with a message indicating no knock events are available for visualization

### Requirement 5: Knock and Ignition Timing Correlation

**User Story:** As a tuner, I want to see the ignition timing at which knock occurs, so that I can determine safe timing limits for each operating region.

#### Acceptance Criteria

1. THE Chart_Renderer SHALL display a scatter plot of Ignition Timing (dBTDC) versus Engine Speed (RPM) for all Knock_Events, with point color indicating Knock_Level intensity
2. THE Knock_Analyzer SHALL compute the mean and maximum Ignition Timing at which Knock_Events occur for each RPM bin
3. THE Knock_Analyzer SHALL compute the mean and maximum Ignition Timing at which Knock_Events occur for each Cylinder_Index

### Requirement 6: Timing Retard Analysis

**User Story:** As a tuner, I want to see when and how much timing retard the ECU applies during knock events, so that I can understand the ECU's knock response behavior.

#### Acceptance Criteria

1. THE Chart_Renderer SHALL display a time-series chart of Ignition Timing Compensation (dBTDC) over the duration of the log
2. THE Knock_Analyzer SHALL compute the total number of samples where Timing_Retard is non-zero
3. THE Knock_Analyzer SHALL compute the maximum Timing_Retard value observed during the log
4. THE Knock_Analyzer SHALL compute the mean Timing_Retard value during Knock_Events
5. WHEN Timing_Retard data is not available in the log, THE Knock_Analyzer SHALL display a message indicating that timing compensation data is not present

### Requirement 7: Operating Condition Identification

**User Story:** As a tuner, I want to know the specific RPM bands, load ranges, and gears where knock is most prevalent, so that I can target my tuning adjustments to those conditions.

#### Acceptance Criteria

1. THE Knock_Analyzer SHALL identify the RPM band containing the highest count of Knock_Events
2. THE Knock_Analyzer SHALL identify the Inlet Manifold Pressure range containing the highest count of Knock_Events
3. THE Knock_Analyzer SHALL identify the gear with the highest count of Knock_Events when gear data is available
4. WHEN gear data is not available in the log, THE Knock_Analyzer SHALL omit gear-based analysis without displaying an error

### Requirement 8: Diagnostic Message Generation

**User Story:** As a tuner, I want clear diagnostic messages summarizing knock behavior, so that I can quickly understand the knock situation without manually interpreting charts.

#### Acceptance Criteria

1. THE Knock_Analyzer SHALL generate a diagnostic message stating the Cylinder_Index with the highest Knock_Event percentage and that percentage value
2. THE Knock_Analyzer SHALL generate a diagnostic message stating the RPM band where the most Knock_Events occur
3. THE Knock_Analyzer SHALL generate a diagnostic message stating the load range where the most Knock_Events occur
4. WHEN the total Knock_Event count is zero, THE Knock_Analyzer SHALL generate a diagnostic message stating that no knock events were detected at the current threshold
5. THE Knock_Analyzer SHALL display all diagnostic messages in a dedicated summary section of the report

### Requirement 9: Per-Cylinder Timing Adjustment Recommendations

**User Story:** As a tuner, I want per-cylinder timing adjustment suggestions based on knock distribution, so that I have a starting point for reducing knock through individual cylinder timing trims.

#### Acceptance Criteria

1. THE Knock_Analyzer SHALL compute a recommended timing reduction for each Cylinder_Index based on the proportion of Knock_Events attributed to that cylinder relative to the cylinder with the fewest Knock_Events
2. THE Knock_Analyzer SHALL scale timing reduction recommendations proportionally, where the cylinder with the most Knock_Events receives the largest reduction and the cylinder with the fewest receives zero reduction
3. THE Knock_Analyzer SHALL cap the maximum recommended timing reduction at 5 degrees
4. THE Knock_Analyzer SHALL display timing recommendations in a table showing Cylinder_Index and recommended timing adjustment in degrees
5. WHEN the total Knock_Event count is zero, THE Knock_Analyzer SHALL not display timing adjustment recommendations

### Requirement 10: Chart Rendering

**User Story:** As a tuner, I want interactive charts rendered on HTML5 Canvas, so that I can visually explore knock patterns across different dimensions.

#### Acceptance Criteria

1. THE Chart_Renderer SHALL render all charts using HTML5 Canvas elements
2. THE Chart_Renderer SHALL render charts using the dark theme color scheme consistent with the TunerControl application (dark background, light text, colored data points)
3. THE Chart_Renderer SHALL label all chart axes with the channel name and unit of measurement
4. THE Chart_Renderer SHALL render charts without requiring any external JavaScript libraries or CDN resources
5. WHEN the analysis data set exceeds 150,000 data points, THE Chart_Renderer SHALL downsample the data for scatter plot rendering while preserving the statistical distribution

### Requirement 11: Application Architecture

**User Story:** As a developer, I want the knock analyzer to follow the same architecture as existing TunerControl tools, so that the codebase remains consistent and maintainable.

#### Acceptance Criteria

1. THE Knock_Analyzer SHALL be structured with separate files: knock/index.html for page structure, knock/styles.css for styling, knock/app.js for UI control, knock/worker.js for analysis computation, and knock/charts.js for chart rendering
2. THE Knock_Analyzer SHALL execute all parsing and analysis computation within a Web_Worker
3. THE Knock_Analyzer SHALL operate without any external dependencies or network requests
4. THE Knock_Analyzer SHALL function when loaded via the file:// protocol
5. THE Knock_Analyzer SHALL include a navigation link back to the TunerControl landing page
6. THE TunerControl landing page SHALL include a navigation card linking to the Knock_Analyzer

### Requirement 12: Progress Feedback

**User Story:** As a tuner, I want to see analysis progress while the tool processes my log file, so that I know the application is working and can estimate completion time.

#### Acceptance Criteria

1. WHILE the Web_Worker is parsing a log file, THE Knock_Analyzer SHALL display a progress bar indicating the percentage of parsing completed
2. WHILE the Web_Worker is performing knock analysis, THE Knock_Analyzer SHALL display a progress indicator showing the current analysis phase
3. WHEN analysis completes, THE Knock_Analyzer SHALL hide the progress indicator and display the results
