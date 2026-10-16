/**
 * lib/m1pkg-parser.js — MoTeC M1 .m1pkg Package Parser (shared utility)
 * Extracts every named calibration value, calibration selection and package metadata
 * from an M1 Tune package, and diffs two packages. Requires lib/xz-decoder.js.
 *
 * Format (reverse engineered, big endian):
 *   Node  = 'Mo' u16 flags | u8 a | u8 b | u16 tag | u32 len | payload padded to 4 bytes.
 *           (a,b) = (1,0) container of nodes; (0,1,0) string; (1,1,8) small int; (0,1,7) blob/timestamp.
 *   Root  > (1,0,9) key/value list: Summary.*, comment.log, modified.utc, pkg.calibrations, ...
 *   Firmware metadata is an embedded XZ stream holding the TuneConfig XML: every item's name,
 *   address (Base 0 = .ecu_cal), type (f32/s32/u32/enum), enums and table MaxSites.
 *   The .ecu_cal image is stored as one (2,0,10) chunk per security group (flags = group << 8):
 *   child (2,1,10) starts with the u32 section offset, child (0,1,7) holds the bytes.
 *   Two copies exist: container (2,0,7) = working tune (edits land here), (2,0,65) = signed baseline.
 */

if (typeof xzDecompress === 'undefined' && typeof require !== 'undefined') {
    var xzDecompress = require('./xz-decoder.js').xzDecompress;
    var xzFindStream = require('./xz-decoder.js').xzFindStream;
}

var M1PKG_PARSER_VERSION = 2;   // bump when extracted output changes so stored imports can be re-parsed
var M1PKG_COPY_TAGS = { working: 7, baseline: 65 };
var M1PKG_TYPE_SIZES = { f32: 4, s32: 4, s32e7: 4, u32: 4, enum: 4 };   // s32e7 = s32 x 1e-7 (GPS degrees)

// =========================================================================
// Mo node tree
// =========================================================================

function m1pkgNodes(bytes, off, end) {
    var out = [];
    while (off + 12 <= end && bytes[off] === 0x4D && bytes[off + 1] === 0x6F) {
        var len = ((bytes[off + 8] << 24) | (bytes[off + 9] << 16) | (bytes[off + 10] << 8) | bytes[off + 11]) >>> 0;
        var p = off + 12;
        if (p + len > end) break;
        out.push({
            flags: (bytes[off + 2] << 8) | bytes[off + 3],
            a: bytes[off + 4], b: bytes[off + 5],
            tag: (bytes[off + 6] << 8) | bytes[off + 7],
            p: p, len: len
        });
        off = p + ((len + 3) & ~3);
    }
    return out;
}

function m1pkgIs(n, a, b, tag) { return n.a === a && n.b === b && n.tag === tag; }

function m1pkgFindAll(bytes, off, end, pred, acc) {
    var list = m1pkgNodes(bytes, off, end);
    for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (pred(n)) acc.push(n);
        if (n.len >= 12) m1pkgFindAll(bytes, n.p, n.p + n.len, pred, acc);
    }
    return acc;
}

function m1pkgLatin1(bytes, p, len) {
    var s = '';
    for (var i = 0; i < len; i += 8192) {
        s += String.fromCharCode.apply(null, bytes.subarray(p + i, p + Math.min(len, i + 8192)));
    }
    return s;
}

/** SYSTEMTIME (8 x u16 little endian) → ISO string. */
function m1pkgTimestamp(bytes, p) {
    var w = [];
    for (var i = 0; i < 8; i++) w.push(bytes[p + i * 2] | (bytes[p + i * 2 + 1] << 8));
    var pad = function (v, n) { v = String(v); while (v.length < n) v = '0' + v; return v; };
    return pad(w[0], 4) + '-' + pad(w[1], 2) + '-' + pad(w[3], 2) + 'T' +
        pad(w[4], 2) + ':' + pad(w[5], 2) + ':' + pad(w[6], 2) + '.' + pad(w[7], 3) + 'Z';
}

/** Decode a value node from the metadata key/value lists. */
function m1pkgValue(bytes, n) {
    if (m1pkgIs(n, 0, 1, 0)) return m1pkgLatin1(bytes, n.p, n.len);
    if (m1pkgIs(n, 1, 1, 8)) {
        return (bytes[n.p + 1] | (bytes[n.p + 2] << 8) | (bytes[n.p + 3] << 16) | (bytes[n.p + 4] << 24)) >>> 0;
    }
    if (m1pkgIs(n, 0, 1, 7) && n.len === 16) return m1pkgTimestamp(bytes, n.p);
    if (m1pkgIs(n, 1, 0, 9)) return m1pkgKeyValues(bytes, n);
    if (m1pkgIs(n, 1, 0, 21)) return m1pkgCommentLog(bytes, n);
    return null;
}

