/**
 * harness/harness-cable.js — Multi-conductor cables in a harness: twisted pairs and triples, shielded or not.
 * Needs harness-model.js and harness-build.js (harnessCutList).
 *
 * harnessCableType(model, partNumber, description) → { conductors, shielded, source, label, short } | null
 *   A wire is part of a cable when its part number or description says so:
 *   - M27500 (MIL-DTL-27500) part numbers decode themselves: M27500-22TG2T14 = 22 AWG, TG wire, 2 conductors, shield T, jacket 14;
 *     shield U means none. "/" or "-" after M27500 and a trailing " (2x)" are accepted.
 *   - model.cableTypes [{ pn, conductors, shielded }]: the user's own list (e.g. Ethernet Cable, a vendor's shielded triple).
 *   - The description: "(Shielded 3)", "(3 Wire Shielded)", "(Twisted Pair)". harnessCables also counts every other row
 *     with the same part number as that cable (a shield row described only as "Shield").
 * harnessCables(model, wires) → { cables: [cable], byEndpoint: { 'CONN.CAV': cable }, untyped: [{ pn, count }] }
 *   wires: harnessCutList(model) (worked out when not given).
 *   cable = { name, explicit, pn, type, conductors: [wire], shields: [wire], wires: [wire], anchor: { block, cavities }, problems: [] }
 *   problems: [{ severity: 'error' | 'warning' | 'info', message }].
 *   The Cable column of a cavity (pin.cable) decides: a name puts the wire in that cable, "-" keeps it out of every cable, blank
 *   leaves it to detection. Detection groups the cable wires (same part number) that run between the same two connectors, in
 *   cavity order with one conductor of each colour (+ a shield); then joins what is left through the connector it shares, so a
 *   return or shield that runs to a splice joins the pair it belongs to. Small connectors (sensors) are joined first.
 *   untyped: part numbers that look like a cable (cable, pair, twisted, ethernet, shielded…) but aren't recognised — add them to
 *   model.cableTypes.
 * harnessNameCables(model, cables) — writes each detected cable's name into the Cable column of its wires (both ends).
 * harnessRenameCable(model, oldName, newName) — renames a cable in every row that names it.
 * harnessCableColor(description) — the conductor's colour ('white/blue'), or 'shield' for a shield or drain.
 */

var HC_M27500 = /^M27500[-\/]?(\d{2})([A-Z]{2})(\d)([A-Z])(\d{2})?$/i;
var HC_OUT = /^(-|none|no|not a cable)$/i;
var HC_LOOKS_LIKE_CABLE = /cable|pair|twist|ethernet|shielded|\bstp\b|\butp\b|cat ?5|cat ?6|multicore|multi-core/i;

function hcPart(pn) {
    return harnessText(pn).replace(/\s+/g, ' ').replace(/\s*\(\d+\s*x\)$/i, '');
}

function hcLabel(conductors, shielded) {
    var name = conductors === 2 ? 'twisted pair' : conductors === 3 ? 'twisted triple' : conductors + '-conductor cable';
    return (shielded ? 'Shielded ' : 'Unshielded ') + name;
}

function hcShort(conductors, shielded) {
    return conductors === 2 ? (shielded ? 'STP' : 'UTP') : conductors + 'C' + (shielded ? ' S' : '');
}

function harnessCableType(model, partNumber, description) {
    var pn = hcPart(partNumber), m = pn.match(HC_M27500), t;
    function type(n, shielded, source) {
        return { conductors: n, shielded: shielded, source: source, label: hcLabel(n, shielded), short: hcShort(n, shielded) };
    }
    if (m && +m[3] >= 2) t = type(+m[3], m[4].toUpperCase() !== 'U', 'M27500');
    if (!t && pn) {
        var key = pn.toLowerCase();
        (model && model.cableTypes || []).some(function (c) {
            if (hcPart(c.pn).toLowerCase() !== key) return false;
            t = type(Math.max(2, parseInt(c.conductors, 10) || 2), !!c.shielded, 'list');
            return true;
        });
    }
    if (!t) {
        var d = harnessText(description), n = d.match(/\(\s*shielded\s*(\d)\s*\)|\(\s*(\d)\s*(?:wire|core|conductor)s?\s*shielded\s*\)/i);
        if (n) t = type(+(n[1] || n[2]), true, 'description');
        else if (/\(\s*(shielded\s+)?twisted\s+pair\s*\)/i.test(d)) t = type(2, /shielded/i.test(d), 'description');
    }
    return t || null;
}

