/**
 * harness/harness-diff.js — What changed between two revisions of a harness (harness-model.js models).
 *
 * harnessDiff(before, after) → {
 *   connectors: { added: [block], removed: [block], changed: [entry], followRename },   splices: the same,
 *   lengths: [{ key, before, after }]   wire lengths in millimetres (null = none); keys are cut-list keys (harness-build.js)
 *   lengthUnit: { before, after },  counts: { …see harnessDiffSummary }, same: true when nothing differs }
 * entry = { id, before, after (blocks), renamedFrom: old id | null, fields: [change], rows: [row], images: { added, removed },
 *           followRename: number of this block's connections that only changed because another connector or splice was renamed }
 * row   = { key (cavity, or the end for a splice wire), kind: 'added' | 'removed' | 'changed', before, after (records),
 *           fields: [change], rewired: the Remote Connection (or a splice wire's end) changed }
 * change = { field, label, before, after }
 *
 * Cavities are matched by name, splice wires by their end; order changes are ignored. A connector or splice that is gone in
 * one revision and new in the other is a rename when most of its cavities (or ends) match. References that only changed
 * because of such a rename (M142.A.3 → "BULK.d" after CHAS.A became BULK) are counted, not listed.
 */

var HDIFF_CONNECTOR_FIELDS = [['title', 'Title'], ['sheet', 'Sheet'], ['connector', 'Connector'], ['boot', 'Boot'],
    ['mateConn', 'Mate connector'], ['matePin', 'Mate pin'], ['notes', 'Notes'], ['chassisFunction', 'Chassis Function column']];
var HDIFF_SPLICE_FIELDS = [['sheet', 'Sheet'], ['type', 'Splice type'], ['boot', 'Boot'], ['notes', 'Notes']];
var HDIFF_PIN_FIELDS = HARNESS_PIN_FIELDS.concat('chassis', 'cable');
var HDIFF_WIRE_FIELDS = HARNESS_WIRE_FIELDS.concat('cable');

function hdiffValue(v) {
    if (v === true) return 'on';
    if (v === false || v === undefined || v === null) return v === false ? 'off' : '';
    return harnessText(v);
}

function hdiffFields(a, b, fields, labels) {
    var out = [];
    fields.forEach(function (f, i) {
        var field = f.join ? f[0] : f, label = f.join ? f[1] : labels[i];
        var x = hdiffValue(a[field]), y = hdiffValue(b[field]);
        if (field === 'chassisFunction') { x = a[field] ? 'on' : 'off'; y = b[field] ? 'on' : 'off'; }
        if (x !== y) out.push({ field: field, label: label, before: x, after: y });
    });
    return out;
}

/** Records keyed by name; a repeated name gets "#2", "#3"… so both copies are compared. */
function hdiffKeyed(recs, keyOf) {
    var map = {}, order = [], n = {};
    recs.forEach(function (r) {
        var k = keyOf(r);
        n[k] = (n[k] || 0) + 1;
        if (n[k] > 1) k += '#' + n[k];
        map[k] = r; order.push(k);
    });
    return { map: map, order: order };
}

/** Share of a's records that have a twin in b (same key and the same wire and function). */
function hdiffLikeness(a, b, keyOf) {
    var ka = hdiffKeyed(a, keyOf), kb = hdiffKeyed(b, keyOf), same = 0;
    ka.order.forEach(function (k) {
        var x = ka.map[k], y = kb.map[k];
        if (y && harnessText(x.wire) === harnessText(y.wire) && harnessText(x.function) === harnessText(y.function)) same++;
    });
    var size = Math.max(ka.order.length, kb.order.length);
    return size ? same / size : 0;
}

/** Pair blocks that are gone with new ones that look the same (≥ 60 % of rows alike, best match first). */
function hdiffRenames(removed, added, likeness) {
    var pairs = [];
    removed.forEach(function (r) { added.forEach(function (a) { var s = likeness(r, a); if (s >= 0.6) pairs.push([s, r, a]); }); });
    pairs.sort(function (x, y) { return y[0] - x[0]; });
    var used = {}, out = [];
    pairs.forEach(function (p) {
        if (used['r' + p[1].id] || used['a' + p[2].id]) return;
        used['r' + p[1].id] = used['a' + p[2].id] = true;
        out.push({ from: p[1], to: p[2] });
    });
    return out;
}

/** Rewrite references in old text with the new names: connector prefixes ("CHAS.A.d" → "BULK.d") and whole splice names. */
function hdiffRenamer(connectorRenames, spliceRenames) {
    var olds = Object.keys(connectorRenames).sort(function (a, b) { return b.length - a.length; });
    if (!olds.length && !Object.keys(spliceRenames).length) return function (t) { return t; };
    function token(s) {
        if (spliceRenames[s]) return spliceRenames[s];
        for (var i = 0; i < olds.length; i++) if (s.indexOf(olds[i] + '.') === 0) return connectorRenames[olds[i]] + s.slice(olds[i].length);
        return s;
    }
    // Remote connections may list several ends ("PDM30.A.1/PDM30.A.10") or carry a note ("X107.H (to fuse)").
    return function (t) { return String(t).split(/([\/,\s]+)/).map(function (s, i) { return i % 2 ? s : token(s); }).join(''); };
}