function m1pkgKeyValues(bytes, list) {
    var out = {};
    var pairs = m1pkgNodes(bytes, list.p, list.p + list.len);
    for (var i = 0; i < pairs.length; i++) {
        var kv = m1pkgNodes(bytes, pairs[i].p, pairs[i].p + pairs[i].len);
        if (kv.length < 2 || !m1pkgIs(kv[0], 0, 1, 0)) continue;
        out[m1pkgLatin1(bytes, kv[0].p, kv[0].len)] = m1pkgValue(bytes, kv[1]);
    }
    return out;
}

function m1pkgCommentLog(bytes, n) {
    var entries = m1pkgNodes(bytes, n.p, n.p + n.len), out = [];
    for (var i = 0; i < entries.length; i++) {
        var f = m1pkgNodes(bytes, entries[i].p, entries[i].p + entries[i].len), e = {};
        for (var k = 0; k < f.length; k++) {
            if (m1pkgIs(f[k], 0, 1, 7) && f[k].len === 16) e.time = m1pkgTimestamp(bytes, f[k].p);
            else if (m1pkgIs(f[k], 0, 1, 0)) e[f[k].flags ? 'note' : 'title'] = m1pkgLatin1(bytes, f[k].p, f[k].len);
        }
        out.push(e);
    }
    return out;
}

/** All top-level key/value metadata of the package. */
function m1pkgReadMeta(bytes) {
    var root = m1pkgNodes(bytes, 0, bytes.length)[0], meta = {};
    if (!root) throw new Error('Not an M1 package (missing Mo header)');
    var top = m1pkgNodes(bytes, root.p, root.p + root.len);
    for (var i = 0; i < top.length; i++) {
        if (!m1pkgIs(top[i], 1, 0, 9)) continue;
        var kv = m1pkgKeyValues(bytes, top[i]);
        for (var k in kv) meta[k] = kv[k];
    }
    return meta;
}

/**
 * Calibration selections (sensor/injector/fuel library entries) from pkg.calibrations.
 * Key "Fuel.Injector.Secondary.Calibration.Proxy" → "Injector Dynamics ID850.1.0".
 */
function m1pkgSelections(meta) {
    var src = meta['pkg.calibrations'] || {}, out = [];
    for (var key in src) {
        var m = /^(.*)\.(\d+)\.(\d+)$/.exec(src[key]);
        out.push({
            slot: key.replace(/\.Proxy$/, ''),
            name: m ? m[1] : src[key],
            version: m ? m[2] + '.' + m[3] : null,
            raw: src[key]
        });
    }
    out.sort(function (x, y) { return x.slot < y.slot ? -1 : x.slot > y.slot ? 1 : 0; });
    return out;
}

/** Rebuild the .ecu_cal image for the requested copy ('working' or 'baseline'). */
function m1pkgCalImage(bytes, copy) {
    var tag = M1PKG_COPY_TAGS[copy];
    if (tag === undefined) throw new Error('Unknown calibration copy: ' + copy);
    var conts = m1pkgFindAll(bytes, 0, bytes.length, function (n) { return m1pkgIs(n, 2, 0, tag); }, []);
    for (var c = 0; c < conts.length; c++) {
        var chunks = m1pkgNodes(bytes, conts[c].p, conts[c].p + conts[c].len).filter(function (n) {
            return m1pkgIs(n, 2, 0, 10);
        });
        if (!chunks.length) continue;
        var parts = [], size = 0;
        for (var i = 0; i < chunks.length; i++) {
            var kids = m1pkgNodes(bytes, chunks[i].p, chunks[i].p + chunks[i].len);
            var h = kids[0].p;
            var start = ((bytes[h] << 24) | (bytes[h + 1] << 16) | (bytes[h + 2] << 8) | bytes[h + 3]) >>> 0;
            parts.push({ start: start, data: bytes.subarray(kids[1].p, kids[1].p + kids[1].len) });
            size = Math.max(size, start + kids[1].len);
        }
        var img = new Uint8Array(size);
        for (var j = 0; j < parts.length; j++) img.set(parts[j].data, parts[j].start);
        return img;
    }
    throw new Error('No ' + copy + ' calibration found in package');
}

// =========================================================================
// TuneConfig XML (minimal element-tree parser; text is ignored except CDATA)
// =========================================================================

