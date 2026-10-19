/**
 * harness/harness-build.js — Cut list and bill of materials from a harness model (harness-model.js).
 *
 * harnessCutList(model) → [wire]: one entry per physical wire, joining the two rows that describe it (a cavity and the cavity or
 *   splice end it goes to). wire = { key, from: end, to: end, wirePn, wire, function, length, problem }
 *   end = { label, kind: 'pin' | 'splice' | 'terminal' | 'outside' | 'missing' | 'none', block, terminal }
 *   wire.cable is the Cable column of either end — a cavity or a splice row ('' when neither names one; harness-cable.js groups the
 *   wires into cables and sets wire.cableName, which the CSV writes) and wire.cableConflict the two names when the ends disagree.
 *   wire.rows are the model's records that describe the wire (its cavity and/or splice rows).
 *   key identifies the wire for its optional length (model.wireLengths[key]); it is the two ends' names, sorted.
 *   problem: '' or why the row needs a look (the two ends list different wires, the other end is missing…).
 * harnessBom(model, wires) → { connectors, boots, splices, terminals, plugs, ends, wire } — each a list of
 *   { part, count, used: [block ids], … }; wire entries add { length, missingLengths }.
 * Wire lengths are optional: model.wireLengths = { key: millimetres }, shown and entered in model.lengthUnit ('mm' default; see
 * harnessSetLength). Nothing needs them; wire.length and the BOM totals are in model.lengthUnit.
 */

var HB_LENGTH_UNITS = ['mm', 'cm', 'in', 'ft'];
var HB_UNIT_MM = { mm: 1, cm: 10, in: 25.4, ft: 304.8 };

/** Lengths are stored in millimetres; this is only the unit they are shown and entered in. */
function harnessSetLengthUnit(model, unit) {
    if (HB_UNIT_MM[unit]) model.lengthUnit = unit;
}

/** Store a length entered in the harness's unit (blank or 0 clears it). */
function harnessSetLength(model, key, value) {
    var v = parseFloat(value), lengths = model.wireLengths = model.wireLengths || {};
    if (isFinite(v) && v > 0) lengths[key] = v * HB_UNIT_MM[model.lengthUnit || 'mm']; else delete lengths[key];
}

function hbShown(model, mm) {
    return Math.round(mm / HB_UNIT_MM[model.lengthUnit || 'mm'] * 1000) / 1000;
}
var HB_NO_PART = /^(|n\/a|na|none|-|tbd|\?|empty|unused|not used)$/i;

function hbPart(v) {
    var t = harnessText(v).replace(/\s+/g, ' ');
    return HB_NO_PART.test(t) ? '' : t;
}

/** Gauge and colours of a wire description ("22 AWG White/Orange"), ignoring shield wording; the text itself when unreadable. */
function hbWireLook(text) {
    var look = typeof hdWireStyle === 'function' ? hdWireStyle(text).label : '';
    return (look || text).toLowerCase();
}

function hbWireKey(a, b) {
    return a < b ? a + '||' + b : b + '||' + a;
}

/** Length of a wire in the harness's unit, or null when none is entered. */
function hbLength(model, key) {
    var n = parseFloat((model.wireLengths || {})[key]);
    return isFinite(n) && n > 0 ? hbShown(model, n) : null;
}

