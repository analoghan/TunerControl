# Requirements Document

## Introduction

A single-page web application that runs entirely in the browser (no backend server) for MoTeC ECU tuning. The user uploads a MoTeC M1 CSV log file and an "Eng Efficiency Main" VE table CSV file. The application parses both files, bins each log sample into the nearest RPM/MAP cell of the VE table, computes a correction percentage per cell from lambda error and closed-loop fuel trim data, and produces two downloadable CSV files: a difference table showing the correction percentages and a new VE table in M1 v2 format ready to import back into MoTeC.

## Glossary

- **VE_Table**: The "Eng Efficiency Main" table in MoTeC M1, a 2-D lookup table of Volumetric Efficiency values indexed by Engine Speed (RPM) and Inlet Manifold Pressure (MAP in kPa).
- **Log_Parser**: The browser-side component that reads a MoTeC M1 CSV export, detects the metadata header rows, and extracts channel data into an in-memory row array.
- **VE_Parser**: The browser-side component that reads an M1 v2 format VE table CSV and produces a structured grid of RPM breakpoints, MAP breakpoints, and VE values.
- **Bin_Assigner**: The component that maps each log sample's RPM and MAP values to the nearest breakpoint in the VE table axes.
- **Correction_Calculator**: The component that computes the VE correction percentage for each RPM/MAP cell from lambda and closed-loop trim data.
- **Hit_Counter**: The component that counts how many log samples fall into each RPM/MAP cell.
- **Output_Builder**: The component that assembles the difference CSV and the new-values M1 v2 CSV from the correction results.
- **Lambda_B1**: The "Exhaust Lambda Bank 1" channel in the MoTeC log.
- **Lambda_B2**: The "Exhaust Lambda Bank 2" channel in the MoTeC log.
- **Lambda_Avg**: The "Exhaust Lambda" channel in the MoTeC log (combined average).
- **Lambda_Actual**: The per-sample effective lambda value, computed as the average of Lambda_B1 and Lambda_B2 when both are present and non-NaN, otherwise the Lambda_Avg channel value.
- **Lambda_Target**: The "Fuel Mixture Aim" channel value for each log sample.
- **CL_Trim_B1**: The "Fuel Closed Loop Control Bank 1 Trim" channel (percent).
- **CL_Trim_B2**: The "Fuel Closed Loop Control Bank 2 Trim" channel (percent).
- **CL_Trim_Avg**: The average of the available non-NaN trim values from CL_Trim_B1 and CL_Trim_B2; equals 0.0 when both are NaN or absent.
- **Correction_%**: The VE correction percentage for a cell: `((Lambda_Target / Lambda_Actual) - 1) * 100 + CL_Trim_Avg`.
- **Hit_Threshold**: The minimum number of valid log samples required for a cell to be included in the output (50 samples). A cell must have strictly more than 50 valid samples to be included.
- **M1_v2_Format**: The MoTeC M1 table CSV format with a 4-row header (`M1,v2` / `Body,%` / `Cols,rpm,Eng Speed` / `Rows,kPa,Inlet Man Pres`), followed by a column-header row of RPM breakpoints, then data rows where the first column is the MAP breakpoint and remaining columns are VE values stored as scientific-notation floats.
- **Difference_CSV**: Output file showing the computed Correction_% for each cell that meets the Hit_Threshold; cells below the threshold are blank.
- **New_Values_CSV**: Output file in M1_v2_Format containing the recommended VE values (original value adjusted by Correction_%) for cells meeting the Hit_Threshold; cells below the threshold retain the original VE value unchanged.
- **RPM_Breakpoints**: The 20 RPM axis values: 0, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000.
- **MAP_Breakpoints**: The 24 MAP axis values (kPa): 10, 15, 20, 25, 30, 35, 40, 50, 55, 60, 70, 80, 90, 100, 110, 120, 140, 160, 180, 200, 220, 240, 260, 280.
- **Web_App**: The single-page HTML/CSS/JavaScript application that runs entirely in the browser without a backend server.
- **Valid Sample**: A log sample where Lambda_Actual is non-NaN and non-zero, and Lambda_Target is non-NaN and non-zero.

---

## Requirements