function m1pkgFindTuneConfig(bytes) {
    var at = 0;
    while ((at = xzFindStream(bytes, at)) >= 0) {
        var out = xzDecompress(bytes, at);
        var head = m1pkgLatin1(out, 0, Math.min(out.length, 400));
        var x = head.indexOf('<TuneConfig');
        if (x >= 0) return m1pkgLatin1(out, head.indexOf('<?xml') >= 0 ? head.indexOf('<?xml') : x, out.length);
        at += 6;
    }
    throw new Error('Firmware TuneConfig not found in package');
}

function m1pkgXmlDecode(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
        if (e[0] === '#') return String.fromCharCode(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    });
}

function m1pkgParseXml(xml) {
    var root = { tag: '#root', attrs: {}, children: [], text: '' }, stack = [root], i = 0;
    var attrRe = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (;;) {
        var lt = xml.indexOf('<', i);
        if (lt < 0) break;
        var top = stack[stack.length - 1];
        if (xml.startsWith('<![CDATA[', lt)) {
            var ce = xml.indexOf(']]>', lt);
            top.text += xml.slice(lt + 9, ce);
            i = ce + 3; continue;
        }
        if (xml.startsWith('<!--', lt)) { i = xml.indexOf('-->', lt) + 3; continue; }
        if (xml[lt + 1] === '?' || xml[lt + 1] === '!') { i = xml.indexOf('>', lt) + 1; continue; }
        var gt = xml.indexOf('>', lt);
        if (xml[lt + 1] === '/') { stack.pop(); i = gt + 1; continue; }
        var body = xml.slice(lt + 1, gt), selfClose = body[body.length - 1] === '/';
        if (selfClose) body = body.slice(0, -1);
        var sp = body.search(/\s/);
        var el = { tag: sp < 0 ? body : body.slice(0, sp), attrs: {}, children: [], text: '' };
        if (sp >= 0) {
            attrRe.lastIndex = 0;
            var m;
            while ((m = attrRe.exec(body))) el.attrs[m[1]] = m1pkgXmlDecode(m[2] !== undefined ? m[2] : m[3]);
        }
        top.children.push(el);
        if (!selfClose) stack.push(el);
        i = gt + 1;
    }
    return root;
}

function m1pkgChild(el, tag) {
    if (!el) return null;
    for (var i = 0; i < el.children.length; i++) if (el.children[i].tag === tag) return el.children[i];
    return null;
}

function m1pkgChildren(el, tag) {
    return el ? el.children.filter(function (c) { return c.tag === tag; }) : [];
}

// =========================================================================
// Item extraction
// =========================================================================

function m1pkgReadWords(view, type, off, n) {
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
        var o = off + i * 4;
        out[i] = type === 'f32' ? view.getFloat32(o, false) :
            type === 's32' ? view.getInt32(o, false) :
            type === 's32e7' ? view.getInt32(o, false) / 1e7 : view.getUint32(o, false);
    }
    return out;
}

/** Address of a <Value> element in .ecu_cal, or -1 if it lives elsewhere (RAM channels etc.). */
function m1pkgCalAddress(valueEl) {
    var a = m1pkgChild(valueEl, 'Address');
    if (!a || a.attrs.Base !== '0') return -1;
    return parseInt(a.attrs.Offset, 16);
}

/** Number of used axis sites: M1 axes are strictly increasing; unused sites repeat the last value. */
function m1pkgUsedSites(values) {
    var n = values.length;
    while (n > 1 && values[n - 1] === values[n - 2]) n--;
    return n;
}

function m1pkgTags(props) {
    var t = m1pkgChild(props, 'Tags');
    return t && t.text.trim() ? t.text.trim().split(',') : [];
}

