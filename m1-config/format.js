/**
 * m1-config/format.js — Display formatting for parsed M1 package items.
 * Values in a package are stored in SI units (deg/s, Pa, s, ratio...). M1 Tune shows them in each
 * item's display unit; these helpers apply the conversions we know to be exact and otherwise fall
 * back to the stored unit so a value is never shown with a wrong unit.
 */

var M1C_UNIT_CONVERSIONS = {
    'deg/s|rpm': function (v) { return v / 6; },
    'deg/s/s|rpm/s': function (v) { return v / 6; },
    // Angles are stored with positive = later in the cycle (dBTDC verified against M1 Tune). Units that
    // count later events positive (after TDC, retard) show as stored; units counting earlier events (before
    // TDC, advance) are negated.
    'deg|dBTDC': function (v) { return -v; },
    'deg|dATDC': function (v) { return v; },
    'deg|dRTD': function (v) { return v; },
    'deg|dADV': function (v) { return -v; },
    's|ms': function (v) { return v * 1e3; },
    's|us': function (v) { return v * 1e6; },
    'ratio|%': function (v) { return v * 100; },
    'ratio|%Trim': function (v) { return v * 100; },
    'ratio/s|%/s': function (v) { return v * 100; },
    'ratio/V|%/V': function (v) { return v * 100; },
    'ratio/deg|%/deg': function (v) { return v * 100; },
    'ratio/Pa|%/kPa': function (v) { return v * 1e5; },
    'ratio/ratio|%/%': function (v) { return v; },
    'Pa|kPa': function (v) { return v / 1e3; },
    'Pa|kPa a': function (v) { return v / 1e3; },
    'Pa|bar': function (v) { return v / 1e5; },
    'Pa|MPa': function (v) { return v / 1e6; },
    'dPa|kPa g': function (v) { return v / 1e3; },
    'dPa|dkPa': function (v) { return v / 1e3; },
    'dPa|dbar': function (v) { return v / 1e5; },
    'dPa|dMPa': function (v) { return v / 1e6; },
    'm/s|km/h': function (v) { return v * 3.6; },
    'm/s/s|G': function (v) { return v / 9.80665; },
    'm|mm': function (v) { return v * 1e3; },
    'm|in': function (v) { return v / 0.0254; },
    'V|mV': function (v) { return v * 1e3; },
    'A|mA': function (v) { return v * 1e3; },
    'kg|mg': function (v) { return v * 1e6; },
    'kg/s|g/s': function (v) { return v * 1e3; },
    'kg/s|g/min': function (v) { return v * 6e4; },
    'kg/mol|g/mol': function (v) { return v * 1e3; },
    'm3|l': function (v) { return v * 1e3; },
    'm3|ul': function (v) { return v * 1e9; },
    'm3/s|ml/s': function (v) { return v * 1e6; },
    'm3/s|ul/s': function (v) { return v * 1e9; },
    'm3/s|ml/min': function (v) { return v * 6e7; }
};

/**
 * Convert a stored value for display. Returns { value, unit, dps }.
 * `src` is anything with unit / displayUnit / dps (an item or a table axis).
 */
function m1cConvert(value, src) {
    var conv = src.displayUnit ? M1C_UNIT_CONVERSIONS[src.unit + '|' + src.displayUnit] : null;
    if (src.displayUnit && src.displayUnit === src.unit) conv = function (v) { return v; };
    if (conv && typeof value === 'number') return { value: conv(value), unit: src.displayUnit, dps: src.dps };
    return { value: value, unit: src.unit, dps: conv ? src.dps : null };
}

/** Format a number with fixed decimals when known, otherwise up to 4 significant decimals. */
function m1cFormatNumber(v, dps) {
    if (typeof v !== 'number') return String(v);
    if (!isFinite(v)) return String(v);
    if (dps !== null && dps !== undefined && dps >= 0 && dps <= 10) return v.toFixed(dps);
    if (Number.isInteger(v)) return String(v);
    var s = v.toPrecision(6);
    return String(parseFloat(s));
}

/** Display string (without unit) for a scalar or IO resource item value. */
function m1cFormatValue(item, value, label) {
    if (item.type === 'io_resource') {
        var ids = (value || []).filter(function (id) { return id !== '0x0000'; });
        return ids.length ? ids.join(', ') : 'Not assigned';
    }
    if (item.type === 'enum') return label !== undefined && label !== null ? label : String(value);
    return m1cFormatNumber(m1cConvert(value, item).value, m1cConvert(value, item).dps);
}

