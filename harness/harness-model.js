/**
 * harness/harness-model.js — Wiring harness model: workbook import/export, endpoint resolution
 * and consistency checks.
 *
 * Model (plain JSON, stored as-is):
 *   { name, sheets: [{ name, kind: 'connectors' | 'splices' }],
 *     connectors: [{ id, title, sheet, connector, boot, mateConn, matePin, notes, columns,
 *                    pins: [{ cavity, terminal, wirePn, wire, function, note, remote, status }] }],
 *     splices:    [{ id, sheet, type, boot, notes, columns,
 *                    wires: [{ end, wirePn, wire, function }] }] }
 *
 * Workbook layout (one block per connector or splice, blank rows between blocks):
 *   <title>
 *   CONNECTOR | <part>          (or SPLICE | <type>)
 *   BOOT | …, MATE CONN | …, MATE PIN | …, NOTES | …
 *   Location | Pin | Conductor Part Number | Conductor Description | Engine Function | <note column> |
 *     Remote Connection | Status                       (splices: Location | Part Number | Description | Function)
 *   one row per cavity (splices: one row per wire end)
 *
 * Remote connections are "CONNECTOR.CAVITY" (e.g. M142.C.14, CHAS.A.f) or a splice name.
 */

var HARNESS_PIN_FIELDS = ['cavity', 'terminal', 'wirePn', 'wire', 'function', 'note', 'remote', 'status'];
var HARNESS_PIN_COLUMNS = ['Location', 'Pin', 'Conductor Part Number', 'Conductor Description', 'Engine Function',
    'Notes', 'Remote Connection', 'Status'];
var HARNESS_WIRE_FIELDS = ['end', 'wirePn', 'wire', 'function'];
var HARNESS_WIRE_COLUMNS = ['Location', 'Conductor Part Number', 'Conductor Description', 'Function'];
var HARNESS_HEADER_FIELDS = { CONNECTOR: 'connector', SPLICE: 'type', BOOT: 'boot', 'MATE CONN': 'mateConn',
    'MATE PIN': 'matePin', NOTES: 'notes' };

/** Remote values that mean "no connection". */
var HARNESS_NO_REMOTE = /^(|n\/a|na|none|empty|-)$/i;
/** Wire values that mean "no wire in this cavity". */
var HARNESS_NO_WIRE = /^(|n\/a|na|none|empty|-|sealing pin|seal|plug)$/i;

function harnessText(v) {
    return v === null || v === undefined ? '' : String(v).trim();
}

/** Connector id used in remote references: "MoTeC M142 A - 34 Way" → "M142.A"; otherwise the title. */
function harnessConnectorId(title) {
    var m = title.match(/^motec\s+(m1\d\d)\s+([a-d])\b/i);
    return m ? m[1].toUpperCase() + '.' + m[2].toUpperCase() : title;
}

// ---------------------------------------------------------------------------
// Workbook import / export
// ---------------------------------------------------------------------------

/** Build a model from readXlsx() output. Sheets without connector/splice blocks are ignored. */
function harnessFromWorkbook(workbook, name) {
    var model = { name: name || 'Harness', sheets: [], connectors: [], splices: [] };
    workbook.sheets.forEach(function (sheet) {
        var rows = sheet.rows.map(function (r) { return (r || []).map(harnessText); });
        var kind = null, block = null, inTable = false;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i], first = r[0] || '';
            if (!r.some(function (v) { return v !== ''; })) { inTable = false; continue; }
            var next = rows[i + 1] ? rows[i + 1][0] || '' : '';
            if (next === 'CONNECTOR' || next === 'SPLICE') {
                var title = first;
                if (next === 'CONNECTOR') {
                    block = { id: harnessConnectorId(title), title: title, sheet: sheet.name, connector: '', boot: '',
                              mateConn: '', matePin: '', notes: '', columns: HARNESS_PIN_COLUMNS.slice(), pins: [] };
                    model.connectors.push(block);
                } else {
                    block = { id: title, sheet: sheet.name, type: '', boot: '', notes: '',
                              columns: HARNESS_WIRE_COLUMNS.slice(), wires: [] };
                    model.splices.push(block);
                }
                if (!kind) kind = next === 'CONNECTOR' ? 'connectors' : 'splices';
                inTable = false;
                continue;
            }
            if (!block) continue;
            if (!inTable && HARNESS_HEADER_FIELDS[first]) { block[HARNESS_HEADER_FIELDS[first]] = r[1] || ''; continue; }
            if (first === 'Location') {
                inTable = true;
                block.columns = r.slice(0, block.pins ? 8 : 4).map(function (h, k) {
                    return h || (block.pins ? HARNESS_PIN_COLUMNS : HARNESS_WIRE_COLUMNS)[k];
                });
                continue;
            }
            if (!inTable) continue;
            var fields = block.pins ? HARNESS_PIN_FIELDS : HARNESS_WIRE_FIELDS, rec = {};
            fields.forEach(function (f, k) { rec[f] = r[k] || ''; });
            (block.pins || block.wires).push(rec);
        }
        if (kind) model.sheets.push({ name: sheet.name, kind: kind });
    });
    if (!model.connectors.length && !model.splices.length) {
        throw new Error('No connector or splice blocks found. Each block needs a title row followed by a ' +
            '"CONNECTOR" or "SPLICE" row and a "Location" header row.');
    }
    return model;
}

