/**
 * harness/harness-can.js — CAN data networks of a harness system: devices, hubs, terminators, checks and diagrams.
 *
 * A system keeps canNetworks: [network] next to its harnesses (harness-store.js saves them with the system).
 *   network:    { id, name, bitrate (kbit/s, '' = not set), notes, hubs, hubLinks, devices, terminators }
 *   hubs:       [{ id, name, notes }]
 *   hubLinks:   [{ a: hubId, b: hubId }]                 hubs wired to each other (order doesn't matter)
 *   devices:    [{ id, name, hub (hubId or ''), termination (true = its 120 Ω resistor is on), bitrate ('' = the network's),
 *                  power (true = powered through the CAN connection), pins, notes }]
 *   terminators:[{ id, name, hub }]                      standalone 120 Ω terminators plugged into a hub
 *   feeds:      [{ id, name, source, to }]               power into the network: source = where it comes from (free text,
 *                                                        e.g. "PDM30 OUT 5"), to = 'hub:<id>' | 'device:<id>' | '', pins
 *   pins:       { h, l, plus, gnd: { harness, connector, cavity } }   the harness cavities a device's or feed's wires use
 *                                                        (harness = harness id in the system; cavity '' = not picked yet)
 * A device with power: true is powered through its CAN connection (+12 V and ground in the same cable).
 *
 * canNetworkChecks(net, members) → [{ severity, where, message }]; with members ([{ id, name, model }], the system's harnesses)
 *   the linked pins are checked too.
 * canNetworkDiagram(net) → { svg, width, height }: hubs in a row, their devices and terminators above and below, every
 *   connection drawn as a twisted pair (CAN-H / CAN-L), power wires (+12 V / ground) alongside where a connection carries power. Uses the SVG helpers of harness-diagram.js.
 */

var CAN_BITRATES = [125, 250, 500, 1000];
var CAN_H_COLOR = '#f9c80e', CAN_L_COLOR = '#2e7d32';

function canId() {
    return 'c' + Math.random().toString(36).slice(2, 10);
}

