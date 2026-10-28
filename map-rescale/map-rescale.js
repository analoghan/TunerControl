/**
 * map-rescale/map-rescale.js — Converts a tune to a new Inlet Manifold Pressure sensor translation so the engine runs the same
 * at the same sensor voltage: every table with a manifold pressure axis (and an Engine Load Normalised axis when Load Normalised
 * mode is Inlet Manifold Pressure, where Load Normalised % = MAP kPa), settings compared with the MAP reading, and Engine
 * Efficiency values scaled by old ÷ new reading (air mass ∝ VE × MAP) so the air mass at each voltage is unchanged.
 *
 * A translation is a straight line { offset, slope }: kPa = offset + slope × volts.
 * Works on a parsed package (lib/m1pkg-parser.js); values stay SI (Pa, ratio) in the converted items.
 * Display helpers come from m1-config/format.js (m1cConvert), which the page loads first.
 */

var MR_MAP_INPUT = 'Inlet.Manifold.Pressure.Value';
var MR_LOAD_INPUT = 'Engine.Load.Normalised.Value';
var MR_TRANSLATION = 'Inlet.Manifold.Pressure.Sensor.Translation';

function mrItem(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

/** Line through (v1, p1) and (v2, p2), pressures in kPa. */
function mrLine(v1, p1, v2, p2) {
    var slope = (p2 - p1) / (v2 - v1);
    return { offset: p1 - slope * v1, slope: slope };
}

/** The tune's Inlet Manifold Pressure Sensor Translation as a line. Throws if it is missing or not a straight line. */
function mrTranslation(pkg) {
    var t = mrItem(pkg, MR_TRANSLATION);
    if (!t || t.kind !== 'Table' || t.unit !== 'Pa') throw new Error('This package has no Inlet Manifold Pressure Sensor Translation table.');
    var a = t.axes[0], n = a.sites || a.maxSites;
    if (n !== 2) throw new Error('Inlet Manifold Pressure Sensor Translation has ' + n + ' sites; only a straight line (2 sites) is supported.');
    return mrLine(a.values[0], t.values[0] / 1000, a.values[1], t.values[1] / 1000);
}

/** kPa read under translation `from` → kPa read under `to` at the same sensor voltage. */
function mrConvertKpa(kpa, from, to) {
    return to.offset + to.slope * (kpa - from.offset) / from.slope;
}

/** True when Engine Load Normalised follows the MAP reading (Load Normalised Mode = Inlet Manifold Pressure). */
function mrLoadIsMap(pkg) {
    var m = mrItem(pkg, 'Engine.Load.Normalised.Mode');
    return !!m && /Inlet Manifold Pressure/.test(String(m.label || m.value));
}

/** Index and kPa scale of a table axis that follows the MAP reading, or null. */
function mrPressureAxis(item, loadIsMap) {
    for (var i = 0; i < item.axes.length; i++) {
        var a = item.axes[i];
        if (a.input === MR_MAP_INPUT && a.unit === 'Pa') return { index: i, toKpa: 1e-3, via: 'Inlet Manifold Pressure' };
        if (loadIsMap && a.input === MR_LOAD_INPUT && a.unit === 'ratio') return { index: i, toKpa: 100, via: 'Engine Load Normalised' };
    }
    return null;
}

/**
 * Tables that change with the translation: [{ item, kind, axis }]
 *   kind 'efficiency' — Engine Efficiency table on a MAP axis (sites and values change)
 *   kind 'axis'       — table on a MAP / Load Normalised axis (only where the axis has more than one site)
 *   kind 'reading'    — table whose values are MAP readings (e.g. Inlet Manifold Pressure Estimate, nitrous MAP windows; 0 = off, left)
 */
function mrFindTables(pkg) {
    var loadIsMap = mrLoadIsMap(pkg), out = [];
    pkg.items.forEach(function (item) {
        if (item.kind !== 'Table' || !item.axes || item.name === MR_TRANSLATION) return;
        var axis = mrPressureAxis(item, loadIsMap);
        if (axis && (item.axes[axis.index].sites || 1) > 1) {
            out.push({ item: item, kind: /^Engine\.Efficiency\./.test(item.name) ? 'efficiency' : 'axis', axis: axis });
        } else if (item.unit === 'Pa' && /Inlet Manifold Pressure|^Inlet\.Manifold\.Pressure\.Estimate/.test(item.name)) {
            out.push({ item: item, kind: 'reading', axis: null });
        }
    });
    return out;
}

/**
 * Settings compared with the MAP reading: [{ item, kind: 'level' | 'delta', toKpa }]. Levels (thresholds, minimum, maximum) move
 * like a reading; deltas (hysteresis, rates) scale with the slope.
 */
function mrFindParameters(pkg) {
    var loadIsMap = mrLoadIsMap(pkg), out = [];
    pkg.items.forEach(function (item) {
        if (item.kind === 'Table' || typeof item.value !== 'number' || /\.Mode$|Sensor|Resource/.test(item.name)) return;
        var toKpa = null;
        if (/Inlet Manifold Pressure/.test(item.name) && (item.unit === 'Pa' || item.unit === 'Pa/s')) toKpa = 1e-3;
        if (loadIsMap && /Engine Load Normalised/.test(item.name) && (item.unit === 'ratio' || item.unit === 'ratio/s')) toKpa = 100;
        if (toKpa === null) return;
        out.push({ item: item, kind: /Hysteresis|Increase|Decrease|Rate|\/s$/.test(item.name + '|' + item.unit) ? 'delta' : 'level', toKpa: toKpa });
    });
    return out;
}

/**
 * Converted value of a setting: { value (SI), note }. A level of 0 is left alone (in M1 a zero threshold usually means off).
 */
function mrConvertParameter(p, from, to) {
    var v = p.item.value;
    if (p.kind === 'delta') return { value: v * to.slope / from.slope, note: 'scaled by the slope ratio' };
    if (v === 0) return { value: 0, note: '0 left as is (usually means off)' };
    return { value: mrConvertKpa(v * p.toKpa, from, to) / p.toKpa, note: '' };
}

/** Strides of a table's value array: values[Σ index[d] × stride[d]], stride[0] = 1. */
function mrStrides(item) {
    var s = [], k = 1;
    item.axes.forEach(function (a) { s.push(k); k *= a.maxSites; });
    return s;
}

/** Every combination of used site indices of the table's axes. */
function mrCells(item) {
    var used = item.axes.map(function (a) { return a.sites || 1; }), out = [[]];
    used.forEach(function (n) {
        var next = [];
        out.forEach(function (idx) { for (var i = 0; i < n; i++) next.push(idx.concat(i)); });
        out = next;
    });
    return out;
}

/**
 * Converts one table found by mrFindTables.
 *   mode 'keep' — axis sites stay; each value is the old table read (clamped at the ends, as M1 does) at the old reading of the
 *                 voltage that now reads the site. Values can be pasted into the existing table.
 *   mode 'move' — sites move to the new reading of their voltage; values stay. Exact, but the sites have to be typed in.
 * Efficiency values are also × old ÷ new reading. In keep mode an efficiency site whose voltage read below the old axis is held
 * (copied from the nearest converted site): the old tune never had a site there (decel readings far below it are what a bad
 * translation produces), so scaling its lowest row by that reading would copy the error. Above the old axis M1 used the top row,
 * so that row × old ÷ new reading is exact.
 * Returns { name, kind, via, item: converted copy (SI), oldSites, newSites (kPa), held: [cell indices], changed,
 * maxChange (display units) }.
 */
function mrConvertTable(entry, from, to, mode) {
    var item = entry.item, values = item.values.slice(), held = [], changed = 0, maxChange = 0;
    var conv = typeof m1cConvert === 'function' ? function (v) { return m1cConvert(v, item).value; } : function (v) { return v; };
    function note(i, nv) {
        var d = Math.abs(conv(nv) - conv(item.values[i]));
        if (d > 1e-9) { changed++; if (d > maxChange) maxChange = d; }
        values[i] = nv;
    }

    if (entry.kind === 'reading') {
        var strides = mrStrides(item);
        mrCells(item).forEach(function (idx) {
            var i = idx.reduce(function (s, x, d) { return s + x * strides[d]; }, 0);
            if (item.values[i] !== 0) note(i, mrConvertKpa(item.values[i] / 1000, from, to) * 1000);   // 0 = off
        });
        return { name: item.name, kind: entry.kind, via: null, item: Object.assign({}, item, { values: values }), oldSites: null, newSites: null,
                 held: held, changed: changed, maxChange: maxChange };
    }

    var p = entry.axis.index, pa = item.axes[p], n = pa.sites, k = entry.axis.toKpa, stride = mrStrides(item);
    var oldSites = pa.values.slice(0, n).map(function (v) { return v * k; });
    var newSites = mode === 'move' ? oldSites.map(function (s) { return mrConvertKpa(s, from, to); }) : oldSites.slice();
    var eff = entry.kind === 'efficiency';

    mrCells(item).forEach(function (idx) {
        var base = 0;
        idx.forEach(function (x, d) { if (d !== p) base += x * stride[d]; });
        var at = function (j) { return item.values[base + j * stride[p]]; };
        var i = base + idx[p] * stride[p];
        if (mode === 'move') {
            var s = newSites[idx[p]];
            note(i, eff ? (s > 0 ? at(idx[p]) * oldSites[idx[p]] / s : at(idx[p])) : at(idx[p]));
            if (eff && !(s > 0)) held.push(idx);
            return;
        }
        var site = oldSites[idx[p]], x = mrConvertKpa(site, to, from);
        if (eff && (x < oldSites[0] || !(site > 0))) { held.push(idx); return; }
        var v;
        if (x <= oldSites[0]) v = at(0);
        else if (x >= oldSites[n - 1]) v = at(n - 1);
        else {
            var j = 1;
            while (oldSites[j] < x) j++;
            v = at(j - 1) + (at(j) - at(j - 1)) * (x - oldSites[j - 1]) / (oldSites[j] - oldSites[j - 1]);
        }
        note(i, eff ? v * x / site : v);
    });

    // Held efficiency sites (always at the low end) take the value of the nearest converted site above them, so the table stays
    // continuous; they are listed so they get re-tuned from logs.
    var converted = oldSites.map(function (s) { return mode === 'move' ? mrConvertKpa(s, from, to) > 0 : s > 0 && mrConvertKpa(s, to, from) >= oldSites[0]; });
    var firstOk = converted.indexOf(true);
    if (firstOk >= 0) held.forEach(function (idx) {
        var base = 0;
        idx.forEach(function (x, d) { if (d !== p) base += x * stride[d]; });
        note(base + idx[p] * stride[p], values[base + firstOk * stride[p]]);
    });

    var axes = item.axes.slice();
    if (mode === 'move') {
        var siteValues = pa.values.slice();
        newSites.forEach(function (s, j) { siteValues[j] = s / k; });
        axes[p] = Object.assign({}, pa, { values: siteValues });
    }
    return { name: item.name, kind: entry.kind, via: entry.axis.via, axisIndex: p, item: Object.assign({}, item, { axes: axes, values: values }),
             oldSites: oldSites, newSites: newSites, held: held, changed: changed, maxChange: maxChange };
}

/**
 * Whole conversion: { tables: [mrConvertTable result], parameters: [{ item, kind, value, note }], loadIsMap }.
 * `skip` (optional) is a set of table names to leave out.
 */
function mrConvertTune(pkg, from, to, mode, skip) {
    var tables = mrFindTables(pkg).filter(function (e) { return !(skip && skip[e.item.name]); })
        .map(function (e) { return mrConvertTable(e, from, to, mode); });
    var parameters = mrFindParameters(pkg).map(function (p) {
        var c = mrConvertParameter(p, from, to);
        return { item: p.item, kind: p.kind, toKpa: p.toKpa, value: c.value, note: c.note };
    });
    return { tables: tables, parameters: parameters, loadIsMap: mrLoadIsMap(pkg) };
}

/** MoTeC scientific number format used in M1 Tune table CSVs: 17 decimals, two-digit exponent. */
function mrSci(v) {
    var s = v.toExponential(17), e = s.indexOf('e'), exp = s.slice(e + 2);
    return s.slice(0, e) + 'e' + s[e + 1] + (exp.length < 2 ? '0' + exp : exp);
}

/**
 * M1 Tune table CSV of an rpm × MAP efficiency table (the layout of an M1 Tune export: M1,v2 header, quoted values, MAP rows
 * highest first, CRLF, trailing NUL). Only for Engine Efficiency Main — the header names of other tables are not verified.
 */
function mrEfficiencyCsv(converted) {
    var item = converted.item, x = item.axes[0], y = item.axes[1], stride = mrStrides(item);
    var q = function (v) { return '"' + mrSci(v) + '"'; };
    var lines = ['M1,v2', 'Body,%', 'Cols,rpm,Eng Speed', 'Rows,kPa,Inlet Man Pres'];
    var rpm = [];
    for (var i = 0; i < x.sites; i++) rpm.push(q(x.values[i] / 6));
    lines.push(',' + rpm.join(','));
    for (var j = y.sites - 1; j >= 0; j--) {
        var row = [q(y.values[j] / 1000)];
        for (i = 0; i < x.sites; i++) row.push(q(item.values[i * stride[0] + j * stride[1]] * 100));
        lines.push(row.join(','));
    }
    return lines.join('\r\n') + '\r\n\0';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { mrLine: mrLine, mrTranslation: mrTranslation, mrConvertKpa: mrConvertKpa, mrLoadIsMap: mrLoadIsMap,
        mrFindTables: mrFindTables, mrFindParameters: mrFindParameters, mrConvertParameter: mrConvertParameter,
        mrConvertTable: mrConvertTable, mrConvertTune: mrConvertTune, mrEfficiencyCsv: mrEfficiencyCsv, mrSci: mrSci };
}
