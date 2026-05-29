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
 *   // config.shiftParams = extracted shift-quality parameters
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
 *   - shiftParams: Extracted shift-quality-relevant parameters (structured)
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

    // Extract shift-quality parameters
    var shiftParams = extractShiftParams(tables);

    return {
        tables: tables,
        constants: constants,
        shiftParams: shiftParams,
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
// Shift Parameter Extraction — structured view of shift-quality parameters
// ---------------------------------------------------------------------------

/**
 * Extracts and organizes shift-quality-relevant parameters from the parsed tables.
 * Groups them into logical categories for the shift analyzer to correlate with log data.
 *
 * @param {Object} tables - Map of table title -> parsed table data
 * @returns {Object} Structured shift parameters
 */
function extractShiftParams(tables) {
    var params = {
        gearRatios: getTableValues(tables, 'Gear Ratio'),
        pressures: {
            startPress: getTableValues(tables, 'Stard Press.'),
            minClutchPress: getScalar(tables, 'Minimum Clutch Press.'),
            minClutchPressDrive: getScalar(tables, 'Minimum Clutch Press. Drive'),
            minClutchPressNeutral: getScalar(tables, 'Minimum Clutch Press. Neutral'),
            addPressFootbrakeOff: getScalar(tables, 'Add Press. Footbrake OFF'),
            addPressAfterLaunch: getScalar(tables, 'Add Press. after launch '),
        },
        timing: {
            pulseTime: getScalar(tables, 'Pulse Time'),
            clutchClosingTime: getScalar(tables, 'Clutch Closing time '),
            closeTime: getScalar(tables, 'Close Time'),
        },
        blip: {
            blipOut: getScalar(tables, 'Blip Out'),
            blipTqTarget: getTableValues(tables, 'Blip TQ Target'),
            minRpmForBlip: getTableValues(tables, 'Min RPM for blip'),
            maxTpsForBlip: getScalar(tables, 'Max TPS for blip'),
            maxTqForBlip: getScalar(tables, 'Max TQ for Blip'),
            clutchSlipBlipDeactivation: getTableValues(tables, 'Clutch slip blip deactivation'),
        },
        adaptation: {
            downshiftAdap: getTableValues(tables, 'Downshift ADAP'),
            brakeAdap: getTableValues(tables, 'Brake ADAP'),
            endAdap: getTableValues(tables, 'End ADAP'),
            downshiftAdapMaxValue: getTableValues(tables, 'Downshift ADAPT. Max Value'),
            torqueReductionAdap: getTableValues(tables, 'Torque Reduction  ADAP'),
        },
        torqueReduction: {
            outputThreshold: getScalar(tables, 'Torque Reduction  Output Threshold'),
            rampOn: getScalar(tables, 'Torque Reduction Ramp ON'),
            rampOff: getScalar(tables, 'Torque Reduction Ramp OFF'),
            advanceTime: getTableValues(tables, 'Torque Reduction Advance Time'),
            type: getScalar(tables, 'Torque reduction type (Only for OEM Can)'),
        },
        corrections: {
            gearShiftPressCorrection: getTableValues(tables, 'Gear Shift pressure Correction %'),
            gearPulseCorrectUp: getTableValues(tables, 'Gear Pulse Correction % UPSHIFT'),
            gearPulseCorrectDown: getTableValues(tables, 'Gear Pulse Correction % DOWN'),
            corrPressTps: getTableValues(tables, 'Corr. Press. TPS'),
            corrPressTpsTorque: getTableValues(tables, 'Corr. Press. TPS/Torque Correction'),
            additionalPressDownshift: getTableValues(tables, 'Additional Press Corr Downshift'),
            pulseCorrectUp: getTableValues(tables, 'Pulse Correction UP'),
            pulseCorrectDown: getTableValues(tables, 'Pulse Correction DOWN'),
            timeCorrectUp: getTableValues(tables, 'Time Correction UP'),
            timeCorrectDown: getTableValues(tables, 'Time Correction DOWN'),
            corrTempUp: getTableValues(tables, 'Corr. Temp. Gear UP'),
            corrTempDown: getTableValues(tables, 'Corr. Temp. Gear Down'),
            corrTempPulseUp: getTableValues(tables, 'Corr. Temp. Pulse Time UP'),
            corrTempPulseDown: getTableValues(tables, 'Corr. Temp. Pulse Time Down'),
            corrDeltaEnd: getTableValues(tables, 'Correction Delta End'),
            slipCorrectUp: getTableValues(tables, 'Clutch Slipt% Corection UP'),
            slipCorrectDown: getTableValues(tables, 'Clutch Slipt% Corection DOWN'),
            slipCorrectStartGear: getTableValues(tables, 'Clutch Slipt% Corection Start Gear'),
        },
        perGearCorrections: extractPerGearCorrections(tables),
        lockup: {
            lockupI: getTableValues(tables, 'Lockup I.'),
            lockupP: getTableValues(tables, 'Lockup P.'),
            lockupOnRpmTps: getTableValues(tables, 'Lockup ON  RPM/TPS'),
            lockupSlipRpm: getTableValues(tables, 'Lockup Slipt RPM'),
            lockupHysteresis: getScalar(tables, 'Lockup Hysteresis'),
            lockupWarmupMultiplier: getScalar(tables, 'Lockup Slipt Warmup multiplier'),
            lockupGearOffAfterLaunch: getScalar(tables, 'Lockup Gear OFF after T-brake/ Launch '),
        },
        slip: {
            slipDiffMultiplier: getTableValues(tables, 'Slip difference Multiplier'),
            slipDiffMaxPressure: getTableValues(tables, 'Slip difference Max Pressure'),
            slipTorquePresCorrection: getTableValues(tables, 'Slip Torque Pres Correction'),
        },
        rpmLimits: {
            maxRpmDownshiftTqPos: getTableValues(tables, 'Max. RPM Downshift Allowance, torque higher than 0 (TQ>0)'),
            maxRpmDownshiftTqNeg: getTableValues(tables, 'Max. RPM Downshift Allowance, torque lower than 0 (TQ<0)'),
            maxRpmSemiAutoUpshift: getTableValues(tables, 'Max. RPM Limit, Semi-Auto Upshift'),
            minRpmSemiAutoDown82: getTableValues(tables, 'Min. RPM Limit 8-2, Semi Auto Downshift'),
            minRpmSemiAutoDown21: getTableValues(tables, 'Min. RPM Limit 2-1, Semi Auto Downshift'),
        },
        gearStart: {
            gearStartPressCorrect: getTableValues(tables, 'Gear Start Press Correct'),
            gearStartTime: getTableValues(tables, 'Gear Start Time'),
        },
    };

    return params;
}

/**
 * Extracts per-gear shift correction tables (Start/End for each transition).
 */
function extractPerGearCorrections(tables) {
    var transitions = [
        '1-2', '2-3', '3-4', '4-5', '5-6', '6-7', '7-8',
        '2-1', '3-2', '4-3', '5-4', '6-5', '7-6', '8-7'
    ];

    var result = {};
    for (var i = 0; i < transitions.length; i++) {
        var t = transitions[i];
        var isUp = parseInt(t[0]) < parseInt(t[2]);
        var dir = isUp ? 'Upshift' : 'Downshift';
        var startTitle = t + ' ' + dir + ' Correction Start';
        var endTitle = t + ' ' + dir + ' Correction End';

        result[t] = {
            start: getTableValues(tables, startTitle),
            end: getTableValues(tables, endTitle)
        };
    }
    return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTableValues(tables, title) {
    var tbl = tables[title];
    if (!tbl) return null;
    // Flatten 1-row tables to a simple array
    if (tbl.rows === 1) return tbl.values[0];
    return tbl.values;
}

function getScalar(tables, title) {
    var tbl = tables[title];
    if (!tbl) return null;
    return tbl.values[0][0];
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
    module.exports = { parseXdf: parseXdf, readBinConfig: readBinConfig };
}
