/**
 * harness/harness-diagram.js — Wiring diagrams (SVG) drawn from a harness model.
 *
 * harnessBlockDiagram(model, id, opts) — one connector or splice: its rows on the left, a wire to every
 *   connector pin or splice each row reaches, and splices followed one step further to their other ends.
 * harnessOverviewDiagram(model, opts) — every connector and splice as a box, joined by wire bundles with
 *   wire counts (ECU connectors left, splices in the middle, other connectors right).
 * Both return { svg, width, height }. Elements carry data-endpoint="CONN.CAVITY" (a row) or
 * data-node="ID" (a block) for click handling. opts.imageUrls maps image id → URL for the pictures drawn
 * under the focused block in the block diagram; opts.hardware is the ECU prefix for the overview (default M1xx).
 * opts.cables (harnessCables(model).byEndpoint) draws the cables leaving the focused connector as twisted ropes (2–4 strands,
 * a grey sheath and the drain alongside when shielded) and tags them (STP, UTP, 3C S…).
 */

var HD_COLORS = {
    white: '#f4f4f4', black: '#1b1b1b', red: '#d32f2f', green: '#2e7d32', blue: '#1e63c4', gray: '#9e9e9e', grey: '#9e9e9e',
    yellow: '#f9c80e', orange: '#ef6c00', brown: '#6d4c41', violet: '#7b1fa2', purple: '#7b1fa2', pink: '#ec5f9a',
    tan: '#d2b48c', natural: '#efe6d0', clear: '#e0e0e0', silver: '#bdbdbd', shield: '#9e9e9e', drain: '#9e9e9e'
};
var HD_ROW = 20, HD_HEAD = 34, HD_GAP = 14, HD_FONT = 'Helvetica, Arial, sans-serif';