/** Sheets for writeXlsx() in the same block layout harnessFromWorkbook() reads. */
function harnessToWorkbook(model) {
    var sheetNames = model.sheets.map(function (s) { return s.name; });
    function addSheet(n) { if (sheetNames.indexOf(n) < 0) sheetNames.push(n); }
    model.connectors.forEach(function (c) { addSheet(c.sheet || 'Connectors'); });
    model.splices.forEach(function (s) { addSheet(s.sheet || 'Splices'); });
    return sheetNames.map(function (sheetName) {
        var rows = [], bold = [];
        function block(title, header, columns, records, fields) {
            if (rows.length) rows.push([]);
            bold.push(rows.length);
            rows.push([title]);
            header.forEach(function (h) { rows.push([h[0], h[1] || '']); });
            bold.push(rows.length);
            rows.push(columns.slice());
            records.forEach(function (rec) { rows.push(fields.map(function (f) { return rec[f] || ''; })); });
        }
        model.connectors.filter(function (c) { return (c.sheet || 'Connectors') === sheetName; }).forEach(function (c) {
            block(c.title || c.id, [['CONNECTOR', c.connector], ['BOOT', c.boot], ['MATE CONN', c.mateConn],
                ['MATE PIN', c.matePin], ['NOTES', c.notes]], c.columns || HARNESS_PIN_COLUMNS, c.pins, HARNESS_PIN_FIELDS);
        });
        model.splices.filter(function (s) { return (s.sheet || 'Splices') === sheetName; }).forEach(function (s) {
            block(s.id, [['SPLICE', s.type], ['BOOT', s.boot], ['NOTES', s.notes]],
                s.columns || HARNESS_WIRE_COLUMNS, s.wires, HARNESS_WIRE_FIELDS);
        });
        return { name: sheetName, rows: rows, bold: bold, widths: [16, 18, 22, 34, 40, 26, 22, 12] };
    });
}

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

/** Lookup tables for resolving remote references; rebuild after edits. */
function harnessIndex(model) {
    var connectors = {}, splices = {}, lower = {};
    model.connectors.forEach(function (c) {
        var pins = {};
        c.pins.forEach(function (p) { if (p.cavity !== '') pins[p.cavity] = p; });
        connectors[c.id] = { connector: c, pins: pins };
        lower[c.id.toLowerCase()] = { kind: 'connector', id: c.id };
    });
    model.splices.forEach(function (s) {
        splices[s.id] = s;
        lower[s.id.toLowerCase()] = { kind: 'splice', id: s.id };
    });
    // Longest ids first so "SPARE.A" wins over "SPARE" when both exist.
    var ids = Object.keys(connectors).sort(function (a, b) { return b.length - a.length; });
    return { connectors: connectors, splices: splices, lower: lower, ids: ids };
}

/**
 * Resolve a remote reference.
 * Returns { kind: 'none' } | { kind: 'pin', connector, cavity, pin|null } | { kind: 'splice', splice }
 *       | { kind: 'external', text } (no dot: CHASSIS, SHIELD …) | { kind: 'unknown', text },
 * plus caseOnly (matched ignoring case) and extra (trailing text such as " (X107.H)" that was ignored).
 */