### Requirement 1: File Upload Interface

**User Story:** As a tuner, I want to upload my MoTeC log CSV and VE table CSV through a browser interface, so that I can process them without installing any software.

#### Acceptance Criteria

1. THE Web_App SHALL provide a file input control that accepts a single MoTeC M1 CSV log file with a `.csv` extension.
2. THE Web_App SHALL provide a file input control that accepts a single M1_v2_Format VE table CSV file with a `.csv` extension.
3. WHEN both file inputs have a valid `.csv` file selected, THE Web_App SHALL enable the "Process" button.
4. IF fewer than two valid `.csv` files are selected (zero or one), THEN THE Web_App SHALL keep the "Process" button disabled.
5. WHEN a file is selected in a file input control, THE Web_App SHALL display the selected filename next to that control.
6. THE Web_App SHALL run entirely in the browser without requiring a backend server, build tools, or package installation, and SHALL be launchable by opening index.html directly in a browser.
7. IF a file with a non-`.csv` extension is selected in either file input, THEN THE Web_App SHALL display an error message identifying the invalid file and treat that input as unset (reverting the button to disabled if applicable).
8. WHEN a previously selected file is cleared or replaced in a file input, THE Web_App SHALL re-evaluate the enabled/disabled state of the "Process" button based on the current state of both inputs.

---

### Requirement 2: MoTeC Log CSV Parsing

**User Story:** As a tuner, I want the application to correctly parse MoTeC M1 CSV exports, so that channel data is accurately extracted despite the multi-row metadata header.

#### Acceptance Criteria

1. WHEN a MoTeC log CSV is loaded, THE Log_Parser SHALL scan the first 25 rows to locate the row whose first field, after stripping surrounding double-quote characters, exactly matches the string "Time" (case-sensitive), and treat that row as the channel header row.
2. WHEN the channel header row is found, THE Log_Parser SHALL treat the immediately following row as the units row and skip it, along with any subsequent rows where all fields are empty strings after trimming, before the first numeric data row.
3. WHEN channel names are extracted, THE Log_Parser SHALL strip surrounding double-quote characters and leading/trailing whitespace from each name.
4. WHEN numeric values are read from data rows, THE Log_Parser SHALL parse scientific-notation strings (e.g., `1.00000000895353912e+03`) as floating-point numbers.
5. IF the "Time" header row is not found within the first 25 rows, THEN THE Log_Parser SHALL display an error message identifying the file as an unrecognised format and halt processing.
6. IF a data row contains a non-numeric value or an empty string in a numeric channel column, THEN THE Log_Parser SHALL treat that value as NaN and continue processing remaining rows.
7. WHEN the log file exceeds 10 MB, THE Log_Parser SHALL process the file in streaming chunks of no more than 500,000 rows to avoid blocking the browser's main thread.

---

### Requirement 3: VE Table CSV Parsing

**User Story:** As a tuner, I want the application to correctly parse the M1 v2 VE table CSV, so that the original VE values and axis breakpoints are accurately read.

#### Acceptance Criteria

1. WHEN a VE table CSV is loaded, THE VE_Parser SHALL verify that row 1 contains "M1" in the first field and "v2" in the second field (after stripping quotes and whitespace); IF this check fails, THEN THE VE_Parser SHALL display an error message, discard any partially parsed data, and halt processing.
2. WHEN the VE table CSV is valid, THE VE_Parser SHALL extract RPM breakpoints from row 5 (the column-header row), skipping the first (empty label) field, parsing each remaining value as a floating-point number and rounding to the nearest integer.
3. WHEN the VE table CSV is valid, THE VE_Parser SHALL extract MAP breakpoints from the first column of rows 6 and beyond, parsing each value as a floating-point number and rounding to the nearest integer.
4. WHEN the VE table CSV is valid, THE VE_Parser SHALL extract VE values from columns 2 and beyond of rows 6 and beyond as floating-point numbers, preserving full precision.
5. IF a VE data cell contains a non-numeric or empty value, THEN THE VE_Parser SHALL display an error message identifying the row and column and halt processing.
6. THE VE_Parser SHALL produce a round-trip-safe representation such that re-serialising the parsed data back to M1_v2_Format produces values whose absolute difference from the original parsed values is no greater than 1e-9.