function hdiffBlocks(before, after, isConnector, renames, renamer) {
    var res = { added: [], removed: [], changed: [], followRename: 0 };
    var byB = {}, byA = {};
    before.forEach(function (b) { byB[b.id] = b; });
    after.forEach(function (b) { byA[b.id] = b; });
    var renamedTo = {}, renamedFrom = {};
    renames.forEach(function (r) { renamedTo[r.from.id] = r.to; renamedFrom[r.to.id] = r.from; });
    before.forEach(function (b) { if (!byA[b.id] && !renamedTo[b.id]) res.removed.push(b); });
    after.forEach(function (a) {
        var b = byB[a.id] || renamedFrom[a.id];
        if (!b) { res.added.push(a); return; }
        var entry = { id: a.id, before: b, after: a, renamedFrom: b.id !== a.id ? b.id : null, followRename: 0,
                      fields: hdiffFields(b, a, isConnector ? HDIFF_CONNECTOR_FIELDS : HDIFF_SPLICE_FIELDS), rows: [], images: { added: 0, removed: 0 } };
        var recField = isConnector ? 'cavity' : 'end', refField = isConnector ? 'remote' : 'end';
        var fields = isConnector ? HDIFF_PIN_FIELDS : HDIFF_WIRE_FIELDS;
        var labels = isConnector ? harnessPinColumns(a, fields) : harnessSpliceColumns(null, fields);
        // Splice wires are matched by their end, with the old end rewritten for renamed connectors.
        var keyB = function (r) { return isConnector ? harnessText(r.cavity) : renamer(harnessText(r.end)).toLowerCase(); };
        var keyA = function (r) { return isConnector ? harnessText(r.cavity) : harnessText(r.end).toLowerCase(); };
        var kb = hdiffKeyed(isConnector ? b.pins : b.wires, keyB), ka = hdiffKeyed(isConnector ? a.pins : a.wires, keyA);
        ka.order.forEach(function (k) {
            var y = ka.map[k], x = kb.map[k];
            if (!x) { entry.rows.push({ key: harnessText(y[recField]), kind: 'added', before: null, after: y, fields: [], rewired: false }); return; }
            var changes = hdiffFields(x, y, fields, labels).filter(function (c) {
                if (c.field !== refField) return true;
                if (renamer(c.before) === c.after) { entry.followRename++; return false; }
                return true;
            });
            if (changes.length) {
                entry.rows.push({ key: harnessText(y[recField]), kind: 'changed', before: x, after: y, fields: changes,
                                  rewired: changes.some(function (c) { return c.field === refField; }) });
            }
        });
        kb.order.forEach(function (k) {
            if (!ka.map[k]) entry.rows.push({ key: harnessText(kb.map[k][recField]), kind: 'removed', before: kb.map[k], after: null, fields: [], rewired: false });
        });
        var imB = (b.images || []).map(function (i) { return i.id; }), imA = (a.images || []).map(function (i) { return i.id; });
        entry.images.added = imA.filter(function (id) { return imB.indexOf(id) < 0; }).length;
        entry.images.removed = imB.filter(function (id) { return imA.indexOf(id) < 0; }).length;
        res.followRename += entry.followRename;
        if (entry.renamedFrom || entry.fields.length || entry.rows.length || entry.images.added || entry.images.removed) res.changed.push(entry);
    });
    return res;
}