function hdEsc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hdClip(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Wire appearance from its description ("22 AWG White/Pink (Shielded 2)"):
 * { color, stripe, width, label, shield }.
 */
function hdWireStyle(desc) {
    var d = String(desc || ''), lower = d.toLowerCase();
    var gauge = lower.match(/(\d+(?:\.\d+)?)\s*(awg|mm2|mm²|sq)/);
    var words = lower.replace(/\(.*?\)/g, ' ').replace(/(\d+(?:\.\d+)?)\s*(awg|mm2|mm²|sq)/, ' ').trim();
    var parts = words.split(/[\/\-]/).map(function (w) { return w.trim().split(/\s+/).pop(); }).filter(Boolean);
    var shieldOnly = /^shield|^drain/.test(lower);
    var color = shieldOnly ? HD_COLORS.shield : HD_COLORS[parts[0]] || '#888';
    var stripe = !shieldOnly && parts[1] && HD_COLORS[parts[1]] ? HD_COLORS[parts[1]] : null;
    var width = 2;
    if (gauge && gauge[2] === 'awg') width = Math.max(1.5, Math.min(7, 2 + (22 - parseFloat(gauge[1])) * 0.45));
    else if (gauge) width = Math.max(1.5, Math.min(7, 1.5 + parseFloat(gauge[1]) * 1.5));
    var label = gauge ? gauge[1] + (gauge[2] === 'awg' ? ' AWG' : ' mm²') : '';
    var names = parts.filter(function (p) { return HD_COLORS[p]; });
    if (names.length) label += (label ? ' ' : '') + names.map(function (n) { return n.charAt(0).toUpperCase() + n.slice(1); }).join('/');
    if (shieldOnly) label = 'Shield';
    return { color: color, stripe: stripe, width: width, label: label, shield: /shield/.test(lower) && !shieldOnly };
}

/** A wire between two points as a smooth horizontal S-curve, drawn with a dark edge so light colours show. */
function hdWirePath(x1, y1, x2, y2, style, title) {
    var mx = (x1 + x2) / 2, d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
    var out = '<g class="wire"><title>' + hdEsc(title) + '</title>' +
        '<path d="' + d + '" stroke="#3a3a3a" stroke-width="' + (style.width + 2) + '" fill="none"/>' +
        '<path d="' + d + '" stroke="' + style.color + '" stroke-width="' + style.width + '" fill="none"/>';
    if (style.stripe) {
        out += '<path d="' + d + '" stroke="' + style.stripe + '" stroke-width="' + Math.max(1, style.width / 2.5) +
            '" stroke-dasharray="7 7" fill="none"/>';
    }
    return out + '</g>';
}

function hdStyleBlock() {
    return '<style>' +
        'text{font-family:' + HD_FONT + ';font-size:11px;fill:#222}' +
        '.box{fill:#fff;stroke:#555;stroke-width:1}.head{fill:#e9eef4;stroke:#555;stroke-width:1}' +
        '.focus .head{fill:#fbe3e7}.splice .head{fill:#fff4d6}.missing .head{fill:#ffe0e0}.missing .box{stroke:#d32f2f;stroke-dasharray:4 3}' +
        '.title{font-weight:bold;font-size:12px}.sub{fill:#666;font-size:10px}.cav{font-weight:bold}.dim{fill:#888}' +
        '.row:hover rect{fill:#fff7d1}.row{cursor:pointer}.node{cursor:pointer}.node:hover .head{stroke:#E31837;stroke-width:2}' +
        '.count{font-size:10px;font-weight:bold}.countbg{fill:#fff;stroke:#777}' +
        '.edge path{stroke:#5b6b7b;stroke-opacity:.45;fill:none}' +
        '.dimmed .edge{opacity:.06}.dimmed .edge.hl{opacity:1}.dimmed .edge.hl path{stroke:#E31837;stroke-opacity:.85}' +
        '.dimmed .node{opacity:.3}.dimmed .node.hl{opacity:1}' +
        '</style>';
}

/** Box with a header and one line per row. rows: [{ cavity, text, extra, endpoint }]. Returns { svg, height, y(i) }. */
function hdBox(x, y, w, title, sub, rows, cls, nodeId) {
    var h = HD_HEAD + rows.length * HD_ROW + (rows.length ? 4 : 0);
    var out = '<g class="block ' + (cls || '') + '"' + (nodeId ? ' data-node="' + hdEsc(nodeId) + '"' : '') + '>' +
        '<rect class="box" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="4"/>' +
        '<g class="node"' + (nodeId ? ' data-node="' + hdEsc(nodeId) + '"' : '') + '><title>' + hdEsc(title + (sub ? ' — ' + sub : '')) + '</title>' +
        '<rect class="head" x="' + x + '" y="' + y + '" width="' + w + '" height="' + (HD_HEAD - 4) + '" rx="4"/>' +
        '<text class="title" x="' + (x + 8) + '" y="' + (y + 14) + '">' + hdEsc(hdClip(title, Math.floor(w / 7.5))) + '</text>' +
        '<text class="sub" x="' + (x + 8) + '" y="' + (y + 26) + '">' + hdEsc(hdClip(sub, Math.floor(w / 6))) + '</text></g>';
    rows.forEach(function (r, i) {
        var ry = y + HD_HEAD + i * HD_ROW;
        out += '<g class="row"' + (r.endpoint ? ' data-endpoint="' + hdEsc(r.endpoint) + '"' : '') + '>' +
            '<title>' + hdEsc((r.endpoint || '') + (r.text ? ' — ' + r.text : '') + (r.extra ? ' (' + r.extra + ')' : '')) + '</title>' +
            '<rect x="' + (x + 1) + '" y="' + ry + '" width="' + (w - 2) + '" height="' + HD_ROW + '" fill="' + (i % 2 ? '#f7f7f7' : '#fff') + '"/>' +
            '<text class="cav" x="' + (x + 8) + '" y="' + (ry + 14) + '">' + hdEsc(hdClip(r.cavity, 7)) + '</text>' +
            '<text x="' + (x + 52) + '" y="' + (ry + 14) + '">' + hdEsc(hdClip(r.text, Math.floor((w - (r.extra ? 175 : 60)) / 6.3))) + '</text>' +
            (r.extra ? '<text class="dim" x="' + (x + w - 8) + '" y="' + (ry + 14) + '" text-anchor="end">' + hdEsc(r.extra) + '</text>' : '') + '</g>';
    });
    return { svg: out + '</g>', height: h, y: function (i) { return y + HD_HEAD + i * HD_ROW + HD_ROW / 2; } };
}

function hdSvg(width, height, body) {
    return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + width + '" height="' + height +
        '" viewBox="0 0 ' + width + ' ' + height + '">' + hdStyleBlock() +
        '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="#fff"/>' + body + '</svg>';
}

function hdFind(model, id) {
    return model.connectors.filter(function (c) { return c.id === id; })[0] ||
        model.splices.filter(function (s) { return s.id === id; })[0] || null;
}

/** Rows of a block as wire ends: [{ cavity, text, wire, remote, endpoint, pin }]. */
function hdRows(block) {
    if (block.pins) {
        return block.pins.map(function (p) {
            return { cavity: p.cavity, text: p.function, wire: p.wire, remote: p.remote, endpoint: block.id + '.' + p.cavity, pin: p };
        });
    }
    return block.wires.map(function (w) {
        return { cavity: '•', text: w.end + (w.function ? ' — ' + w.function : ''), wire: w.wire, remote: w.end, endpoint: block.id };
    });
}

function harnessBlockDiagram(model, id, opts) {
    opts = opts || {};
    var focus = hdFind(model, id);
    if (!focus) return { svg: hdSvg(400, 60, '<text x="20" y="34">No connector or splice named ' + hdEsc(id) + '.</text>'), width: 400, height: 60 };
    var index = harnessIndex(model), isSplice = !focus.pins;
    var rows = hdRows(focus);
    var x0 = 20, w0 = 400, x1 = 560, w1 = 300, x2 = 1000, w2 = 300, body = '', wires = '';

    // Column 1: everything the focus rows reach, grouped per connector/splice in order of first use.
    var groups = [], byKey = {};
    function group(key, make) {
        if (!byKey[key]) { byKey[key] = make(); byKey[key].order = groups.length; groups.push(byKey[key]); }
        return byKey[key];
    }
    var links = [], stubs = [];   // links: { from: row index, group, entry }; stubs: Unterminated / Eyelet / Battery / Device rows
    rows.forEach(function (r, i) {
        var res = harnessResolve(index, r.remote);
        if (res.terminal) stubs.push({ from: i, wire: r.wire, end: res, title: r.endpoint + ' → ' + harnessText(r.remote) });
        if (res.kind === 'none') return;
        var g, entryKey, entry;
        if (res.kind === 'pin') {
            g = group('c:' + res.connector.id, function () { return { kind: 'connector', block: res.connector, entries: [], map: {} }; });
            entryKey = res.cavity;
            entry = g.map[entryKey] || (g.map[entryKey] = g.entries.push({ cavity: res.cavity,
                text: res.pin ? res.pin.function : '(no such cavity)', endpoint: res.connector.id + '.' + res.cavity }) - 1);
        } else if (res.kind === 'splice') {
            g = group('s:' + res.splice.id, function () { return { kind: 'splice', block: res.splice, entries: [], map: {} }; });
            entry = 0;
        } else {
            g = group('x:' + res.text, function () { return { kind: 'missing', text: res.text, entries: [], map: {} }; });
            entry = 0;
        }
        links.push({ from: i, group: g, entry: entry, wire: r.wire, title: r.endpoint + ' → ' + harnessText(r.remote) });
    });

    // Splices reached: their wire ends. A wire from the focus goes to the end that leads back to it; the other ends lead on
    // to column 2.
    var far = [];
    function backTo(res, row) {
        if (isSplice) return res.kind === 'splice' && res.splice === focus;
        return res.kind === 'pin' && res.connector === focus && res.pin === row.pin;   // "M142.A.26" matches cavity "26.0"
    }
    groups.forEach(function (g) {
        if (g.kind !== 'splice') return;
        g.ends = g.block.wires.map(function (w) {
            return { cavity: '•', text: w.end + (w.function ? ' — ' + w.function : ''), extra: hdWireStyle(w.wire).label, endpoint: g.block.id,
                     res: harnessResolve(index, w.end), raw: w };
        });
        g.used = {};
        g.ends.forEach(function (e, k) {
            var back = (e.res.kind === 'pin' && e.res.connector === focus) || (e.res.kind === 'splice' && e.res.splice === focus);
            if (!back && e.res.kind !== 'none') far.push({ group: g, end: k, res: e.res, wire: e.raw.wire, title: g.block.id + ' → ' + e.raw.end });
        });
    });
    links.forEach(function (l) {
        if (l.group.kind !== 'splice') return;
        var ends = l.group.ends, k;
        for (k = 0; k < ends.length; k++) if (!l.group.used[k] && backTo(ends[k].res, rows[l.from])) break;
        if (k < ends.length) { l.group.used[k] = true; l.entry = k; } else l.entry = null;   // no matching end: the header
    });

    // Column 2: far ends of the splices, grouped per block. A connector the focus also reaches directly is drawn only here,
    // with its direct wires running across to it.
    var farGroups = [], farBy = {};
    function farKey(res) { return res.kind === 'pin' ? 'c:' + res.connector.id : res.kind === 'splice' ? 's:' + res.splice.id : 'x:' + res.text; }
    function farEntry(g, res) {
        var ek = res.kind === 'pin' ? String(res.cavity).toLowerCase() : '';
        if (g.map[ek] === undefined) {
            g.map[ek] = g.entries.push(res.kind === 'pin'
                ? { cavity: res.cavity, text: res.pin ? res.pin.function : '(no such cavity)', endpoint: res.connector.id + '.' + res.cavity }
                : { cavity: '', text: '' }) - 1;
        }
        return g.map[ek];
    }
    far.forEach(function (f) {
        var key = farKey(f.res);
        var g = farBy[key] || (farBy[key] = farGroups[farGroups.push({ res: f.res, entries: [], map: {}, links: [], direct: [] }) - 1]);
        g.links.push({ from: f, entry: farEntry(g, f.res), wire: f.wire, title: f.title });
    });
    links.forEach(function (l) {
        var g = l.group.kind === 'connector' ? farBy['c:' + l.group.block.id] : null;
        if (!g) return;
        l.group.moved = true;
        var res = harnessResolve(index, rows[l.from].remote);
        g.direct.push({ from: l.from, entry: farEntry(g, res), wire: l.wire, title: l.title });
    });

    // Lay out column 1, then column 2.
    var y1 = 20, y2 = 20;
    groups.forEach(function (g) {
        if (g.moved) return;
        var box;
        if (g.kind === 'connector') box = hdBox(x1, y1, w1, g.block.id, g.block.connector || g.block.title, g.entries, '', g.block.id);
        else if (g.kind === 'splice') box = hdBox(x1, y1, w1, g.block.id, 'Splice' + (g.block.type ? ' · ' + g.block.type : ''), g.ends, 'splice', g.block.id);
        else box = hdBox(x1, y1, w1, g.text, 'Not in this harness', [], 'missing', null);
        box.top = y1;
        g.box = box;
        body += box.svg;
        y1 += box.height + HD_GAP;
    });
    var direct = [];
    farGroups.forEach(function (g) {
        var box, r = g.res;
        if (r.kind === 'pin') box = hdBox(x2, y2, w2, r.connector.id, r.connector.connector || r.connector.title, g.entries, '', r.connector.id);
        else if (r.kind === 'splice') box = hdBox(x2, y2, w2, r.splice.id, 'Splice', [], 'splice', r.splice.id);
        else box = hdBox(x2, y2, w2, r.text, 'Not in this harness', [], 'missing', null);
        var top = y2;
        g.links.forEach(function (l) {
            var ty = r.kind === 'pin' ? box.y(l.entry) : top + 15;
            wires += hdWirePath(x1 + w1, l.from.group.box.y(l.from.end), x2, ty, hdWireStyle(l.wire), l.title + ' · ' + (l.wire || ''));
        });
        g.direct.forEach(function (d) { direct.push({ from: d.from, y: box.y(d.entry), wire: d.wire, title: d.title }); });
        body += box.svg;
        y2 += box.height + HD_GAP;
    });

    // Focus block with a wire column, and its pictures underneath.
    var focusRows = rows.map(function (r) { return { cavity: r.cavity, text: r.text, extra: hdWireStyle(r.wire).label, endpoint: r.endpoint }; });
    var fbox = hdBox(x0, 20, w0, focus.id, isSplice ? 'Splice' + (focus.type ? ' · ' + focus.type : '')
        : [focus.connector, focus.title !== focus.id ? focus.title : ''].filter(Boolean).join(' · '), focusRows,
        'focus' + (isSplice ? ' splice' : ''), null);
    // Where each focus row's wire ends: column 1, or straight to column 2 (behind the column 1 boxes).
    var ends = [], dest = {};
    links.forEach(function (l) {
        var g = l.group;
        if (g.moved) return;
        var ty = g.kind === 'missing' || l.entry === null ? g.box.top + 15 : g.box.y(l.entry);   // nothing to match: the header
        ends.push(dest[l.from] = { from: l.from, x: x1, y: ty, wire: l.wire, title: l.title + ' · ' + (l.wire || '') });
    });
    direct.forEach(function (d) {
        ends.push(dest[d.from] = { from: d.from, x: x2, y: d.y, wire: d.wire, title: d.title + ' · ' + (d.wire || '') });
    });
    var cables = opts.cables && !isSplice ? hdCableMarks(rows, fbox, x0 + w0, opts.cables, dest) : { wires: '', marks: '', drawn: {} };
    ends.forEach(function (e) {
        if (!cables.drawn[e.from]) wires += hdWirePath(x0 + w0, fbox.y(e.from), e.x, e.y, hdWireStyle(e.wire), e.title);
    });
    wires += cables.wires;
    // Unterminated / Eyelet / Battery / Device: a short wire ending in a symbol (cap, ring terminal, battery cell, box), connected at this end only.
    stubs.forEach(function (s) {
        var y = fbox.y(s.from), xs = x0 + w0, xe = xs + 46, sym, xl;
        if (s.end.terminal === 'Eyelet') {
            sym = '<circle cx="' + (xe + 6) + '" cy="' + y + '" r="5.5" fill="#fff" stroke="#555" stroke-width="2.5"/>';
            xl = xe + 14;
        } else if (s.end.terminal === 'Battery') {
            sym = '<line x1="' + xe + '" y1="' + (y - 8) + '" x2="' + xe + '" y2="' + (y + 8) + '" stroke="#555" stroke-width="1.5"/>' +
                '<line x1="' + (xe + 5) + '" y1="' + (y - 4) + '" x2="' + (xe + 5) + '" y2="' + (y + 4) + '" stroke="#555" stroke-width="3"/>';
            xl = xe + 9;
        } else if (s.end.terminal === 'Device') {
            sym = '<rect x="' + xe + '" y="' + (y - 6) + '" width="12" height="12" rx="1.5" fill="#fff" stroke="#555" stroke-width="2"/>';
            xl = xe + 15;
        } else {
            sym = '<line x1="' + xe + '" y1="' + (y - 7) + '" x2="' + xe + '" y2="' + (y + 7) + '" stroke="#555" stroke-width="2.5"/>';
            xl = xe + 3;
        }
        wires += hdWirePath(xs, y, xe, y, hdWireStyle(s.wire), s.title + ' · ' + (s.wire || ''));
        // Symbol and label go over the other wires, which may cross here. A note stays in the tooltip.
        body += '<g class="terminal ' + s.end.terminal.toLowerCase() + '"><title>' + hdEsc(s.title) + '</title><rect x="' + xl + '" y="' + (y - 8) +
            '" width="' + (s.end.label.length * 6 + 12) + '" height="16" rx="3" fill="#fff" stroke="#bbb"/>' + sym +
            '<text class="dim" x="' + (xl + 5) + '" y="' + (y + 4) + '">' + hdEsc(s.end.label) + '</text></g>';
    });
    body += cables.marks;
    var yImg = 20 + fbox.height + 16, pics = '';
    (focus.images || []).forEach(function (im) {
        var url = opts.imageUrls && opts.imageUrls[im.id];
        if (!url) return;
        var w = Math.min(w0, im.w || w0), h = Math.round((im.h || w) * w / (im.w || w));
        pics += '<image x="' + x0 + '" y="' + yImg + '" width="' + w + '" height="' + h + '" href="' + hdEsc(url) + '" xlink:href="' + hdEsc(url) +
            '" preserveAspectRatio="xMidYMid meet"><title>' + hdEsc(im.caption || focus.id) + '</title></image>';
        yImg += h + 10;
    });

    var width = (farGroups.length ? x2 + w2 : groups.length ? x1 + w1 : x0 + w0 + (stubs.length ? 130 : 0)) + 20;
    var height = Math.max(yImg, y1, y2, 20 + fbox.height + 20);
    if (!groups.length && !stubs.length) body += '<text class="sub" x="' + x1 + '" y="40">No connections from ' + hdEsc(focus.id) + '.</text>';
    return { svg: hdSvg(width, height, wires + fbox.svg + body + pics), width: width, height: height };
}

var HD_ROPE_FAN = 36;   // px at each end where a cable's conductors fan out of the rope to their rows

/** Points along hdWirePath's horizontal S-curve, about every 2 px, with the distance along it: [[x, y, dist], …]. */
function hdCurvePoints(x1, y1, x2, y2) {
    var mx = (x1 + x2) / 2, steps = Math.max(4, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 2)), pts = [], dist = 0;
    for (var i = 0; i <= steps; i++) {
        var t = i / steps, u = 1 - t;
        var x = u * u * u * x1 + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * x2;
        var y = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;
        if (i) dist += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
        pts.push([x, y, dist]);
    }
    return pts;
}

