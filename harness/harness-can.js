/**
 * harness/harness-can.js — CAN data networks of a harness system: devices, hubs, terminators, checks and diagrams.
 *
 * A system keeps canNetworks: [network] next to its harnesses (harness-store.js saves them with the system).
 *   network:    { id, name, bitrate (kbit/s, '' = not set), notes, hubs, hubLinks, devices, terminators }
 *   hubs:       [{ id, name, notes }]
 *   hubLinks:   [{ a: hubId, b: hubId }]                 hubs wired to each other (order doesn't matter)
 *   devices:    [{ id, name, hub (hubId or ''), termination (true = its 120 Ω resistor is on), bitrate ('' = the network's), notes }]
 *   terminators:[{ id, name, hub }]                      standalone 120 Ω terminators plugged into a hub
 *
 * canNetworkChecks(net) → [{ severity, where, message }]
 * canNetworkDiagram(net) → { svg, width, height }: hubs in a row, their devices and terminators above and below, every
 *   connection drawn as a twisted pair (CAN-H / CAN-L). Uses the SVG helpers of harness-diagram.js.
 */

var CAN_BITRATES = [125, 250, 500, 1000];
var CAN_H_COLOR = '#f9c80e', CAN_L_COLOR = '#2e7d32';

function canId() {
    return 'c' + Math.random().toString(36).slice(2, 10);
}

function canNewNetwork(name) {
    return { id: canId(), name: name || 'CAN', bitrate: 500, notes: '', hubs: [], hubLinks: [], devices: [], terminators: [] };
}

/** Speed in kbit/s as a number, or null when not set ("500", "500 kbit/s", "1 Mbit/s" → 1000). */
function canBitrate(v) {
    var t = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
    if (!t) return null;
    var n = parseFloat(t);
    if (isNaN(n) || n <= 0) return null;
    return /m/.test(t) ? n * 1000 : n;
}

function canBitrateText(kbit) {
    if (!kbit) return '';
    return kbit >= 1000 && kbit % 1000 === 0 ? kbit / 1000 + ' Mbit/s' : kbit + ' kbit/s';
}

/** A device's speed: its own, or the network's when it has none. */
function canDeviceBitrate(net, d) {
    return canBitrate(d.bitrate) || canBitrate(net.bitrate);
}

function canHub(net, id) {
    return id ? net.hubs.filter(function (h) { return h.id === id; })[0] || null : null;
}

function canHubLinked(net, a, b) {
    return net.hubLinks.some(function (l) { return (l.a === a && l.b === b) || (l.a === b && l.b === a); });
}

function canSetHubLink(net, a, b, on) {
    net.hubLinks = net.hubLinks.filter(function (l) { return !((l.a === a && l.b === b) || (l.a === b && l.b === a)); });
    if (on && a !== b) net.hubLinks.push({ a: a, b: b });
}

/** Remove a hub and everything that pointed at it (links; devices and terminators become unconnected). */
function canRemoveHub(net, id) {
    net.hubs = net.hubs.filter(function (h) { return h.id !== id; });
    net.hubLinks = net.hubLinks.filter(function (l) { return l.a !== id && l.b !== id; });
    net.devices.concat(net.terminators).forEach(function (d) { if (d.hub === id) d.hub = ''; });
}

/** Terminations on the bus: devices with theirs on, and terminators plugged into a hub (or with no hubs to plug into). */
function canTerminations(net) {
    return net.devices.filter(function (d) { return d.termination; }).length +
        net.terminators.filter(function (t) { return canHub(net, t.hub) || !net.hubs.length; }).length;
}

/** Hubs grouped by what they're wired to: [[hubId, …], …], the first hub's group first. */
function canHubGroups(net) {
    var seen = {}, groups = [];
    net.hubs.forEach(function (start) {
        if (seen[start.id]) return;
        var group = [], queue = [start.id];
        seen[start.id] = true;
        while (queue.length) {
            var id = queue.shift();
            group.push(id);
            net.hubLinks.forEach(function (l) {
                var other = l.a === id ? l.b : l.b === id ? l.a : null;
                if (other && !seen[other] && canHub(net, other)) { seen[other] = true; queue.push(other); }
            });
        }
        groups.push(group);
    });
    return groups;
}