---

### Requirement 4: Channel Resolution

**User Story:** As a tuner, I want the application to find the correct channels in the log regardless of minor naming variations, so that analysis works reliably across different MoTeC export configurations.

#### Acceptance Criteria

1. THE Log_Parser SHALL resolve the RPM channel by matching the column name "Engine Speed" (case-insensitive, whitespace-trimmed).
2. THE Log_Parser SHALL resolve the MAP channel by matching the column name "Inlet Manifold Pressure" (case-insensitive, whitespace-trimmed).
3. THE Log_Parser SHALL resolve Lambda_B1 by matching "Exhaust Lambda Bank 1" (case-insensitive, whitespace-trimmed).
4. THE Log_Parser SHALL resolve Lambda_B2 by matching "Exhaust Lambda Bank 2" (case-insensitive, whitespace-trimmed).
5. THE Log_Parser SHALL resolve Lambda_Avg by matching "Exhaust Lambda" (case-insensitive, whitespace-trimmed) only when no column matching "Exhaust Lambda Bank 1" or "Exhaust Lambda Bank 2" is present.
6. THE Log_Parser SHALL resolve Lambda_Target by matching "Fuel Mixture Aim" (case-insensitive, whitespace-trimmed).
7. THE Log_Parser SHALL resolve CL_Trim_B1 by matching "Fuel Closed Loop Control Bank 1 Trim" (case-insensitive, whitespace-trimmed).
8. THE Log_Parser SHALL resolve CL_Trim_B2 by matching "Fuel Closed Loop Control Bank 2 Trim" (case-insensitive, whitespace-trimmed).
9. IF the RPM channel or MAP channel cannot be resolved, THEN THE Log_Parser SHALL display an error message naming each missing channel and halt processing.
10. IF Lambda_B1 and Lambda_B2 are both absent, THEN THE Log_Parser SHALL use Lambda_Avg as the sole lambda source for all samples (treating it as both banks); IF Lambda_Avg is also absent, THEN THE Log_Parser SHALL display an error message and halt processing.
11. IF Lambda_Target is absent, THEN THE Log_Parser SHALL display an error message and halt processing.
12. IF CL_Trim_B1 or CL_Trim_B2 is absent, THEN THE Log_Parser SHALL use 0.0 as the trim value for the missing bank and SHALL display a non-fatal warning identifying which bank trim channel was not found.
13. WHEN processing is halted due to a missing required channel, THE Log_Parser SHALL discard any partially resolved channel data and return an error state to the Web_App.

---

### Requirement 5: Bin Assignment

**User Story:** As a tuner, I want each log sample assigned to the nearest VE table cell, so that corrections are applied to the right RPM/MAP region.

#### Acceptance Criteria

1. WHEN assigning a log sample, THE Bin_Assigner SHALL select the RPM breakpoint from RPM_Breakpoints whose absolute difference from the sample's RPM value is smallest; WHEN two RPM breakpoints are equidistant, THE Bin_Assigner SHALL select the lower breakpoint.
2. WHEN assigning a log sample, THE Bin_Assigner SHALL select the MAP breakpoint from MAP_Breakpoints whose absolute difference from the sample's MAP value is smallest; WHEN two MAP breakpoints are equidistant, THE Bin_Assigner SHALL select the lower breakpoint.
3. WHEN a log sample is assigned to a cell, THE Hit_Counter SHALL increment the count for the (RPM_breakpoint, MAP_breakpoint) cell by 1.
4. WHEN all log samples have been processed, THE Hit_Counter SHALL produce a grid of 480 cells (24 MAP breakpoints × 20 RPM breakpoints), with each cell initialised to zero and incremented only by samples assigned to it.
5. IF a log sample's RPM value is NaN or its MAP value is NaN, THEN THE Bin_Assigner SHALL skip that sample and not increment any cell count.

---

### Requirement 6: Correction Calculation

**User Story:** As a tuner, I want the application to compute the VE correction percentage for each cell from lambda error and closed-loop trim data, so that I know exactly how much to adjust each cell.

#### Acceptance Criteria