/** The point d px to the side of pts[i] (positive = below on a path heading right). */
function hdSide(pts, i, d) {
    var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    return [pts[i][0] - dy / len * d, pts[i][1] + dx / len * d];
}

function hdPoly(p) { return p.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' '); }

/** One strand (or part of one) in its colour over a dark edge, with its stripe. */
function hdStrand(p, style, dash) {
    var pts = hdPoly(p);
    return '<polyline points="' + pts + '" stroke="#3a3a3a" stroke-width="' + (style.width + 2) + '" fill="none"/>' +
        '<polyline points="' + pts + '" stroke="' + style.color + '" stroke-width="' + style.width + '" fill="none"/>' +
        (style.stripe ? '<polyline points="' + pts + '" stroke="' + style.stripe + '" stroke-width="' + Math.max(1, style.width / 2.5) +
            '" stroke-dasharray="' + (dash || '7 7') + '" fill="none"/>' : '');
}

/**
 * A cable as a twisted rope from the focus box (x xs) to the blocks it reaches (x xt): its conductors leave their rows, twist
 * round each other (2 or 3 strands, over and under) along the run and fan out to their far rows; a shielded cable gets a grey
 * sheath with the drain wire running alongside it. conds/drains: [{ y0, y1, style, title }] (a drain's y1 may be null: it ends
 * elsewhere and is drawn on its own). Returns { wires, tagX, tagY }.
 */
