/**
 * log-health/m1pkg-health.js — Tune settings the Log Health checks compare the log with, from a parsed .m1pkg (lib/m1pkg-parser.js).
 *
 * m1pkgHealth(pkg) → {
 *   tuneName, modified,
 *   fuel: { stoich, density, altStoich, altDensity, compositionMode }     (density kg/m³; null when missing)
 *   aim: { main, alt, blend } | null    main/alt: { x: [rpm], y: [kPa], v: [[LA per x] per y] } (first Z slice);
 *                                       blend: { x: [composition %], y: [%] }
 *   clTrim: { min, max } | null         Fuel Closed Loop Control Trim Minimum / Maximum extremes (% trim, e.g. −15 / +15)
 *   fuelPressureWarnMax: kPa | null
 *   banks: [bank of cylinder 1…n]       (Engine Cylinder N Bank)
 *   map: { at0, at5 } | null            Inlet Manifold Pressure Sensor Translation (kPa at 0 V and 5 V)
 * }
 * Plain data, so it can be posted to the worker.
 */

function m1hItem(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

function m1hNum(pkg, name, scale) {
    var it = m1hItem(pkg, name);
    return it && typeof it.value === 'number' ? it.value * (scale || 1) : null;
}

/** rpm × MAP table (first Z slice) in rpm, kPa and its own units, or null. */
function m1hRpmMapTable(item) {
    if (!item || item.kind !== 'Table' || item.axes.length < 2) return null;
    var x = item.axes[0], y = item.axes[1];
    if (x.unit !== 'deg/s' || y.unit !== 'Pa' || !x.values || !y.values) return null;
    var out = { x: [], y: [], v: [] };
    for (var i = 0; i < x.sites; i++) out.x.push(x.values[i] / 6);
    for (var j = 0; j < y.sites; j++) {
        out.y.push(y.values[j] / 1000);
        var row = [];
        for (i = 0; i < x.sites; i++) row.push(item.values[i + j * x.maxSites]);
        out.v.push(row);
    }
    return out;
}

function m1pkgHealth(pkg) {
    var out = { tuneName: pkg.tuneName || null, modified: pkg.modified || null };
    var mode = m1hItem(pkg, 'Fuel.Composition.Mode');
    out.fuel = {
        stoich: m1hNum(pkg, 'Fuel.Properties.Stoichiometric Ratio'), density: m1hNum(pkg, 'Fuel.Properties.Density'),
        altStoich: m1hNum(pkg, 'Alternative Fuel.Properties.Stoichiometric Ratio'), altDensity: m1hNum(pkg, 'Alternative Fuel.Properties.Density'),
        compositionMode: mode ? mode.label || null : null
    };

    var main = m1hRpmMapTable(m1hItem(pkg, 'Fuel.Mixture Aim.Main')), alt = m1hRpmMapTable(m1hItem(pkg, 'Alternative Fuel.Mixture Aim'));
    var bl = m1hItem(pkg, 'Alternative Fuel.Mixture Aim Blend'), blend = null;
    if (bl && bl.kind === 'Table' && bl.axes.length === 1 && bl.axes[0].values) {
        blend = { x: [], y: [] };
        for (var i = 0; i < bl.axes[0].sites; i++) { blend.x.push(bl.axes[0].values[i] * 100); blend.y.push(bl.values[i] * 100); }
    }
    out.aim = main ? { main: main, alt: alt, blend: blend } : null;

    var lo = m1hItem(pkg, 'Fuel.Closed Loop.Control.Trim.Minimum.Value'), hi = m1hItem(pkg, 'Fuel.Closed Loop.Control.Trim.Maximum.Value');
    function used(item, pick) {
        if (!item || item.kind !== 'Table') return null;
        var best = null, nx = item.axes[0].sites || 1, ny = item.axes.length > 1 ? item.axes[1].sites || 1 : 1;
        for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
            var v = item.values[i + j * item.axes[0].maxSites] * 100;
            if (v > 50) v -= 100;   // stored as a multiplier (0.85 / 1.15) → −15 / +15 %
            if (best === null || pick(v, best)) best = v;
        }
        return best;
    }
    var tmin = used(lo, function (a, b) { return a < b; }), tmax = used(hi, function (a, b) { return a > b; });
    out.clTrim = tmin !== null && tmax !== null ? { min: tmin, max: tmax } : null;

    var fpw = m1hNum(pkg, 'Fuel.Pressure.Warning.Maximum', 1e-3);
    out.fuelPressureWarnMax = fpw > 0 ? fpw : null;

    var n = m1hNum(pkg, 'Engine.Cylinders') || 8;
    out.banks = [];
    for (var c = 1; c <= n; c++) {
        var b = m1hItem(pkg, 'Engine.Cylinder ' + c + '.Bank');
        out.banks.push(b && typeof b.value === 'number' ? b.value : (c % 2 ? 1 : 2));
    }

    var t = m1hItem(pkg, 'Inlet.Manifold.Pressure.Sensor.Translation');
    if (t && t.kind === 'Table' && t.axes[0].sites === 2) {
        var a = t.axes[0], slope = (t.values[1] - t.values[0]) / 1000 / (a.values[1] - a.values[0]), off = t.values[0] / 1000 - slope * a.values[0];
        out.map = { at0: off, at5: off + 5 * slope };
    } else out.map = null;
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { m1pkgHealth: m1pkgHealth };