function harnessCableColor(description) {
    var d = harnessText(description).toLowerCase();
    if (/^(shield|drain|braid)/.test(d)) return 'shield';
    return d.replace(/\(.*?\)/g, ' ').replace(/\b\d+(\.\d+)?\s*(awg|aw|ga|mm2|mm²|sq)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function harnessCables(model, wires) {
    wires = wires || harnessCutList(model);
    var index = harnessIndex(model), order = {};
    function pins(id) { return index.connectors[id] ? index.connectors[id].connector.pins.length : 0; }
    model.connectors.forEach(function (c) { c.pins.forEach(function (p, i) { order[harnessEndpointName(c.id, p.cavity)] = i; }); });
    function ends(w) {
        return [w.from, w.to].filter(function (e) { return e.kind === 'pin'; }).map(function (e) {
            return { block: e.block, cavity: e.label.slice(e.block.length + 1), label: e.label, order: order[e.label] === undefined ? 1e6 : order[e.label] };
        });
    }
    function info(w) {
        return { wire: w, type: harnessCableType(model, w.wirePn, w.wire), pnKey: hcPart(w.wirePn).toLowerCase(), color: harnessCableColor(w.wire), ends: ends(w) };
    }

    // Units: wires that belong together so far.
    function unit(list, pnKey, type) {
        var u = { items: list, pnKey: pnKey, type: type, colors: {}, shields: 0, conductors: 0 };
        list.forEach(function (x) { if (x.color === 'shield') u.shields++; else { u.conductors++; u.colors[x.color] = true; } });
        return u;
    }
    function fits(a, b) {
        if (a.pnKey !== b.pnKey || a.shields + b.shields > 1) return false;
        if (a.conductors + b.conductors > a.type.conductors) return false;
        return !Object.keys(b.colors).some(function (c) { return a.colors[c]; });
    }
    function merge(a, b) { return unit(a.items.concat(b.items), a.pnKey, a.type); }
    function at(u, block) {
        var best = 1e9;
        u.items.forEach(function (x) { x.ends.forEach(function (e) { if (e.block === block && e.order < best) best = e.order; }); });
        return best;
    }

    var named = {}, namedOrder = [], units = [], all = wires.map(info), pnType = {};
    // A part number is a cable when any of its rows says so ("TSB-3C" + "(3 Wire Shielded)"), so its shield row ("Shield") is too.
    all.forEach(function (x) { if (x.type && x.pnKey && !pnType[x.pnKey]) pnType[x.pnKey] = x.type; });
    all.forEach(function (x) { if (!x.type && x.pnKey) x.type = pnType[x.pnKey] || null; });
    all.forEach(function (x) {
        var name = harnessText(x.wire.cable);
        if (HC_OUT.test(name)) return;
        if (name) {
            var k = name.toLowerCase();
            if (!named[k]) { named[k] = { name: name, items: [] }; namedOrder.push(k); }
            named[k].items.push(x);
        } else if (x.type) units.push(unit([x], x.pnKey, x.type));
    });

    // Pass 1: the same two connectors at both ends, in cavity order.
    var buckets = {}, rest = [];
    units.forEach(function (u) {
        var e = u.items[0].ends;
        if (e.length < 2) { rest.push(u); return; }
        var blocks = [e[0].block, e[1].block].sort(), key = u.pnKey + '|' + blocks.join('|');
        (buckets[key] = buckets[key] || []).push(u);
    });
    Object.keys(buckets).forEach(function (key) {
        var list = buckets[key], block = key.split('|')[1];
        list.sort(function (a, b) { return at(a, block) - at(b, block); });
        var cur = null;
        list.forEach(function (u) {
            if (cur && fits(cur, u)) cur = merge(cur, u);
            else { if (cur) rest.push(cur); cur = u; }
        });
        if (cur) rest.push(cur);
    });

    // Pass 2: join through a shared connector, smallest connectors (sensors) first.
    var count = {};
    rest.forEach(function (u) { u.items.forEach(function (x) { x.ends.forEach(function (e) { count[e.block] = (count[e.block] || 0) + 1; }); }); });
    Object.keys(count).sort(function (a, b) { return count[a] - count[b] || (a < b ? -1 : 1); }).forEach(function (block) {
        var here = rest.filter(function (u) { return at(u, block) < 1e9; }), others = rest.filter(function (u) { return at(u, block) >= 1e9; });
        here.sort(function (a, b) { return at(a, block) - at(b, block); });
        var out = [], cur = null;
        here.forEach(function (u) {
            if (cur && fits(cur, u)) cur = merge(cur, u);
            else { if (cur) out.push(cur); cur = u; }
        });
        if (cur) out.push(cur);
        rest = others.concat(out);
    });

    var cables = [];
    function addCable(items, name, explicit) {
        var conductors = items.filter(function (x) { return x.color !== 'shield'; }), shields = items.filter(function (x) { return x.color === 'shield'; });
        if (!conductors.length) return;   // a shield lead on its own (splice to splice): not a cable
        var typed = items.filter(function (x) { return x.type; }), type = typed.length ? typed[0].type : null;
        var pns = {};
        items.forEach(function (x) { var p = hcPart(x.wire.wirePn); if (p) pns[p.toLowerCase()] = p; });
        // The connector all (or most) of its wires share names it ("KNOCK1 1, 2, SHIELD"); on a tie the smaller one, the device end.
        var blocks = {};
        items.forEach(function (x) { x.ends.forEach(function (e) { (blocks[e.block] = blocks[e.block] || []).push(e); }); });
        var anchor = Object.keys(blocks).sort(function (a, b) {
            return blocks[b].length - blocks[a].length || pins(a) - pins(b) || (a < b ? -1 : 1);
        })[0];
        var cavities = anchor ? blocks[anchor].slice().sort(function (a, b) { return a.order - b.order; }).map(function (e) { return e.cavity; }) : [];
        var cable = { name: name || (anchor ? anchor + ' ' + cavities.join(', ') : items[0].wire.from.label), explicit: explicit,
                      pn: Object.keys(pns).map(function (k) { return pns[k]; }).join(', '), type: type,
                      conductors: conductors.map(function (x) { return x.wire; }), shields: shields.map(function (x) { return x.wire; }),
                      wires: items.map(function (x) { return x.wire; }), anchor: { block: anchor || '', cavities: cavities }, problems: [] };
        items.forEach(function (x) { x.wire.cableName = cable.name; });   // shown in the cut list
        var p = cable.problems, n = conductors.length;
        if (Object.keys(pns).length > 1) p.push({ severity: 'warning', message: 'Its wires have different part numbers (' + cable.pn + ').' });
        if (type && n > type.conductors) p.push({ severity: 'warning', message: n + ' conductors, but ' + cable.pn + ' has ' + type.conductors + '.' });
        if (type && n < type.conductors) p.push({ severity: 'info', message: 'Only ' + n + ' of its ' + type.conductors + ' conductors are used in this harness.' });
        if (type && type.shielded && !shields.length) {
            p.push({ severity: 'info', message: 'No shield or drain wire in this harness, so the shield is not grounded here.' });
        }
        if (shields.length > 1) p.push({ severity: 'warning', message: shields.length + ' shield wires.' });
        var seen = {};
        conductors.forEach(function (x) {
            if (x.color && seen[x.color]) p.push({ severity: 'warning', message: 'Two conductors are ' + x.wire.wire + '.' });
            seen[x.color] = true;
        });
        items.forEach(function (x) {
            if (x.wire.cableConflict) {
                p.push({ severity: 'error', message: 'The ends of ' + x.wire.from.label + ' name different cables (' + x.wire.cableConflict.join(' / ') + ').' });
            }
        });
        cables.push(cable);
    }
    namedOrder.forEach(function (k) { addCable(named[k].items, named[k].name, true); });
    rest.forEach(function (u) { addCable(u.items, '', false); });
    cables.sort(function (a, b) { return (a.anchor.block + ' ' + a.name < b.anchor.block + ' ' + b.name) ? -1 : 1; });

    var byEndpoint = {};
    cables.forEach(function (c) { c.wires.forEach(function (w) { [w.from, w.to].forEach(function (e) { if (e.kind === 'pin') byEndpoint[e.label] = c; }); }); });

    var untyped = {};
    all.forEach(function (x) {
        var p = hcPart(x.wire.wirePn);
        if (x.type || !p || !(HC_LOOKS_LIKE_CABLE.test(p) || HC_LOOKS_LIKE_CABLE.test(x.wire.wire))) return;
        var k = p.toLowerCase();
        (untyped[k] = untyped[k] || { pn: p, count: 0 }).count++;
    });
    return { cables: cables, byEndpoint: byEndpoint, untyped: Object.keys(untyped).map(function (k) { return untyped[k]; }) };
}

/** The cavity rows of a wire's connector ends. */
function hcRows(model, wire) {
    var index = harnessIndex(model);
    return [wire.from, wire.to].filter(function (e) { return e.kind === 'pin'; }).map(function (e) {
        var c = index.connectors[e.block];
        return c ? c.pins[e.label.slice(e.block.length + 1)] : null;
    }).filter(Boolean);
}

function harnessNameCables(model, cables) {
    var n = 0;
    cables.forEach(function (c) {
        if (c.explicit) return;
        c.wires.forEach(function (w) { hcRows(model, w).forEach(function (p) { p.cable = c.name; n++; }); });
        c.explicit = true;
    });
    return n;
}

function harnessRenameCable(model, oldName, newName) {
    var key = harnessText(oldName).toLowerCase(), n = 0;
    model.connectors.forEach(function (c) {
        c.pins.forEach(function (p) { if (harnessText(p.cable).toLowerCase() === key) { p.cable = harnessText(newName); n++; } });
    });
    return n;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { harnessCableType: harnessCableType, harnessCableColor: harnessCableColor, harnessCables: harnessCables,
        harnessNameCables: harnessNameCables, harnessRenameCable: harnessRenameCable };
}