function hdCableRope(conds, drains, shielded, xs, xt) {
    function mean(l, k) { return l.reduce(function (s, c) { return s + c[k]; }, 0) / l.length; }
    var pts = hdCurvePoints(xs + HD_ROPE_FAN, mean(conds, 'y0'), xt - HD_ROPE_FAN, mean(conds, 'y1'));
    var n = conds.length, len = pts[pts.length - 1][2], wmax = Math.max.apply(null, conds.map(function (c) { return c.style.width; }));
    var amp = n === 2 ? 3.4 : 2.4 + n * 0.8, period = len / Math.max(1, Math.round(len / (n === 2 ? 20 : 24)));
    // Whole twists, so each strand leaves the rope on the side it entered; the start phase keeps the strands apart there.
    var phase0 = Math.PI / 2 + Math.PI / (2 * n);
    function ang(k, i) { return 2 * Math.PI * pts[i][2] / period + phase0 + 2 * Math.PI * k / n; }
    // Strand k goes to the k-th row from the top, the strand starting highest to the top row.
    var order = conds.map(function (c, k) { return k; }).sort(function (a, b) { return Math.sin(ang(a, 0)) - Math.sin(ang(b, 0)); });
    var byY0 = conds.slice().sort(function (a, b) { return a.y0 - b.y0; }), strandOf = [];
    order.forEach(function (k, r) { strandOf[k] = byY0[r]; });
    var out = '', back = '', front = '', ends = '';
    var sheath = amp + wmax / 2 + 3;
    if (shielded) {
        out += '<polyline points="' + hdPoly(pts) + '" stroke="#e4e4e4" stroke-width="' + (2 * sheath) + '" fill="none"/>';
        [-sheath, sheath].forEach(function (d) {
            out += '<polyline points="' + hdPoly(pts.map(function (q, i) { return hdSide(pts, i, d); })) +
                '" stroke="#777" stroke-width="1.2" stroke-dasharray="4 3" fill="none"/>';
        });
    }
    // Each strand split where it passes behind / in front of the others; behind parts first.
    for (var k = 0; k < n; k++) {
        var c = strandOf[k], seg = [], depth = null;
        for (var i = 0; i < pts.length; i++) {
            var p = hdSide(pts, i, amp * Math.sin(ang(k, i))), d = Math.cos(ang(k, i)) >= 0;
            if (depth !== null && d !== depth) {
                seg.push(p);
                if (depth) front += hdStrand(seg, c.style, '4 4'); else back += hdStrand(seg, c.style, '4 4');
                seg = [];
            }
            depth = d;
            seg.push(p);
        }
        if (depth) front += hdStrand(seg, c.style, '4 4'); else back += hdStrand(seg, c.style, '4 4');
        var s = hdSide(pts, 0, amp * Math.sin(ang(k, 0))), e = hdSide(pts, pts.length - 1, amp * Math.sin(ang(k, pts.length - 1)));
        ends += hdWirePath(xs, c.y0, s[0], s[1], c.style, c.title) + hdWirePath(e[0], e[1], xt, c.y1, c.style, c.title);
    }
    // Drain wires alongside, on the side of their rows.
    drains.forEach(function (w, j) {
        var below = w.y0 >= mean(conds, 'y0'), off = (below ? 1 : -1) * (sheath + 2.5 + w.style.width / 2 + j * (w.style.width + 3));
        var along = pts.map(function (q, i) { return hdSide(pts, i, off); }), a = along[0], z = along[along.length - 1];
        ends += '<g class="wire"><title>' + hdEsc(w.title) + '</title>' + hdStrand(along, w.style) + '</g>' +
            hdWirePath(xs, w.y0, a[0], a[1], w.style, w.title) + hdWirePath(z[0], z[1], xt, w.y1, w.style, w.title);
    });
    var top = Math.min.apply(null, [pts[0][1]].concat(drains.map(function (w) { return w.y0 < pts[0][1] ? pts[0][1] - sheath - 6 : pts[0][1]; })));
    return { wires: out + back + front + ends, tagX: xs + HD_ROPE_FAN + 6, tagY: top - sheath - 4 };
}