function harnessResolve(index, text) {
    var t = harnessText(text);
    if (HARNESS_NO_REMOTE.test(t)) return { kind: 'none' };
    var extra = '', m = t.match(/^(\S+)\s+\(.*\)$/);
    if (m) { extra = t.slice(m[1].length).trim(); t = m[1]; }
    function attempt(s, ci) {
        var key = ci ? s.toLowerCase() : s;
        if (ci ? index.lower[key] && index.lower[key].kind === 'splice' : index.splices[key]) {
            return { kind: 'splice', splice: index.splices[ci ? index.lower[key].id : key] };
        }
        for (var i = 0; i < index.ids.length; i++) {
            var id = index.ids[i], cmp = ci ? id.toLowerCase() : id;
            if (key.indexOf(cmp + '.') === 0 && key.length > cmp.length + 1) {
                var cavity = s.slice(id.length + 1), entry = index.connectors[id], pin = entry.pins[cavity] || null;
                if (!pin && ci) {
                    for (var c in entry.pins) if (c.toLowerCase() === cavity.toLowerCase()) { pin = entry.pins[c]; cavity = c; break; }
                }
                return { kind: 'pin', connector: entry.connector, cavity: cavity, pin: pin };
            }
        }
        return null;
    }
    var r = attempt(t, false);
    if (!r) { r = attempt(t, true); if (r) r.caseOnly = true; }
    if (!r) r = t.indexOf('.') < 0 ? { kind: 'external', text: t } : { kind: 'unknown', text: t };
    if (extra) r.extra = extra;
    return r;
}

function harnessEndpointName(connectorId, cavity) {
    return connectorId + '.' + cavity;
}

function harnessHasWire(rec) {
    return !HARNESS_NO_WIRE.test(harnessText(rec.wirePn)) || !HARNESS_NO_WIRE.test(harnessText(rec.wire));
}

