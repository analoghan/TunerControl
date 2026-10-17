/**
 * harness/harness-pinout.js — Pinout sheets: one table per connector for the bench and for fault-finding later.
 *
 * harnessPinouts(model, wires) → { connectorId: [row] }, rows in the connector's own cavity order (as the workbook lists them):
 *   row = { cavity, empty, function, note, chassis, terminal, wirePn, wire, look: { color, stripe, label }, to: [end] }
 *   empty: no wire in the cavity (a plug, a seal or nothing).
 *   to: where the cavity's wires go, from harnessCutList (wires; worked out when not given). Both directions count, so a cavity
 *   with a blank Remote Connection that another cavity points at still shows that cavity.
 *   end = { label, kind: 'pin' | 'splice' | 'terminal' | 'outside' | 'missing', others: [label] }
 *   others: for a splice, the splice's other ends (the cavities this one is joined to through it).
 * harnessSpliceSheet(model, wires) → [{ id, type, boot, notes, ends: [{ label, kind, wire, function }] }]
 */

function harnessPinouts(model, wires) {
    wires = wires || harnessCutList(model);
    var to = {}, spliceEnds = {};
    function link(a, b) {
        if (!b.label) return;
        if (a.kind === 'pin') (to[a.label] = to[a.label] || []).push(b);
        if (a.kind === 'splice') (spliceEnds[a.block] = spliceEnds[a.block] || []).push(b.label);
    }
    wires.forEach(function (w) { link(w.from, w.to); link(w.to, w.from); });
    var out = {};
    model.connectors.forEach(function (c) {
        out[c.id] = c.pins.map(function (p) {
            var label = harnessEndpointName(c.id, p.cavity), seen = {};
            var ends = (to[label] || []).filter(function (e) {
                if (seen[e.label]) return false;
                seen[e.label] = true;
                return true;
            }).map(function (e) {
                return { label: e.label, kind: e.kind,
                         others: e.kind === 'splice' ? (spliceEnds[e.block] || []).filter(function (l) { return l !== label; }) : [] };
            });
            var empty = !harnessHasWire(p), look = typeof hdWireStyle === 'function' ? hdWireStyle(p.wire) : { color: '', stripe: null, label: '' };
            return { cavity: p.cavity, empty: empty, function: harnessText(p.function), note: harnessText(p.note), chassis: harnessText(p.chassis),
                     terminal: harnessText(p.terminal), wirePn: harnessText(p.wirePn), wire: harnessText(p.wire),
                     look: { color: look.color, stripe: look.stripe, label: look.label }, to: empty ? [] : ends };
        });
    });
    return out;
}

function harnessSpliceSheet(model, wires) {
    wires = wires || harnessCutList(model);
    var ends = {};
    wires.forEach(function (w) {
        [[w.from, w.to], [w.to, w.from]].forEach(function (pair) {
            if (pair[0].kind === 'splice' && pair[1].label) {
                (ends[pair[0].block] = ends[pair[0].block] || []).push({ label: pair[1].label, kind: pair[1].kind, wire: w.wire, function: w.function });
            }
        });
    });
    return model.splices.map(function (s) {
        return { id: s.id, type: harnessText(s.type), boot: harnessText(s.boot), notes: harnessText(s.notes), ends: ends[s.id] || [] };
    });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { harnessPinouts: harnessPinouts, harnessSpliceSheet: harnessSpliceSheet };