function canNetworkChecks(net) {
    var out = [];
    function add(severity, where, message) { out.push({ severity: severity, where: where, message: message }); }
    var speed = canBitrate(net.bitrate), n = canTerminations(net);
    if (!speed) add('warning', net.name, 'No speed set for the network.');
    if (n !== 2) {
        add(n < 2 ? 'error' : 'warning', net.name, n === 0
            ? 'No termination. A CAN bus needs a 120 Ω termination at each end — two in total.'
            : n === 1 ? 'Only one termination. A CAN bus needs a 120 Ω termination at each end — two in total (60 Ω across CAN-H/CAN-L).'
            : n + ' terminations: the bus measures ' + Math.round(120 / n) + ' Ω instead of 60 Ω. Keep exactly two, at the ends of the bus.');
    }
    if (net.devices.length < 2) add('warning', net.name, 'A network needs at least two devices to talk to each other.');
    var names = {};
    net.hubs.concat(net.devices, net.terminators).forEach(function (x) {
        var k = String(x.name || '').trim().toLowerCase();
        if (!k) { add('warning', net.name, 'A ' + (net.hubs.indexOf(x) >= 0 ? 'hub' : net.devices.indexOf(x) >= 0 ? 'device' : 'terminator') + ' has no name.'); return; }
        if (names[k]) add('warning', x.name, '"' + x.name + '" is used more than once in this network.');
        names[k] = true;
    });
    net.devices.forEach(function (d) {
        var own = canBitrate(d.bitrate);
        if (own && speed && own !== speed) {
            add('error', d.name, 'Runs at ' + canBitrateText(own) + ' but the network is ' + canBitrateText(speed) + ' — every device on a bus must use the same speed.');
        }
        if (net.hubs.length && !canHub(net, d.hub)) add('warning', d.name, 'Not connected to a hub.');
    });
    net.terminators.forEach(function (t) {
        if (net.hubs.length && !canHub(net, t.hub)) add('warning', t.name, 'Terminator not plugged into a hub, so it does not count.');
    });
    if (!net.hubs.length && net.devices.length) add('warning', net.name, 'No hubs: add one and connect the devices to it to show the wiring.');
    var groups = canHubGroups(net);
    groups.slice(1).forEach(function (g) {
        add('error', g.map(function (id) { return canHub(net, id).name; }).join(', '),
            'Not wired to ' + canHub(net, groups[0][0]).name + ' — the hubs of one network must all be connected.');
    });
    return out;
}

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

/** Points along a straight line or a cubic curve, about every 2 px: [[x, y], …]. */
function canSample(p0, p1, c0, c1) {
    var len = Math.max(Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1])) * (c0 ? 1.4 : 1), steps = Math.max(2, Math.ceil(len / 2)), pts = [];
    for (var i = 0; i <= steps; i++) {
        var t = i / steps, u = 1 - t;
        pts.push(c0 ? [u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0],
                       u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1]]
                    : [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]);
    }
    return pts;
}

/** A twisted pair along the sampled path: CAN-H and CAN-L crossing every half twist, each with a dark edge. */
function canTwistedPair(pts, title) {
    var amp = 3.2, period = 18, dist = 0, h = [], l = [];
    for (var i = 0; i < pts.length; i++) {
        if (i) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
        var off = amp * Math.sin(2 * Math.PI * dist / period);
        h.push((pts[i][0] + nx * off).toFixed(1) + ',' + (pts[i][1] + ny * off).toFixed(1));
        l.push((pts[i][0] - nx * off).toFixed(1) + ',' + (pts[i][1] - ny * off).toFixed(1));
    }
    function line(p, color) {
        return '<polyline points="' + p.join(' ') + '" stroke="#333" stroke-width="3.6" fill="none"/>' +
            '<polyline points="' + p.join(' ') + '" stroke="' + color + '" stroke-width="2" fill="none"/>';
    }
    return '<g class="can-pair"><title>' + hdEsc(title) + '</title>' + line(l, CAN_L_COLOR) + line(h, CAN_H_COLOR) + '</g>';
}

var CAN_ITEM_W = 160, CAN_ITEM_H = 56, CAN_TERM_H = 44, CAN_GAP = 22, CAN_HUB_H = 40;