1. IF a log sample has both Lambda_B1 and Lambda_B2 columns present with non-NaN, non-zero values for that sample row, THEN THE Correction_Calculator SHALL compute Lambda_Actual as `(Lambda_B1 + Lambda_B2) / 2`.
2. IF a log sample has one of Lambda_B1 or Lambda_B2 as NaN or zero for that sample row but the other is a non-NaN, non-zero value, THEN THE Correction_Calculator SHALL use the valid bank's value as Lambda_Actual.
3. IF both Lambda_B1 and Lambda_B2 are absent or NaN for a sample, THEN THE Correction_Calculator SHALL use Lambda_Avg as Lambda_Actual for that sample.
4. WHEN computing CL_Trim_Avg for a log sample, THE Correction_Calculator SHALL average the available non-NaN trim values from CL_Trim_B1 and CL_Trim_B2; IF both are NaN or absent, THEN CL_Trim_Avg SHALL be 0.0.
5. IF Lambda_Actual is zero or NaN for a sample, THEN THE Correction_Calculator SHALL exclude that sample from all cell calculations (it is not a Valid Sample).
6. IF Lambda_Target is zero or NaN for a sample, THEN THE Correction_Calculator SHALL exclude that sample from all cell calculations (it is not a Valid Sample).
7. IF a cell has more than Hit_Threshold valid samples, THEN THE Correction_Calculator SHALL compute Correction_% as the mean of `((Lambda_Target / Lambda_Actual) - 1) * 100 + CL_Trim_Avg` across all Valid Samples assigned to that cell.
8. IF a cell has Hit_Threshold or fewer valid samples, THEN THE Correction_Calculator SHALL mark that cell as below the Hit_Threshold; the cell SHALL be omitted entirely from the Difference_CSV output and its original VE value SHALL be preserved unchanged in the New_Values_CSV.

---

### Requirement 7: Output Generation — Difference CSV

**User Story:** As a tuner, I want a downloadable difference CSV showing the correction percentages per cell, so that I can review which cells need adjustment and by how much.

#### Acceptance Criteria

1. WHEN output is generated, THE Output_Builder SHALL produce a Difference_CSV with a header row containing an empty first field followed by the RPM_Breakpoints as column labels, in ascending RPM order.
2. WHEN output is generated, THE Output_Builder SHALL produce one data row per MAP breakpoint in MAP_Breakpoints, with the MAP value as the first field, in ascending MAP order.
3. WHEN a cell exceeds the Hit_Threshold, THE Output_Builder SHALL write the Correction_% value rounded to 2 decimal places in the corresponding cell of the Difference_CSV.
4. WHEN a cell is at or below the Hit_Threshold, THE Output_Builder SHALL write an empty string in the corresponding cell of the Difference_CSV.
5. THE Output_Builder SHALL make the Difference_CSV available for download via a browser download link with a default filename of `VE_Difference.csv`.
6. WHEN the Difference_CSV is opened in a spreadsheet application, the grid layout SHALL match the VE table orientation: MAP breakpoints as row labels and RPM breakpoints as column labels.

---

### Requirement 8: Output Generation — New Values CSV

**User Story:** As a tuner, I want a downloadable new VE table CSV in M1 v2 format, so that I can import it directly into MoTeC without manual reformatting.

#### Acceptance Criteria

1. WHEN output is generated, THE Output_Builder SHALL produce a New_Values_CSV whose first 4 rows exactly match the M1_v2_Format header: `M1,v2` / `Body,%` / `Cols,rpm,Eng Speed` / `Rows,kPa,Inlet Man Pres`.
2. WHEN output is generated, THE Output_Builder SHALL write the RPM breakpoints in row 5 of the New_Values_CSV as quoted scientific-notation floats, preserving the original string values from the input VE table file exactly.
3. WHEN a cell exceeds the Hit_Threshold, THE Output_Builder SHALL write the new VE value as `original_VE * (1 + Correction_% / 100)` in the corresponding cell, formatted as a quoted scientific-notation float with the same number of significant digits as the original VE table input file.
4. WHEN a cell is at or below the Hit_Threshold, THE Output_Builder SHALL write the original VE value unchanged in the corresponding cell, preserving the original quoted scientific-notation string exactly.
5. WHEN at least one cell has been processed, THE Output_Builder SHALL make the New_Values_CSV available for download via a browser download link with a default filename of `VE_New_Values.csv`; IF no cells were processed, THE Output_Builder SHALL not provide a download link for the New_Values_CSV.
6. WHEN the New_Values_CSV is re-parsed by THE VE_Parser, the resulting VE values SHALL differ from the written values by no more than 1e-9 (round-trip property).

