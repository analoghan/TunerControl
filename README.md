# TunerControl

<p align="center">
  <img src="TunerControlLogo.png" alt="TunerControl" width="400">
</p>

A zero-dependency, browser-based toolkit for MoTeC M1 ECU tuning and analysis. No installation, no build step, no backend server required — just open in a browser and go.

---

## Tools

The MoTeC M1 tools are built around a supercharged GM Gen V LT4 (M142 ECU + E888 expander) but work with any M1 log. Analysis tools that need tune
values can use a tune stored in the M1 Config Viewer (suggested from the log's ECU serial and time) or a `.m1pkg` file, and most can save their
results to the Tuning History and open the matching stretch of the log in an embedded Log Viewer (**Show in log**).

### VE Table Tuning
Analyze MoTeC log data against your current VE table to compute per-cell correction percentages. The table can come straight from an M1 Tune package (`.m1pkg`, reads Engine Efficiency Main) or from a CSV export. Produces downloadable CSVs ready to import back into MoTeC M1 Tune.

**Features:**
- Accepts CSV log exports or raw `.ld` binary log files
- Configurable filters: min hit count, coolant temperature, run time, TPS rate of change — with the reason each sample was left out
- Outlier filtering (configurable σ threshold) with two-pass statistical analysis
- Partial apply scaling factor for conservative iterative tuning
- Minimum change amount to ignore noise
- Gaussian spatial smoothing for correction maps
- Standard deviation display for data quality assessment
- 4 display views: Correction %, New VE Values, Hit Counts, Std Dev
- Interactive 3D surface plot with drag rotation and zoom
- Copy to clipboard (pastes directly into MoTeC M1 Tune tables)
- Show any cell's samples in the log; save the run to the Tuning History
- Comprehensive help documentation

### Transient Fuel Analyzer
Detects throttle tip-ins and tip-outs in a log and measures the lambda excursion after each — lean spikes, rich overshoot, recovery time — to
calibrate the fuel film tables. With a tune it reads the film tables and suggests per-cell corrections, reports tip-ins that go rich before
the lean spike, and skips events that overlap a fuel cut (overrun cut or injectors off at Minimum Volume) so they aren't mistaken for film. Events open in the log; runs save to the Tuning History.

### Knock Analyzer
Knock events per stretch (not per sample) against the tune's own **Knock Threshold** table, per cylinder, with an RPM × load grid, operating
condition correlation and timing recommendations. Includes a knock sensor check (one sensor reading far lower than the other), the LT4's
knock frequencies (first and second order from bore size) and the M1 knock control setup. Events open in the log.

### DI Fuel Pressure Deep Dive
Rail pressure vs aim (MPa logged, shown in bar), overshoot/undershoot and tracking grids by RPM and fuel volume, and pump checks (how hard the HPFP is driven, undershoot with the pump near its limit). With a
tune it reviews the rail pressure control settings and suggests changes backed by how much data supports them.

### DI Injection Timing
Start of injection for direct injection from the cam profile and valve events, using the GM Gen V calculator method (0.006" valve events,
dBTDC with 360 = overlap TDC). Explains the Fuel Timing Primary Main table, reviews the tune's timing tables and checks a log against the
injection window.

### Injector Characterization
Lean spike analysis, injector pulsewidth stability (short-pulse region vs the tune's Minimum Volume), DI fuel pressure tracking, injection
timing and closed-loop fuel trim diagnostics.

### Diagnostics
Load one log and get correlated diagnostics across fueling, knock, rail pressure and idle on one page.

### Idle, Duty Cycle and Charge Cooling
- **Idle Behavior Analyzer** — deceleration idle hang detection, settle time analysis and mass flow correlation
- **Injector Duty Cycle** — duty cycle across RPM and load zones, headroom limits and the DI injection window
- **Charge Cooling Gain** — lambda step-test logs to set the charge cooling gain for your fuel and IAT

### Log Viewer
Plot any log channels (`.ld` or CSV) with preset channel layouts (e.g. fuelling), and see which stretches the VE filters leave out and where the transient
events are — check an analysis against the raw data. The same viewer is embedded in the analysis tools.

### Tuning History
Saved VE, transient fuel, knock and fuel pressure runs in log order, with the tune each was made on: see whether each tune change moved the
results the right way.

### M1 Config Viewer
Import MoTeC M1 Tune packages (`.m1pkg`) directly — no export step needed — and track how a tune evolves.

**Features:**
- Decodes every calibration parameter, table, I/O resource assignment and calibration library selection from the package
- Values shown in M1 Tune display units (rpm, kPa, dBTDC, ms, %…) with expandable table grids, and each value's history across versions
- **Follow settings:** click a setting or a value that points somewhere to see what it references and what references it — enum values,
  I/O assignments, table axes — and follow the chain (e.g. Brake Switch Index → Driver Switch 8 → FIRMWARE5 → CAN receive signal)
- **Firmware I/O tab:** the virtual channels FIRMWARE0–31, with the CAN signal that writes each one (bus, ID, bits, scaling), what reads it
  and what that is used for
- **Your labels:** give any setting or I/O resource your own description ("Auxiliary Output 3 = intercooler pump relay"); labels show
  everywhere it appears, carry across tune versions, are searchable and listed on a My Labels tab
- **Export PDF:** a printable report of the calibrations, driver switches, Firmware I/O, parameters (optionally with table values),
  labels or a comparison between versions — saved through the browser's print dialog
- Tune history stored in the browser (IndexedDB) with JSON backup export/restore, or on the optional TunerControl server (SQLite) when served from it
- Compare any two versions: changed values, table cells (with axis breakpoints), I/O assignments, calibration selections and save notes

### Harness Builder
Design and check wiring harnesses built around the M1 ECU.

**Features:**
- Imports harness spreadsheets (`.xlsx`) laid out as one block per connector or splice: CONNECTOR/BOOT/MATE CONN/MATE PIN/NOTES rows, then a Location header row and one row per cavity (Remote Connection = `CONNECTOR.CAVITY` or a splice name)
- **Add from .xlsx:** copy connectors and splices from another workbook into an open harness, by sheet or one at a time; names already
  used can replace the existing block or be added under a new name, with connections among the added blocks following the rename
- Edit connectors, cavities, wires and splices in the browser; renaming a connector updates every connection that refers to it. Blocks are
  grouped by sheet (matched ignoring case and spacing), and the Sheet field offers the existing sheet names
- One-ended connections are valid ends: **Unterminated** (e.g. a shield grounded at one end), **Eyelet** (ring terminal on a stud),
  **Battery** (`+` / `-`) and **Device** (wired straight into a device), each with an optional note in brackets
  (`Eyelet (engine block)`, `Chassis Ground (Eyelet)`), drawn with their own symbol in the diagrams
- Pin columns: Location, Pin, conductor part number and description, ECU Function, notes and Remote Connection, plus an optional
  **Chassis Function** column (switched on per connector) for what each wire connects to outside the harness
- Checks every connection at both ends: references to nothing (with "did you mean" fixes), ends that disagree, splices that don't list their wires, chained splices, wire part numbers that differ between ends, wired cavities with no connection
- Compares the ECU (M142) and E888 pins against the I/O assignments in a tune from the M1 Config Viewer (your resource names from there place the pins, and your labels count when matching names, e.g. "IC pump" on Auxiliary Output 3), and harness pin labels against the M142 datasheet pinout
- Connector and splice images: pictures placed beside each block in the spreadsheet are imported, can be added/removed/captioned, viewed full size, and are written back on export
- Wiring diagrams drawn from the harness: per connector or splice (every wire in its real colour/gauge to the pins it reaches, through splices to their far ends, with the connector's pictures) and an overview of all connectors and splices with wire counts; click through to the editor, download as SVG
- Harness systems: harnesses that plug into each other (e.g. engine + chassis + transmission sub-harness) are grouped; connectors with the same name and mating part numbers are joined cavity to cavity automatically (or linked by hand), with checks across each join, circuit tracing through every harness, a system overview diagram and a whole-system tune comparison. Importing a workbook offers to split a sheet that holds the other half of a mating pair into its own harness, and to join a system with harnesses it plugs into
- **CAN networks** in a harness system: devices, hubs and how the hubs connect, termination on/off per device, standalone
  terminators, speed per network and device, power through the CAN connection, power feeds into a hub or device, hub links that carry CAN, power or both (and power shared between networks, for power hubs that split the
  data buses), and links from each wire to its harness connector pin
  (filled in from pin functions such as "CAN 1 High"). Checks the termination count (two, 60 Ω), speed mismatches, unconnected hubs or
  devices and linked pins that are missing or don't match, and draws each network with twisted-pair (CAN-H/CAN-L) wiring
- **Export PDF:** overview and system diagrams, checks, connector and splice tables with their problems, per-block diagrams, pictures and
  the tune comparison, in portrait or landscape
- Every save is a revision (server or browser storage), and single revisions can be deleted; export back to `.xlsx` in the same layout, pictures included

### Calculators
Quick bidirectional unit conversions for tuning:
- kPa ↔ PSI ↔ Bar (gauge and absolute with 102 kPa atmospheric reference)
- °C ↔ °F
- AFR ↔ Lambda (gasoline)
- km/h ↔ mph
- Lambda Fuel Conversion chart (gasoline and E85 with common tuning targets)

---

## Getting Started

1. Clone or download this repository.
2. Serve the files over HTTP/HTTPS (recommended) or open `index.html` directly in a browser.

```bash
# Quick local server (Python 3)
python3 -m http.server 8080
# then open http://localhost:8080
```

3. Click any tool card on the landing page to get started.

> **Note:** The tools use Web Workers for heavy computation. Some browsers restrict
> Web Workers on `file://` URLs. If a tool doesn't respond after clicking Process,
> use a local HTTP server as shown above.

### Optional server (shared tune history)

`server/server.js` serves the same files plus an API that stores the M1 Config Viewer's tune history and labels,
the Harness Builder's harnesses and the Tuning History in SQLite, so they persist on a server and are shared between browsers. It has no npm dependencies and needs
Node.js 22.13+. See [server/README.md](server/README.md) for systemd and Docker setup.

---

## Project Structure

```
index.html                  — Landing page with tool navigation
TunerControlLogo.png        — Project logo

ve-table/                   — VE Table Tuning Tool
  index.html                — Tool UI
  app.js                    — Main thread: UI, Worker lifecycle, rendering, 3D plot
  worker.js                 — Worker thread: parsing, filtering, correction, output
  styles.css                — Dark theme styling
  help.html                 — Comprehensive documentation and usage guide

injector/                   — Injector Characterization Tool
  index.html, app.js, charts.js, worker.js, styles.css

knock/                      — Knock Analyzer
  index.html, app.js, charts.js, worker.js, styles.css

idle/                       — Idle Behavior Analyzer
  index.html, app.js, charts.js, worker.js, styles.css

fuel-pressure/              — DI Fuel Pressure Deep Dive
  index.html, app.js, charts.js, worker.js, styles.css

calculators/                — Unit Conversion Calculators
  index.html                — Main calculators page
  lambda-fuel.html          — Lambda/AFR fuel conversion chart (gasoline & E85)

transient-fuel/             — Transient Fuel Analyzer (film-correct.js = table corrections, m1pkg-film.js)
di-timing/                  — DI Injection Timing (di-calc.js = GM Gen V method, m1pkg-di.js, worker.js log check)
diagnostics/                — Unified diagnostics from one log
duty-cycle/, charge-cooling/ — Injector Duty Cycle, Charge Cooling Gain
log-viewer/                 — Log Viewer + embeddable LogPanel (log-file.js, log-chart.js, log-panel.js)
history/                    — Tuning History (run-store.js, run-builders.js, run-save.css)

m1-config/                  — M1 Config Viewer (.m1pkg import, tune history, compare, follow, labels, Firmware I/O, PDF)
  index.html, app.js, format.js, resource-names.js, tune-source.js, tune-db.js, tune-api.js, worker.js, styles.css

harness/                    — Harness Builder (.xlsx import/add/export, editor, checks, diagrams, systems, tune comparison, PDF)
  index.html, app.js, harness-model.js, harness-tune.js, harness-diagram.js, harness-system.js, harness-can.js, harness-store.js, styles.css

lib/                        — Vendored libraries (Chart.js, zoom plugin, Hammer.js) and shared code
                              (ld-parser.js, m1pkg-parser.js, xz-decoder.js, xlsx.js, print-report.js/.css for PDF export)

server/                     — Optional Node server: static files + SQLite API for tunes and harnesses (see server/README.md)
deploy/                     — systemd unit for the server (Dockerfile at the repo root)

tests/                      — Browser-based test suite
  index.html                — Test harness (no build step required)
  test-*.js                 — Unit and property-based tests

analysis/                   — Reference data and analysis scripts (not part of the app)
files/                      — Sample log and VE table files for testing
```

---

## Running Tests

1. Serve the project over HTTP (see Getting Started above).
2. Open `http://localhost:8080/tests/index.html` in a browser.
3. The test harness runs all unit and property-based tests and displays a pass/fail summary.

Node tests (server API and the analysis workers):

```bash
node tests/run-server-tests.js
node tests/test-knock-analysis.js
node tests/test-fp-analysis.js
node tests/test-worker-pipeline.js
```

---

## Technology

- Pure HTML/CSS/JavaScript — no frameworks, no build tools, no npm
- Web Workers for non-blocking computation on large log files
- Chart.js for 2D charting (vendored in `lib/`)
- Canvas API for 3D surface visualization
- Runs entirely client-side — no data leaves your browser unless you use the optional server
- PDF export through the browser's own print dialog (no PDF library)

---

## License

See [LICENSE](LICENSE) for details.
