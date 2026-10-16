/**
 * m1-config/links.js — Cross-references between the settings of a tune, so the Config Viewer can follow a
 * setting to what it points at and back ("Brake Switch → Driver Switch 8 → FIRMWARE5 → CAN receive signal").
 *
 * Entities are setting groups ('g:Driver.Switch 8', every dotted prefix of an item name) and I/O resources
 * ('r:firmware5', by resource name, or by raw IDs when unnamed). References come from:
 *   - enum values that name a group or a resource ("Driver Switch 8", "Firmware 5", "Driver Keypad Button 7");
 *   - I/O resource assignments (Driver Switch 8 Input Resource = FIRMWARE5);
 *   - table axes whose input is another setting's channel (Z = Driver.Fuel Mixture Aim Main Switch.Value).
 * A reference to an item's own group or one of its ancestors is not kept.
 */

function m1lNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function m1lTokens(s) { return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

/** Parent group of an item ('Driver.Switch 8.Input Resource' → 'Driver.Switch 8'). */
function m1lGroupOf(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
}

/** True when a is b or one of b's ancestors ('Driver' and 'Driver.Switch 8' for 'Driver.Switch 8.Input'). */
function m1lAncestorOrSelf(a, b) { return a === b || b.indexOf(a + '.') === 0; }

/**
 * Build the reference index for a package's items. resName(ids) → resource name or null (m1cResourceName).
 * Returns { groups, resources, refs, byTarget, byItem }.
 */
function m1lBuildIndex(items, resName) {
    var groups = {}, groupByNorm = {}, groupsByLast = {}, resources = {}, resByNorm = {};
    items.forEach(function (it) {
        var parts = it.name.split('.');
        for (var k = 1; k < parts.length; k++) {
            var path = parts.slice(0, k).join('.');
            if (!groups[path]) {
                groups[path] = { key: 'g:' + path, path: path, items: [] };
                var n = m1lNorm(path);
                if (!groupByNorm[n] || path.length < groupByNorm[n].length) groupByNorm[n] = path;
                var toks = m1lTokens(path), last = toks[toks.length - 1];
                (groupsByLast[last] = groupsByLast[last] || []).push(path);
            }
            if (k === parts.length - 1) groups[path].items.push(it);
        }
    });

    function resourceKey(name, ids) { return name ? 'r:' + m1lNorm(name) : 'r:' + ids.filter(function (v) { return v !== '0x0000'; }).join(','); }
    function addResource(key, name) {
        if (!resources[key]) resources[key] = { key: key, name: name };
        if (name && !resources[key].name) resources[key].name = name;
        return resources[key];
    }
    items.forEach(function (it) {
        if (it.type !== 'io_resource' || !(it.value || []).some(function (v) { return v !== '0x0000'; })) return;
        var name = resName(it.value) || null, key = resourceKey(name, it.value);
        addResource(key, name || it.value.filter(function (v) { return v !== '0x0000'; }).join(', '));
        if (name) resByNorm[m1lNorm(name)] = key;
    });

    /**
     * An enum label → entity key: a resource, a group of the same name, a group of that name next to the item
     * ("Button 1" inside Driver.CAN Keypad.Button 3 → Driver.CAN Keypad.Button 1), or a group whose path contains the
     * label's words in order.
     */
    function resolveLabel(label, itemName) {
        var n = m1lNorm(label);
        if (!n) return null;
        if (resByNorm[n]) return resByNorm[n];
        var fw = /^firmware ?(\d+)$/i.exec(String(label).trim());
        if (fw) return addResource('r:firmware' + fw[1], 'FIRMWARE' + fw[1]).key;
        if (groupByNorm[n]) return 'g:' + groupByNorm[n];
        var anc = m1lGroupOf(itemName);
        while (anc.indexOf('.') > 0) {
            anc = m1lGroupOf(anc);
            var near = groupByNorm[m1lNorm(anc) + n];
            if (near && near.indexOf(anc + '.') === 0) return 'g:' + near;
        }
        // Looser: "Driver Keypad Button 7" → "Driver.CAN Keypad.Button 7". Only for labels ending in a number,
        // matching the last word and containing every word in order; the shortest such path wins.
        var toks = m1lTokens(label), last = toks[toks.length - 1];
        if (toks.length < 2 || !/^\d+$/.test(last)) return null;
        var best = null;
        (groupsByLast[last] || []).forEach(function (path) {
            var pt = m1lTokens(path), j = 0;
            for (var i = 0; i < pt.length && j < toks.length; i++) if (pt[i] === toks[j]) j++;
            if (j === toks.length && pt.length <= toks.length + 2 && (!best || path.length < best.length)) best = path;
        });
        return best ? 'g:' + best : null;
    }

    /** An axis input channel ('Driver.Fuel Mixture Aim Main Switch.Value') → the longest setting group it names. */
    function resolveChannel(input) {
        var parts = String(input || '').split('.');
        for (var k = parts.length; k >= 2; k--) {
            var path = parts.slice(0, k).join('.');
            if (groups[path]) return 'g:' + path;
        }
        return null;
    }

    var refs = [];
    function add(it, kind, to, text) {
        if (!to) return;
        var own = m1lGroupOf(it.name);
        if (to.indexOf('g:') === 0 && (m1lAncestorOrSelf(to.slice(2), own) || m1lAncestorOrSelf(own, to.slice(2)))) return;
        refs.push({ from: it.name, item: it, kind: kind, to: to, text: text });
    }
    items.forEach(function (it) {
        if (it.type === 'io_resource' && (it.value || []).some(function (v) { return v !== '0x0000'; })) {
            add(it, 'resource', resourceKey(resName(it.value) || null, it.value), resources[resourceKey(resName(it.value) || null, it.value)].name);
        } else if (it.type === 'enum' && it.label) {
            add(it, 'value', resolveLabel(it.label, it.name), it.label);
        }
        (it.axes || []).forEach(function (a) {
            if (a.input) add(it, 'axis', resolveChannel(a.input), a.axis + ' axis: ' + a.input);
        });
    });

    var byTarget = {}, byItem = {};
    refs.forEach(function (r) {
        (byTarget[r.to] = byTarget[r.to] || []).push(r);
        (byItem[r.from] = byItem[r.from] || []).push(r);
    });
    return { groups: groups, resources: resources, refs: refs, byTarget: byTarget, byItem: byItem };
}

/** Display title of an entity key. */
function m1lTitle(index, key) {
    if (key.indexOf('r:') === 0) return (index.resources[key] && index.resources[key].name) || key.slice(2);
    return key.slice(2);
}

/**
 * Everything about one entity for the Follow view:
 * { key, kind: 'group'|'resource', title, parents: [{ key, title }], members: [item], memberCount,
 *   subgroups: [{ key, title, count }], uses: [ref], usedBy: [ref] }.
 * For a group, members are its own items, uses are their references out of the group, and usedBy are references
 * into the group or any group below it. For a resource, usedBy are the assignments and enum values naming it.
 */
function m1lEntity(index, key, maxMembers) {
    var limit = maxMembers || 400;
    if (key.indexOf('r:') === 0) {
        if (!index.resources[key]) return null;
        return { key: key, kind: 'resource', title: m1lTitle(index, key), parents: [], members: [], memberCount: 0,
                 subgroups: [], uses: [], usedBy: (index.byTarget[key] || []).slice() };
    }
    var path = key.slice(2), g = index.groups[path];
    if (!g) return null;
    var parts = path.split('.'), parents = [];
    for (var k = 1; k < parts.length; k++) {
        var p = parts.slice(0, k).join('.');
        parents.push({ key: 'g:' + p, title: p });
    }
    var subgroups = Object.keys(index.groups).filter(function (q) {
        return q.indexOf(path + '.') === 0 && q.slice(path.length + 1).indexOf('.') < 0;
    }).map(function (q) {
        var count = 0;
        Object.keys(index.groups).forEach(function (r) { if (m1lAncestorOrSelf(q, r)) count += index.groups[r].items.length; });
        return { key: 'g:' + q, title: q.slice(path.length + 1), count: count };
    });
    var uses = [];
    g.items.forEach(function (it) {
        (index.byItem[it.name] || []).forEach(function (r) {
            if (!(r.to.indexOf('g:') === 0 && m1lAncestorOrSelf(path, r.to.slice(2)))) uses.push(r);
        });
    });
    var usedBy = [];
    Object.keys(index.byTarget).forEach(function (t) {
        if (t.indexOf('g:') === 0 && m1lAncestorOrSelf(path, t.slice(2))) {
            index.byTarget[t].forEach(function (r) { if (!m1lAncestorOrSelf(path, m1lGroupOf(r.from))) usedBy.push(r); });
        }
    });
    usedBy.sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
    return { key: key, kind: 'group', title: path, parents: parents, members: g.items.slice(0, limit), memberCount: g.items.length,
             subgroups: subgroups, uses: uses, usedBy: usedBy };
}

/** The entity an item's own value points at (an enum value or I/O resource), or null. */
function m1lValueTarget(index, item) {
    var refs = index.byItem[item.name] || [];
    for (var i = 0; i < refs.length; i++) if (refs[i].kind !== 'axis') return refs[i].to;
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { m1lBuildIndex: m1lBuildIndex, m1lEntity: m1lEntity, m1lValueTarget: m1lValueTarget,
                       m1lTitle: m1lTitle, m1lGroupOf: m1lGroupOf };
}