function m1pkgExtractItems(config, img, enums) {
    var view = new DataView(img.buffer, img.byteOffset, img.byteLength), items = [];

    function readValue(valueEl, n) {
        var off = m1pkgCalAddress(valueEl);
        if (off < 0 || off + 4 * n > img.length) return null;
        return { offset: off, values: m1pkgReadWords(view, valueEl.attrs.Type, off, n) };
    }

    // Display unit + decimal places per item name. Tables and axes borrow these from their
    // output/input channels, which may be defined anywhere in the tree, so they resolve after the walk.
    var locales = {}, tables = [];

    function locale(props) {
        var loc = m1pkgChild(props, 'DefaultLocale');
        if (!loc) return { unit: null, dps: null };
        return {
            unit: loc.attrs.DisplayUnit || null,
            dps: loc.attrs.DisplayDPS !== undefined ? parseInt(loc.attrs.DisplayDPS, 10) : null
        };
    }

    function visit(el, path) {
        var kids = m1pkgChild(el, 'Items') ? m1pkgChild(el, 'Items').children : [];
        for (var i = 0; i < kids.length; i++) {
            var it = kids[i], name = path.concat([it.attrs.Name]);
            var kind = it.tag.replace(/^BuiltIn\./, ''), props = m1pkgChild(it, 'Properties');
            if (props) {
                if (m1pkgChild(props, 'DefaultLocale')) locales[name.join('.')] = locale(props);
                extract(it, kind, props, name.join('.'));
            }
            visit(it, name);
        }
    }

    function extract(it, kind, props, name) {
        var body = m1pkgChild(props, 'Body');
        var value = m1pkgChild(props, 'Value');
        if (body && m1pkgChild(body, 'Value')) {
            var axes = [], cells = 1;
            ['X', 'Y', 'Z'].forEach(function (ax) {
                var a = m1pkgChild(props, ax);
                if (!a) return;
                var sites = parseInt(a.attrs.MaxSites, 10), av = m1pkgChild(a, 'Value');
                var r = readValue(av, sites);
                cells *= sites;
                axes.push({
                    axis: ax, input: a.attrs.ItemInput || null, type: av.attrs.Type,
                    unit: av.attrs.Unit || null, displayUnit: null, dps: null, maxSites: sites,
                    sites: r ? m1pkgUsedSites(r.values) : null,
                    values: r ? r.values : null
                });
            });
            var bv = m1pkgChild(body, 'Value'), rb = readValue(bv, cells);
            if (!rb) return;
            var table = {
                name: name, kind: kind, type: bv.attrs.Type, unit: bv.attrs.Unit || null,
                displayUnit: null, dps: null, output: body.attrs.ItemOutput || null,
                tags: m1pkgTags(props), offset: rb.offset, axes: axes, values: rb.values
            };
            items.push(table); tables.push(table);
            return;
        }
        if (!value || kind === 'Channel' || kind === 'CalibrationChannel') return;
        var off = m1pkgCalAddress(value);
        if (off < 0) return;
        if (/^IOResource/.test(kind)) {
            // 5 x u32 resource (pin) IDs; pin names are defined by M1 Tune, not the package.
            var ids = m1pkgReadWords(view, 'u32', off, 5).map(function (v) {
                return '0x' + ('0000' + v.toString(16)).slice(-4);
            });
            items.push({
                name: name, kind: kind, type: 'io_resource', unit: null, displayUnit: null, dps: null,
                tags: m1pkgTags(props), offset: off,
                methods: m1pkgChildren(value, 'IOMethod').map(function (m) { return m.attrs.Name; }),
                value: ids
            });
            return;
        }
        var type = value.attrs.Type;
        if (!M1PKG_TYPE_SIZES[type]) return;
        var v = m1pkgReadWords(view, type, off, 1)[0];
        var loc = locale(props);
        var rec = {
            name: name, kind: kind, type: type, unit: value.attrs.Unit || null,
            displayUnit: loc.unit, dps: loc.dps, tags: m1pkgTags(props), offset: off, value: v
        };
        if (type === 'enum') {
            var e = enums[value.attrs.EnumID];
            rec.label = e && e[v] !== undefined ? e[v] : null;
        }
        items.push(rec);
    }

    visit(m1pkgChild(config, 'Device'), []);
    tables.forEach(function (t) {
        var out = locales[t.output] || {};
        t.displayUnit = out.unit || null; t.dps = out.dps !== undefined ? out.dps : null;
        t.axes.forEach(function (a) {
            var inp = locales[a.input] || {};
            a.displayUnit = inp.unit || null; a.dps = inp.dps !== undefined ? inp.dps : null;
        });
    });
    return items;
}

// =========================================================================
// Public API
// =========================================================================

/**
 * Parse an .m1pkg (ArrayBuffer or Uint8Array).
 * options.copy: 'working' (default — the tune as last saved) or 'baseline' (signed copy).
 * Returns a JSON-serialisable object:
 *   { parserVersion, meta, firmware, tuneName, modified, serial, commentLog, selections, copy, items }
 */