/** A device or terminator box. Returns svg; (x, y) is its top-left corner. */
function canItemBox(net, item, isTerm, x, y) {
    var h = isTerm ? CAN_TERM_H : CAN_ITEM_H, out = '<g class="can-item" data-can-item="' + hdEsc(item.id) + '"><title>' +
        hdEsc(item.name + (item.notes ? ' — ' + item.notes : '')) + '</title>' +
        '<rect class="box" x="' + x + '" y="' + y + '" width="' + CAN_ITEM_W + '" height="' + h + '" rx="4"/>' +
        '<rect class="head" x="' + x + '" y="' + y + '" width="' + CAN_ITEM_W + '" height="20" rx="4"/>' +
        '<text class="title" x="' + (x + 8) + '" y="' + (y + 14) + '">' + hdEsc(hdClip(item.name || '(no name)', 20)) + '</text>';
    if (isTerm) {
        // Resistor zig-zag and its value.
        var zx = x + 10, zy = y + 32, zz = 'M' + zx + ',' + zy;
        for (var i = 0; i < 6; i++) zz += ' L' + (zx + 4 + i * 6) + ',' + (zy + (i % 2 ? 5 : -5));
        zz += ' L' + (zx + 40) + ',' + zy;
        out += '<path d="' + zz + '" stroke="#333" stroke-width="1.5" fill="none"/>' +
            '<text x="' + (x + 58) + '" y="' + (y + 36) + '">120 Ω terminator</text>';
    } else {
        var own = canBitrate(item.bitrate), net0 = canBitrate(net.bitrate), speed = own || net0, bad = own && net0 && own !== net0;
        out += '<text class="' + (bad ? 'can-bad' : 'dim') + '" x="' + (x + 8) + '" y="' + (y + 36) + '">' + hdEsc(speed ? canBitrateText(speed) : 'speed not set') + '</text>' +
            '<rect class="' + (item.termination ? 'can-term-on' : 'can-term-off') + '" x="' + (x + CAN_ITEM_W - 72) + '" y="' + (y + 25) + '" width="64" height="16" rx="8"/>' +
            '<text class="can-term-text" x="' + (x + CAN_ITEM_W - 40) + '" y="' + (y + 37) + '" text-anchor="middle">' + (item.termination ? '120 Ω on' : 'Term off') + '</text>' +
            (item.notes ? '<text class="sub" x="' + (x + 8) + '" y="' + (y + 50) + '">' + hdEsc(hdClip(item.notes, 26)) + '</text>' : '');
    }
    return out + '</g>';
}

