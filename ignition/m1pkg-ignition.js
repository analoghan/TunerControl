/**
 * ignition/m1pkg-ignition.js — Ignition settings from a MoTeC M1 package (.m1pkg), for the Ignition Review.
 *
 * m1pkgIgnition(pkg) → {
 *   tuneName, loadIsMap,
 *   main, alt: table | null          Ignition Timing Main / Alternative Fuel Ignition Timing, the slice the Main Switch selects
 *   slice: { index, label, differ }  which Z slice (Driver Ignition Timing Main Switch), and whether the slices differ
 *   blend: { x: [composition %], y: [%] } | null   Alternative Fuel Ignition Timing Blend
 *   compensations: [{ name, table }]  "… Ignition Timing Compensation / Trim" tables that aren't all zero
 *   cylinderTrims: [table | null] per cylinder (Ignition Cylinder N Trim Main)
 *   knock: m1pkgKnock(pkg) subset { threshold, inputs } | null   (needs knock/m1pkg-knock.js)
 * }
 * table = { name, axes: [{ input, values }], v: [[…]] } in display units: axes in rpm / % / kPa / °C, values in dBTDC (= −stored).
 * v is [row per Y site][X site] (one row for a 1-D table). Plain data, so it can be posted to the worker.
 */

var M1IG_COMP_RE = /Ignition Timing (Compensation|Trim)(\.Main|\.Table)?$/;
var M1IG_COMP_SKIP = /^(Ignition\.Cylinder|Alternative Fuel|Anti Lag|Traction|Transmission|Idle|Gear\.Shift|Engine\.Overrun)/;

function m1igItem(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

function m1igAxisValue(v, unit) {
    return unit === 'deg/s' ? v / 6 : unit === 'ratio' ? v * 100 : unit === 'Pa' ? v / 1000 : v;
}

/** Display-unit table of the first two axes (Z slice `z`), or null. Axes without site values (enumerations) are skipped. */
function m1igTable(item, z) {
    if (!item || item.kind !== 'Table' || !item.axes || !item.axes.length) return null;
    var dims = item.axes.map(function (a) { return a.maxSites; });
    var used = item.axes.map(function (a) { return a.values ? (a.sites || a.maxSites) : (a.maxSites || 1); });
    var axes = [];
    for (var d = 0; d < Math.min(2, item.axes.length); d++) {
        var a = item.axes[d];
        if (!a.values) return null;
        axes.push({ input: a.input, values: a.values.slice(0, used[d]).map(function (v) { return Math.round(m1igAxisValue(v, a.unit) * 1000) / 1000; }) });
    }
    var nx = used[0], ny = axes.length > 1 ? used[1] : 1, zOff = item.axes.length > 2 ? (z || 0) * dims[0] * dims[1] : 0, v = [];
    for (var iy = 0; iy < ny; iy++) {
        var row = [];
        for (var ix = 0; ix < nx; ix++) {
            var raw = item.values[ix + iy * dims[0] + zOff];
            row.push(Math.round((item.unit === 'deg' ? -raw : item.unit === 'ratio' ? raw * 100 : raw) * 100) / 100 || 0);   // || 0: no −0
        }
        v.push(row);
    }
    // A 2-D table with one Y site (or a 3-D one with one Y and Z site) is really 1-D
    if (axes.length > 1 && ny === 1) axes.pop();
    return { name: item.name, axes: axes, v: v };
}

function m1igAllZero(t) { return t.v.every(function (row) { return row.every(function (x) { return x === 0; }); }); }

function m1pkgIgnition(pkg) {
    var mode = m1igItem(pkg, 'Engine.Load.Normalised.Mode');
    var out = { tuneName: pkg.tuneName || null, loadIsMap: !!mode && /Inlet Manifold Pressure/.test(String(mode.label || '')), main: null, alt: null,
        slice: null, blend: null, compensations: [], cylinderTrims: [], knock: null };

    // Main Switch: a switch input picks the slice; without one the Default mapping does (A, B, C = slices 0, 1, 2)
    var main = m1igItem(pkg, 'Ignition.Timing.Main'), def = m1igItem(pkg, 'Driver.Ignition Timing Main Switch.Mapping.Default.Value');
    var label = def && def.label ? def.label : 'A', z = Math.max(0, 'ABC'.indexOf(label));
    var nz = main && main.axes.length > 2 ? main.axes[2].maxSites : 1;
    out.main = m1igTable(main, z);
    out.alt = m1igTable(m1igItem(pkg, 'Alternative Fuel.Ignition Timing'), z);
    if (out.main) {
        var differ = false;
        for (var s = 0; s < nz && !differ; s++) differ = JSON.stringify(m1igTable(main, s).v) !== JSON.stringify(out.main.v);
        var sw = m1igItem(pkg, 'Driver.Ignition Timing Main Switch.Index.Value');
        out.slice = { index: z, label: label, differ: differ, switched: !!sw && sw.label !== 'Not in Use' };
    }
    var bl = m1igTable(m1igItem(pkg, 'Alternative Fuel.Ignition Timing Blend'));
    if (bl && bl.axes.length === 1) out.blend = { x: bl.axes[0].values, y: bl.v[0] };

    pkg.items.forEach(function (it) {
        if (it.kind !== 'Table' || !M1IG_COMP_RE.test(it.name) || M1IG_COMP_SKIP.test(it.name) || it.unit !== 'deg') return;
        var t = m1igTable(it, 0);
        if (t && !m1igAllZero(t)) out.compensations.push(t);
    });

    var n = (m1igItem(pkg, 'Engine.Cylinders') || {}).value || 8;
    for (var c = 1; c <= n; c++) out.cylinderTrims.push(m1igTable(m1igItem(pkg, 'Ignition.Cylinder ' + c + '.Trim.Main.Value')));

    if (typeof m1pkgKnock === 'function') {
        var k = m1pkgKnock(pkg);
        out.knock = { threshold: k.threshold, inputs: k.inputs };
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { m1pkgIgnition: m1pkgIgnition, m1igTable: m1igTable };
