# VE Table Tuning Tool

A zero-dependency, browser-only single-page application for MoTeC M1 ECU tuning.
Upload a MoTeC M1 CSV log file and an "Eng Efficiency Main" VE table CSV, and the
app computes per-cell VE correction percentages and produces two downloadable CSVs:

- **VE_Difference.csv** — correction percentages per RPM/MAP cell
- **VE_New_Values.csv** — updated VE table in M1 v2 format, ready to import into MoTeC

No installation, no build step, no backend server required.

---

## How to open the app

1. Clone or download this repository so all files are in the same directory.
2. Open `index.html` directly in a modern browser (Chrome, Firefox, Edge, or Safari).
   - On macOS: double-click `index.html` in Finder, or run `open index.html` in Terminal.
   - On Windows: double-click `index.html` in Explorer.
   - On Linux: run `xdg-open index.html` in a terminal.
3. Select your MoTeC log CSV and VE table CSV using the file inputs, then click **Process**.

> **Note:** The app uses a Web Worker (`worker.js`) for heavy computation. Some browsers
> restrict Web Workers on `file://` URLs. If the app does not respond after clicking
> Process, serve the files over a local HTTP server instead:
>
> ```bash
> # Python 3
> python3 -m http.server 8080
> # then open http://localhost:8080 in your browser
> ```

---

## How to run the tests

1. Open `tests/index.html` directly in a browser (same method as above).
2. The test harness loads [fast-check](https://github.com/dubzzz/fast-check) from CDN,
   imports all test modules, runs every unit test and property-based test, and displays
   a pass/fail summary with individual test names.

> **Note:** The same `file://` Web Worker restriction applies here. If tests that import
> from `worker.js` fail to load, serve the project with a local HTTP server and open
> `http://localhost:8080/tests/index.html` instead.

---

## Project structure

```
index.html                  — App UI shell
app.js                      — Main thread: UI events, Worker lifecycle, result rendering
worker.js                   — Worker thread: parsing, binning, correction, output building
styles.css                  — Layout and colour-coding
README.md                   — This file

tests/
  index.html                — Browser-based test harness (no build step)
  test-log-parser.js        — Unit tests for Log_Parser and channel resolver
  test-ve-parser.js         — Unit tests for VE_Parser
  test-bin-assigner.js      — Unit tests for Bin_Assigner
  test-correction-calculator.js  — Unit tests for Correction_Calculator
  test-hit-counter.js       — Unit tests for Hit_Counter
  test-output-builder.js    — Unit tests for Output_Builder
  test-properties.js        — Property-based tests (Properties 1–10)

analysis/                   — Reference data and analysis scripts (not part of the app)
```
