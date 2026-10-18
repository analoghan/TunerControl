/**
 * bin-reader.js — TunerPro Bin Config Reader
 *
 * Parses a TunerPro .bin file using an XDF definition to extract named parameters.
 * Focuses on shift-quality-relevant TCU parameters: clutch pressures, overlap timing,
 * downshift blip settings, adaptation values, and per-gear correction tables.
 *
 * Usage:
 *   var xdfDef = parseXdf(xdfText);
 *   var config = readBinConfig(binBuffer, xdfDef);
 *   // config.tables = { title: { values, rows, cols, equation, address, ... } }
 *   // config.settings = gear ratios, start gear, blip, adaptation and correction tables (extractShiftSettings)
 */

// ---------------------------------------------------------------------------
// XDF Parser — extracts table/constant definitions from XDF XML
// ---------------------------------------------------------------------------

/**
 * Parses an XDF XML string and returns all table and constant definitions.
 *
 * @param {string} xdfText - Raw XDF file content
 * @returns {Object} Parsed XDF definition
 *   - tables: Array of table definitions
 *   - constants: Array of constant definitions
 *   - categories: Map of category index -> name
 *   - header: { title, description, author, regionSize }
 */
function parseXdf(xdfText) {
    var tables = [];
    var constants = [];
    var categories = {};

    // Parse categories
    var catPattern = /<CATEGORY index="([^"]*)" name="([^"]*)" \/>/g;
    var catMatch;
    while ((catMatch = catPattern.exec(xdfText)) !== null) {
        categories[parseInt(catMatch[1], 16)] = catMatch[2];
    }

    // Parse header info
    var titleMatch = xdfText.match(/<deftitle>([^<]*)<\/deftitle>/);
    var descMatch = xdfText.match(/<description>([^<]*)<\/description>/);
    var authorMatch = xdfText.match(/<author>([^<]*)<\/author>/);
    var regionMatch = xdfText.match(/<REGION[^>]*size="([^"]*)"[^>]*>/);

    var header = {
        title: titleMatch ? titleMatch[1].trim() : '',
        description: descMatch ? descMatch[1].trim() : '',
        author: authorMatch ? authorMatch[1].trim() : '',
        regionSize: regionMatch ? parseInt(regionMatch[1], 16) : 0
    };

    // Parse XDFTABLE entries
    var tablePattern = /<XDFTABLE[^>]*>([\s\S]*?)<\/XDFTABLE>/g;
    var tableMatch;
    while ((tableMatch = tablePattern.exec(xdfText)) !== null) {
        var tbl = parseXdfTable(tableMatch[1]);
        if (tbl) tables.push(tbl);
    }

    // Parse XDFCONSTANT entries
    var constPattern = /<XDFCONSTANT[^>]*>([\s\S]*?)<\/XDFCONSTANT>/g;
    var constMatch;
    while ((constMatch = constPattern.exec(xdfText)) !== null) {
        var cst = parseXdfConstant(constMatch[1]);
        if (cst) constants.push(cst);
    }

    return { tables: tables, constants: constants, categories: categories, header: header };
}

/**
 * Parses a single XDFTABLE block.
 */
function parseXdfTable(block) {
    var titleMatch = block.match(/<title>([^<]*)<\/title>/);
    if (!titleMatch) return null;

    var title = decodeXmlEntities(titleMatch[1]);
    var descMatch = block.match(/<description>([^<]*)<\/description>/);
    var catMatch = block.match(/<CATEGORYMEM[^>]*category="(\d+)"[^>]*\/>/);

    // Parse z-axis (the actual data)
    var zAxisMatch = block.match(/<XDFAXIS id="z">([\s\S]*?)<\/XDFAXIS>/);
    if (!zAxisMatch) return null;

    var zBlock = zAxisMatch[1];
    var embedded = parseEmbeddedData(zBlock);
    if (!embedded || embedded.address === null) return null;

    var equation = extractEquation(zBlock);

    // Parse x-axis labels
    var xAxisMatch = block.match(/<XDFAXIS id="x"[^>]*>([\s\S]*?)<\/XDFAXIS>/);
    var xLabels = xAxisMatch ? extractLabels(xAxisMatch[1]) : [];
    var xUnits = xAxisMatch ? extractUnits(xAxisMatch[1]) : '';

    // Parse y-axis labels
    var yAxisMatch = block.match(/<XDFAXIS id="y"[^>]*>([\s\S]*?)<\/XDFAXIS>/);
    var yLabels = yAxisMatch ? extractLabels(yAxisMatch[1]) : [];
    var yUnits = yAxisMatch ? extractUnits(yAxisMatch[1]) : '';

    return {
        title: title,
        description: descMatch ? decodeXmlEntities(descMatch[1]) : '',
        category: catMatch ? parseInt(catMatch[1], 10) : -1,
        address: embedded.address,
        sizeBits: embedded.sizeBits,
        rows: embedded.rows,
        cols: embedded.cols,
        equation: equation,
        xLabels: xLabels,
        yLabels: yLabels,
        xUnits: xUnits,
        yUnits: yUnits,
        lsbFirst: embedded.lsbFirst
    };
}