---

### Requirement 9: Progress Indication

**User Story:** As a tuner, I want a progress indicator during processing, so that I know the application is working and not frozen when handling large log files.

#### Acceptance Criteria

1. WHEN the user clicks "Process", THE Web_App SHALL display a visible progress indicator within 100 ms.
2. WHILE log file parsing is in progress, THE Web_App SHALL update the progress indicator to reflect the proportion of the file parsed, updating at least once per 500,000 rows processed.
3. WHEN processing completes successfully, THE Web_App SHALL hide the progress indicator and display the results summary.
4. IF processing encounters a fatal error, THE Web_App SHALL hide the progress indicator and display a descriptive error message identifying the cause of failure.
5. WHILE processing is in progress, THE Web_App SHALL disable the "Process" button to prevent duplicate submissions.
6. WHEN processing completes (successfully or with a fatal error), THE Web_App SHALL re-enable the "Process" button if both file inputs still have valid files selected.

---

### Requirement 10: Results Summary Display

**User Story:** As a tuner, I want a summary table displayed in the browser after processing, so that I can review the corrections before downloading the output files.

#### Acceptance Criteria

1. WHEN processing completes and at least one Valid Sample was processed, THE Web_App SHALL display a 2-D summary table with MAP breakpoints as row headers and RPM breakpoints as column headers.
2. IF no Valid Samples were processed, THEN THE Web_App SHALL display a message indicating no data was processed and SHALL NOT display the summary table.
3. WHEN a cell exceeds the Hit_Threshold, THE Web_App SHALL display the Correction_% value (rounded to 2 decimal places) in the corresponding table cell, with a green background for positive values (add fuel) and a red background for negative values (remove fuel).
4. WHEN a cell is at or below the Hit_Threshold, THE Web_App SHALL display the cell with a grey background and no numeric value, visually distinguishing it from cells with sufficient data.
5. THE Web_App SHALL display the total number of log samples processed and the count of cells that exceeded the Hit_Threshold alongside the summary table.
6. THE Web_App SHALL display the download buttons for Difference_CSV and New_Values_CSV only after processing completes successfully and at least one cell exceeded the Hit_Threshold.

---

### Requirement 11: Error Handling and Validation

**User Story:** As a tuner, I want clear error messages when files are invalid or channels are missing, so that I can diagnose and fix problems without guessing.

#### Acceptance Criteria

1. IF a selected file cannot be read by the browser File API, THEN THE Web_App SHALL display an error message stating the filename and that the file could not be read, and SHALL halt processing.
2. IF the MoTeC log CSV does not contain a "Time" header row within the first 25 rows, THEN THE Web_App SHALL display an error message identifying the file as an unrecognised MoTeC CSV format and halt processing.
3. IF the VE table CSV does not begin with "M1" and "v2" in the first row, THEN THE Web_App SHALL display an error message identifying the file as an unrecognised VE table format and halt processing.
4. IF a required channel (RPM, MAP, any lambda source, or Lambda_Target) is missing from the log, THEN THE Web_App SHALL display an error message naming each missing required channel and halt processing.
5. IF processing completes but zero cells exceed the Hit_Threshold, THEN THE Web_App SHALL display a warning message advising the user that no cells had sufficient data and that the output files will contain no corrections; the download buttons SHALL NOT be shown.
6. WHERE a non-fatal condition is detected (e.g., a missing CL trim bank channel), THE Web_App SHALL display a warning message in a visually distinct style (e.g., yellow banner) that does not halt processing; all non-fatal warnings SHALL be displayed before the results summary.
7. WHEN multiple errors or warnings occur during a single processing run, THE Web_App SHALL display all of them, not just the first one encountered.
