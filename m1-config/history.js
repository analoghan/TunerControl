/**
 * m1-config/history.js — Value history of one parameter or table cell across tune versions.
 *
 * m1hPoints(rows, item, key)  rows: [{ tuneName, modified, value, label }] oldest first (value is the stored
 *                              base-unit number, an I/O id list, or null when the tune lacks the item)
 *   → [{ tuneName, short, modified, text, num }]   text = display text, num = display-unit number or null
 * m1hChartSvg(points, unit)    line chart of the numeric points (SVG string), or '' when fewer than two
 * m1hShortName(tuneName)       "C7 Z06 LT4 - 2026 - Blake - V55" → "V55"
 */

function m1hShortName(name) {
    var parts = String(name || '').split(' - ');
    return parts[parts.length - 1] || String(name || '');
}

function m1hPoints(rows, item, key, formatIo) {
    return rows.map(function (r) {
        var text, num = null;
        if (r.value === null || r.value === undefined) text = '—';
        else if (item.type === 'io_resource') {
            var ids = Array.isArray(r.value) ? r.value : String(r.value).split(',');
            text = formatIo ? formatIo(ids) : m1cFormatValue(item, ids);
        } else {
            text = m1cFormatCell(item, key, r.value, r.label);
            if (item.type !== 'enum' && typeof r.value === 'number') {
                var axis = /^([XYZ])\[/.exec(key || '');
                var src = axis && item.axes ? item.axes.filter(function (a) { return a.axis === axis[1]; })[0] : item;
                num = m1cConvert(r.value, src).value;
            }
        }
        return { tuneName: r.tuneName, short: m1hShortName(r.tuneName), modified: r.modified, text: text, num: num };
    });
}

function m1hEsc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function m1hChartSvg(points, unit) {
    var pts = points.filter(function (p) { return p.num !== null && isFinite(p.num); });
    if (pts.length < 2) return '';
    var W = 640, H = 250, L = 64, R = 16, T = 28, B = 46;
    var min = Math.min.apply(null, pts.map(function (p) { return p.num; }));
    var max = Math.max.apply(null, pts.map(function (p) { return p.num; }));
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.1;
    min -= pad; max += pad;
    function x(i) { return L + (points.length === 1 ? 0 : i * (W - L - R) / (points.length - 1)); }
    function y(v) { return T + (H - T - B) * (1 - (v - min) / (max - min)); }
    var grid = '', ticks = 4;
    for (var k = 0; k <= ticks; k++) {
        var v = min + (max - min) * k / ticks, yy = y(v);
        grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="#333"/>' +
            '<text x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end" fill="#999" font-size="11">' +
            m1hEsc(+v.toPrecision(4)) + '</text>';
    }
    var line = [], dots = '', labels = '';
    points.forEach(function (p, i) {
        labels += '<text x="' + x(i) + '" y="' + (H - B + 16) + '" text-anchor="middle" fill="#bbb" font-size="11">' + m1hEsc(p.short) + '</text>';
        if (p.num === null || !isFinite(p.num)) return;
        line.push(x(i) + ',' + y(p.num));
        dots += '<circle cx="' + x(i) + '" cy="' + y(p.num) + '" r="4" fill="#E31837"><title>' + m1hEsc(p.tuneName + ': ' + p.text +
            (unit ? ' ' + unit : '')) + '</title></circle>';
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Value history chart">' +
        grid + '<polyline points="' + line.join(' ') + '" fill="none" stroke="#E31837" stroke-width="2"/>' + dots + labels +
        (unit ? '<text x="' + (L - 6) + '" y="14" text-anchor="end" fill="#999" font-size="11">' + m1hEsc(unit) + '</text>' : '') + '</svg>';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { m1hPoints: m1hPoints, m1hChartSvg: m1hChartSvg, m1hShortName: m1hShortName };
}
