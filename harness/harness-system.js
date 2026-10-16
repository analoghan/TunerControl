/**
 * harness/harness-system.js — Harness systems: several harnesses joined by mating connectors.
 *
 * members:  [{ id, name, model }]                      harnesses in the system (latest revisions)
 * settings: { manual: [link], rejected: [link] }        user overrides, link = { a: end, b: end },
 *                                                       end = { harness: id, connector: id }
 * Two connectors in different harnesses mate automatically when they have the same name and their part
 * numbers mate (one's CONNECTOR is the other's MATE CONN). Mated connectors join cavity to cavity.
 *
 * Endpoints across the system are keyed "harnessId|ENDPOINT" (ENDPOINT = "CONN.CAVITY", a splice id, or
 * "?text" for a reference to something outside the harness).
 */

function hsysNorm(part) {
    return String(part || '').toUpperCase().replace(/\s+/g, '');
}

/** 'mate' (part numbers mate), 'unknown' (not enough part information) or 'conflict'. */
function hsysPartsMate(a, b) {
    var ac = hsysNorm(a.connector), am = hsysNorm(a.mateConn), bc = hsysNorm(b.connector), bm = hsysNorm(b.mateConn);
    if ((ac && ac === bm) || (bc && bc === am)) return 'mate';
    var known = function (v) { return v && v !== 'N/A' && v !== 'NA'; };
    if ((known(ac) && known(bm)) || (known(bc) && known(am))) return 'conflict';
    return 'unknown';
}

function hsysLinkKey(link) {
    var a = link.a.harness + '|' + link.a.connector, b = link.b.harness + '|' + link.b.connector;
    return a < b ? a + '||' + b : b + '||' + a;
}

/**
 * Mated connector pairs: automatic matches plus manual links, minus rejected ones.
 * Returns { mates: [{ a, b, source: 'auto' | 'manual', parts }], suggestions: [...] } where suggestions are
 * same-name pairs that were rejected or whose parts don't mate (shown so the user can link them).
 */
function harnessMates(members, settings) {
    settings = settings || {};
    var rejected = {}, mates = [], suggestions = [], seen = {};
    (settings.rejected || []).forEach(function (l) { rejected[hsysLinkKey(l)] = true; });
    function find(end) {
        var m = members.filter(function (x) { return x.id === end.harness; })[0];
        var c = m ? m.model.connectors.filter(function (k) { return k.id === end.connector; })[0] : null;
        return c ? { member: m, connector: c } : null;
    }
    for (var i = 0; i < members.length; i++) {
        for (var j = i + 1; j < members.length; j++) {
            members[i].model.connectors.forEach(function (ca) {
                members[j].model.connectors.forEach(function (cb) {
                    if (ca.id.toLowerCase() !== cb.id.toLowerCase()) return;
                    var link = { a: { harness: members[i].id, connector: ca.id }, b: { harness: members[j].id, connector: cb.id } };
                    var parts = hsysPartsMate(ca, cb), key = hsysLinkKey(link);
                    if (parts !== 'conflict' && !rejected[key]) { mates.push(Object.assign(link, { source: 'auto', parts: parts })); seen[key] = true; }
                    else suggestions.push(Object.assign(link, { source: rejected[key] ? 'rejected' : 'auto', parts: parts }));
                });
            });
        }
    }
    (settings.manual || []).forEach(function (l) {
        var key = hsysLinkKey(l), a = find(l.a), b = find(l.b);
        if (seen[key] || !a || !b) return;
        seen[key] = true;
        mates.push({ a: l.a, b: l.b, source: 'manual', parts: hsysPartsMate(a.connector, b.connector) });
        suggestions = suggestions.filter(function (s) { return hsysLinkKey(s) !== key; });
    });
    return { mates: mates, suggestions: suggestions };
}

function hsysMember(members, id) {
    return members.filter(function (m) { return m.id === id; })[0] || null;
}

function hsysConnector(members, end) {
    var m = hsysMember(members, end.harness);
    return m ? m.model.connectors.filter(function (c) { return c.id === end.connector; })[0] || null : null;
}

/** Words that describe the kind of signal rather than what it is, ignored when comparing functions. */
var HSYS_GENERIC = ['signal', 'from', 'to', 'the', 'and', 'ecu', 'input', 'output', 'wire', 'shield', 'm142', 'e888'];

