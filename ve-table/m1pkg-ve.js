/**
 * m1pkg-ve.js — Builds the VE table input from a MoTeC M1 package (.m1pkg).
 *
 * Extracts Engine.Efficiency.Main from a parsed package (lib/m1pkg-parser.js) and renders it as the
 * same "M1,v2" CSV that M1 Tune exports, so the worker processes it exactly like a CSV export and
 * VE_New_Values.csv stays importable into M1 Tune.
 */

var M1VE_TABLE_NAME = 'Engine.Efficiency.Main';

/** MoTeC-style scientific notation: 17 decimals, two-digit signed exponent (matches worker.js). */
function m1veScientific(value) {
    var raw = value.toExponential(17), e = raw.indexOf('e');
    var sign = raw[e + 1], digits = raw.slice(e + 2);
    return raw.slice(0, e) + 'e' + sign + (digits.length < 2 ? '0' + digits : digits);
}

function m1veQuote(value) { return '"' + m1veScientific(value) + '"'; }

/**
 * Converts a parsed package's main efficiency table to M1 v2 CSV text.
 * Package values are SI (deg/s, Pa, ratio); the CSV uses rpm, kPa and %.
 * Returns { csv, tuneName, rpmSites, mapSites }; throws if the table is missing or not RPM × MAP.
 */
function m1pkgVeTableCsv(pkg) {
    var item = null;
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === M1VE_TABLE_NAME) item = pkg.items[i];
    if (!item || item.kind !== 'Table') throw new Error('This package has no ' + M1VE_TABLE_NAME + ' table.');

    var ax = {};
    item.axes.forEach(function (a) { ax[a.axis] = a; });
    var x = ax.X, y = ax.Y, z = ax.Z;
    if (!x || !y || x.unit !== 'deg/s' || y.unit !== 'Pa' || item.unit !== 'ratio') {
        throw new Error(M1VE_TABLE_NAME + ' is not an engine speed × manifold pressure table of ratios ' +
            '(axes: ' + item.axes.map(function (a) { return a.input + ' [' + a.unit + ']'; }).join(', ') + ').');
    }
    if (!/^Inlet\.Manifold\.Pressure/.test(y.input || '')) {
        throw new Error(M1VE_TABLE_NAME + ' Y axis is ' + y.input + ', but this tool bins log samples by ' +
            'Inlet Manifold Pressure.');
    }
    if (z && z.sites > 1) {
        throw new Error(M1VE_TABLE_NAME + ' has ' + z.sites + ' ' + z.input + ' slices; this tool only ' +
            'handles a single RPM × MAP table.');
    }

    var nx = x.sites, ny = y.sites, lines = ['M1,v2', 'Body,%', 'Cols,rpm,Eng Speed', 'Rows,kPa,Inlet Man Pres'];
    var header = [''];
    for (var ix = 0; ix < nx; ix++) header.push(m1veQuote(x.values[ix] / 6));
    lines.push(header.join(','));
    // M1 Tune exports the highest pressure first.
    for (var iy = ny - 1; iy >= 0; iy--) {
        var row = [m1veQuote(y.values[iy] / 1000)];
        for (ix = 0; ix < nx; ix++) row.push(m1veQuote(item.values[ix + iy * x.maxSites] * 100));
        lines.push(row.join(','));
    }
    return { csv: lines.join('\n'), tuneName: pkg.tuneName, rpmSites: nx, mapSites: ny };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { m1pkgVeTableCsv: m1pkgVeTableCsv, m1veScientific: m1veScientific, M1VE_TABLE_NAME: M1VE_TABLE_NAME };
}