function harnessCutList(model) {
    var index = harnessIndex(model), wires = [], seen = {}, rowUsed = {};   // rowUsed: splice rows ("SPLICE#k") already in a wire
    var reached = {}, noEnd = [];   // reached: cavities that are the far end of a wire; noEnd: cavities with no other end given
    function pinEnd(connector, pin, cavity) {
        return { label: harnessEndpointName(connector.id, pin ? pin.cavity : cavity), kind: pin ? 'pin' : 'missing', block: connector.id,
                 terminal: pin ? hbPart(pin.terminal) : '' };
    }
    function farEnd(res, text) {
        if (res.kind === 'pin') return pinEnd(res.connector, res.pin, res.cavity);
        if (res.kind === 'splice') return { label: res.splice.id, kind: 'splice', block: res.splice.id, terminal: hbPart(res.splice.type) };
        if (res.kind === 'none' && res.terminal) {
            return { label: res.label + (res.note ? ' (' + res.note + ')' : ''), kind: 'terminal', block: '', terminal: res.label };
        }
        if (res.kind === 'none') return { label: '', kind: 'none', block: '', terminal: '' };
        return { label: harnessText(text), kind: res.kind === 'external' ? 'outside' : 'missing', block: '', terminal: '' };
    }
    /** The splice row (index) whose end is this connector pin. */
    function spliceRowFor(splice, pin) {
        for (var k = 0; k < splice.wires.length; k++) {
            var r = harnessResolve(index, splice.wires[k].end);
            if (r.kind === 'pin' && r.pin === pin) return k;
        }
        return -1;
    }
    function add(key, from, to, a, b) {
        if (seen[key]) return;
        seen[key] = true;
        var pa = hbPart(a.wirePn), pb = b ? hbPart(b.wirePn) : '', da = harnessText(a.wire), db = b ? harnessText(b.wire) : '';
        var problem = '', samePart = pa && pb && pa.toLowerCase() === pb.toLowerCase();
        if (b && !harnessHasWire(b)) {
            problem = 'The other end (' + to.label + ') lists no wire.';
        } else if (b && pa && pb && !samePart) {
            problem = 'The two ends list different wires (' + pa + ' / ' + pb + ').';
        } else if (b && da && db && hbWireLook(da) !== hbWireLook(db)) {
            problem = 'The two ends describe the wire differently (' + da + ' / ' + db + ').';
        } else if (to.kind === 'missing') problem = to.label ? 'The other end (' + to.label + ') is not in this harness.' : 'The other end does not exist.';
        else if (to.kind === 'none') problem = 'No other end is given.';
        var ca = harnessText(a.cable), cb = b ? harnessText(b.cable) : '';
        wires.push({ key: key, from: from, to: to, wirePn: pa || pb, wire: da || db, function: harnessText(a.function) || (b ? harnessText(b.function) : ''),
                     length: hbLength(model, key), problem: problem, cable: ca || cb, rows: b ? [a, b] : [a],
                     cableConflict: ca && cb && ca.toLowerCase() !== cb.toLowerCase() ? [ca, cb] : null });
    }

    model.connectors.forEach(function (c) {
        c.pins.forEach(function (p) {
            if (!harnessHasWire(p)) return;
            var from = pinEnd(c, p), res = harnessResolve(index, p.remote), to = farEnd(res, p.remote), other = null, toKey = to.label;
            // A cavity with no remote of its own may be the far end of another cavity's wire: decide after every wire is known.
            if (to.kind === 'none') { noEnd.push([from, p]); return; }
            if (res.kind === 'pin') { other = res.pin; reached[to.label] = true; }
            else if (res.kind === 'splice') {
                var k = spliceRowFor(res.splice, p);
                other = k >= 0 ? res.splice.wires[k] : null;
                toKey = res.splice.id + '#' + (k >= 0 ? k : '?' + from.label);
                if (k >= 0) rowUsed[toKey] = true;
            } else if (to.kind === 'terminal' || to.kind === 'none') toKey = '~' + from.label;
            add(hbWireKey(from.label, toKey), from, to, p, other);
        });
    });
    noEnd.forEach(function (x) {
        if (!reached[x[0].label]) add(hbWireKey(x[0].label, '~' + x[0].label), x[0], { label: '', kind: 'none', block: '', terminal: '' }, x[1], null);
    });
    // Splice rows not reached from a connector: splice to splice, to a terminal, or to something outside.
    model.splices.forEach(function (s) {
        s.wires.forEach(function (w, k) {
            var self = s.id + '#' + k;
            if (!harnessHasWire(w) || rowUsed[self]) return;
            rowUsed[self] = true;
            var res = harnessResolve(index, w.end), from = { label: s.id, kind: 'splice', block: s.id, terminal: hbPart(s.type) };
            var otherKey = '~' + self, other = null;
            if (res.kind === 'pin') {
                otherKey = res.pin ? harnessEndpointName(res.connector.id, res.pin.cavity) : res.connector.id + '.' + res.cavity;
            } else if (res.kind === 'splice') {
                // The row of the other splice that points back here and is not in a wire yet.
                for (var m = 0; m < res.splice.wires.length; m++) {
                    var back = harnessResolve(index, res.splice.wires[m].end), key = res.splice.id + '#' + m;
                    if (back.kind === 'splice' && back.splice === s && !rowUsed[key]) { otherKey = key; other = res.splice.wires[m]; rowUsed[key] = true; break; }
                }
            }
            add(hbWireKey(self, otherKey), from, farEnd(res, w.end), w, other);
        });
    });
    return wires;
}

