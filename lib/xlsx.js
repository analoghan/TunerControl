/**
 * lib/xlsx.js — Minimal .xlsx reader and writer (no dependencies).
 *
 * readXlsx(buffer)  → Promise<{ sheets: [{ name, rows: [[text, ...], ...], images: [...] }] }>
 *   Cell values as text (shared strings, inline strings, numbers, booleans); styles and formulas are
 *   ignored. Rows/columns keep their positions (missing cells are '').
 *   images: pictures placed on the sheet, [{ row, col, cx, cy, mime, data: Uint8Array }] — row/col are the
 *   0-based cell of the picture's top-left corner, cx/cy its size in EMU (914400 per inch, 9525 per pixel).
 *   Uses DecompressionStream('deflate-raw'), available in current browsers and Node 18+.
 *
 * writeXlsx(sheets) → Uint8Array
 *   sheets: [{ name, rows: [[text, ...]], widths?: [chars, ...], bold?: [rowIndex, ...],
 *              images?: [{ row, col, cx, cy, mime, data }] }]  (PNG, JPEG or GIF)
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

/** Resolve a relationship target against the directory of the part that refers to it. */
function xlsxResolve(fromPart, target) {
    if (target.charAt(0) === '/') return target.slice(1);
    var parts = fromPart.split('/').slice(0, -1);
    target.split('/').forEach(function (seg) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
    });
    return parts.join('/');
}

function xlsxRels(xml) {
    var rels = {}, re = /<Relationship\b([^>]*)\/?>/g, m;
    while (xml && (m = re.exec(xml))) rels[xlsxAttr(m[1], 'Id')] = { target: xlsxAttr(m[1], 'Target'), type: xlsxAttr(m[1], 'Type') || '' };
    return rels;
}

var XLSX_IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

function xlsxColumnName(index) {
    var s = '';
    for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * A number cell as Excel shows it in General format: some writers (e.g. Google Sheets) store whole numbers as "26.0" and
 * long binary fractions ("0.30000000000000004"); Excel shows 26 and 0.3. Anything that isn't a plain number stays as it is.
 */
function xlsxNumberText(t) {
    if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t)) return t;
    var n = parseFloat(Number(t).toPrecision(15));
    return isFinite(n) && Math.abs(n) < 1e15 ? String(n) : t;
}

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
            else text = v ? xlsxNumberText(xlsxUnescape(v[1])) : '';
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
                return Promise.all([text(s.path), xlsxSheetImages(s.path, text, bytes, entries)]).then(function (r) {
                    return { name: s.name, rows: r[0] ? xlsxSheetRows(r[0], shared) : [], images: r[1] };
                });
            }));
        })
        .then(function (sheets) { return { sheets: sheets }; });
}

/** Pictures on a sheet (via its drawing part), in anchor order. */
function xlsxSheetImages(sheetPath, text, bytes, entries) {
    var relsPath = sheetPath.replace(/([^\/]+)$/, '_rels/$1.rels');
    return text(relsPath).then(function (relsXml) {
        var rels = xlsxRels(relsXml), drawingPath = null;
        Object.keys(rels).forEach(function (id) {
            if (/\/drawing$/.test(rels[id].type)) drawingPath = xlsxResolve(sheetPath, rels[id].target);
        });
        if (!drawingPath) return [];
        return Promise.all([text(drawingPath), text(drawingPath.replace(/([^\/]+)$/, '_rels/$1.rels'))]).then(function (d) {
            if (!d[0]) return [];
            var drels = xlsxRels(d[1]), anchors = [], re = /<(?:xdr:)?(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/(?:xdr:)?\1>/g, m;
            while ((m = re.exec(d[0]))) {
                var a = m[0], embed = a.match(/r:embed="([^"]+)"/), from = a.match(/<(?:xdr:)?from>([\s\S]*?)<\/(?:xdr:)?from>/);
                if (!embed || !from || !drels[embed[1]]) continue;
                var col = from[1].match(/<(?:xdr:)?col>(\d+)</), row = from[1].match(/<(?:xdr:)?row>(\d+)</);
                var ext = a.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/) || a.match(/<(?:xdr:)?ext\s+cx="(\d+)"\s+cy="(\d+)"/);
                var media = xlsxResolve(drawingPath, drels[embed[1]].target);
                anchors.push({ row: row ? +row[1] : 0, col: col ? +col[1] : 0, cx: ext ? +ext[1] : 0, cy: ext ? +ext[2] : 0, media: media });
            }
            return Promise.all(anchors.map(function (an) {
                var entry = entries[an.media];
                if (!entry) return null;
                return xlsxZipRead(bytes, entry).then(function (data) {
                    var ext = (an.media.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
                    return { row: an.row, col: an.col, cx: an.cx, cy: an.cy, mime: XLSX_IMAGE_TYPES[ext.toLowerCase()] || 'application/octet-stream',
                             data: data.slice() };
                });
            })).then(function (list) { return list.filter(Boolean); });
        });
    });
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Cell styles a sheet can use: sheet.rowStyles maps a row index to one style name per column (cells are written for every
 * styled column, empty or not, so fills and borders run across the table). sheet.bold (row indexes) makes whole rows bold.
 *   title    bold white on dark blue        header  bold on grey-blue, bordered
 *   band0/1  alternating light/dark rows, bordered
 *   metaKey  bold on light grey, bordered    meta    light grey, bordered
 */
var XLSX_STYLES = { bold: 1, title: 2, header: 3, band0: 4, band1: 5, metaKey: 6, meta: 7 };

function xlsxSheetXml(sheet) {
    var bold = {}, styles = sheet.rowStyles || {};
    (sheet.bold || []).forEach(function (r) { bold[r] = true; });
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'];
    if (sheet.widths && sheet.widths.length) {
        out.push('<cols>' + sheet.widths.map(function (w, i) {
            return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
        }).join('') + '</cols>');
    }
    out.push('<sheetData>');
    sheet.rows.forEach(function (row, r) {
        var cells = [], rs = styles[r] || [], n = Math.max((row || []).length, rs.length);
        for (var c = 0; c < n; c++) {
            var v = (row || [])[c], st = XLSX_STYLES[rs[c]] || (bold[r] ? 1 : 0), sAttr = st ? ' s="' + st + '"' : '';
            if (v === null || v === undefined || v === '') {
                if (st && rs[c]) cells.push('<c r="' + xlsxColumnName(c) + (r + 1) + '"' + sAttr + '/>');
                continue;
            }
            cells.push('<c r="' + xlsxColumnName(c) + (r + 1) + '" t="inlineStr"' + sAttr +
                '><is><t xml:space="preserve">' + xlsxEscape(v) + '</t></is></c>');
        }
        if (cells.length) out.push('<row r="' + (r + 1) + '">' + cells.join('') + '</row>');
    });
    out.push('</sheetData>');
    if (sheet.images && sheet.images.length) out.push('<drawing r:id="rId1"/>');
    out.push('</worksheet>');
    return out.join('');
}

var XLSX_IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' };

function xlsxDrawingXml(images) {
    var ns = 'http://schemas.openxmlformats.org/drawingml/2006/';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<xdr:wsDr xmlns:xdr="' + ns + 'spreadsheetDrawing" xmlns:a="' + ns + 'main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        images.map(function (im, k) {
            var ext = 'cx="' + Math.round(im.cx) + '" cy="' + Math.round(im.cy) + '"';
            return '<xdr:oneCellAnchor><xdr:from><xdr:col>' + im.col + '</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + im.row +
                '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext ' + ext + '/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + (k + 2) +
                '" name="Picture ' + (k + 1) + '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
                '<xdr:blipFill><a:blip r:embed="rId' + (k + 1) + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
                // No a:xfrm: the anchor places the picture (some viewers would put an xfrm offset of 0,0 at the sheet's corner).
                '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
                '</xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
        }).join('') + '</xdr:wsDr>';
}

