/**
 * lib/xlsx.js — Minimal .xlsx reader and writer (no dependencies).
 *
 * readXlsx(buffer)  → Promise<{ sheets: [{ name, rows: [[text, ...], ...] }] }>
 *   Cell values as text (shared strings, inline strings, numbers, booleans); styles, formulas and
 *   images are ignored. Rows/columns keep their positions (missing cells are '').
 *   Uses DecompressionStream('deflate-raw'), available in current browsers and Node 18+.
 *
 * writeXlsx(sheets) → Uint8Array
 *   sheets: [{ name, rows: [[text, ...]], widths?: [chars, ...], bold?: [rowIndex, ...] }]
 *   Writes an uncompressed (stored) zip that Excel, LibreOffice and readXlsx open.
 */

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

function xlsxZipEntries(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not an .xlsx file (no zip directory found)');
    var count = view.getUint16(eocd + 10, true), p = view.getUint32(eocd + 16, true), entries = {};
    for (var n = 0; n < count; n++) {
        if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt .xlsx zip directory');
        var method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true);
        var nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true);
        var commentLen = view.getUint16(p + 32, true), local = view.getUint32(p + 42, true);
        var name = xlsxUtf8(bytes.subarray(p + 46, p + 46 + nameLen));
        entries[name] = { method: method, size: size, local: local };
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function xlsxZipRead(bytes, entry) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    var data = bytes.subarray(start, start + entry.size);
    if (entry.method === 0) return Promise.resolve(data);
    if (entry.method !== 8) return Promise.reject(new Error('Unsupported zip compression method ' + entry.method));
    if (typeof DecompressionStream === 'undefined') {
        return Promise.reject(new Error('This browser cannot unzip .xlsx files (DecompressionStream missing)'));
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
}

function xlsxUtf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
}

var XLSX_CRC_TABLE = null;