function harnessDiff(before, after) {
    var bc = before.connectors || [], ac = after.connectors || [], bs = before.splices || [], as = after.splices || [];
    var idsA = {}, idsB = {};
    ac.concat(as).forEach(function (x) { idsA[x.id] = true; });
    bc.concat(bs).forEach(function (x) { idsB[x.id] = true; });
    var cavity = function (p) { return harnessText(p.cavity); };
    var cRen = hdiffRenames(bc.filter(function (b) { return !idsA[b.id]; }), ac.filter(function (a) { return !idsB[a.id]; }),
        function (r, a) { return hdiffLikeness(r.pins, a.pins, cavity); });
    var connectorRenames = {};
    cRen.forEach(function (r) { connectorRenames[r.from.id] = r.to.id; });
    var connectorOnly = hdiffRenamer(connectorRenames, {});
    var sRen = hdiffRenames(bs.filter(function (b) { return !idsA[b.id]; }), as.filter(function (a) { return !idsB[a.id]; }),
        function (r, a) {
            return hdiffLikeness(r.wires.map(function (w) { return Object.assign({}, w, { end: connectorOnly(harnessText(w.end)).toLowerCase() }); }),
                a.wires.map(function (w) { return Object.assign({}, w, { end: harnessText(w.end).toLowerCase() }); }), function (w) { return w.end; });
        });
    var spliceRenames = {};
    sRen.forEach(function (r) { spliceRenames[r.from.id] = r.to.id; });
    var renamer = hdiffRenamer(connectorRenames, spliceRenames);

    var out = { connectors: hdiffBlocks(bc, ac, true, cRen, renamer), splices: hdiffBlocks(bs, as, false, sRen, renamer), lengths: [],
                lengthUnit: { before: before.lengthUnit || 'mm', after: after.lengthUnit || 'mm' } };
    var lb = {}, la = after.wireLengths || {};
    Object.keys(before.wireLengths || {}).forEach(function (k) {
        var parts = k.split('||').map(renamer);
        lb[parts[0] < parts[1] ? parts[0] + '||' + parts[1] : parts[1] + '||' + parts[0]] = before.wireLengths[k];
    });
    Object.keys(lb).concat(Object.keys(la).filter(function (k) { return !(k in lb); })).forEach(function (k) {
        var x = k in lb ? +lb[k] : null, y = k in la ? +la[k] : null;
        if (x !== y) out.lengths.push({ key: k, before: x, after: y });
    });
    var c = out.counts = { connectorsAdded: out.connectors.added.length, connectorsRemoved: out.connectors.removed.length,
        connectorsRenamed: out.connectors.changed.filter(function (e) { return e.renamedFrom; }).length,
        splicesAdded: out.splices.added.length, splicesRemoved: out.splices.removed.length,
        splicesRenamed: out.splices.changed.filter(function (e) { return e.renamedFrom; }).length,
        blocksChanged: out.connectors.changed.length + out.splices.changed.length,
        detailsChanged: out.connectors.changed.concat(out.splices.changed).filter(function (e) {
            return e.fields.length || e.images.added || e.images.removed; }).length,
        rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0, rewired: 0, lengths: out.lengths.length,
        followRename: out.connectors.followRename + out.splices.followRename };
    out.connectors.changed.concat(out.splices.changed).forEach(function (e) {
        e.rows.forEach(function (r) {
            if (r.kind === 'added') c.rowsAdded++; else if (r.kind === 'removed') c.rowsRemoved++; else c.rowsChanged++;
            if (r.rewired) c.rewired++;
        });
    });
    out.same = !c.connectorsAdded && !c.connectorsRemoved && !c.splicesAdded && !c.splicesRemoved && !c.blocksChanged && !c.lengths &&
        out.lengthUnit.before === out.lengthUnit.after;
    return out;
}

/** One line: "2 connectors added, 1 renamed · 14 cavities or splice wires changed (4 rewired), 3 added · 2 wire lengths changed". */
function harnessDiffSummary(diff) {
    var c = diff.counts, parts = [];
    function n(v, one, many) { return v + ' ' + (v === 1 ? one : many); }
    function group(list) { return list.filter(Boolean).join(', '); }
    var conn = group([c.connectorsAdded && n(c.connectorsAdded, 'connector', 'connectors') + ' added',
        c.connectorsRemoved && n(c.connectorsRemoved, 'connector', 'connectors') + ' removed',
        c.connectorsRenamed && n(c.connectorsRenamed, 'connector', 'connectors') + ' renamed']);
    var spl = group([c.splicesAdded && n(c.splicesAdded, 'splice', 'splices') + ' added',
        c.splicesRemoved && n(c.splicesRemoved, 'splice', 'splices') + ' removed',
        c.splicesRenamed && n(c.splicesRenamed, 'splice', 'splices') + ' renamed']);
    if (conn) parts.push(conn);
    if (spl) parts.push(spl);
    var rows = group([c.rowsChanged && n(c.rowsChanged, 'row', 'rows') + ' changed' + (c.rewired ? ' (' + c.rewired + ' rewired)' : ''),
        c.rowsAdded && n(c.rowsAdded, 'row', 'rows') + ' added', c.rowsRemoved && n(c.rowsRemoved, 'row', 'rows') + ' removed']);
    if (rows) parts.push(rows);
    if (c.lengths) parts.push(n(c.lengths, 'wire length', 'wire lengths') + ' changed');
    if (diff.lengthUnit.before !== diff.lengthUnit.after) parts.push('length unit ' + diff.lengthUnit.before + ' → ' + diff.lengthUnit.after);
    if (c.detailsChanged) parts.push('details or pictures changed on ' + n(c.detailsChanged, 'connector or splice', 'connectors or splices'));
    return parts.length ? parts.join(' · ') : 'No differences.';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { harnessDiff: harnessDiff, harnessDiffSummary: harnessDiffSummary };