/**
 * The cables whose wires leave the focus rows (one per run of neighbouring rows). dest[i] = { x, y, wire, title } is where row i's
 * wire ends. A run whose conductors all end at the same x is drawn as a rope (hdCableRope) and its rows marked in drawn; any
 * other run gets a short twist where it leaves the box. Every run gets a shield oval / tick and a tag (STP, UTP, 3C S…).
 * Returns { wires (behind the boxes), marks (over them), drawn }.
 */
function hdCableMarks(rows, fbox, xs, byEndpoint, dest) {
    var wires = '', out = '', drawn = {}, byCable = [], seen = [];
    dest = dest || {};
    rows.forEach(function (r, i) {
        var c = byEndpoint[r.endpoint];
        if (!c) return;
        var k = seen.indexOf(c);
        if (k < 0) { k = seen.push(c) - 1; byCable.push([]); }
        byCable[k].push(i);
    });
    seen.forEach(function (c, k) {
        var shieldRows = {}, runs = [], run = null;
        c.shields.forEach(function (w) { [w.from, w.to].forEach(function (e) { shieldRows[e.label] = true; }); });
        byCable[k].forEach(function (i) {
            if (run && i === run[run.length - 1] + 1) run.push(i); else runs.push(run = [i]);
        });
        var type = c.type, tag = type ? type.short : 'Cable', shielded = type ? type.shielded : c.shields.length > 0;
        var title = c.name + ' · ' + (type ? type.label : 'cable') + (c.pn ? ' · ' + c.pn : '') +
            (c.problems.length ? ' — ' + c.problems.map(function (p) { return p.message; }).join(' ') : '');
        runs.forEach(function (run) {
            var cond = run.filter(function (i) { return !shieldRows[rows[i].endpoint]; }), shield = run.filter(function (i) { return shieldRows[rows[i].endpoint]; });
            var span = cond.length ? cond : run, top = fbox.y(span[0]), bottom = fbox.y(span[span.length - 1]), cx = xs + 30, cy = (top + bottom) / 2;
            var xt = cond.length && dest[cond[0]] ? dest[cond[0]].x : null;
            var rope = cond.length >= 2 && cond.length <= 4 && cond.every(function (i) { return dest[i] && dest[i].x === xt; });
            var tx = xs + 50, ty = top - 4;
            if (rope) {
                var end = function (i) { return { y0: fbox.y(i), y1: dest[i] && dest[i].x === xt ? dest[i].y : null, style: hdWireStyle(rows[i].wire), title: dest[i] ? dest[i].title : rows[i].endpoint }; };
                var drains = shield.filter(function (i) { return dest[i] && dest[i].x === xt; });
                var r = hdCableRope(cond.map(end), drains.map(end), shielded, xs, xt);
                wires += '<g class="cable rope"><title>' + hdEsc(title) + '</title>' + r.wires + '</g>';
                cond.concat(drains).forEach(function (i) { drawn[i] = true; });
                shield = shield.filter(function (i) { return drains.indexOf(i) < 0; });
                tx = r.tagX; ty = r.tagY;
                cx = xs + HD_ROPE_FAN; top = bottom = cy = (top + bottom) / 2;
            }
            out += '<g class="cable"><title>' + hdEsc(title) + '</title>';
            // The twist: neighbouring conductors cross over and back, each in its own colour over a dark edge, ending on its own row.
            for (var j = 0; !rope && j + 1 < cond.length; j++) {
                var y1 = fbox.y(cond[j]), y2 = fbox.y(cond[j + 1]), a = hdWireStyle(rows[cond[j]].wire), b = hdWireStyle(rows[cond[j + 1]].wire);
                out += '<rect x="' + (xs + 17) + '" y="' + (y1 - 4) + '" width="26" height="' + (y2 - y1 + 8) + '" fill="#fff"/>';
                [[y2, y1, b], [y1, y2, a]].forEach(function (l) {
                    var d = 'M' + (xs + 16) + ',' + l[0] + ' C' + (xs + 23) + ',' + l[0] + ' ' + (xs + 23) + ',' + l[1] + ' ' + (xs + 30) + ',' + l[1] +
                        ' C' + (xs + 37) + ',' + l[1] + ' ' + (xs + 37) + ',' + l[0] + ' ' + (xs + 44) + ',' + l[0];
                    out += '<path d="' + d + '" stroke="#3a3a3a" stroke-width="' + (l[2].width + 2) + '" fill="none"/>' +
                        '<path d="' + d + '" stroke="' + l[2].color + '" stroke-width="' + l[2].width + '" fill="none"/>' +
                        (l[2].stripe ? '<path d="' + d + '" stroke="' + l[2].stripe + '" stroke-width="' + Math.max(1, l[2].width / 2.5) +
                            '" stroke-dasharray="4 4" fill="none"/>' : '');
                });
            }
            if (shielded) {
                var ry = rope ? 0 : (bottom - top) / 2 + 9;
                if (!rope) out += '<ellipse cx="' + cx + '" cy="' + cy + '" rx="17" ry="' + ry + '" fill="none" stroke="#666" stroke-width="1.4" stroke-dasharray="4 3"/>';
                // A shield / drain row not drawn along the rope (it ends elsewhere): a tick from the shield to it.
                shield.forEach(function (i) {
                    var ys = fbox.y(i), edge = rope ? cy + (ys > cy ? 8 : -8) : ys > cy ? bottom + 9 : top - 9;
                    out += '<line x1="' + cx + '" y1="' + edge + '" x2="' + cx + '" y2="' + ys + '" stroke="#666" stroke-width="1.4"/>' +
                        '<circle cx="' + cx + '" cy="' + ys + '" r="2.2" fill="#666"/>';
                });
            }
            out += '<rect x="' + (tx - 2) + '" y="' + (ty - 9) + '" width="' + (tag.length * 6 + 4) + '" height="11" rx="2" fill="#fff" stroke="#bbb"/>' +
                '<text class="dim" x="' + tx + '" y="' + ty + '" style="font-size:9px">' + hdEsc(tag) + '</text></g>';
        });
    });
    return { wires: wires, marks: out, drawn: drawn };
}