function xlsxCrc32(bytes) {
    if (!XLSX_CRC_TABLE) {
        XLSX_CRC_TABLE = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            XLSX_CRC_TABLE[n] = c >>> 0;
        }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = XLSX_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** Stored (uncompressed) zip of [{ name, data: Uint8Array }]. */
function xlsxZipWrite(files) {
    var enc = new TextEncoder(), locals = [], central = [], offset = 0;
    files.forEach(function (f) {
        var name = enc.encode(f.name), crc = xlsxCrc32(f.data), size = f.data.length;
        var lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
        lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
        lh.setUint16(26, name.length, true);
        locals.push(new Uint8Array(lh.buffer), name, f.data);
        var ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true);
        ch.setUint32(24, size, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + size;
    });
    var centralSize = central.reduce(function (s, b) { return s + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    var parts = locals.concat(central, [new Uint8Array(end.buffer)]);
    var out = new Uint8Array(offset + centralSize + 22), p = 0;
    parts.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xlsxUnescape(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
        if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
    });
}

function xlsxEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        // Characters XML 1.0 cannot hold at all.
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function xlsxAttr(attrs, name) {
    var m = attrs.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"'));
    return m ? xlsxUnescape(m[1]) : null;
}

/** All text in <t> elements of a fragment (plain or rich-text runs). */
function xlsxText(xml) {
    var out = '', re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, m;
    while ((m = re.exec(xml))) out += xlsxUnescape(m[1]);
    return out;
}

/** 'BC12' → column index 54. */
function xlsxColumn(ref) {
    var col = 0;
    for (var i = 0; i < ref.length; i++) {
        var c = ref.charCodeAt(i);
        if (c < 65 || c > 90) break;
        col = col * 26 + (c - 64);
    }
    return col - 1;
}

function xlsxColumnName(index) {
    var s = '';
    for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

function xlsxSheetRows(xml, shared) {
    var rows = [], rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, m;
    while ((m = rowRe.exec(xml))) {
        var r = parseInt(xlsxAttr(m[1], 'r'), 10) - 1;
        if (isNaN(r)) r = rows.length;
        var row = [], cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, c, next = 0;
        while ((c = cellRe.exec(m[2] || ''))) {
            var ref = xlsxAttr(c[1], 'r'), col = ref ? xlsxColumn(ref) : next, type = xlsxAttr(c[1], 't');
            var body = c[2] || '', v = body.match(/<v>([\s\S]*?)<\/v>/), text = '';
            if (type === 's') text = v ? shared[parseInt(v[1], 10)] || '' : '';
            else if (type === 'inlineStr') text = xlsxText(body);
            else if (type === 'b') text = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
            else text = v ? xlsxUnescape(v[1]) : '';
            while (row.length < col) row.push('');
            row[col] = text;
            next = col + 1;
        }
        while (rows.length < r) rows.push([]);
        rows[r] = row;
    }
    return rows;
}

function readXlsx(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), entries;
    try { entries = xlsxZipEntries(bytes); } catch (e) { return Promise.reject(e); }
    function text(name) {
        var e = entries[name];
        return e ? xlsxZipRead(bytes, e).then(xlsxUtf8) : Promise.resolve(null);
    }
    if (!entries['xl/workbook.xml']) return Promise.reject(new Error('Not an Excel workbook (xl/workbook.xml missing)'));
    return Promise.all([text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels'), text('xl/sharedStrings.xml')])
        .then(function (parts) {
            var shared = [], si = /<si>([\s\S]*?)<\/si>/g, m;
            while (parts[2] && (m = si.exec(parts[2]))) shared.push(xlsxText(m[1]));
            var rels = {}, relRe = /<Relationship\b([^>]*)\/?>/g;
            while (parts[1] && (m = relRe.exec(parts[1]))) rels[xlsxAttr(m[1], 'Id')] = xlsxAttr(m[1], 'Target');
            var sheets = [], sheetRe = /<sheet\b([^>]*)\/?>/g;
            while ((m = sheetRe.exec(parts[0]))) {
                var target = rels[xlsxAttr(m[1], 'r:id')] || '';
                var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
                sheets.push({ name: xlsxAttr(m[1], 'name'), path: path });
            }
            return Promise.all(sheets.map(function (s) {
                return text(s.path).then(function (xml) {
                    return { name: s.name, rows: xml ? xlsxSheetRows(xml, shared) : [] };
                });
            }));
        })
        .then(function (sheets) { return { sheets: sheets }; });
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function xlsxSheetXml(sheet) {
    var bold = {};
    (sheet.bold || []).forEach(function (r) { bold[r] = true; });
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
    if (sheet.widths && sheet.widths.length) {
        out.push('<cols>' + sheet.widths.map(function (w, i) {
            return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
        }).join('') + '</cols>');
    }
    out.push('<sheetData>');
    sheet.rows.forEach(function (row, r) {
        var cells = [];
        (row || []).forEach(function (v, c) {
            if (v === null || v === undefined || v === '') return;
            cells.push('<c r="' + xlsxColumnName(c) + (r + 1) + '" t="inlineStr"' + (bold[r] ? ' s="1"' : '') +
                '><is><t xml:space="preserve">' + xlsxEscape(v) + '</t></is></c>');
        });
        if (cells.length) out.push('<row r="' + (r + 1) + '">' + cells.join('') + '</row>');
    });
    out.push('</sheetData></worksheet>');
    return out.join('');
}

function writeXlsx(sheets) {
    var enc = new TextEncoder();
    var ns = 'http://schemas.openxmlformats.org/', rel = ns + 'officeDocument/2006/relationships';
    var files = [
        { name: '[Content_Types].xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="' + ns + 'package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            sheets.map(function (s, i) {
                return '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
                    '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
            }).join('') + '</Types>' },
        { name: '_rels/.rels', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="' + ns + 'package/2006/relationships">' +
            '<Relationship Id="rId1" Type="' + rel + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
        { name: 'xl/workbook.xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<workbook xmlns="' + ns + 'spreadsheetml/2006/main" xmlns:r="' + rel + '"><sheets>' +
            sheets.map(function (s, i) {
                // Excel sheet names: max 31 chars, no []:*?/\
                var name = String(s.name || 'Sheet' + (i + 1)).replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31);
                return '<sheet name="' + xlsxEscape(name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
            }).join('') + '</sheets></workbook>' },
        { name: 'xl/_rels/workbook.xml.rels', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="' + ns + 'package/2006/relationships">' +
            sheets.map(function (s, i) {
                return '<Relationship Id="rId' + (i + 1) + '" Type="' + rel + '/worksheet" Target="worksheets/sheet' +
                    (i + 1) + '.xml"/>';
            }).join('') +
            '<Relationship Id="rId' + (sheets.length + 1) + '" Type="' + rel + '/styles" Target="styles.xml"/>' +
            '</Relationships>' },
        { name: 'xl/styles.xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<styleSheet xmlns="' + ns + 'spreadsheetml/2006/main">' +
            '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
            '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
            '</styleSheet>' }
    ];
    sheets.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', xml: xlsxSheetXml(s) }); });
    return xlsxZipWrite(files.map(function (f) { return { name: f.name, data: enc.encode(f.xml) }; }));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readXlsx: readXlsx, writeXlsx: writeXlsx, xlsxColumn: xlsxColumn, xlsxColumnName: xlsxColumnName };
}