/**
 * Parses a single XDFCONSTANT block.
 */
function parseXdfConstant(block) {
    var titleMatch = block.match(/<title>([^<]*)<\/title>/);
    if (!titleMatch) return null;

    var embedded = parseEmbeddedData(block);
    if (!embedded || embedded.address === null) return null;

    var equation = extractEquation(block);

    return {
        title: decodeXmlEntities(titleMatch[1]),
        address: embedded.address,
        sizeBits: embedded.sizeBits,
        equation: equation
    };
}

// ---------------------------------------------------------------------------
// XDF parsing helpers
// ---------------------------------------------------------------------------

function parseEmbeddedData(block) {
    var m = block.match(/<EMBEDDEDDATA([^>]*)\/?>|<EMBEDDEDDATA([^>]*)>/);
    if (!m) return null;

    var attrs = m[1] || m[2] || '';
    var addrMatch = attrs.match(/mmedaddress="([^"]*)"/);
    var sizeMatch = attrs.match(/mmedelementsizebits="([^"]*)"/);
    var rowsMatch = attrs.match(/mmedrowcount="([^"]*)"/);
    var colsMatch = attrs.match(/mmedcolcount="([^"]*)"/);

    return {
        address: addrMatch ? parseInt(addrMatch[1], 16) : null,
        sizeBits: sizeMatch ? parseInt(sizeMatch[1], 10) : 8,
        rows: rowsMatch ? parseInt(rowsMatch[1], 10) : 1,
        cols: colsMatch ? parseInt(colsMatch[1], 10) : 1,
        lsbFirst: true // XDF default from header
    };
}

function extractEquation(block) {
    var m = block.match(/<MATH equation="([^"]*)"/);
    return m ? decodeXmlEntities(m[1]) : 'X';
}

function extractLabels(axisBlock) {
    var labels = [];
    var pattern = /<LABEL index="\d+" value="([^"]*)" \/>/g;
    var m;
    while ((m = pattern.exec(axisBlock)) !== null) {
        labels.push(decodeXmlEntities(m[1]));
    }
    return labels;
}

function extractUnits(axisBlock) {
    var m = axisBlock.match(/<units>([^<]*)<\/units>/);
    return m ? m[1] : '';
}

function decodeXmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------------------
// Bin Reader — reads parameter values from a bin buffer using XDF definitions
// ---------------------------------------------------------------------------

/**
 * Reads all parameters from a bin file using XDF table definitions.
 *
 * @param {ArrayBuffer} buffer - Raw .bin file contents
 * @param {Object} xdfDef - Parsed XDF definition from parseXdf()
 * @returns {Object} Config data
 *   - tables: Map of title -> { values (2D array), raw, rows, cols, address, equation, ... }
 *   - constants: Map of title -> { value, raw, address }
 *   - settings: what the shift analysis uses (extractShiftSettings)
 *   - metadata: { binSize, xdfTitle, xdfAuthor }
 */