function harnessOverviewDiagram(model, opts) {
    opts = opts || {};
    var index = harnessIndex(model), ecu = new RegExp('^' + (opts.hardware ? opts.hardware.replace(/\W/g, '\\$&') : 'M1\\d\\d') + '\\.', 'i');
    var nodes = {}, order = [];
    function node(id, kind) {
        if (!nodes[id]) { nodes[id] = { id: id, kind: kind, edges: {}, wires: 0 }; order.push(id); }
        return nodes[id];
    }
    model.connectors.forEach(function (c) { node(c.id, ecu.test(c.id) ? 'ecu' : 'connector'); });
    model.splices.forEach(function (s) { node(s.id, 'splice'); });

    // Count each wire once: key it by its two ends.
    var seen = {};
    function link(aBlock, aEnd, res) {
        var bBlock, bEnd;
        if (res.kind === 'pin') { bBlock = res.connector.id; bEnd = res.connector.id + '.' + res.cavity; }
        else if (res.kind === 'splice') { bBlock = res.splice.id; bEnd = res.splice.id; }
        else return;
        if (bBlock === aBlock) return;
        var key = [aEnd, bEnd].sort().join('|');
        if (seen[key]) return;
        seen[key] = true;
        var a = nodes[aBlock], b = nodes[bBlock];
        a.edges[bBlock] = (a.edges[bBlock] || 0) + 1;
        b.edges[aBlock] = (b.edges[aBlock] || 0) + 1;
        a.wires++; b.wires++;
    }
    model.connectors.forEach(function (c) {
        c.pins.forEach(function (p) { link(c.id, c.id + '.' + p.cavity, harnessResolve(index, p.remote)); });
    });
    // A splice's end of a wire is the splice itself, so a wire listed both on a pin (remote = splice) and in
    // the splice's list (end = pin) gets the same key and is counted once.
    model.splices.forEach(function (s) {
        s.wires.forEach(function (w) { link(s.id, s.id, harnessResolve(index, w.end)); });
    });

    var cols = [[], [], []];
    order.forEach(function (id) {
        var n = nodes[id];
        cols[n.kind === 'ecu' ? 0 : n.kind === 'splice' ? 1 : 2].push(n);
    });
    if (!cols[0].length && cols[2].length) {   // no ECU connectors: put the busiest connector on the left
        cols[2].sort(function (a, b) { return b.wires - a.wires; });
        cols[0].push(cols[2].shift());
    }
    var BOX_H = 34, GAP = 10, COL_X = [20, 330, 640], BOX_W = 210, colOf = {};
    cols.forEach(function (col, c) { col.forEach(function (n) { colOf[n.id] = c; }); });
    function place() {
        cols.forEach(function (col) { col.forEach(function (n, i) { n.y = 20 + i * (BOX_H + GAP); }); });
    }
    place();
    // Order the middle and right columns by the weighted average position of their neighbours in other
    // columns (a few sweeps), which keeps most bundles short and uncrossed.
    for (var pass = 0; pass < 3; pass++) {
        [1, 2].forEach(function (c) {
            cols[c].forEach(function (n) {
                var sum = 0, cnt = 0;
                Object.keys(n.edges).forEach(function (o) {
                    if (colOf[o] === c) return;
                    sum += nodes[o].y * n.edges[o]; cnt += n.edges[o];
                });
                n.bary = cnt ? sum / cnt : n.y;
            });
            cols[c].sort(function (a, b) { return a.bary - b.bary; });
            place();
        });
    }

    var edges = '', boxes = '', drawn = {};
    order.forEach(function (id) {
        var a = nodes[id];
        Object.keys(a.edges).forEach(function (o) {
            var key = [id, o].sort().join('|');
            if (drawn[key]) return;
            drawn[key] = true;
            var b = nodes[o], ca = colOf[id], cb = colOf[o], count = a.edges[o];
            var left = ca <= cb ? a : b, right = ca <= cb ? b : a, cl = colOf[left.id], cr = colOf[right.id];
            var x1 = COL_X[cl] + BOX_W, y1 = left.y + BOX_H / 2, x2 = COL_X[cr], y2 = right.y + BOX_H / 2, d;
            if (cl === cr) {   // same column: loop out to the right
                x2 = x1; var bulge = x1 + 40 + Math.min(80, Math.abs(y2 - y1) / 6);
                d = 'M' + x1 + ',' + y1 + ' C' + bulge + ',' + y1 + ' ' + bulge + ',' + y2 + ' ' + x2 + ',' + y2;
            } else {
                var mx = (x1 + x2) / 2;
                d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
            }
            var w = Math.min(7, 1 + Math.log(count + 1) * 1.4);
            // Count label 85% of the way along the bundle, next to the box it arrives at.
            var p = d.match(/-?[\d.]+/g).map(Number), t = cl === cr ? 0.5 : 0.85, u = 1 - t;
            var tx = u * u * u * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t * t * t * p[6];
            var ty = u * u * u * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t * t * t * p[7];
            edges += '<g class="edge" data-a="' + hdEsc(left.id) + '" data-b="' + hdEsc(right.id) + '"><title>' +
                hdEsc(left.id + ' ↔ ' + right.id + ': ' + count + ' wire' + (count === 1 ? '' : 's')) + '</title>' +
                '<path d="' + d + '" stroke-width="' + w + '"/>' +
                '<circle class="countbg" cx="' + tx + '" cy="' + ty + '" r="9"/>' +
                '<text class="count" x="' + tx + '" y="' + (ty + 3.5) + '" text-anchor="middle">' + count + '</text></g>';
        });
    });
    order.forEach(function (id) {
        var n = nodes[id], x = COL_X[colOf[id]], block = hdFind(model, id);
        var sub = n.kind === 'splice' ? 'Splice' : (block.connector || '');
        boxes += '<g class="node block ' + (n.kind === 'splice' ? 'splice' : n.kind === 'ecu' ? 'focus' : '') + '" data-node="' + hdEsc(id) + '">' +
            '<title>' + hdEsc(id + (sub ? ' — ' + sub : '') + ': ' + n.wires + ' wire' + (n.wires === 1 ? '' : 's')) + '</title>' +
            '<rect class="head" x="' + x + '" y="' + n.y + '" width="' + BOX_W + '" height="' + BOX_H + '" rx="4"/>' +
            '<text class="title" x="' + (x + 8) + '" y="' + (n.y + 15) + '">' + hdEsc(hdClip(id, 26)) + '</text>' +
            '<text class="sub" x="' + (x + 8) + '" y="' + (n.y + 28) + '">' + hdEsc(hdClip(sub, 24)) + '</text>' +
            '<text class="sub" x="' + (x + BOX_W - 8) + '" y="' + (n.y + 15) + '" text-anchor="end">' + n.wires + '</text></g>';
    });
    var rowsMax = Math.max(cols[0].length, cols[1].length, cols[2].length);
    var width = COL_X[2] + BOX_W + 140, height = 20 + rowsMax * (BOX_H + GAP) + 20;
    var heads = ['ECU', 'Splices', 'Connectors'].map(function (t, c) {
        return cols[c].length ? '<text class="sub" x="' + COL_X[c] + '" y="12">' + t.toUpperCase() + '</text>' : '';
    }).join('');
    return { svg: hdSvg(width, height, heads + edges + boxes), width: width, height: height };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { harnessBlockDiagram: harnessBlockDiagram, harnessOverviewDiagram: harnessOverviewDiagram, hdWireStyle: hdWireStyle };
}