function parseM1Pkg(input, options) {
    var opts = options || {};
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var meta = m1pkgReadMeta(bytes);
    var img = m1pkgCalImage(bytes, opts.copy || 'working');
    var config = m1pkgChild(m1pkgParseXml(m1pkgFindTuneConfig(bytes)), 'TuneConfig');

    var enums = {};
    m1pkgChildren(m1pkgChild(config, 'EnumTable'), 'Enum').forEach(function (e) {
        var map = {};
        m1pkgChildren(e, 'EnumItem').forEach(function (i) { map[parseInt(i.attrs.Value, 10)] = i.attrs.Name; });
        enums[e.attrs.ID] = map;
    });
    var tuneData = m1pkgChild(m1pkgChild(config, 'Device'), 'TuneData');

    var commentLog = meta['comment.log'] || [];
    var summary = {};
    for (var k in meta) if (k !== 'comment.log' && k !== 'pkg.calibrations') summary[k] = meta[k];

    return {
        parserVersion: M1PKG_PARSER_VERSION,
        meta: summary,
        firmware: {
            name: meta['Summary.Firmware'] || null,
            version: meta['Summary.Firmware Version'] || null,
            id: tuneData ? tuneData.attrs.FirmwareID || null : null
        },
        tuneName: meta['Summary.Comment'] || null,
        modified: meta['modified.utc'] || null,
        serial: meta['device.serialnum'] !== undefined ? meta['device.serialnum'] : null,
        commentLog: commentLog,
        selections: m1pkgSelections(meta),
        copy: opts.copy || 'working',
        items: m1pkgExtractItems(config, img, enums)
    };
}

/**
 * Flatten an item into individually tracked cells — one database row each.
 * Keys: '' for scalars, 'X[i]'/'Y[i]'/'Z[i]' for axis sites, 'V[x,y,z]' for table cells.
 */
function m1pkgCells(item) {
    if (!item.axes) return [{ key: '', value: item.value, label: item.label }];
    var out = [], dims = item.axes.map(function (a) { return a.maxSites; });
    item.axes.forEach(function (a) {
        (a.values || []).forEach(function (v, i) { out.push({ key: a.axis + '[' + i + ']', value: v }); });
    });
    item.values.forEach(function (v, i) {
        var idx = [], r = i;
        for (var d = 0; d < dims.length; d++) { idx.push(r % dims[d]); r = Math.floor(r / dims[d]); }
        out.push({ key: 'V[' + idx.join(',') + ']', value: v });
    });
    return out;
}

function m1pkgSame(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
        return true;
    }
    return Object.is(a, b);
}

/**
 * Diff two parsed packages (results of parseM1Pkg).
 * Returns { from, to, firmwareChanged, selections: [...], items: [{ name, change, cells }] }
 * where change is 'changed' | 'added' | 'removed'.
 */
function diffM1Pkg(a, b) {
    var sa = {}, sb = {}, selections = [];
    a.selections.forEach(function (s) { sa[s.slot] = s; });
    b.selections.forEach(function (s) { sb[s.slot] = s; });
    Object.keys(sa).concat(Object.keys(sb).filter(function (k) { return !sa[k]; })).forEach(function (slot) {
        var x = sa[slot] ? sa[slot].raw : null, y = sb[slot] ? sb[slot].raw : null;
        if (x !== y) selections.push({ slot: slot, from: x, to: y });
    });

    var ia = {}, ib = {}, items = [];
    a.items.forEach(function (i) { ia[i.name] = i; });
    b.items.forEach(function (i) { ib[i.name] = i; });
    var names = Object.keys(ia).concat(Object.keys(ib).filter(function (k) { return !ia[k]; })).sort();
    names.forEach(function (name) {
        var x = ia[name], y = ib[name];
        if (!x || !y) { items.push({ name: name, change: x ? 'removed' : 'added', item: x || y, cells: [] }); return; }
        var cx = m1pkgCells(x), cy = {}, cells = [];
        m1pkgCells(y).forEach(function (c) { cy[c.key] = c; });
        cx.forEach(function (c) {
            var d = cy[c.key];
            if (!d || !m1pkgSame(c.value, d.value)) {
                cells.push({ key: c.key, from: c.value, to: d ? d.value : null,
                    fromLabel: c.label, toLabel: d ? d.label : undefined });
            }
        });
        if (cells.length) items.push({ name: name, change: 'changed', kind: y.kind, unit: y.unit, cells: cells });
    });

    return {
        from: a.tuneName, to: b.tuneName,
        firmwareChanged: a.firmware.id !== b.firmware.id,
        selections: selections,
        items: items
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseM1Pkg: parseM1Pkg, diffM1Pkg: diffM1Pkg, m1pkgCells: m1pkgCells,
        m1pkgNodes: m1pkgNodes, m1pkgParseXml: m1pkgParseXml, m1pkgUsedSites: m1pkgUsedSites,
        M1PKG_PARSER_VERSION: M1PKG_PARSER_VERSION
    };
}