function canNetworkDiagram(net) {
    var body = '', wires = '', groups = canHubGroups(net), order = [].concat.apply([], groups), top = 70;
    var attached = {};
    order.forEach(function (id) { attached[id] = []; });
    var loose = [];
    net.devices.forEach(function (d) { (attached[d.hub] || loose).push({ item: d, term: false }); });
    net.terminators.forEach(function (t) { (attached[t.hub] || loose).push({ item: t, term: true }); });

    // Each hub gets a column wide enough for the items above and below it.
    var x = 20, cols = {}, hubY = top + CAN_ITEM_H + 60, bottomY = hubY + CAN_HUB_H + 60, maxBottom = hubY + CAN_HUB_H;
    order.forEach(function (id) {
        var items = attached[id], up = items.slice(0, Math.ceil(items.length / 2)), down = items.slice(up.length);
        var n = Math.max(1, up.length, down.length), w = n * CAN_ITEM_W + (n - 1) * CAN_GAP;
        cols[id] = { x: x, w: w, up: up, down: down };
        x += w + 70;
    });
    order.forEach(function (id) {
        var c = cols[id], hub = canHub(net, id), links = net.hubLinks.filter(function (l) { return l.a === id || l.b === id; }).length;
        function place(list, y, above) {
            var span = list.length * CAN_ITEM_W + (list.length - 1) * CAN_GAP, x0 = c.x + (c.w - span) / 2;
            list.forEach(function (it, i) {
                var ix = x0 + i * (CAN_ITEM_W + CAN_GAP), h = it.term ? CAN_TERM_H : CAN_ITEM_H, cx = ix + CAN_ITEM_W / 2;
                var iy = above ? y + CAN_ITEM_H - h : y;
                body += canItemBox(net, it.item, it.term, ix, iy);
                wires += canTwistedPair(canSample([cx, above ? iy + h : hubY + CAN_HUB_H], [cx, above ? hubY : iy]), it.item.name + ' ⇄ ' + hub.name);
                if (!above) maxBottom = Math.max(maxBottom, iy + h);
            });
        }
        place(c.up, top, true);
        place(c.down, bottomY, false);
        body += '<g class="can-hub" data-can-item="' + hdEsc(id) + '"><title>' + hdEsc(hub.name + (hub.notes ? ' — ' + hub.notes : '')) + '</title>' +
            '<rect class="can-hub-box" x="' + c.x + '" y="' + hubY + '" width="' + c.w + '" height="' + CAN_HUB_H + '" rx="6"/>' +
            '<text class="title" x="' + (c.x + 10) + '" y="' + (hubY + 17) + '">' + hdEsc(hub.name || '(no name)') + '</text>' +
            '<text class="sub" x="' + (c.x + 10) + '" y="' + (hubY + 31) + '">Hub · ' + (c.up.length + c.down.length) + ' connected' +
            (links ? ' · ' + links + ' hub link' + (links === 1 ? '' : 's') : '') + '</text></g>';
    });
    // Hub links: neighbours in the row straight across; others as a curve under everything.
    var under = 0, linkY = hubY + CAN_HUB_H / 2;
    net.hubLinks.forEach(function (l) {
        var a = cols[l.a], b = cols[l.b];
        if (!a || !b) return;
        if (a.x > b.x) { var t = a; a = b; b = t; }
        var title = canHub(net, l.a).name + ' ⇄ ' + canHub(net, l.b).name;
        if (order.indexOf(l.a) >= 0 && Math.abs(order.indexOf(l.a) - order.indexOf(l.b)) === 1) {
            wires += canTwistedPair(canSample([a.x + a.w, linkY], [b.x, linkY]), title);
        } else {
            var dip = maxBottom + 40 + 24 * under++, p0 = [a.x + a.w / 2, hubY + CAN_HUB_H], p1 = [b.x + b.w / 2, hubY + CAN_HUB_H];
            wires += canTwistedPair(canSample(p0, p1, [p0[0], dip], [p1[0], dip]), title);
        }
    });
    var height = Math.max(maxBottom + 30 + 24 * under, hubY + CAN_HUB_H + 30);
    // Anything not on a hub, in a row underneath.
    if (loose.length) {
        var ly = height + 24;
        body += '<text class="sub" x="20" y="' + (ly - 8) + '">' + (net.hubs.length ? 'Not connected to a hub' : 'No hubs yet') + '</text>';
        loose.forEach(function (it, i) { body += canItemBox(net, it.item, it.term, 20 + i * (CAN_ITEM_W + CAN_GAP), ly); });
        height = ly + CAN_ITEM_H + 20;
        x = Math.max(x, 20 + loose.length * (CAN_ITEM_W + CAN_GAP) + 50);
    }
    var width = Math.max(x - 50, 560) + 20, n = canTerminations(net), speed = canBitrate(net.bitrate);
    var head = '<text class="title" x="20" y="24" style="font-size:15px">' + hdEsc(net.name || 'CAN network') + '</text>' +
        '<text class="sub" x="20" y="42">' + hdEsc([speed ? canBitrateText(speed) : 'speed not set', n + ' termination' + (n === 1 ? '' : 's') +
            (n ? ' (' + Math.round(120 / n) + ' Ω)' : ''), net.devices.length + ' device' + (net.devices.length === 1 ? '' : 's')].join(' · ')) + '</text>' +
        '<g transform="translate(' + (width - 190) + ',16)"><line x1="0" y1="6" x2="26" y2="6" stroke="' + CAN_H_COLOR + '" stroke-width="3"/>' +
        '<text x="32" y="10">CAN-H</text><line x1="90" y1="6" x2="116" y2="6" stroke="' + CAN_L_COLOR + '" stroke-width="3"/>' +
        '<text x="122" y="10">CAN-L</text><text class="sub" x="0" y="28">twisted pair</text></g>';
    var style = '<style>.can-hub-box{fill:#e3ecf7;stroke:#3a5f8a;stroke-width:1.5}.can-term-on{fill:#e8f5e9;stroke:#2e7d32}' +
        '.can-term-off{fill:#f2f2f2;stroke:#aaa}.can-term-text{font-size:10px}.can-bad{fill:#c62828;font-weight:bold}' +
        '.can-item,.can-hub{cursor:pointer}.can-item:hover .head,.can-hub:hover rect{stroke:#E31837;stroke-width:2}</style>';
    return { svg: hdSvg(width, height, style + head + wires + body), width: width, height: height };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { canNewNetwork: canNewNetwork, canBitrate: canBitrate, canBitrateText: canBitrateText, canTerminations: canTerminations,
        canHubGroups: canHubGroups, canNetworkChecks: canNetworkChecks, canNetworkDiagram: canNetworkDiagram, canSetHubLink: canSetHubLink,
        canRemoveHub: canRemoveHub, canDeviceBitrate: canDeviceBitrate, canTwistedPair: canTwistedPair, canSample: canSample };
}