function writeXlsx(sheets) {
    var enc = new TextEncoder();
    var ns = 'http://schemas.openxmlformats.org/', rel = ns + 'officeDocument/2006/relationships';
    var files = [
        { name: '[Content_Types].xml', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="' + ns + 'package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
            '<Default Extension="gif" ContentType="image/gif"/>' +
            sheets.map(function (s, i) {
                return s.images && s.images.length ? '<Override PartName="/xl/drawings/drawing' + (i + 1) +
                    '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '';
            }).join('') +
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
            '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>' +
            '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
            '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
            '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
            ['FF1F3B57', 'FFD6DCE4', 'FFFFFFFF', 'FFE9EEF4', 'FFF3F3F3'].map(function (c) {
                return '<fill><patternFill patternType="solid"><fgColor rgb="' + c + '"/><bgColor indexed="64"/></patternFill></fill>';
            }).join('') + '</fills>' +
            '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
            '<border>' + ['left', 'right', 'top', 'bottom'].map(function (e) {
                return '<' + e + ' style="thin"><color rgb="FFBFBFBF"/></' + e + '>';
            }).join('') + '<diagonal/></border></borders>' +
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            '<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
            // title, header, band0, band1, metaKey, meta (XLSX_STYLES)
            [[2, 2, 0], [1, 3, 1], [0, 4, 1], [0, 5, 1], [1, 6, 1], [0, 6, 1]].map(function (x) {
                return '<xf numFmtId="0" fontId="' + x[0] + '" fillId="' + x[1] + '" borderId="' + x[2] + '" xfId="0" applyFont="1" applyFill="1"' +
                    (x[2] ? ' applyBorder="1"' : '') + '/>';
            }).join('') + '</cellXfs>' +
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
            '</styleSheet>' }
    ];
    var mediaCount = 0;
    sheets.forEach(function (s, i) {
        var images = (s.images || []).filter(function (im) { return XLSX_IMAGE_EXT[im.mime]; });
        s = Object.assign({}, s, { images: images });
        files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', xml: xlsxSheetXml(s) });
        if (!images.length) return;
        files.push({ name: 'xl/worksheets/_rels/sheet' + (i + 1) + '.xml.rels', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="' + ns + 'package/2006/relationships"><Relationship Id="rId1" Type="' + rel +
            '/drawing" Target="../drawings/drawing' + (i + 1) + '.xml"/></Relationships>' });
        files.push({ name: 'xl/drawings/drawing' + (i + 1) + '.xml', xml: xlsxDrawingXml(images) });
        files.push({ name: 'xl/drawings/_rels/drawing' + (i + 1) + '.xml.rels', xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="' + ns + 'package/2006/relationships">' + images.map(function (im, k) {
                var name = 'image' + (++mediaCount) + '.' + XLSX_IMAGE_EXT[im.mime];
                files.push({ name: 'xl/media/' + name, data: im.data });
                return '<Relationship Id="rId' + (k + 1) + '" Type="' + rel + '/image" Target="../media/' + name + '"/>';
            }).join('') + '</Relationships>' });
    });
    return xlsxZipWrite(files.map(function (f) { return { name: f.name, data: f.data || enc.encode(f.xml) }; }));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readXlsx: readXlsx, writeXlsx: writeXlsx, xlsxColumn: xlsxColumn, xlsxColumnName: xlsxColumnName };
}
