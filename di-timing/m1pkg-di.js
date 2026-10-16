/**
 * di-timing/m1pkg-di.js — Direct injection timing settings from a MoTeC M1 package (.m1pkg).
 *
 * m1pkgDi(pkg) → {
 *   tuneName,
 *   table: { rpm: [..], map: [kPa..], values: [[dBTDC per rpm site] per MAP site] } | null   (Fuel.Timing.Primary.Main)
 *   startLimit, primaryLimit, limitMargin, makeup: dBTDC | null
 *   spark: largest Ignition Timing Main advance (° BTDC) | null
 *   camAim: { min, max } intake camshaft aim (° advance) | null
 *   cylinders, notes: [string]
 * }
 * Angles are stored with positive = later in the cycle; M1 Tune shows dBTDC = −stored (dADV = −stored).
 */

function m1diItem(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

function m1diFirst(it) {
    if (!it) return null;
    if (typeof it.value === 'number') return it.value;
    return it.values && typeof it.values[0] === 'number' ? it.values[0] : null;
}

function m1diR(v) { return v === null ? null : Math.round(v * 100) / 100; }

/** Used values of a table as rows over its first two axes (X = columns, Y = rows); null if not a table. */
function m1diGrid(it) {
    if (!it || it.kind !== 'Table') return null;
    var x = (it.axes || []).filter(function (a) { return a.axis === 'X'; })[0], y = (it.axes || []).filter(function (a) { return a.axis === 'Y'; })[0];
    if (!x || !(x.sites > 0)) return null;
    var ny = y && y.sites > 0 ? y.sites : 1, rows = [];
    for (var iy = 0; iy < ny; iy++) {
        var row = [];
        for (var ix = 0; ix < x.sites; ix++) row.push(it.values[ix + iy * x.maxSites]);
        rows.push(row);
    }
    return { x: x, y: y && y.sites > 0 ? y : null, rows: rows };
}

function m1pkgDi(pkg) {
    var out = { tuneName: pkg.tuneName, table: null, startLimit: null, primaryLimit: null, limitMargin: null, makeup: null,
                spark: null, camAim: null, cylinders: null, notes: [] };
    var g = m1diGrid(m1diItem(pkg, 'Fuel.Timing.Primary.Main'));
    if (g && g.x.unit === 'deg/s') {
        var mapAxis = g.y && g.y.unit === 'Pa' ? g.y : null;
        out.table = {
            rpm: g.x.values.slice(0, g.x.sites).map(function (v) { return Math.round(v / 6); }),
            map: mapAxis ? mapAxis.values.slice(0, mapAxis.sites).map(function (v) { return Math.round(v / 1000); }) : [null],
            values: g.rows.map(function (row) { return row.map(function (v) { return m1diR(-v); }); })
        };
        if (g.y && !mapAxis) out.notes.push('Fuel Timing Primary Main has a ' + g.y.input + ' axis; its rows are shown as they are.');
    }
    var neg = function (name) { var v = m1diFirst(m1diItem(pkg, name)); return v === null ? null : m1diR(-v); };
    out.startLimit = neg('Fuel.Timing.Primary.Injection Start Limit');
    out.primaryLimit = neg('Fuel.Timing.Primary.Limit.Main');
    out.limitMargin = neg('Fuel.Timing.Primary.Limit.Margin');
    out.makeup = neg('Fuel.Timing.Primary.Makeup');

    var ign = m1diGrid(m1diItem(pkg, 'Ignition.Timing.Main'));
    if (ign) {
        var max = -Infinity;
        ign.rows.forEach(function (row) { row.forEach(function (v) { if (-v > max) max = -v; }); });
        out.spark = isFinite(max) ? m1diR(max) : null;
    }
    var cam = m1diGrid(m1diItem(pkg, 'Inlet.Camshaft.Aim'));
    if (cam) {
        var lo = Infinity, hi = -Infinity;
        cam.rows.forEach(function (row) { row.forEach(function (v) { lo = Math.min(lo, -v); hi = Math.max(hi, -v); }); });
        out.camAim = { min: m1diR(lo), max: m1diR(hi) };
    }
    var cyl = m1diItem(pkg, 'Engine.Cylinders');
    out.cylinders = cyl && typeof cyl.value === 'number' ? cyl.value : null;
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { m1pkgDi: m1pkgDi };