function hsysSameFunction(a, b) {
    function words(t) {
        return String(t || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
            .filter(function (w) { return w.length > 1 && HSYS_GENERIC.indexOf(w) < 0; });
    }
    var wa = words(a), wb = words(b);
    if (!wa.length || !wb.length) return true;
    return wa.some(function (w) { return wb.indexOf(w) >= 0; });
}

/**
 * Checks across mated connectors. Returns [{ severity, harness, where, message, other }] where `where` is the
 * endpoint in `harness` and `other` = { harness, where } is the matching end on the other side.
 */
function harnessSystemChecks(members, mates) {
    var issues = [];
    mates.forEach(function (link) {
        var ma = hsysMember(members, link.a.harness), mb = hsysMember(members, link.b.harness);
        var ca = hsysConnector(members, link.a), cb = hsysConnector(members, link.b);
        if (!ca || !cb) return;
        var nameA = ma.name + ' ' + ca.id, nameB = mb.name + ' ' + cb.id;
        if (link.parts === 'conflict') {
            issues.push({ severity: 'error', harness: ma.id, where: ca.id, other: { harness: mb.id, where: cb.id },
                message: 'Linked to ' + nameB + ', but the part numbers don\'t mate (' + (ca.connector || '?') + ' / mate ' +
                    (ca.mateConn || '?') + ' vs ' + (cb.connector || '?') + ' / mate ' + (cb.mateConn || '?') + ').' });
        }
        var pa = {}, pb = {};
        ca.pins.forEach(function (p) { pa[p.cavity] = p; });
        cb.pins.forEach(function (p) { pb[p.cavity] = p; });
        Object.keys(pa).concat(Object.keys(pb).filter(function (k) { return !pa[k]; })).forEach(function (cav) {
            var x = pa[cav], y = pb[cav], wx = x && harnessHasWire(x), wy = y && harnessHasWire(y);
            var here = { harness: ma.id, where: ca.id + '.' + cav, other: { harness: mb.id, where: cb.id + '.' + cav } };
            if (!x || !y) {
                if ((x && wx) || (y && wy)) {
                    issues.push(Object.assign(here, { severity: 'warning', message: 'Cavity ' + cav + ' is only defined on the ' +
                        (x ? nameA : nameB) + ' side of the ' + ca.id + ' join.' }));
                }
                return;
            }
            if (wx !== wy) {
                issues.push(Object.assign(here, { severity: 'warning', message: 'Cavity ' + cav + ' has a wire on the ' +
                    (wx ? nameA : nameB) + ' side but none on the ' + (wx ? nameB : nameA) + ' side.' }));
            } else if (wx && wy && !hsysSameFunction(x.function, y.function)) {
                issues.push(Object.assign(here, { severity: 'warning', message: 'Cavity ' + cav + ' is "' + x.function + '" in ' + ma.name +
                    ' but "' + y.function + '" in ' + mb.name + '.' }));
            }
        });
    });
    return issues;
}

/**
 * Connection graph of the whole system: nodes keyed "harnessId|ENDPOINT", edges for every wire inside a
 * harness and every mated cavity pair. Returns { nodes: { key: node }, adj: { key: [edge] } }.
 */
function harnessSystemGraph(members, mates) {
    var nodes = {}, adj = {}, seen = {};
    function node(m, endpoint, kind, extra) {
        var key = m.id + '|' + endpoint;
        if (!nodes[key]) nodes[key] = Object.assign({ key: key, harness: m.id, harnessName: m.name, endpoint: endpoint, kind: kind }, extra || {});
        return key;
    }
    function edge(a, b, kind, wire) {
        var k = a < b ? a + '>' + b : b + '>' + a;
        if (a === b || seen[k]) return;
        seen[k] = true;
        (adj[a] = adj[a] || []).push({ to: b, kind: kind, wire: wire || '' });
        (adj[b] = adj[b] || []).push({ to: a, kind: kind, wire: wire || '' });
    }
    function target(m, index, text) {
        var r = harnessResolve(index, text);
        if (r.kind === 'pin') {
            return node(m, r.connector.id + '.' + r.cavity, 'pin', { block: r.connector.id, cavity: r.cavity,
                function: r.pin ? r.pin.function : '', missing: !r.pin });
        }
        if (r.kind === 'splice') return node(m, r.splice.id, 'splice', { block: r.splice.id, function: r.splice.notes || '' });
        if (r.kind === 'none') return null;
        return node(m, '?' + r.text, 'external', { function: r.kind === 'unknown' ? 'Not in this harness' : 'Outside this harness' });
    }
    members.forEach(function (m) {
        var index = harnessIndex(m.model);
        m.model.connectors.forEach(function (c) {
            c.pins.forEach(function (p) {
                var a = node(m, c.id + '.' + p.cavity, 'pin', { block: c.id, cavity: p.cavity, function: p.function, wire: p.wire });
                var b = target(m, index, p.remote);
                if (b) edge(a, b, 'wire', p.wire);
            });
        });
        m.model.splices.forEach(function (s) {
            var a = node(m, s.id, 'splice', { block: s.id, function: s.notes || '' });
            s.wires.forEach(function (w) {
                var b = target(m, index, w.end);
                if (b) edge(a, b, 'wire', w.wire);
            });
        });
    });
    mates.forEach(function (link) {
        var ma = hsysMember(members, link.a.harness), mb = hsysMember(members, link.b.harness);
        var ca = hsysConnector(members, link.a), cb = hsysConnector(members, link.b);
        if (!ca || !cb) return;
        var cavs = {};
        cb.pins.forEach(function (p) { cavs[p.cavity] = true; });
        ca.pins.forEach(function (p) {
            if (!cavs[p.cavity]) return;
            edge(ma.id + '|' + ca.id + '.' + p.cavity, mb.id + '|' + cb.id + '.' + p.cavity, 'mate', '');
        });
    });
    return { nodes: nodes, adj: adj };
}

/**
 * Everything connected to one endpoint (a circuit), breadth first.
 * Returns { nodes: [node + { depth }], edges: [{ from, to, kind, wire }] } or null if the endpoint is unknown.
 */
function harnessTrace(graph, startKey) {
    if (!graph.nodes[startKey]) return null;
    var depth = {}, order = [startKey], edges = [], seen = {};
    depth[startKey] = 0;
    for (var i = 0; i < order.length; i++) {
        var k = order[i];
        (graph.adj[k] || []).forEach(function (e) {
            var ek = k < e.to ? k + '>' + e.to : e.to + '>' + k;
            if (!seen[ek]) { seen[ek] = true; edges.push({ from: k, to: e.to, kind: e.kind, wire: e.wire }); }
            if (depth[e.to] === undefined) { depth[e.to] = depth[k] + 1; order.push(e.to); }
        });
    }
    return {
        nodes: order.map(function (key) { return Object.assign({}, graph.nodes[key], { depth: depth[key] }); }),
        edges: edges
    };
}

/** Circuit diagram: endpoints in columns by distance from the start, wires in colour, mated joins as ⇄. */
function harnessTraceDiagram(trace) {
    var COL_W = 300, BOX_W = 200, BOX_H = 48, GAP = 12, cols = [], pos = {};
    trace.nodes.forEach(function (n) { (cols[n.depth] = cols[n.depth] || []).push(n); });
    cols.forEach(function (col, c) {
        col.forEach(function (n, r) { pos[n.key] = { x: 20 + c * COL_W, y: 30 + r * (BOX_H + GAP) }; });
    });
    var harnessNames = {}, colorIdx = 0, palette = ['#e9eef4', '#e6f4ea', '#fdf0e2', '#efe7f7', '#e3f2f8'], fills = {};
    trace.nodes.forEach(function (n) { if (!fills[n.harness]) { fills[n.harness] = palette[colorIdx++ % palette.length]; harnessNames[n.harness] = n.harnessName; } });
    var wires = '', boxes = '';
    trace.edges.forEach(function (e) {
        var a = pos[e.from], b = pos[e.to];
        if (!a || !b) return;
        if (a.x > b.x) { var t = a; a = b; b = t; }
        var x1 = a.x + BOX_W, y1 = a.y + BOX_H / 2, x2 = b.x, y2 = b.y + BOX_H / 2;
        if (a.x === b.x) { x2 = x1; }
        if (e.kind === 'mate') {
            var d = 'M' + x1 + ',' + y1 + ' C' + ((x1 + x2) / 2) + ',' + y1 + ' ' + ((x1 + x2) / 2) + ',' + y2 + ' ' + x2 + ',' + y2;
            wires += '<g class="wire"><title>Mated connector</title><path d="' + d + '" stroke="#555" stroke-width="6" fill="none"/>' +
                '<path d="' + d + '" stroke="#fff" stroke-width="3" fill="none"/>' +
                '<text x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 6) + '" text-anchor="middle" class="sub">⇄ mated</text></g>';
        } else {
            var st = hdWireStyle(e.wire);
            wires += hdWirePath(x1, y1, x2, y2, st, (e.wire || 'wire') + ': ' + e.from.split('|')[1] + ' → ' + e.to.split('|')[1]);
            if (st.label) {
                wires += '<text class="dim" x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 5) + '" text-anchor="middle" font-size="9">' + hdEsc(st.label) + '</text>';
            }
        }
    });
    trace.nodes.forEach(function (n) {
        var p = pos[n.key], ep = n.endpoint.charAt(0) === '?' ? n.endpoint.slice(1) : n.endpoint;
        var cls = n.kind === 'splice' ? 'splice' : n.kind === 'external' || n.missing ? 'missing' : '';
        boxes += '<g class="block node ' + cls + '" data-trace="' + hdEsc(n.key) + '"><title>' + hdEsc(n.harnessName + ' · ' + ep +
            (n.function ? ' — ' + n.function : '')) + '</title>' +
            '<rect class="box" x="' + p.x + '" y="' + p.y + '" width="' + BOX_W + '" height="' + BOX_H + '" rx="4"' +
            (cls ? '' : ' style="fill:' + fills[n.harness] + '"') + '/>' +
            '<text class="sub" x="' + (p.x + 8) + '" y="' + (p.y + 13) + '">' + hdEsc(hdClip(n.harnessName, 34)) + '</text>' +
            '<text class="title" x="' + (p.x + 8) + '" y="' + (p.y + 28) + '">' + hdEsc(hdClip(ep, 28)) + (n.kind === 'splice' ? ' (splice)' : '') + '</text>' +
            '<text x="' + (p.x + 8) + '" y="' + (p.y + 42) + '">' + hdEsc(hdClip(n.function, 34)) + '</text></g>';
    });
    var rows = Math.max.apply(null, cols.map(function (c) { return c.length; }));
    var width = 20 + cols.length * COL_W, height = 30 + rows * (BOX_H + GAP) + 10;
    var legend = Object.keys(harnessNames).map(function (h, i) {
        return '<rect x="' + (20 + i * 190) + '" y="6" width="12" height="12" style="fill:' + fills[h] + ';stroke:#555"/>' +
            '<text class="sub" x="' + (36 + i * 190) + '" y="16">' + hdEsc(hdClip(harnessNames[h], 28)) + '</text>';
    }).join('');
    return { svg: hdSvg(Math.max(width, 400), height, legend + wires + boxes), width: width, height: height };
}

/** Overview of a system: one box per harness listing its mated connectors, joined across. */
function harnessSystemDiagram(members, mates) {
    var BOX_W = 230, COL = 330, rowsOf = {}, pos = {};
    members.forEach(function (m) { rowsOf[m.id] = []; });
    mates.forEach(function (l) {
        [l.a, l.b].forEach(function (end) { if (rowsOf[end.harness] && rowsOf[end.harness].indexOf(end.connector) < 0) rowsOf[end.harness].push(end.connector); });
    });
    var boxes = '', height = 0;
    members.forEach(function (m, i) {
        var x = 20 + i * COL, y = 20, rows = rowsOf[m.id].map(function (id) {
            var c = m.model.connectors.filter(function (k) { return k.id === id; })[0] || {};
            return { cavity: '', text: id, extra: c.connector || '', endpoint: null };
        });
        var sub = m.model.connectors.length + ' connectors · ' + m.model.splices.length + ' splices';
        var b = hdBox(x, y, BOX_W, m.name, sub, rows, '', null);
        boxes += b.svg.replace('<g class="block ', '<g data-harness="' + hdEsc(m.id) + '" class="block ');
        rowsOf[m.id].forEach(function (id, r) { pos[m.id + '|' + id] = { x: x, y: b.y(r) }; });
        height = Math.max(height, y + b.height + 20);
    });
    var links = '';
    mates.forEach(function (l) {
        var a = pos[l.a.harness + '|' + l.a.connector], b = pos[l.b.harness + '|' + l.b.connector];
        if (!a || !b) return;
        if (a.x > b.x) { var t = a; a = b; b = t; }
        var x1 = a.x + BOX_W, x2 = b.x, d = 'M' + x1 + ',' + a.y + ' C' + ((x1 + x2) / 2) + ',' + a.y + ' ' + ((x1 + x2) / 2) + ',' + b.y + ' ' + x2 + ',' + b.y;
        links += '<g><title>' + hdEsc(l.a.connector + ' mated (' + l.source + ')') + '</title><path d="' + d + '" stroke="#555" stroke-width="6" fill="none"/>' +
            '<path d="' + d + '" stroke="' + (l.parts === 'conflict' ? '#f44336' : '#fff') + '" stroke-width="3" fill="none"/></g>';
    });
    var width = 20 + members.length * COL;
    return { svg: hdSvg(Math.max(width, 400), Math.max(height, 80), links + boxes), width: width, height: height };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { harnessMates: harnessMates, hsysPartsMate: hsysPartsMate, harnessSystemChecks: harnessSystemChecks,
        harnessSystemGraph: harnessSystemGraph, harnessTrace: harnessTrace, harnessTraceDiagram: harnessTraceDiagram,
        harnessSystemDiagram: harnessSystemDiagram, hsysLinkKey: hsysLinkKey };
}
