/**
 * idle/m1pkg-idle.js — Idle control settings from a MoTeC M1 package (.m1pkg), for the Idle Behavior Analyzer.
 *
 * m1pkgIdle(pkg) → {
 *   tuneName,
 *   integralMin, integralMax: %        (Idle Mass Flow Integral Minimum / Maximum)
 *   pGain: % per rpm                   (Idle Mass Flow Proportional Gain; the controller adds pGain × (aim − rpm))
 *   feedForward: { aim: [rpm], coolant: [°C], values: [[% per aim site] per coolant site] } | null   (Feed Forward Main,
 *                at the first Ambient Pressure site)
 *   aimMain: { coolant: [°C], values: [rpm] } | null                  (Idle Aim Main, first Idle Aim Switch site)
 *   throttleAimMax: %                  (Idle Actuator Throttle Aim Maximum: idle mass flow 100 % = this throttle opening)
 *   pedalThreshold: %                  (Idle Activate Throttle Pedal Threshold)
 *   pedalTranslation: { sensor: [%], rpm: [rpm] | null, yInput, rows: [[% per sensor site] per rpm site] } | null
 *                                      (Throttle Pedal Translation, first Translation Switch slice; output = logged Throttle Pedal)
 *   notes: [string]
 * }
 * Package values are SI: engine speed deg/s (÷ 6 → rpm), ratios (× 100 → %), pressure Pa. Tables: values[x + y × x.maxSites].
 * The result is plain data, so it can be posted to the analysis worker.
 */

function m1idItem(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

function m1idAxis(item, axis) {
    return (item.axes || []).filter(function (a) { return a.axis === axis; })[0] || null;
}

function m1idNum(item, scale) {
    return item && typeof item.value === 'number' ? Math.round(item.value * scale * 1e4) / 1e4 : null;
}

function m1pkgIdle(pkg) {
    var out = { tuneName: pkg.tuneName || '', integralMin: null, integralMax: null, pGain: null, feedForward: null, aimMain: null,
                throttleAimMax: null, pedalThreshold: null, pedalTranslation: null, notes: [] };
    out.integralMin = m1idNum(m1idItem(pkg, 'Idle.Mass Flow.Integral.Minimum'), 100);
    out.integralMax = m1idNum(m1idItem(pkg, 'Idle.Mass Flow.Integral.Maximum'), 100);
    // ratio per deg/s → % per rpm (1 rpm = 6 deg/s)
    out.pGain = m1idNum(m1idItem(pkg, 'Idle.Mass Flow.Proportional.Gain'), 600);

    var ff = m1idItem(pkg, 'Idle.Mass Flow.Feed Forward.Main');
    if (ff && ff.values) {
        var x = m1idAxis(ff, 'X'), y = m1idAxis(ff, 'Y');
        if (x && x.sites > 0 && /Idle\.Aim/.test(x.input || '') && x.unit === 'deg/s') {
            var ny = y && y.sites > 0 && /Coolant\.Temperature/.test(y.input || '') ? y.sites : 1, values = [];
            for (var iy = 0; iy < ny; iy++) {
                var row = [];
                for (var ix = 0; ix < x.sites; ix++) row.push(Math.round(ff.values[ix + iy * x.maxSites] * 100 * 1000) / 1000);
                values.push(row);
            }
            out.feedForward = {
                aim: x.values.slice(0, x.sites).map(function (v) { return Math.round(v / 6 * 10) / 10; }),
                coolant: ny > 1 || (y && y.sites === 1 && /Coolant/.test(y.input || '')) ? y.values.slice(0, ny) : [0],
                values: values, coolantAxis: ny > 1
            };
        } else {
            out.notes.push('Idle Mass Flow Feed Forward Main is not set up against Idle Aim, so its cells can\'t be matched to the log.');
        }
    }
    // Pull-away: idle throttle = feed forward × Throttle Aim Maximum; the pedal takes over above it (Throttle.Pedal.Translation output).
    out.throttleAimMax = m1idNum(m1idItem(pkg, 'Idle.Actuator.Throttle Aim.Maximum'), 100);
    out.pedalThreshold = m1idNum(m1idItem(pkg, 'Idle.Activate.Throttle Pedal.Threshold'), 100);
    var tr = m1idItem(pkg, 'Throttle.Pedal.Translation');
    if (tr && tr.values) {
        var tx = m1idAxis(tr, 'X'), ty = m1idAxis(tr, 'Y');
        if (tx && tx.sites > 0) {
            var nr = ty && ty.sites > 0 ? ty.sites : 1, rows = [];
            for (var r = 0; r < nr; r++) {
                var vals = [];
                for (var c = 0; c < tx.sites; c++) vals.push(Math.round(tr.values[c + r * tx.maxSites] * 1000) / 10);
                rows.push(vals);
            }
            out.pedalTranslation = {
                sensor: tx.values.slice(0, tx.sites).map(function (v) { return Math.round(v * 1000) / 10; }),
                rpm: ty && ty.sites > 0 && ty.unit === 'deg/s' ? ty.values.slice(0, nr).map(function (v) { return Math.round(v / 6); }) : null,
                yInput: ty ? ty.input || null : null, rows: rows   // first Throttle Pedal Translation Switch slice
            };
        }
    }
    var aim = m1idItem(pkg, 'Idle.Aim.Main');
    if (aim && aim.values) {
        var ax = m1idAxis(aim, 'X');
        if (ax && ax.sites > 0 && /Coolant\.Temperature/.test(ax.input || '')) {
            out.aimMain = { coolant: ax.values.slice(0, ax.sites), values: aim.values.slice(0, ax.sites).map(function (v) { return Math.round(v / 6 * 10) / 10; }) };
        }
    }
    if (out.integralMin === null) out.notes.push('Idle Mass Flow Integral Minimum not found in this tune.');
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { m1pkgIdle: m1pkgIdle };
