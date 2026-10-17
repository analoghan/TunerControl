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

/** Rows of a block as wire ends: [{ cavity, text, wire, remote, endpoint }]. */
function hdRows(block) {
    if (block.pins) {
        return block.pins.map(function (p) {
            return { cavity: p.cavity, text: p.function, wire: p.wire, remote: p.remote, endpoint: block.id + '.' + p.cavity };
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
    var links = [], stubs = [];   // links: { from: row index, group, entry }; stubs: Unterminated / Eyelet / Battery rows
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

    // Lay out column 1 and, for splices reached, column 2 with their other ends.
    var y1 = 20, y2 = 20, far = [];
    groups.forEach(function (g) {
        var box;
        if (g.kind === 'connector') {
            box = hdBox(x1, y1, w1, g.block.id, g.block.connector || g.block.title, g.entries, '', g.block.id);
        } else if (g.kind === 'splice') {
            // Splice rows: its wire ends. Ends that lead back to the focus block are drawn from the focus side.
            var ends = g.block.wires.map(function (w) {
                return { cavity: '•', text: w.end + (w.function ? ' — ' + w.function : ''), extra: hdWireStyle(w.wire).label,
                         endpoint: g.block.id, raw: w };
            });
            box = hdBox(x1, y1, w1, g.block.id, 'Splice' + (g.block.type ? ' · ' + g.block.type : ''), ends, 'splice', g.block.id);
            ends.forEach(function (e, k) {
                var res = harnessResolve(index, e.raw.end);
                var back = (res.kind === 'pin' && res.connector === focus) || (res.kind === 'splice' && res.splice === focus);
                if (!back && res.kind !== 'none') far.push({ fromY: box.y(k), res: res, wire: e.raw.wire, title: g.block.id + ' → ' + e.raw.end });
            });
        } else {
            box = hdBox(x1, y1, w1, g.text, 'Not in this harness', [], 'missing', null);
        }
        box.top = y1;
        g.box = box;
        body += box.svg;
        y1 += box.height + HD_GAP;
    });

    // Column 2: far ends of the splices, grouped per block.
    var farGroups = [], farBy = {};
    far.forEach(function (f) {
        var key, g;
        if (f.res.kind === 'pin') key = 'c:' + f.res.connector.id;
        else if (f.res.kind === 'splice') key = 's:' + f.res.splice.id;
        else key = 'x:' + f.res.text;
        g = farBy[key] || (farBy[key] = farGroups[farGroups.push({ res: f.res, entries: [], map: {}, links: [] }) - 1]);
        var ek = f.res.kind === 'pin' ? f.res.cavity : '';
        if (g.map[ek] === undefined) {
            g.map[ek] = g.entries.push(f.res.kind === 'pin'
                ? { cavity: f.res.cavity, text: f.res.pin ? f.res.pin.function : '(no such cavity)', endpoint: f.res.connector.id + '.' + f.res.cavity }
                : { cavity: '', text: '' }) - 1;
        }
        g.links.push({ fromY: f.fromY, entry: g.map[ek], wire: f.wire, title: f.title });
    });
    farGroups.forEach(function (g) {
        var box, r = g.res;
        if (r.kind === 'pin') box = hdBox(x2, y2, w2, r.connector.id, r.connector.connector || r.connector.title, g.entries, '', r.connector.id);
        else if (r.kind === 'splice') box = hdBox(x2, y2, w2, r.splice.id, 'Splice', [], 'splice', r.splice.id);
        else box = hdBox(x2, y2, w2, r.text, 'Not in this harness', [], 'missing', null);
        var top = y2;
        g.links.forEach(function (l) {
            var ty = r.kind === 'pin' ? box.y(l.entry) : top + 15;
            wires += hdWirePath(x1 + w1, l.fromY, x2, ty, hdWireStyle(l.wire), l.title + ' · ' + (l.wire || ''));
        });
        body += box.svg;
        y2 += box.height + HD_GAP;
    });

    // Focus block with a wire column, and its pictures underneath.
    var focusRows = rows.map(function (r) { return { cavity: r.cavity, text: r.text, extra: hdWireStyle(r.wire).label, endpoint: r.endpoint }; });
    var fbox = hdBox(x0, 20, w0, focus.id, isSplice ? 'Splice' + (focus.type ? ' · ' + focus.type : '')
        : [focus.connector, focus.title !== focus.id ? focus.title : ''].filter(Boolean).join(' · '), focusRows,
        'focus' + (isSplice ? ' splice' : ''), null);
    links.forEach(function (l) {
        var g = l.group, ty = g.kind === 'connector' ? g.box.y(l.entry) : g.box.top + 15;   // splices/missing: header
        wires += hdWirePath(x0 + w0, fbox.y(l.from), x1, ty, hdWireStyle(l.wire), l.title + ' · ' + (l.wire || ''));
    });
    // Unterminated / Eyelet / Battery: a short wire ending in a symbol (cap, ring terminal, battery cell), connected at this end only.
    stubs.forEach(function (s) {
        var y = fbox.y(s.from), xs = x0 + w0, xe = xs + 46, sym, xl;
        if (s.end.terminal === 'Eyelet') {
            sym = '<circle cx="' + (xe + 6) + '" cy="' + y + '" r="5.5" fill="#fff" stroke="#555" stroke-width="2.5"/>';
            xl = xe + 14;
        } else if (s.end.terminal === 'Battery') {
            sym = '<line x1="' + xe + '" y1="' + (y - 8) + '" x2="' + xe + '" y2="' + (y + 8) + '" stroke="#555" stroke-width="1.5"/>' +
                '<line x1="' + (xe + 5) + '" y1="' + (y - 4) + '" x2="' + (xe + 5) + '" y2="' + (y + 4) + '" stroke="#555" stroke-width="3"/>';
            xl = xe + 9;
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