function canNewNetwork(name) {
    return { id: canId(), name: name || 'CAN', bitrate: 500, notes: '', hubs: [], hubLinks: [], devices: [], terminators: [], feeds: [] };
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

/** Power feeds (older networks have none stored). */
function canFeeds(net) {
    if (!net.feeds) net.feeds = [];
    return net.feeds;
}

/** What a power feed goes into: { hub } or { device }, or null when it isn't connected. */
function canFeedTarget(net, feed) {
    var m = String(feed.to || '').match(/^(hub|device):(.+)$/);
    if (!m) return null;
    if (m[1] === 'hub') { var h = canHub(net, m[2]); return h ? { hub: h } : null; }
    var d = net.devices.filter(function (x) { return x.id === m[2]; })[0];
    return d ? { device: d } : null;
}

/** Remove a hub and everything that pointed at it (links; devices, terminators and feeds become unconnected). */
function canRemoveHub(net, id) {
    net.hubs = net.hubs.filter(function (h) { return h.id !== id; });
    net.hubLinks = net.hubLinks.filter(function (l) { return l.a !== id && l.b !== id; });
    net.devices.concat(net.terminators).forEach(function (d) { if (d.hub === id) d.hub = ''; });
    canFeeds(net).forEach(function (f) { if (f.to === 'hub:' + id) f.to = ''; });
}

/** Remove a device; feeds into it become unconnected. */
function canRemoveDevice(net, id) {
    net.devices = net.devices.filter(function (d) { return d.id !== id; });
    canFeeds(net).forEach(function (f) { if (f.to === 'device:' + id) f.to = ''; });
}

/**
 * Which hub groups and devices have power: power entering a hub reaches every hub wired to it and every powered device
 * on them; power fed into a device reaches its hub's group when the device is powered through its CAN connection.
 * Returns { groups: { groupIndex: true }, devices: { id: true } }.
 */
function canPowered(net) {
    var groups = canHubGroups(net), groupOf = {}, out = { groups: {}, devices: {} };
    groups.forEach(function (g, i) { g.forEach(function (id) { groupOf[id] = i; }); });
    canFeeds(net).forEach(function (f) {
        var to = canFeedTarget(net, f);
        if (!to) return;
        if (to.hub) out.groups[groupOf[to.hub.id]] = true;
        else {
            out.devices[to.device.id] = true;
            if (to.device.power && groupOf[to.device.hub] !== undefined) out.groups[groupOf[to.device.hub]] = true;
        }
    });
    net.devices.forEach(function (d) { if (d.power && groupOf[d.hub] !== undefined && out.groups[groupOf[d.hub]]) out.devices[d.id] = true; });
    return out;
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

function canNetworkChecks(net, members) {
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
    var powered = canPowered(net);
    canFeeds(net).forEach(function (f) {
        if (!canFeedTarget(net, f)) add('warning', f.name || net.name, 'Power feed not connected to a hub or device.');
        if (!String(f.source || '').trim()) add('warning', f.name || net.name, 'Power feed has no source — say where the power comes from.');
    });
    net.devices.forEach(function (d) {
        if (d.power && !powered.devices[d.id]) {
            add('warning', d.name, canFeeds(net).length ? 'Powered through its CAN connection, but no power feed reaches its hub.'
                : 'Powered through its CAN connection, but the network has no power feed.');
        }
    });
    var groups = canHubGroups(net);
    groups.slice(1).forEach(function (g) {
        add('error', g.map(function (id) { return canHub(net, id).name; }).join(', '),
            'Not wired to ' + canHub(net, groups[0][0]).name + ' — the hubs of one network must all be connected.');
    });
    return members ? out.concat(canPinChecks(net, members)) : out;
}

// ---------------------------------------------------------------------------
// Pins: the harness cavities a device's or feed's wires use
// ---------------------------------------------------------------------------

var CAN_PIN_LABELS = { h: 'CAN-H', l: 'CAN-L', plus: '+12 V', gnd: 'GND' };

/** The wires of a device (CAN-H/L, plus +12 V and ground when it is powered through the connection) or a feed (power only). */
function canPinRoles(item, isFeed) {
    return isFeed ? ['plus', 'gnd'] : item.power ? ['h', 'l', 'plus', 'gnd'] : ['h', 'l'];
}

/**
 * What a pin's function says about CAN: { role: 'h' | 'l' | 'plus' | 'gnd', buses: ['1', …] } or null.
 * "CAN 1 High", "M142 CAN2 Low", "CAN Bus 3 High", "CAN 1/2 Power", "CAN Power Ground", "CANH".
 */
function canFunctionRole(text) {
    var t = harnessText(text), m = t.match(/\bCAN(?:(?=[HL]\b)|(?![a-z]))[\s_-]*(?:bus[\s_-]*)?(\d+(?:\s*\/\s*\d+)*)?/i);
    if (!m) return null;
    var rest = t.slice(m.index + m[0].length);
    var role = /\b(ground|gnd|earth)\b/i.test(rest) ? 'gnd' : /\b(power|pwr|supply|battery|bat)\b|\+\s*12|\b12\s*v\b/i.test(rest) ? 'plus'
        : /\b(high|hi)\b|^[\s_-]*h\b/i.test(rest) ? 'h' : /\b(low|lo)\b|^[\s_-]*l\b/i.test(rest) ? 'l' : null;
    return role ? { role: role, buses: m[1] ? m[1].split(/\s*\/\s*/) : [] } : null;
}

/** The bus number in a network's name ("CAN 2", "CAN Bus 3"), or ''. */
function canNetBus(net) {
    var m = String(net.name || '').match(/\bCAN[\s_-]*(?:bus[\s_-]*)?(\d+)\b/i);
    return m ? m[1] : '';
}

/** "M142.C.14" for a linked pin (the same form as a Remote Connection). */
function canPinText(ref) {
    return ref && ref.connector ? ref.connector + (ref.cavity ? '.' + ref.cavity : '') : '';
}

/**
 * Look up a linked pin in the system's harnesses: { member, connector, pin } — connector null when the harness has no such
 * connector, pin null when the connector has no such cavity — or null when the harness is not in the system.
 */
function canFindPin(members, ref) {
    var m = ref ? members.filter(function (x) { return x.id === ref.harness; })[0] : null;
    if (!m) return null;
    var c = m.model.connectors.filter(function (k) { return k.id === ref.connector; })[0] || null, cav = String(ref.cavity || '').trim().toLowerCase();
    var pin = c && cav ? c.pins.filter(function (p) { return String(p.cavity).trim().toLowerCase() === cav; })[0] || null : null;
    return { member: m, connector: c, pin: pin };
}

/**
 * Pins of a connector for an item's wires, picked by their functions: { role: cavity }. When the connector has several buses,
 * uses the network name's bus number ("CAN 2") or the bus of the item's pins already linked; leaves a wire out when unsure.
 */
function canSuggestPins(net, item, isFeed, members, harnessId, connectorId) {
    var found = canFindPin(members, { harness: harnessId, connector: connectorId, cavity: '' }), out = {};
    if (!found || !found.connector) return out;
    var bus = canNetBus(net), pins = item.pins || {};
    Object.keys(pins).forEach(function (r) {
        var p = canFindPin(members, pins[r]), f = p && p.pin ? canFunctionRole(p.pin.function) : null;
        if (!bus && f && f.buses.length === 1) bus = f.buses[0];
    });
    canPinRoles(item, isFeed).forEach(function (role) {
        var c = found.connector.pins.filter(function (p) { var f = canFunctionRole(p.function); return f && f.role === role; });
        if (c.length > 1 && bus) {
            var onBus = c.filter(function (p) { return canFunctionRole(p.function).buses.indexOf(bus) >= 0; });
            var only = onBus.filter(function (p) { return canFunctionRole(p.function).buses.length === 1; });
            c = only.length ? only : onBus.length ? onBus : c;
        }
        if (c.length === 1) out[role] = c[0].cavity;
    });
    return out;
}

/** Point links at a renamed connector. Returns true when any changed. */
function canRenameConnector(nets, harnessId, oldId, newId) {
    var changed = false;
    nets.forEach(function (net) {
        net.devices.concat(canFeeds(net)).forEach(function (it) {
            Object.keys(it.pins || {}).forEach(function (r) {
                var ref = it.pins[r];
                if (ref && ref.harness === harnessId && ref.connector === oldId) { ref.connector = newId; changed = true; }
            });
        });
    });
    return changed;
}

/** Linked pins of the networks in one harness: { 'CONNECTOR|cavity (lower case)': [{ net, item, role, isFeed }] }. */
function canPinUses(nets, harnessId) {
    var out = {};
    nets.forEach(function (net) {
        [[net.devices, false], [canFeeds(net), true]].forEach(function (list) {
            list[0].forEach(function (it) {
                canPinRoles(it, list[1]).forEach(function (role) {
                    var ref = (it.pins || {})[role];
                    if (!ref || ref.harness !== harnessId || !ref.cavity) return;
                    var k = ref.connector + '|' + String(ref.cavity).trim().toLowerCase();
                    (out[k] = out[k] || []).push({ net: net, item: it, role: role, isFeed: list[1] });
                });
            });
        });
    });
    return out;
}

function canPinChecks(net, members) {
    var out = [], used = {}, netBus = canNetBus(net);
    function add(severity, where, message) { out.push({ severity: severity, where: where, message: message }); }
    [[net.devices, false], [canFeeds(net), true]].forEach(function (list) {
        list[0].forEach(function (it) {
            var buses = {}, name = it.name || net.name;
            canPinRoles(it, list[1]).forEach(function (role) {
                var ref = (it.pins || {})[role], label = CAN_PIN_LABELS[role];
                if (!ref || !ref.connector) return;
                var f = canFindPin(members, ref), text = canPinText(ref);
                if (!f) { add('warning', name, label + ' is linked to ' + text + ' in a harness that is not in this system.'); return; }
                if (!f.connector) { add('warning', name, label + ' is linked to ' + text + ', but ' + f.member.name + ' has no connector ' + ref.connector + '.'); return; }
                if (!ref.cavity) { add('warning', name, label + ': pick the pin on ' + ref.connector + '.'); return; }
                if (!f.pin) { add('warning', name, label + ' is linked to ' + text + ', but ' + ref.connector + ' in ' + f.member.name + ' has no cavity ' + ref.cavity + '.'); return; }
                var k = ref.harness + '|' + ref.connector + '|' + String(ref.cavity).trim().toLowerCase();
                if (used[k]) add('error', name, text + ' is used for both ' + used[k] + ' and ' + name + ' ' + label + '.');
                else used[k] = name + ' ' + label;
                var fr = canFunctionRole(f.pin.function);
                if (fr && fr.role !== role) add('warning', name, label + ' is linked to ' + text + ', whose function is "' + harnessText(f.pin.function) + '".');
                if (fr && fr.buses.length === 1) {
                    buses[fr.buses[0]] = true;
                    if (netBus && fr.buses[0] !== netBus && (role === 'h' || role === 'l')) {
                        add('warning', name, label + ' is linked to ' + text + ' ("' + harnessText(f.pin.function) + '"), but this network is CAN ' + netBus + '.');
                    }
                }
            });
            var b = Object.keys(buses);
            if (b.length > 1) add('warning', name, 'Its pins are on different CAN buses (' + b.map(function (x) { return 'CAN ' + x; }).join(', ') + ').');
        });
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

var CAN_ITEM_W = 180, CAN_ITEM_H = 56, CAN_TERM_H = 44, CAN_GAP = 22, CAN_HUB_H = 40, CAN_POWER_OFFSET = 14;
var CAN_PLUS_COLOR = '#d32f2f', CAN_GND_COLOR = '#1b1b1b';

/** Two power wires (+12 V red, ground black) side by side along the sampled path, each with a dark edge. */
function canPowerPair(pts, title) {
    function side(d) {
        return pts.map(function (p, i) {
            var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
            var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
            return (p[0] - dy / len * d).toFixed(1) + ',' + (p[1] + dx / len * d).toFixed(1);
        }).join(' ');
    }
    function line(p, color) {
        return '<polyline points="' + p + '" stroke="#333" stroke-width="3.6" fill="none"/><polyline points="' + p + '" stroke="' + color + '" stroke-width="2" fill="none"/>';
    }
    return '<g class="can-power"><title>' + hdEsc(title) + '</title>' + line(side(-2.6), CAN_PLUS_COLOR) + line(side(2.6), CAN_GND_COLOR) + '</g>';
}

var CAN_ITEM_HEIGHT = { device: CAN_ITEM_H, term: CAN_TERM_H, feed: CAN_TERM_H };
var CAN_PIN_SHORT = { h: 'H', l: 'L', plus: '+', gnd: '\u2212' };

/** Linked pins of some of an item's wires: [{ role, text }]. */
function canLinkedPins(item, roles) {
    return roles.map(function (r) {
        var ref = (item.pins || {})[r];
        return ref && ref.cavity ? { role: r, text: canPinText(ref), ref: ref } : null;
    }).filter(Boolean);
}

/** A pin for a label: a long connector name is shortened, never the cavity ("MoTeC PDM30…26.0"). */
function canPinShort(ref, max) {
    var cav = String(ref.cavity), room = max - cav.length - 1;
    return ref.connector.length <= room ? canPinText(ref) : hdClip(ref.connector, Math.max(4, room)) + cav;
}

/** The linked pins as labels beside a wire, one line each ("H M142.C.14"), centred on y. */
function canPinLabels(item, roles, x, y, anchor) {
    var lines = canLinkedPins(item, roles);
    return lines.map(function (l, i) {
        return '<text class="can-pin" x="' + x + '" y="' + (y + (i - (lines.length - 1) / 2) * 11 + 3).toFixed(1) + '" text-anchor="' + anchor + '">' +
            hdEsc(CAN_PIN_SHORT[l.role] + ' ' + canPinShort(l.ref, 17)) + '</text>';
    }).join('');
}

/** A wire's tooltip with its linked pins. */
function canPinTitle(title, item, roles) {
    var lines = canLinkedPins(item, roles);
    return title + (lines.length ? ' — ' + lines.map(function (l) { return CAN_PIN_LABELS[l.role] + ' ' + l.text; }).join(', ') : '');
}

/** A device, terminator or power feed box; (x, y) is its top-left corner. */
function canItemBox(net, item, type, x, y) {
    var h = CAN_ITEM_HEIGHT[type], out = '<g class="can-item can-' + type + '" data-can-item="' + hdEsc(item.id) + '"><title>' +
        hdEsc(item.name + (type === 'feed' && item.source ? ' — from ' + item.source : '') + (item.notes ? ' — ' + item.notes : '')) + '</title>' +
        '<rect class="box" x="' + x + '" y="' + y + '" width="' + CAN_ITEM_W + '" height="' + h + '" rx="4"/>' +
        '<rect class="' + (type === 'feed' ? 'can-feed-head' : 'head') + '" x="' + x + '" y="' + y + '" width="' + CAN_ITEM_W + '" height="20" rx="4"/>' +
        '<text class="title" x="' + (x + 8) + '" y="' + (y + 14) + '">' + hdEsc(hdClip(item.name || '(no name)', 23)) + '</text>';
    if (type === 'term') {
        // Resistor zig-zag and its value.
        var zx = x + 10, zy = y + 32, zz = 'M' + zx + ',' + zy;
        for (var i = 0; i < 6; i++) zz += ' L' + (zx + 4 + i * 6) + ',' + (zy + (i % 2 ? 5 : -5));
        zz += ' L' + (zx + 40) + ',' + zy;
        out += '<path d="' + zz + '" stroke="#333" stroke-width="1.5" fill="none"/>' +
            '<text x="' + (x + 58) + '" y="' + (y + 36) + '">120 Ω terminator</text>';
    } else if (type === 'feed') {
        out += '<text x="' + (x + 8) + '" y="' + (y + 36) + '">' + hdEsc(hdClip('Power from ' + (item.source || '?'), 28)) + '</text>';
    } else {
        var own = canBitrate(item.bitrate), net0 = canBitrate(net.bitrate), speed = own || net0, bad = own && net0 && own !== net0;
        out += '<text class="' + (bad ? 'can-bad' : 'dim') + '" x="' + (x + 8) + '" y="' + (y + 36) + '">' + hdEsc(speed ? canBitrateText(speed) : 'speed not set') + '</text>' +
            (item.power ? '<rect class="can-pwr" x="' + (x + CAN_ITEM_W - 112) + '" y="' + (y + 25) + '" width="36" height="16" rx="8"/>' +
                '<text class="can-term-text can-pwr-text" x="' + (x + CAN_ITEM_W - 94) + '" y="' + (y + 37) + '" text-anchor="middle">PWR</text>' : '') +
            '<rect class="' + (item.termination ? 'can-term-on' : 'can-term-off') + '" x="' + (x + CAN_ITEM_W - 72) + '" y="' + (y + 25) + '" width="64" height="16" rx="8"/>' +
            '<text class="can-term-text" x="' + (x + CAN_ITEM_W - 40) + '" y="' + (y + 37) + '" text-anchor="middle">' + (item.termination ? '120 Ω on' : 'Term off') + '</text>' +
            (item.notes ? '<text class="sub" x="' + (x + 8) + '" y="' + (y + 50) + '">' + hdEsc(hdClip(item.notes, 30)) + '</text>' : '');
    }
    return out + '</g>';
}

function canNetworkDiagram(net) {
    var body = '', wires = '', groups = canHubGroups(net), order = [].concat.apply([], groups), feeds = canFeeds(net);
    var attached = {}, loose = [], toDevice = {}, boxes = {}, FEED_STEP = CAN_TERM_H + 36;
    order.forEach(function (id) { attached[id] = []; });
    net.devices.forEach(function (d) { (attached[d.hub] || loose).push({ item: d, type: 'device' }); });
    net.terminators.forEach(function (t) { (attached[t.hub] || loose).push({ item: t, type: 'term' }); });
    feeds.forEach(function (f) {
        var to = canFeedTarget(net, f);
        if (to && to.hub) attached[to.hub.id].push({ item: f, type: 'feed' });
        else if (to && to.device) (toDevice[to.device.id] = toDevice[to.device.id] || []).push(f);
        else loose.push({ item: f, type: 'feed' });
    });

    // Each hub gets a column wide enough for the items above and below it. Feeds into a device sit next to it (above a device
    // in the top row, below one in the bottom row), so room is kept above the top row for theirs.
    var x = 20, cols = {}, stackTop = 0;
    order.forEach(function (id) {
        var items = attached[id], up = items.slice(0, Math.ceil(items.length / 2)), down = items.slice(up.length);
        var n = Math.max(1, up.length, down.length), w = n * CAN_ITEM_W + (n - 1) * CAN_GAP;
        cols[id] = { x: x, w: w, up: up, down: down };
        up.forEach(function (it) { if (toDevice[it.item.id]) stackTop = Math.max(stackTop, toDevice[it.item.id].length); });
        x += w + 70;
    });
    var top = 70 + stackTop * FEED_STEP, hubY = top + CAN_ITEM_H + 60, bottomY = hubY + CAN_HUB_H + 60, maxBottom = hubY + CAN_HUB_H;
    /** Feeds into a device: stacked on its free side, each with two power wires straight into it. */
    function deviceFeeds(dev) {
        var b = boxes[dev.id];
        (toDevice[dev.id] || []).forEach(function (f, k) {
            // Wires run to the device, or for a second feed to the box between it and the device.
            var px = b.x + CAN_ITEM_W / 2 + CAN_POWER_OFFSET * 2, fy, y0, y1;
            if (b.above) { fy = b.y - (k + 1) * FEED_STEP; y0 = fy + CAN_TERM_H; y1 = b.y - k * FEED_STEP; }
            else { fy = b.y + b.h + 36 + k * FEED_STEP; y0 = fy; y1 = k ? fy - 36 : b.y + b.h; }
            body += canItemBox(net, f, 'feed', b.x, fy) + canPinLabels(f, ['plus', 'gnd'], px + 9, (y0 + y1) / 2, 'start');
            wires += canPowerPair(canSample([px, y0], [px, y1]), canPinTitle(f.name + ' → ' + dev.name + ' (power)', f, ['plus', 'gnd']));
            if (!b.above) maxBottom = Math.max(maxBottom, fy + CAN_TERM_H);
        });
    }
    order.forEach(function (id) {
        var c = cols[id], hub = canHub(net, id), links = net.hubLinks.filter(function (l) { return l.a === id || l.b === id; }).length;
        function place(list, y, above) {
            var span = list.length * CAN_ITEM_W + (list.length - 1) * CAN_GAP, x0 = c.x + (c.w - span) / 2;
            list.forEach(function (it, i) {
                var ix = x0 + i * (CAN_ITEM_W + CAN_GAP), h = CAN_ITEM_HEIGHT[it.type], cx = ix + CAN_ITEM_W / 2;
                var iy = above ? y + CAN_ITEM_H - h : y, y0 = above ? iy + h : hubY + CAN_HUB_H, y1 = above ? hubY : iy;
                body += canItemBox(net, it.item, it.type, ix, iy);
                boxes[it.item.id] = { x: ix, y: iy, h: h, above: above };
                var title = it.item.name + ' ⇄ ' + hub.name, mid = (y0 + y1) / 2;
                if (it.type === 'feed') {
                    wires += canPowerPair(canSample([cx, y0], [cx, y1]), canPinTitle(title + ' (power)', it.item, ['plus', 'gnd']));
                    body += canPinLabels(it.item, ['plus', 'gnd'], cx + 9, mid, 'start');
                } else if (it.type === 'device') {
                    wires += canTwistedPair(canSample([cx, y0], [cx, y1]), canPinTitle(title, it.item, ['h', 'l']));
                    body += canPinLabels(it.item, ['h', 'l'], cx - 9, mid, 'end');
                    if (it.item.power) {
                        wires += canPowerPair(canSample([cx + CAN_POWER_OFFSET, y0], [cx + CAN_POWER_OFFSET, y1]), canPinTitle(title + ' (power)', it.item, ['plus', 'gnd']));
                        body += canPinLabels(it.item, ['plus', 'gnd'], cx + CAN_POWER_OFFSET + 9, mid, 'start');
                    }
                } else {
                    wires += canTwistedPair(canSample([cx, y0], [cx, y1]), title);
                }
                if (!above) maxBottom = Math.max(maxBottom, iy + h);
            });
        }
        place(c.up, top, true);
        place(c.down, bottomY, false);
        c.up.concat(c.down).forEach(function (it) { if (it.type === 'device') deviceFeeds(it.item); });
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
        if (Math.abs(order.indexOf(l.a) - order.indexOf(l.b)) === 1) {
            wires += canTwistedPair(canSample([a.x + a.w, linkY], [b.x, linkY]), title);
        } else {
            var dip = maxBottom + 40 + 24 * under++, p0 = [a.x + a.w / 2, hubY + CAN_HUB_H], p1 = [b.x + b.w / 2, hubY + CAN_HUB_H];
            wires += canTwistedPair(canSample(p0, p1, [p0[0], dip], [p1[0], dip]), title);
        }
    });
    var height = Math.max(maxBottom + 30 + 24 * under, hubY + CAN_HUB_H + 30);
    // Anything not on a hub, in a row underneath (feeds into those devices go below them).
    if (loose.length) {
        var ly = height + 24;
        body += '<text class="sub" x="20" y="' + (ly - 8) + '">' + (net.hubs.length ? 'Not connected to a hub' : 'No hubs yet') + '</text>';
        maxBottom = ly + CAN_ITEM_H;
        loose.forEach(function (it, i) {
            var ix = 20 + i * (CAN_ITEM_W + CAN_GAP);
            body += canItemBox(net, it.item, it.type, ix, ly);
            boxes[it.item.id] = { x: ix, y: ly, h: CAN_ITEM_HEIGHT[it.type], above: false };
            if (it.type === 'device') deviceFeeds(it.item);
        });
        height = maxBottom + 20;
        x = Math.max(x, 20 + loose.length * (CAN_ITEM_W + CAN_GAP) + 50);
    }
    var width = Math.max(x - 50, 640) + 20, n = canTerminations(net), speed = canBitrate(net.bitrate);
    var head = '<text class="title" x="20" y="24" style="font-size:15px">' + hdEsc(net.name || 'CAN network') + '</text>' +
        '<text class="sub" x="20" y="42">' + hdEsc([speed ? canBitrateText(speed) : 'speed not set', n + ' termination' + (n === 1 ? '' : 's') +
            (n ? ' (' + Math.round(120 / n) + ' Ω)' : ''), net.devices.length + ' device' + (net.devices.length === 1 ? '' : 's'),
            feeds.length ? feeds.length + ' power feed' + (feeds.length === 1 ? '' : 's') : ''].filter(Boolean).join(' · ')) + '</text>';
    function key(dx, color, label) {
        return '<line x1="' + dx + '" y1="6" x2="' + (dx + 22) + '" y2="6" stroke="' + color + '" stroke-width="3"/><text x="' + (dx + 27) + '" y="10">' + label + '</text>';
    }
    head += '<g transform="translate(' + (width - 300) + ',16)">' + key(0, CAN_H_COLOR, 'CAN-H') + key(72, CAN_L_COLOR, 'CAN-L') +
        key(144, CAN_PLUS_COLOR, '+12 V') + key(216, CAN_GND_COLOR, 'GND') + '<text class="sub" x="0" y="28">CAN wires twisted; power alongside</text></g>';
    var style = '<style>.can-hub-box{fill:#e3ecf7;stroke:#3a5f8a;stroke-width:1.5}.can-term-on{fill:#e8f5e9;stroke:#2e7d32}' +
        '.can-term-off{fill:#f2f2f2;stroke:#aaa}.can-term-text{font-size:10px}.can-bad{fill:#c62828;font-weight:bold}' +
        '.can-pin{font-size:9px;fill:#333}.can-pwr{fill:#ffebee;stroke:#d32f2f}.can-pwr-text{fill:#b71c1c;font-weight:bold}.can-feed-head{fill:#ffe3e3;stroke:#555;stroke-width:1}' +
        '.can-item,.can-hub{cursor:pointer}.can-item:hover .head,.can-item:hover .can-feed-head,.can-hub:hover rect{stroke:#E31837;stroke-width:2}</style>';
    return { svg: hdSvg(width, height, style + head + wires + body), width: width, height: height };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { canNewNetwork: canNewNetwork, canBitrate: canBitrate, canBitrateText: canBitrateText, canTerminations: canTerminations,
        canHubGroups: canHubGroups, canNetworkChecks: canNetworkChecks, canNetworkDiagram: canNetworkDiagram, canSetHubLink: canSetHubLink,
        canRemoveHub: canRemoveHub, canRemoveDevice: canRemoveDevice, canFeeds: canFeeds, canFeedTarget: canFeedTarget,
        canPowered: canPowered, canPowerPair: canPowerPair, canPinRoles: canPinRoles, canFunctionRole: canFunctionRole, canNetBus: canNetBus,
        canPinText: canPinText, canFindPin: canFindPin, canSuggestPins: canSuggestPins, canRenameConnector: canRenameConnector, canPinUses: canPinUses, canDeviceBitrate: canDeviceBitrate, canTwistedPair: canTwistedPair, canSample: canSample };
}