/** Bill of materials. wires: harnessCutList(model) (worked out when not given). */
function harnessBom(model, wires) {
    wires = wires || harnessCutList(model);
    function tally() {
        var by = {}, list = [];
        return {
            add: function (part, used, extra) {
                if (!part) return;
                var k = part.toLowerCase();
                if (!by[k]) { by[k] = Object.assign({ part: part, count: 0, used: [] }, extra || {}); list.push(by[k]); }
                by[k].count++;
                if (used && by[k].used.indexOf(used) < 0) by[k].used.push(used);
                return by[k];
            },
            list: function () { return list.sort(function (a, b) { return b.count - a.count || a.part.localeCompare(b.part); }); }
        };
    }
    var connectors = tally(), boots = tally(), splices = tally(), terminals = tally(), plugs = tally(), ends = tally(), wire = tally();
    var unnamed = { connectors: 0, terminals: 0 };
    model.connectors.forEach(function (c) {
        var part = hbPart(c.connector);
        if (part) connectors.add(part, c.id); else unnamed.connectors++;
        boots.add(hbPart(c.boot), c.id);
        c.pins.forEach(function (p) {
            if (harnessHasWire(p)) {
                if (hbPart(p.terminal)) terminals.add(hbPart(p.terminal), c.id); else unnamed.terminals++;
            } else if (/seal|plug/i.test(harnessText(p.wirePn) + ' ' + harnessText(p.wire))) {
                plugs.add(hbPart(p.wirePn) || hbPart(p.wire), c.id);
            }
        });
    });
    model.splices.forEach(function (s) {
        splices.add(hbPart(s.type) || 'Splice (type not given)', s.id);
        boots.add(hbPart(s.boot), s.id);
    });
    wires.forEach(function (w) {
        if (w.to.kind === 'terminal' && w.to.terminal !== 'Unterminated' && w.to.terminal !== 'Device') ends.add(w.to.terminal === 'Eyelet' ? 'Eyelet (ring terminal)' : w.to.terminal, w.from.block);
        var part = w.wirePn ? w.wirePn + (w.wire ? ' — ' + w.wire : '') : (w.wire || 'Wire (not described)');
        var row = wire.add(part, w.from.block, { mm: 0, missingLengths: 0 });
        var mm = parseFloat((model.wireLengths || {})[w.key]);
        if (isFinite(mm) && mm > 0) row.mm += mm; else row.missingLengths++;
    });
    wire.list().forEach(function (x) { x.length = hbShown(model, x.mm); delete x.mm; });
    return { connectors: connectors.list(), boots: boots.list(), splices: splices.list(), terminals: terminals.list(), plugs: plugs.list(),
             ends: ends.list(), wire: wire.list(), unnamed: unnamed, lengthUnit: model.lengthUnit || 'mm' };
}

/** CSV text (RFC 4180 quoting) from a header row and rows. */
function hbCsv(header, rows) {
    function cell(v) { var s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    return [header].concat(rows).map(function (r) { return r.map(cell).join(','); }).join('\r\n') + '\r\n';
}

function harnessCutListCsv(model, wires) {
    var unit = model.lengthUnit || 'mm';
    return hbCsv(['#', 'From', 'From terminal', 'To', 'To terminal', 'Wire part number', 'Wire', 'Cable', 'Function', 'Length (' + unit + ')', 'Note'],
        (wires || harnessCutList(model)).map(function (w, i) {
            return [i + 1, w.from.label, w.from.terminal, w.to.label, w.to.kind === 'terminal' ? '' : w.to.terminal, w.wirePn, w.wire, w.cableName || '',
                    w.function, w.length === null ? '' : w.length, w.problem];
        }));
}

function harnessBomCsv(model, bom) {
    bom = bom || harnessBom(model);
    var rows = [], unit = bom.lengthUnit;
    function section(name, list, fn) { list.forEach(function (x) { rows.push([name].concat(fn(x))); }); }
    var plain = function (x) { return [x.part, x.count, '', x.used.join(' ')]; };
    section('Connector', bom.connectors, plain);
    section('Boot', bom.boots, plain);
    section('Splice', bom.splices, plain);
    section('Terminal', bom.terminals, plain);
    section('Cavity plug', bom.plugs, plain);
    section('Wire end', bom.ends, plain);
    section('Wire', bom.wire, function (x) {
        return [x.part, x.count, x.length ? +x.length.toFixed(3) + ' ' + unit + (x.missingLengths ? ' (' + x.missingLengths + ' without a length)' : '') : '', x.used.join(' ')];
    });
    return hbCsv(['Kind', 'Part', 'Quantity', 'Total length', 'Used in'], rows);
}

/** Point lengths at a connector's new name (keys use "CONNECTOR.CAVITY"). */
function harnessRenameLengths(model, oldId, newId) {
    var lengths = model.wireLengths;
    if (!lengths) return;
    Object.keys(lengths).forEach(function (k) {
        var parts = k.split('||').map(function (p) { return p.indexOf(oldId + '.') === 0 ? newId + p.slice(oldId.length) : p === oldId ? newId : p; });
        var nk = hbWireKey(parts[0], parts[1]);
        if (nk !== k) { lengths[nk] = lengths[k]; delete lengths[k]; }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { harnessCutList: harnessCutList, harnessBom: harnessBom, harnessCutListCsv: harnessCutListCsv, harnessBomCsv: harnessBomCsv,
        hbWireKey: hbWireKey, harnessRenameLengths: harnessRenameLengths, harnessSetLengthUnit: harnessSetLengthUnit, harnessSetLength: harnessSetLength };
}