function readBinConfig(buffer, xdfDef) {
    var view = new DataView(buffer);
    var tables = {};
    var constants = {};

    // Read all tables
    for (var i = 0; i < xdfDef.tables.length; i++) {
        var tbl = xdfDef.tables[i];
        var result = readTable(view, buffer.byteLength, tbl);
        if (result) {
            tables[tbl.title] = result;
        }
    }

    // Read all constants
    for (var i = 0; i < xdfDef.constants.length; i++) {
        var cst = xdfDef.constants[i];
        var result = readConstant(view, buffer.byteLength, cst);
        if (result) {
            constants[cst.title] = result;
        }
    }

    var settings = extractShiftSettings(tables);

    return {
        tables: tables,
        constants: constants,
        settings: settings,
        metadata: {
            binSize: buffer.byteLength,
            xdfTitle: xdfDef.header.title,
            xdfAuthor: xdfDef.header.author,
            xdfDescription: xdfDef.header.description,
            tableCount: Object.keys(tables).length,
            categories: xdfDef.categories
        }
    };
}

/**
 * Reads a single table's values from the bin buffer.
 */
function readTable(view, bufLen, tbl) {
    var byteSize = tbl.sizeBits / 8;
    var totalElements = tbl.rows * tbl.cols;
    var totalBytes = totalElements * byteSize;

    if (tbl.address + totalBytes > bufLen) return null;

    var transform = compileEquation(tbl.equation);
    var values = [];
    var raw = [];

    for (var r = 0; r < tbl.rows; r++) {
        var rowVals = [];
        var rowRaw = [];
        for (var c = 0; c < tbl.cols; c++) {
            var offset = tbl.address + (r * tbl.cols + c) * byteSize;
            var rawVal = readElement(view, offset, tbl.sizeBits, tbl.lsbFirst);
            rowRaw.push(rawVal);
            rowVals.push(transform(rawVal));
        }
        values.push(rowVals);
        raw.push(rowRaw);
    }

    return {
        values: values,
        raw: raw,
        rows: tbl.rows,
        cols: tbl.cols,
        address: tbl.address,
        equation: tbl.equation,
        xLabels: tbl.xLabels,
        yLabels: tbl.yLabels,
        category: tbl.category
    };
}

/**
 * Reads a single constant value from the bin buffer.
 */
function readConstant(view, bufLen, cst) {
    var byteSize = cst.sizeBits / 8;
    if (cst.address + byteSize > bufLen) return null;

    var transform = compileEquation(cst.equation);
    var rawVal = readElement(view, cst.address, cst.sizeBits, true);

    return {
        value: transform(rawVal),
        raw: rawVal,
        address: cst.address
    };
}

/**
 * Reads a single numeric element from the buffer.
 */
function readElement(view, offset, sizeBits, lsbFirst) {
    switch (sizeBits) {
        case 8:
            return view.getUint8(offset);
        case 16:
            return view.getUint16(offset, lsbFirst);
        case 32:
            return view.getUint32(offset, lsbFirst);
        default:
            return view.getUint8(offset);
    }
}

// ---------------------------------------------------------------------------
// Shift settings — found by pattern, because XDF versions rename tables
// (V10.75 "3-2 Downshift Correction Start", V10.78 "3-2 DOWN Correction Start"; "Brake ADAP" → "Brake Clutch DOWN Adaptation")
// ---------------------------------------------------------------------------

function brNorm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

/** The first table whose title matches one of the patterns (regular expressions, tested on the trimmed lower-case title). */
function brFind(tables, patterns) {
    var titles = Object.keys(tables);
    for (var p = 0; p < patterns.length; p++) {
        for (var i = 0; i < titles.length; i++) if (patterns[p].test(brNorm(titles[i]))) return { title: titles[i], table: tables[titles[i]] };
    }
    return null;
}

function brScalar(found) { return found ? found.table.values[0][0] : null; }

/** A table for display: { title, rows: [label], cols: [label], values }. */
function brView(found) {
    if (!found) return null;
    var t = found.table;
    return { title: found.title.trim(), rowLabels: (t.yLabels || []).slice(0, t.rows), colLabels: (t.xLabels || []).slice(0, t.cols), values: t.values };
}

/**
 * Settings the shift analysis uses:
 *   gearRatios {gear: ratio}, startGear [per program] (Program Selector "ST. GEAR" row), programs, adaptOil { min, max, source },
 *   blip { minRpm [N, S1, S2], maxTps, maxTq, slipDeactivation [..], out }, adaptationTables [view], corrections { "3-2": { start, end } },
 *   shiftTables [view] (Pulse / Time Correction, Slow Ram, temperature corrections), torqueReduction { tables… }
 */