/** Unit to show next to an item's values (display unit when we can convert to it). */
function m1cUnit(src) {
    if (src.type === 'enum' || src.type === 'io_resource') return '';
    return m1cConvert(0, src).unit || '';
}

/**
 * Used portion of a table for display: converted axes and rows of body values.
 * Returns { x, y, z, slices: [{ zValue, rows: [[...]] }] } — 1D tables have a single row.
 */
function m1cTableGrid(item) {
    var ax = {};
    item.axes.forEach(function (a) { ax[a.axis] = a; });
    var dims = item.axes.map(function (a) { return a.maxSites; });
    function used(a) { return a ? (a.sites || a.maxSites) : 1; }
    function axisValues(a) {
        if (!a) return null;
        return a.values.slice(0, used(a)).map(function (v) { return m1cConvert(v, a).value; });
    }
    function bodyAt(ix, iy, iz) {
        var idx = ix + (dims.length > 1 ? iy * dims[0] : 0) + (dims.length > 2 ? iz * dims[0] * dims[1] : 0);
        return m1cConvert(item.values[idx], item).value;
    }
    var nx = used(ax.X), ny = used(ax.Y), nz = used(ax.Z), slices = [];
    var zValues = axisValues(ax.Z);
    for (var iz = 0; iz < nz; iz++) {
        var rows = [];
        for (var iy = 0; iy < ny; iy++) {
            var row = [];
            for (var ix = 0; ix < nx; ix++) row.push(bodyAt(ix, iy, iz));
            rows.push(row);
        }
        slices.push({ zValue: zValues ? zValues[iz] : null, rows: rows });
    }
    return { x: axisValues(ax.X), y: axisValues(ax.Y), z: zValues, slices: slices };
}

/** Short size description, e.g. "9 × 7 of 11 × 11". */
function m1cTableSize(item) {
    var usedDims = item.axes.map(function (a) { return a.sites || a.maxSites; });
    var maxDims = item.axes.map(function (a) { return a.maxSites; });
    var u = usedDims.join(' × '), m = maxDims.join(' × ');
    return u === m ? u : u + ' of ' + m;
}

/**
 * Human-readable location for a diff cell key: 'V[2,0]' → "6000 rpm, 0 kPa"; 'X[3]' → "X axis site 4".
 */
function m1cCellLabel(item, key) {
    if (!key) return '';
    var m = /^([XYZ])\[(\d+)\]$/.exec(key);
    if (m) return m[1] + ' axis site ' + (parseInt(m[2], 10) + 1);
    var v = /^V\[([\d,]+)\]$/.exec(key);
    if (!v || !item.axes) return key;
    return v[1].split(',').map(function (s, i) {
        var a = item.axes[i], idx = parseInt(s, 10);
        if (!a || !a.values) return '#' + idx;
        var c = m1cConvert(a.values[idx], a);
        return m1cFormatNumber(c.value, c.dps) + (c.unit ? ' ' + c.unit : '');
    }).join(', ');
}

/** Format a diff cell value: axis cells use the axis unit, body cells and scalars the item unit. */
function m1cFormatCell(item, key, value, label) {
    if (value === null || value === undefined) return '—';
    var m = /^([XYZ])\[/.exec(key || '');
    if (m && item.axes) {
        var a = item.axes.filter(function (x) { return x.axis === m[1]; })[0];
        var c = m1cConvert(value, a);
        return m1cFormatNumber(c.value, c.dps);
    }
    if (item.axes) {
        var b = m1cConvert(value, item);
        return m1cFormatNumber(b.value, b.dps);
    }
    return m1cFormatValue(item, value, label);
}

/** Which tabs an item belongs to (mirrors the categories of the M1 Config page). */
function m1cCategories(item) {
    var cats = ['all'];
    if (item.tags.indexOf('Feature') >= 0) cats.push('firmware');
    if (item.name.indexOf('Driver.') === 0) cats.push('driver');
    if (item.tags.indexOf('Engine') >= 0) cats.push('engine');
    if (item.tags.indexOf('Vehicle') >= 0) cats.push('vehicle');
    return cats;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        m1cConvert: m1cConvert, m1cFormatNumber: m1cFormatNumber, m1cFormatValue: m1cFormatValue,
        m1cUnit: m1cUnit, m1cTableGrid: m1cTableGrid, m1cTableSize: m1cTableSize,
        m1cCellLabel: m1cCellLabel, m1cFormatCell: m1cFormatCell, m1cCategories: m1cCategories
    };
}
