# TunerControl

<p align="center">
  <img src="TunerControlLogo.png" alt="TunerControl" width="400">
</p>

A zero-dependency, browser-based toolkit for engine and transmission tuning: MoTeC M1 ECU analysis, a Haltech VE tool and a TurboLamik
8HP shift analyzer. No installation, no build step and no npm — open it in a browser and go. An optional Node server keeps tunes, harnesses
and the tuning history in one place for every browser; without it everything is stored in the browser.

---

## Tools

The landing page has four sections: **MoTeC M1 Tuning** (everything below up to Backup & Restore), **Haltech Tuning**, **TurboLamik
Transmission** and **Calculators**.

The MoTeC M1 page groups its tools in the calibration order: **Check the log** (Log Health, Log Viewer, Cross-Tool Diagnostics, Pull Report), **Airflow & fuel
model** (VE, MAP Rescale, Closed-Loop Period, Charge Cooling, Transient Fuel), **Direct injection** (Injector Characterization, DI Fuel Pressure, DI Injection Timing,
Duty Cycle), **Ignition, knock & idle** (Knock Analyzer, Ignition Review, Idle), and **Tunes & wiring** (M1 Config Viewer, Tuning History, Harness Builder), with Backup & Restore below.

The MoTeC M1 tools are built around a supercharged GM Gen V LT4 (M142 ECU + E888 expander) but work with any M1 log. Analysis tools that need tune
values can use a tune stored in the M1 Config Viewer (suggested from the log's ECU serial and time) or a `.m1pkg` file, and most can save their
results to the Tuning History, export them as a PDF report and open the matching stretch of the log in an embedded Log Viewer (**Show in log**).

### Log Health
Run it first on every new log: looks for readings that can't be right, so sensor faults, wrong sensor setups and substituted values are caught
before anything is tuned from the log. With the tune that ran the log (suggested from the log's ECU serial and time), diagnostic values get the
firmware's own names and severities and the fuel model checks run. Findings are Fail / Check / Note / OK, each with what was measured and how
much of the log supports it, and open in the embedded Log Viewer with their channels and stretches marked; Export PDF prints them.
- **Log** — holds where the logger stopped (a log can join two key cycles: temperatures jump across it), engine stalls and near-stalls
- **ECU diagnostics** — every Diagnostic channel's non-OK values, named and graded from the tune's firmware enumerations
- **Substituted values** — "X Sensor" against "X": the ECU using an estimate or default instead of the reading
- **Sensors** — stuck sensors; key-on MAP vs ambient vs airbox; MAP never ≤ 0 and agreeing with airbox pressure at part load; ambient pressure
  plausible; oil pressure; temperatures out of range, jumping, disagreeing at a cold start; gauge pressures below −20 kPa
- **Lambda** — banks reading free air while fuelling, bank 1 vs bank 2, closed-loop trims at their limits
- **Fuel model** (with the tune) — stoich against fuel composition and the alternative fuel's properties (E85-like vs ethanol), and where Fuel
  Mixture Aim comes from: Main, the alternative fuel blend, or a compensation
- **Fuel supply, throttle, electrical, knock inputs, speed signals** — low-side pressure and droop, throttle following its aim, battery and
  injector supply voltages, a dead or low knock bank, engine speed jumps, wheel speeds

### VE Table Tuning
Analyze MoTeC log data against your current VE table to compute per-cell correction percentages. The table is Engine Efficiency Main, read from the tune (a stored tune or an `.m1pkg`). Produces downloadable CSVs ready to import back into MoTeC M1 Tune.

**Features:**
- Accepts CSV log exports or raw `.ld` binary log files
- Configurable filters: min hit count, coolant temperature, run time, TPS rate of change — with the reason each sample was left out
- Lambda delay from the tune's Fuel Closed Loop Period at each sample's exhaust mass flow (Engine Load × rpm), or fixed; a sample counts
  only if MAP and throttle stay steady until its lambda reading, with no fuel cut in between
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

### Closed-Loop Period
Times the lambda sensor's response to fuelling steps — mixture aim steps from a step test (MoTeC's method: hold a point, step the aim −0.1 λ) and
clean overrun fuel cuts — and compares the delay with **Fuel Closed Loop Period** at the step's exhaust mass flow. Pools steps from several logs,
suggests a Period per site only from enough consistent steps (rounded up: a slightly long Period is the safe side), says at which rpm × MAP the logs
reached the untested sites, and copies the Period row for M1 Tune. Every step opens in the log.

### Knock Analyzer
Knock events per stretch (not per sample) against the tune's own **Knock Threshold** table, per cylinder, with an RPM × load grid, operating
condition correlation and timing recommendations. Threshold & gain calibration (MoTeC training method): per-cylinder Knock Gain to even out each knock input, and Knock Threshold per engine speed
from the loudest cylinder's no-knock level × 1.25 — withheld until the knock frequency is near a bore-based order, and only where the log has enough
data at load. Includes a knock sensor check (one sensor reading far lower than the other), the LT4's
knock frequencies (first and second order from bore size) and the M1 knock control setup. Events open in the log.

### Ignition Review
Rebuilds the logged Ignition Timing in the Normal state from the tune — Ignition Timing Main blended toward Alternative Fuel Ignition Timing by fuel
composition, at engine speed × Load Normalised (MAP in MAP load mode), plus Ignition Timing Compensation — and lists stretches where timing leaves
it at a steady load (knock control, limits). Shows which compensation tables explain the logged compensation and what inlet air temperature takes
under boost, the flex blend and boost rows where the Alternative Fuel table runs less advance than Main, per-cylinder trims against the knock
input each cylinder is on (trims on one input only while the other reads low is flagged), time in each ignition state, and timing and knock margin
by table cell. Never suggests adding timing.

### DI Fuel Pressure Deep Dive
Rail pressure vs aim (MPa logged, shown in bar), overshoot/undershoot and tracking grids by RPM and fuel volume, and pump checks (how hard the HPFP is driven, undershoot with the pump near its limit). With a
tune it reviews the rail pressure control settings and suggests changes backed by how much data supports them. Low-side (lift pump) pressure by fuel
flow: droop, dips below 250 kPa, when Fuel Pump 2 comes in, and how much rail undershoot came while the feed sagged.

### Pull Report
Every full-throttle or boost pull (MAP ≥ 100 kPa or pedal ≥ 85 % for 0.8 s) in one or more logs: lambda per bank against the aim 0.3 s earlier,
closed-loop trims, knock per cylinder against Knock Threshold, timing, rail and low-side fuel pressure, injector duty, temperatures, oil pressure
against 10 psi per 1000 rpm, voltages, limits and cuts. Flags per pull, the worst case of each across pulls, and every pull opens in the log.

### DI Injection Timing
Start of injection for direct injection from the cam profile and valve events, using the GM Gen V calculator method (0.006" valve events,
dBTDC with 360 = overlap TDC). Explains the Fuel Timing Primary Main table, reviews the tune's timing tables and checks a log against the
injection window.

### Injector Characterization
Lean spike analysis, injector pulsewidth stability, DI fuel pressure tracking, injection timing and closed-loop fuel trim diagnostics. With
the tune (stored or .m1pkg): injection cuts explained by its Minimum Volume and the logged fuel volume, and its Linearisation table against
the rail pressures and short pulses in the log.

### Diagnostics
Load one log and get correlated diagnostics across fueling, knock, rail pressure and idle on one page; with the tune, the injector findings
use its Minimum Volume and Linearisation.

### Idle, Duty Cycle and Charge Cooling
- **Idle Behavior Analyzer** — returns to idle (gear changes left out), settle times and idle hangs against the logged Idle Aim, and
  steady idle: rpm against the aim and Idle Mass Flow against its feed forward (e.g. idle held above the aim while the controller takes
  air away = feed forward too high). With the tune (stored or .m1pkg): the idle integral against its limits, the Feed Forward Main cells
  the idle used with suggested values, the feed forward split into Main and compensations, and the aim against Idle Aim Main
- **Injector Duty Cycle** — duty cycle per rpm band in seconds and held peaks (not single samples), episodes above the warning level, the
  implied DI injection window (the M1's DI duty cycle is a share of it) and how much of the load range the log covers
- **Charge Cooling Gain** — finds the aim steps of a closed-loop-off step test, compares the change in lambda with the change in aim, and
  says which way to move the gain (stays lean on a rich step = raise), as in MoTeC's training

### MAP Rescale
Converts a tune to a new Inlet Manifold Pressure sensor translation so the engine runs the same at the same sensor voltage. A translation
change is an offset and a slope, so the old ÷ new reading differs at every pressure and a flat VE multiplier is wrong. With a tune (stored or
`.m1pkg`), the translation its tables were made for and the new one (typed or taken from another tune) it converts:
- Engine Efficiency Main — re-read at each site's old reading and × old ÷ new reading, so the air mass at every voltage stays the same; sites
  whose voltage read below the old table are held (copied from the nearest converted row) and marked for re-tuning
- every table on a MAP axis (mixture aim, fuel timing, film, closed-loop limits…) and, when Engine Load Normalised Mode is Inlet Manifold
  Pressure, every table on Load Normalised (ignition, alternative fuel ignition, cylinder trims, knock)
- tables whose values are MAP readings, and settings compared with MAP (thresholds converted, hysteresis scaled by the slope ratio, 0 = off left)

Keep the axis sites (values re-read — paste into the existing tables) or move them (exact; type the new sites). Each table copies as
tab-separated values; Engine Efficiency Main also downloads as an M1 Tune table CSV.

### Log Viewer
Plot any log channels (`.ld` or CSV) with preset channel layouts (e.g. fuelling), and see which stretches the VE filters leave out and where the transient
events are — check an analysis against the raw data. The same viewer is embedded in the analysis tools.

### Tuning History
Saved VE, transient fuel, knock, fuel pressure, Log Health, Ignition Review, Closed-Loop Period and Pull Report runs in log order, with the tune each was made on: see whether each tune change moved the
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
- Tune history stored in the browser (IndexedDB) or on the optional TunerControl server (SQLite) when served from it
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
- **Cables:** twisted pairs and other multi-conductor cables found from the conductor part numbers (M27500 decodes itself; others in a
  list) and descriptions such as "(3 Wire Shielded)", grouped by the connectors they run between, with their shield or drain rows; names
  kept in an optional Cable column; checks for extra or same-colour conductors and for a pair swapped across a mated connector; diagrams draw
  the twist and shield
- **Cut list & BOM:** one row per wire (both ends, terminals, wire part number and description, function, ends that disagree), and a
  bill of materials — connectors, boots, splices, terminals, cavity plugs, eyelets and wire per part number; optional wire lengths with
  totals per wire type; CSV downloads and PDF sections
- **Pinout sheets:** a printed page per connector (pictures, parts, and per cavity the function, wire with a colour swatch, part number,
  terminal and where it goes, both ways and through splices) plus a splice page; from the connector editor or Export PDF
- **Revision compare:** any two revisions, or a revision against what's open: connectors and splices added, removed or renamed,
  cavities added, removed, changed or rewired, header and picture changes and wire lengths; links into the editor and a PDF section
- Every save is a revision (server or browser storage), and single revisions can be deleted; export back to `.xlsx` in the same layout, styled (title bar, shaded headings, alternating rows), pictures included and scaled to at most 320 × 240 px

### Backup & Restore

- One JSON file with everything stored, from the server or browser storage: every tune with its original `.m1pkg`, resource names
  and labels, the tuning history, harnesses with every revision, harness systems with their joins and CAN networks, harness pictures
  and page settings
- Restores into a server or a browser (empty or not): adds what is missing and keeps anything already there with the same id, so it
  is safe to run twice; older M1 Config Viewer backups restore too

### Haltech VE Table Tuning
The VE Table tool for a Haltech Nexus: reads an NSP datalog (CSV) and a VE table copied out of NSP (Copy Table → CSV), and computes per-cell
corrections from wideband lambda against target lambda (with short/long term trims when logged). Same filters as the M1 version (hit count,
coolant temperature, run time, outlier σ, minimum change, scaling), a 3D surface plot, and a corrected table to paste back into NSP.

### TurboLamik Shift Analyzer (ZF 8HP)

For a TurboLamik 8HP TCU (here with a Haltech Nexus R5): reads a TunerPro RT log (`.xdl` with its `.adx`, or `.csv`) and optionally the
TCU bin (`.bin` with its `.xdf`; V10.75 and V10.78 table names both work).
- Each shift runs from the request (Gear Target changes) to the Gear change, split into the delay before the ratio moves and the ratio
  change, from timestamps; checked against the TCU's own Time 1 Shift Time
- Flare (input above the gear it should be held to), sag and bump (vehicle acceleration from Output RPM), blip and torque cut per shift,
  with medians per transition and per oncoming shift element (A–E), and a chart of any shift
- Oil temperature at every shift, against the bin's adaptation window; Adaptation Activation Parameter codes (TurboLamik manual) and the
  shifts the TCU learns on (3→4 D, 4→5 C, 5→6 E, 6→7 A, 6→5 B)
- From the bin: gear ratios, start gear per program, blip limits, adaptation tables, Correction Start / End for the logged shifts and the
  shift-feel tables; findings only from repeated shifts, pointing at the tables TurboLamik's shift-quality guide names

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
index.html                  — Landing page (MoTeC M1, Haltech, TurboLamik, Calculators)
TunerControlLogo.png        — Project logo
motec/index.html            — MoTeC M1 tool menu

Each analysis tool is index.html + app.js (UI) + worker.js (parsing and analysis in a Web Worker) + styles.css + help.html,
plus the files named here:

ve-table/                   — VE Table Tuning (m1pkg-ve.js reads Engine Efficiency Main from a tune)
transient-fuel/             — Transient Fuel Analyzer (film-correct.js = table corrections, m1pkg-film.js)
knock/                      — Knock Analyzer (charts.js, knock-freq.js + frequency-calc.html, m1pkg-knock.js)
pulls/                      — Pull Report (pull-analysis.js = puAnalyze over one or more logs)
cl-period/                  — Closed-Loop Period (cl-analysis.js = clAnalyze over one or more logs, m1pkg-cl.js)
ignition/                   — Ignition Review (ign-analysis.js = igAnalyze, m1pkg-ignition.js; uses the Log Health log helpers)
fuel-pressure/              — DI Fuel Pressure Deep Dive (charts.js, m1pkg-rail.js)
di-timing/                  — DI Injection Timing (di-calc.js = GM Gen V method, m1pkg-di.js, worker.js log check)
injector/                   — Injector Characterization (charts.js, m1pkg-injector.js — also used by diagnostics/)
diagnostics/                — Diagnostics from one log (worker-diagnostics.js; loads injector/worker.js first)
idle/                       — Idle Behavior Analyzer (charts.js, m1pkg-idle.js)
duty-cycle/                 — Injector Duty Cycle (duty-analysis.js)
charge-cooling/             — Charge Cooling Gain (cc-analysis.js)
log-viewer/                 — Log Viewer + embeddable LogPanel (log-file.js, log-chart.js, log-panel.js/.css)
history/                    — Tuning History (run-store.js, run-builders.js, run-save.css)

m1-config/                  — M1 Config Viewer (.m1pkg import, tune history, compare, follow, labels, Firmware I/O, PDF)
                              format.js (units), links.js (follow settings), resource-names.js, history.js,
                              tune-db.js / tune-api.js (browser / server storage), tune-source.js + tune-picker.js
                              (the stored-tune picker the analysis tools use), worker.js

harness/                    — Harness Builder: harness-model.js, harness-build.js (cut list, BOM), harness-cable.js (cables), harness-pinout.js,
                              harness-diff.js (revision compare), harness-diagram.js, harness-system.js, harness-can.js,
                              harness-tune.js, harness-store.js

backup/                     — Backup & Restore page (backup-page.js; the format and both backends are in lib/backup.js)

haltech/                    — Haltech menu and ve-table/ (Haltech NSP VE Table Tuning)

turbolamik/index.html       — TurboLamik menu
transmission/               — TurboLamik 8HP Shift Analyzer: shift-analysis.js (shift timing, flare, adaptation),
                              bin-reader.js (TCU bin tables found by pattern), xdl-parser.js (TunerPro logs)

calculators/                — Unit conversions (index.html) and the lambda/AFR fuel chart (lambda-fuel.html)

lib/                        — Vendored libraries (Chart.js, zoom plugin, Hammer.js) and shared code:
                              ld-parser.js (the .ld reader every tool uses), m1pkg-parser.js + xz-decoder.js, xlsx.js, print-report.js/.css (PDF export),
                              backup.js

server/                     — Optional Node server: static files + SQLite API (server.js lists the API, db.js the
                              schema; see server/README.md)
deploy/                     — systemd unit for the server (Dockerfile at the repo root)

tests/                      — Browser test suite (index.html) and Node test scripts
docs/archive/               — Early design specs and the tuning-knowledge RAG design (historical, not kept up to date)
```

Logs, tune packages and other personal data go in `files/`, and the server's database in `data/`; both are git-ignored and not
part of the repository.

---

## Running Tests

1. Serve the project over HTTP (see Getting Started above).
2. Open `http://localhost:8080/tests/index.html` in a browser.
3. The test harness runs all unit and property-based tests and displays a pass/fail summary.

Node tests (server API, analysis workers and the smaller tools) — run them all with one command, or a few by name:

```bash
node tests/run-all.js                     # every Node test script, one line each and a total
node tests/run-all.js knock pulls         # only scripts whose name contains "knock" or "pulls"
```

Or run a script on its own — each prints its own pass/fail count:

```bash
node tests/run-server-tests.js            # server API and database (in-memory SQLite)
node tests/test-worker-pipeline.js        # VE parsing and analysis
node tests/run-channel-resolver-tests.js  # VE channel names
node tests/run-property10.js              # VE correction property test
node tests/test-knock-analysis.js         # Knock Analyzer
node tests/test-knock-calibration.js      # Knock threshold and gain calibration
node tests/test-ignition.js               # Ignition Review
node tests/test-cl-period.js              # Closed-Loop Period step timing
node tests/test-pulls.js                  # Pull Report
node tests/test-knock-channel-resolution.js
node tests/test-cylinder-distribution.js
node tests/test-timing-correlation.js
node tests/test-worst-conditions.js
node tests/test-fp-analysis.js            # DI Fuel Pressure
node tests/test-small-tools.js            # Idle, Duty Cycle, Charge Cooling
node tests/test-diagnostics.js            # Diagnostics knock findings
node tests/test-transmission.js           # TurboLamik Shift Analyzer
node tests/test-map-rescale.js            # MAP Rescale
node tests/test-ve-lambda-delay.js        # VE lambda delay from the tune
node tests/test-log-health.js             # Log Health checks
```

The other `tests/test-*.js` files run in the browser suite only.

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