/** Edit distance, for "did you mean" suggestions. */
function harnessDistance(a, b) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
        cur = [i];
        for (j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/** Closest existing endpoint name to an unresolved reference, or null. */
function harnessSuggest(model, text) {
    var best = null, bestD = Infinity, t = text.toLowerCase();
    function squash(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }
    function consider(name) {
        // Same characters apart from dots/case ("M142.D15" → "M142.D.15") beats any other near miss.
        var d = squash(name) === squash(text) ? -1 : harnessDistance(t, name.toLowerCase());
        if (d < bestD) { bestD = d; best = name; }
    }
    model.splices.forEach(function (s) { consider(s.id); });
    model.connectors.forEach(function (c) {
        c.pins.forEach(function (p) { if (p.cavity !== '') consider(harnessEndpointName(c.id, p.cavity)); });
    });
    return best && (bestD <= 1 || (bestD === 2 && t.length >= 10)) ? best : null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Consistency checks. Returns [{ severity: 'error' | 'warning', where, message, target, ref, fix }]:
 *   where  — endpoint or block the issue belongs to ("M142.C.1", "M142.SPL.0VA1")
 *   target — related endpoint/block to jump to, or null
 *   ref    — the row it came from: { kind: 'pin' | 'wire', block, index } (null for block-level issues)
 *   fix    — suggested replacement for that row's remote/end (unknown references only), or null
 */
function harnessCheck(model) {
    var index = harnessIndex(model), issues = [], reported = {}, ref = null;
    function add(severity, where, message, target, fix) {
        issues.push({ severity: severity, where: where, message: message, target: target || null, ref: ref, fix: fix || null });
    }
    function pairOnce(tag, a, b) {
        var key = tag + ':' + [a, b].sort().join('|');
        if (reported[key]) return false;
        reported[key] = true;
        return true;
    }

    var seen = {};
    ref = null;
    model.connectors.concat(model.splices).forEach(function (b) {
        if (!b.id) add('error', '(unnamed)', 'A ' + (b.pins ? 'connector' : 'splice') + ' has no name.');
        else if (seen[b.id.toLowerCase()]) add('error', b.id, 'Name "' + b.id + '" is used by more than one connector or splice.');
        seen[(b.id || '').toLowerCase()] = true;
    });

    function sameWire(a, b, here, there) {
        var pa = harnessText(a.wirePn), pb = harnessText(b.wirePn);
        if (pa && pb && !HARNESS_NO_WIRE.test(pa) && !HARNESS_NO_WIRE.test(pb) && pa !== pb && pairOnce('wire', here, there)) {
            add('warning', here, 'Wire part number differs from the other end ' + there + ': "' + pa + '" vs "' + pb + '".', there);
        }
    }

    function describe(r, raw, here, wire, backOk) {
        if (r.caseOnly) add('warning', here, '"' + raw + '" only matches ignoring upper/lower case.', null);
        if (r.extra) add('warning', here, 'Extra text "' + r.extra + '" after the connection was ignored.', null);
        if (r.kind === 'unknown') {
            var s = harnessSuggest(model, r.text);
            add('error', here, 'Goes to "' + r.text + '", which is not a connector pin or splice in this harness' +
                (s ? ' — did you mean ' + s + '?' : '.'), s, s);
            return;
        }
        if (r.kind === 'external') {
            add('warning', here, 'Goes to "' + r.text + '", which is not defined in this harness.', null);
            return;
        }
        if (r.kind === 'pin') {
            var there = harnessEndpointName(r.connector.id, r.cavity);
            if (!r.pin) { add('error', here, 'Goes to ' + there + ', but ' + r.connector.id + ' has no cavity "' + r.cavity + '".', null); return; }
            var back = harnessResolve(index, r.pin.remote);
            if (!backOk(back) && pairOnce('link', here, there)) {
                add('error', here, 'Goes to ' + there + ', but ' + there + ' goes to ' +
                    (back.kind === 'none' ? 'nothing' : '"' + harnessText(r.pin.remote) + '"') + '.', there);
            }
            if (harnessHasWire(wire) && !harnessHasWire(r.pin) && pairOnce('empty', here, there)) {
                add('warning', here, 'Has a wire, but ' + there + ' has no wire listed.', there);
            }
            sameWire(wire, r.pin, here, there);
        }
        if (r.kind === 'splice') {
            // `here` is a connector endpoint, or a splice name when two splices are chained together.
            var listed = null;
            r.splice.wires.forEach(function (w) {
                var e = harnessResolve(index, w.end);
                if ((e.kind === 'pin' && harnessEndpointName(e.connector.id, e.cavity) === here) ||
                    (e.kind === 'splice' && e.splice.id === here)) listed = w;
            });
            if (!listed && pairOnce('link', here, r.splice.id)) {
                add('error', here, 'Goes to splice ' + r.splice.id + ', but the splice does not list ' + here + '.', r.splice.id);
            } else if (listed) sameWire(wire, listed, here, r.splice.id);
        }
    }

    model.connectors.forEach(function (c) {
        var cavities = {};
        c.pins.forEach(function (p, i) {
            ref = { kind: 'pin', block: c.id, index: i };
            var here = harnessEndpointName(c.id, p.cavity);
            if (p.cavity === '') { add('error', c.id, 'A row has no cavity/location.'); return; }
            if (cavities[p.cavity]) add('error', here, 'Cavity "' + p.cavity + '" appears more than once in ' + c.id + '.');
            cavities[p.cavity] = true;
            var r = harnessResolve(index, p.remote);
            if (r.kind === 'none') {
                if (harnessHasWire(p)) add('warning', here, 'Has a wire (' + (p.wire || p.wirePn) + ') but no remote connection.');
                return;
            }
            if (!harnessHasWire(p)) add('warning', here, 'Has a remote connection but no wire listed.');
            describe(r, harnessText(p.remote), here, p, function (back) {
                return back.kind === 'pin' && back.connector.id === c.id && back.cavity === p.cavity;
            });
        });
    });

    model.splices.forEach(function (s) {
        ref = null;
        if (s.wires.length < 2) add('warning', s.id, 'Splice joins fewer than two wires.');
        s.wires.forEach(function (w, i) {
            ref = { kind: 'wire', block: s.id, index: i };
            var r = harnessResolve(index, w.end), raw = harnessText(w.end);
            if (r.kind === 'none') { add('error', s.id, 'A wire in the splice has no location.'); return; }
            if (r.kind === 'splice' && r.splice.id === s.id) { add('error', s.id, 'Splice lists itself as a wire end.'); return; }
            describe(r, raw, s.id, w, function (back) { return back.kind === 'splice' && back.splice.id === s.id; });
        });
    });
    ref = null;
    return issues;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        harnessFromWorkbook: harnessFromWorkbook, harnessToWorkbook: harnessToWorkbook, harnessIndex: harnessIndex,
        harnessResolve: harnessResolve, harnessCheck: harnessCheck, harnessConnectorId: harnessConnectorId,
        harnessHasWire: harnessHasWire, harnessEndpointName: harnessEndpointName, harnessText: harnessText,
        HARNESS_PIN_FIELDS: HARNESS_PIN_FIELDS, HARNESS_WIRE_FIELDS: HARNESS_WIRE_FIELDS
    };
}
