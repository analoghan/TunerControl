/**
 * map-rescale/app.js — UI for the MAP Rescale page: pick the tune, the translation its tables were made for and the new one,
 * then show every converted table (copy to paste into M1 Tune, Engine Efficiency Main also as an M1 Tune table CSV) and the settings.
 * Conversion in map-rescale.js; display units via m1-config/format.js.
 */

var analyzeBtn = document.getElementById('analyze-btn');
var errorBox = document.getElementById('error-container');
var resultsSection = document.getElementById('results-section');
var fields = { old0: 'old-0', old5: 'old-5', new0: 'new-0', new5: 'new-5' };
Object.keys(fields).forEach(function (k) { fields[k] = document.getElementById(fields[k]); });

var tunePkg = null;      // parsed package being converted
var lastResult = null;   // { conversion, from, to, mode }

function showError(msg) { errorBox.textContent = msg; errorBox.hidden = !msg; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function kpa(v, d) { return (Math.round(v * Math.pow(10, d === undefined ? 1 : d)) / Math.pow(10, d === undefined ? 1 : d)).toFixed(d === undefined ? 1 : d); }
function niceName(name) { return name.replace(/\.Value$/, '').replace(/\./g, ' '); }

/** Translation endpoints for the form: { at0, at5 } from a package, or throws. */
function translationOf(pkg) {
    var t = mrTranslation(pkg);
    return { tuneName: pkg.tuneName, at0: t.offset, at5: t.offset + 5 * t.slope };
}

function lineFrom(at0, at5) {
    if (!isFinite(at0) || !isFinite(at5) || at5 <= at0) return null;
    return mrLine(0, at0, 5, at5);
}

function updateButton() {
    analyzeBtn.disabled = !tunePkg || !lineFrom(parseFloat(fields.old0.value), parseFloat(fields.old5.value)) ||
        !lineFrom(parseFloat(fields.new0.value), parseFloat(fields.new5.value));
}
Object.keys(fields).forEach(function (k) { fields[k].addEventListener('input', updateButton); });

tsPicker({
    pkgInput: document.getElementById('pkg-input'), select: document.getElementById('tune-select'), row: document.getElementById('tune-row'),
    hint: document.getElementById('tune-hint'), status: document.getElementById('tune-status'), what: 'the MAP translation',
    none: 'No tune chosen.',
    extract: function (pkg) { var t = translationOf(pkg); t.pkg = pkg; return t; },
    describe: function (t) {
        var n = mrFindTables(t.pkg).length;
        return 'MAP translation ' + kpa(t.at0) + ' kPa at 0 V, ' + kpa(t.at5) + ' kPa at 5 V; ' + n + ' tables follow the MAP reading' +
            (mrLoadIsMap(t.pkg) ? ' (Engine Load Normalised mode is Inlet Manifold Pressure, so ignition and knock tables are included).' : '.');
    },
    onError: showError,
    onChange: function (t) {
        tunePkg = t ? t.pkg : null;
        if (t) {
            showError('');
            fields.old0.value = kpa(t.at0, 2);
            fields.old5.value = kpa(t.at5, 2);
            document.getElementById('old-note').textContent = 'from the tune — change it if its tables were made for an older translation';
        }
        resultsSection.hidden = true;
        updateButton();
    }
});

var newStatus = document.getElementById('new-tune-status');
tsPicker({
    pkgInput: document.getElementById('new-pkg-input'), select: document.getElementById('new-tune-select'),
    row: document.getElementById('new-tune-row'), hint: document.getElementById('new-tune-hint'), status: newStatus,
    what: 'the MAP translation', none: '',
    extract: translationOf,
    describe: function (t) { return 'New translation ' + kpa(t.at0) + ' kPa at 0 V, ' + kpa(t.at5) + ' kPa at 5 V.'; },
    onError: showError,
    onChange: function (t) {
        newStatus.hidden = !t;
        if (t) { fields.new0.value = kpa(t.at0, 2); fields.new5.value = kpa(t.at5, 2); }
        updateButton();
    }
});

analyzeBtn.addEventListener('click', function () {
    showError('');
    var from = lineFrom(parseFloat(fields.old0.value), parseFloat(fields.old5.value));
    var to = lineFrom(parseFloat(fields.new0.value), parseFloat(fields.new5.value));
    var mode = document.querySelector('input[name="mode"]:checked').value;
    try {
        var conversion = mrConvertTune(tunePkg, from, to, mode);
        // Tables of MAP readings that are all 0 (off) don't change; leave them out of the report.
        conversion.tables = conversion.tables.filter(function (t) { return t.kind !== 'reading' || t.changed; });
        lastResult = { conversion: conversion, from: from, to: to, mode: mode };
    } catch (err) { showError(err.message); return; }
    render(lastResult);
    resultsSection.hidden = false;
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(r) {
    gridCache = [];
    document.getElementById('translation-content').innerHTML = translationHtml(r);
    document.getElementById('summary-content').innerHTML = summaryHtml(r);
    document.getElementById('tables-content').innerHTML = r.conversion.tables.map(function (t, i) { return tableHtml(t, i, r.mode); }).join('');
}

function translationHtml(r) {
    var volts = [0.3, 0.5, 0.75, 1.0, 1.6, 2.0, 2.5, 3.0, 4.0, 4.5];
    var rows = volts.map(function (v) {
        var a = r.from.offset + r.from.slope * v, b = r.to.offset + r.to.slope * v;
        return '<tr><td>' + v.toFixed(2) + '</td><td>' + kpa(a) + '</td><td>' + kpa(b) + '</td><td>' + (b - a >= 0 ? '+' : '') + kpa(b - a) +
            '</td><td>' + (a > 0 && b > 0 ? kpa((a / b - 1) * 100) + ' %' : '—') + '</td></tr>';
    }).join('');
    var same = Math.abs(r.from.offset - r.to.offset) < 1e-6 && Math.abs(r.from.slope - r.to.slope) < 1e-6;
    return (same ? '<div class="rec-item rec-warning">The two translations are the same — nothing changes.</div>' : '') +
        '<p>Type the new translation into <b>Inlet Manifold Pressure Sensor Translation</b>: <b>' + kpa(r.to.offset, 2) + ' kPa at 0 V, ' +
        kpa(r.to.offset + 5 * r.to.slope, 2) + ' kPa at 5 V</b> (' + kpa(r.to.slope, 2) + ' kPa/V; was ' + kpa(r.from.offset, 2) + ' / ' +
        kpa(r.from.offset + 5 * r.from.slope, 2) + ', ' + kpa(r.from.slope, 2) + ' kPa/V).</p>' +
        '<table class="event-table" style="max-width:560px"><thead><tr><th>Sensor V</th><th>Old reading kPa</th><th>New reading kPa</th>' +
        '<th>Change</th><th>VE × (old ÷ new − 1)</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="section-desc">Check the new translation before converting: key-on engine-off MAP should equal the real barometric pressure, ' +
        'and the decel floor should stay plausible (never ≤ 0). Ambient Pressure has its own sensor translation and is not changed here.</p>';
}

function summaryHtml(r) {
    var c = r.conversion;
    var rows = c.tables.map(function (t, i) {
        var unit = m1cUnit(t.item);
        var what = t.kind === 'reading' ? 'values are MAP readings' : (r.mode === 'move' ? 'sites moved' : 'values re-read') + ' along ' + t.via +
            (t.kind === 'efficiency' ? ', × old ÷ new reading' : '');
        return '<tr><td class="left"><a href="#mr-t' + i + '">' + esc(niceName(t.name)) + '</a></td><td class="left">' + what + '</td><td>' + t.changed +
            '</td><td>' + (t.changed ? m1cFormatNumber(t.maxChange, (t.item.dps || 0) + 1) + ' ' + esc(unit) : '—') + '</td><td>' +
            (t.held.length || '') + '</td></tr>';
    }).join('');
    var params = c.parameters.filter(function (p) { return p.item.value !== 0; });
    var zero = c.parameters.length - params.length;
    var prows = params.map(function (p) {
        var unit = p.toKpa === 100 ? '%' : 'kPa';
        var f = function (v) { return m1cFormatNumber(v * p.toKpa, 2) + ' ' + unit + (p.kind === 'delta' && p.item.unit.slice(-2) === '/s' ? '/s' : ''); };
        return '<tr><td class="left">' + esc(niceName(p.item.name)) + '</td><td>' + f(p.item.value) + '</td><td><b>' + f(p.value) + '</b></td><td class="left">' +
            esc(p.note) + '</td></tr>';
    }).join('');
    return '<table class="event-table"><thead><tr><th class="left">Table</th><th class="left">How</th><th>Cells changed</th><th>Largest change</th>' +
        '<th>Held</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        (c.loadIsMap ? '' : '<p class="section-desc">Engine Load Normalised is not in Inlet Manifold Pressure mode, so tables on it are left alone.</p>') +
        '<h3 style="margin-top:16px">Settings compared with MAP</h3>' +
        (params.length ? '<table class="event-table"><thead><tr><th class="left">Setting</th><th>Now</th><th>New</th><th class="left">Note</th></tr></thead><tbody>' +
            prows + '</tbody></table>' : '<p>None set.</p>') +
        (zero ? '<p class="section-desc">' + zero + ' more are 0 (off) and stay 0.</p>' : '') +
        '<p class="section-desc">Tables whose MAP axis has a single site don\'t depend on MAP and are not listed.</p>';
}

/** Grid of one Z slice: pressure rows highest first (2D), or one row (1D). Returns { html, tsv, sitesTsv }. */
function gridOf(t, z, mode) {
    var item = t.item, axes = item.axes, strides = [], k = 1;
    axes.forEach(function (a) { strides.push(k); k *= a.maxSites; });
    var p = t.axisIndex, x = axes[0], y = axes.length > 1 ? axes[1] : null;
    var nx = x.sites || 1, ny = y ? (y.sites || 1) : 1;
    var heldSet = {};
    t.held.forEach(function (idx) { heldSet[idx.join(',')] = true; });
    var origValues = findOriginal(t.name).values;
    var fmt = function (v) { return m1cFormatNumber(m1cConvert(v, item).value, item.dps); };
    var site = function (a, j, axisIndex) {
        if (!a.values) return String(j + 1);   // e.g. a Gear axis without site values
        var v = m1cConvert(a.values[j], a).value;
        return axisIndex === p && t.newSites ? m1cFormatNumber(v, 1) : m1cFormatNumber(v, a.dps);
    };
    var moved = function (axisIndex) { return mode === 'move' && axisIndex === p ? ' class="moved"' : ''; };
    var head = '<tr><th>' + (y ? esc(m1cUnit(y)) + ' \\ ' : '') + esc(m1cUnit(x)) + '</th>';
    for (var i = 0; i < nx; i++) head += '<th' + moved(0) + '>' + site(x, i, 0) + '</th>';
    head += '</tr>';
    var body = '', tsv = [], rowsOrder = [];
    for (var j = ny - 1; j >= 0; j--) rowsOrder.push(j);
    if (!y || p !== 1) rowsOrder.reverse();
    rowsOrder.forEach(function (j) {
        var tr = '<tr>' + (y ? '<th' + moved(1) + '>' + site(y, j, 1) + '</th>' : '<th></th>'), line = [];
        for (var i = 0; i < nx; i++) {
            var idx = [i];
            if (y) idx.push(j);
            if (axes.length > 2) idx.push(z);
            var flat = idx.reduce(function (s, v, d) { return s + v * strides[d]; }, 0);
            var cls = heldSet[idx.join(',')] ? 'held' : Math.abs(item.values[flat] - origValues[flat]) > 1e-12 ? 'changed' : '';
            var txt = fmt(item.values[flat]);
            tr += '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + txt + '</td>';
            line.push(txt);
        }
        body += tr + '</tr>';
        tsv.push(line.join('\t'));
    });
    var pa = t.axisIndex !== undefined ? axes[t.axisIndex] : null, sites = [];
    if (pa) for (i = 0; i < (pa.sites || 1); i++) sites.push(site(pa, i, t.axisIndex));
    return { html: '<table class="mr-grid"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>', tsv: tsv.join('\n'), sitesTsv: sites.join('\t') };
}

function findOriginal(name) { return mrItem(tunePkg, name); }

var gridCache = [];   // grids of the rendered tables, for the copy buttons

function tableHtml(t, i, mode) {
    var axes = t.item.axes, z = axes.length > 2 ? axes[2] : null, nz = z ? (z.sites || 1) : 1, out = '';
    var note = t.kind === 'reading' ? 'Values are MAP readings, converted to the new translation (0 = off, left).' :
        t.kind === 'efficiency' ? 'Values × old ÷ new reading so the air mass at each voltage stays the same.' +
            (mode === 'move' ? ' Type the new ' + t.via + ' sites (orange header), then paste the values.' : '') :
        mode === 'move' ? 'Values unchanged; type the new ' + t.via + ' sites (orange header).' : 'Sites unchanged; paste the values.';
    for (var s = 0; s < nz; s++) {
        var g = gridOf(t, s, mode), key = gridCache.length;
        gridCache.push(g);
        out += (nz > 1 ? '<p class="mr-note">' + esc(niceName(z.input)) + ' = ' + m1cFormatNumber(m1cConvert(z.values[s], z).value, z.dps) + ' ' +
            esc(m1cUnit(z)) + '</p>' : '') + '<div class="mr-grid-wrap">' + g.html + '</div>' +
            '<div class="mr-buttons"><button data-copy="' + key + '">Copy values</button>' +
            (mode === 'move' && t.newSites ? '<button data-copy-sites="' + key + '">Copy ' + esc(t.via) + ' sites</button>' : '') +
            (t.name === 'Engine.Efficiency.Main' && s === 0 ? '<button data-csv="' + i + '">Download M1 Tune CSV</button>' : '') + '</div>';
    }
    return '<div class="mr-table" id="mr-t' + i + '"><h3>' + esc(niceName(t.name)) + ' <span class="mr-note">(' + esc(m1cUnit(t.item)) + ')</span></h3>' +
        '<p class="mr-note">' + note + (t.held.length ? ' ' + t.held.length + ' cells held.' : '') + '</p>' + out + '</div>';
}

document.getElementById('tables-content').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy !== undefined) copyText(gridCache[+b.dataset.copy].tsv, b);
    else if (b.dataset.copySites !== undefined) copyText(gridCache[+b.dataset.copySites].sitesTsv, b);
    else if (b.dataset.csv !== undefined) {
        var t = lastResult.conversion.tables[+b.dataset.csv];
        var blob = new Blob([mrEfficiencyCsv(t)], { type: 'text/csv' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'Eng Efficiency Main - ' + (tunePkg.tuneName || 'tune').replace(/[\\/:*?"<>|]/g, '') + ' MAP ' + kpa(lastResult.to.offset) + '_' +
            kpa(lastResult.to.offset + 5 * lastResult.to.slope) + '.csv';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
});

function copyText(text, btn) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    var done = function (msg) { var old = btn.textContent; btn.textContent = msg; setTimeout(function () { btn.textContent = old; }, 1200); };
    if (ok) done('Copied');
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { done('Copied'); }, function () { done('Copy failed'); });
    else done('Copy failed');
}