function extractShiftSettings(tables) {
    var out = {};
    var ratio = brFind(tables, [/^gear ratio$/]);
    if (ratio) {
        out.gearRatios = {};
        var labels = ratio.table.xLabels || [];
        ratio.table.values[0].forEach(function (v, i) { var g = parseInt(labels[i], 10); if (g >= 1 && g <= 8) out.gearRatios[g] = v; });
    }
    var prog = brFind(tables, [/^program selector$/]);
    if (prog) {
        var row = (prog.table.yLabels || []).map(brNorm).map(function (l) { return l.replace(/^\.\s*/, ''); }).indexOf('st. gear');
        if (row >= 0) out.startGear = prog.table.values[row].slice();
        out.programs = (prog.table.xLabels || []).slice(0, prog.table.cols);
    }
    var oMin = brFind(tables, [/^oil temp min$/]), oMax = brFind(tables, [/^oil temp max$/]);
    out.adaptOil = oMin && oMax ? { min: brScalar(oMin), max: brScalar(oMax), source: 'bin' } : null;
    function col(found) { return found ? found.table.values.map(function (r) { return r[0]; }) : null; }
    var deact = brFind(tables, [/^clutch slip blip deactivation$/]);
    out.blip = { minRpm: col(brFind(tables, [/^min rpm for blip$/])), maxTps: brScalar(brFind(tables, [/^max tps for blip$/])),
                 maxTq: brScalar(brFind(tables, [/^max tq for blip$/])), slipDeactivation: col(deact), out: brScalar(brFind(tables, [/^blip out$/])),
                 rowLabels: deact ? (deact.table.yLabels || []).slice(0, deact.table.rows) : ['N', 'S1', 'S2'] };
    out.adaptationTables = Object.keys(tables).filter(function (k) { return /adapt|adap\b/i.test(k) && !/enable|activation|send|change/i.test(k); })
        .sort().map(function (k) { return brView({ title: k, table: tables[k] }); });
    out.corrections = {};
    Object.keys(tables).forEach(function (k) {
        var m = brNorm(k).match(/^(\d)-(\d) (?:up|down|upshift|downshift) cor\w* (start|end)$/);
        if (!m) return;
        var key = m[1] + '-' + m[2];
        (out.corrections[key] = out.corrections[key] || {})[m[3]] = brView({ title: k, table: tables[k] });
    });
    out.shiftTables = [/^pulse correction up$/, /^pulse correction down$/, /^time correction up$/, /^time correction down$/, /^slow ram up$/, /^slow ram down$/,
        /^gear pulse correction% (ushift|upshift)$/, /^gear pulse correction % upshift$/, /^gear pulse correction% down$/, /^gear pulse correction % down$/,
        /^corr\. temp\. gear up$/, /^corr\. temp\. gear down$/, /^corr\. temp\. pulse time up$/, /^corr\. temp\. pulse time down$/]
        .map(function (re) { return brView(brFind(tables, [re])); }).filter(Boolean);
    return out;
}

// ---------------------------------------------------------------------------
// Equation compiler (reuse from xdl-parser if available, otherwise standalone)
// ---------------------------------------------------------------------------

if (typeof compileEquation === 'undefined') {
    /**
     * Compiles an XDF equation string into a callable function.
     * Supports: X/x, constants, +, -, *, /, parentheses.
     */
    var compileEquation = function(equation) {
        if (!equation || equation === 'X' || equation === 'x') {
            return function (x) { return x; };
        }

        var expr = equation.replace(/x/g, 'X');

        if (!/^[X0-9+\-*/().  ]+$/.test(expr)) {
            return function (x) { return x; };
        }

        try {
            var body = expr.replace(/X/g, 'v');
            var fn = new Function('v', 'return (' + body + ');');
            fn(1);
            return fn;
        } catch (e) {
            return function (x) { return x; };
        }
    };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseXdf: parseXdf, readBinConfig: readBinConfig, extractShiftSettings: extractShiftSettings };
}
