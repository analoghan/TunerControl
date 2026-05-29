/**
 * xdl-parser.js — TunerPro XDL Binary Log Parser
 *
 * Parses .xdl binary log files using channel definitions from an ADX file.
 * The XDL format stores interleaved command frames at fixed record sizes,
 * with each record containing payload data for a single command.
 *
 * File structure:
 *   Header (variable size, offset stored at bytes 4-7)
 *     - Version, timestamp, total records, num commands
 *     - Command table: hash + name + params per command
 *   Data area (total_records * record_size bytes)
 *     - Each record: next_ptr(4) + timestamp_ms(4) + cmd_idx(2) + marker(2) + payload
 *
 * Usage:
 *   var adxDef = parseAdx(adxText);
 *   var result = parseXdl(xdlBuffer, adxDef, progressCallback);
 *   // result = { columnNames: [...], data: [[...], ...], timestamps: [...] }
 */

// ---------------------------------------------------------------------------
// ADX Parser — extracts channel definitions from ADX XML text
// ---------------------------------------------------------------------------

/**
 * Parses an ADX XML string and returns structured channel definitions
 * grouped by parent command hash.
 *
 * @param {string} adxText - Raw ADX XML file content
 * @returns {Object} Parsed ADX definition
 *   - commands: Map of command hash (number) -> { channels: [...] }
 *   - allChannels: Flat array of all channel definitions
 */
function parseAdx(adxText) {
    var channels = [];

    // Parse ADXVALUE elements
    var valuePattern = /<ADXVALUE[^>]*>[\s\S]*?<\/ADXVALUE>/g;
    var match;
    while ((match = valuePattern.exec(adxText)) !== null) {
        var block = match[0];
        var ch = parseAdxChannel(block);
        if (ch) channels.push(ch);
    }

    // Parse ADXBITMASK elements (single-bit flags)
    var bitmaskPattern = /<ADXBITMASK[^>]*>[\s\S]*?<\/ADXBITMASK>/g;
    while ((match = bitmaskPattern.exec(adxText)) !== null) {
        var block = match[0];
        var bm = parseAdxBitmask(block);
        if (bm) channels.push(bm);
    }

    // Group by parent command hash
    var commands = {};
    for (var i = 0; i < channels.length; i++) {
        var cmdHash = channels[i].parentCmd;
        if (!commands[cmdHash]) {
            commands[cmdHash] = { channels: [] };
        }
        commands[cmdHash].channels.push(channels[i]);
    }

    return { commands: commands, allChannels: channels };
}

/**
 * Parses a single ADXVALUE XML block into a channel definition.
 * @param {string} block - XML text of one ADXVALUE element
 * @returns {Object|null} Channel definition or null if incomplete
 */
function parseAdxChannel(block) {
    var title = extractAttr(block, 'title');
    var parentCmd = extractTag(block, 'parentcmdidhash');
    var packetOffset = extractTag(block, 'packetoffset');

    if (!title || !parentCmd || !packetOffset) return null;

    var sizeInBits = extractTag(block, 'sizeinbits');
    var flags = extractTag(block, 'flags');
    var equation = extractMathEquation(block);
    var units = extractTag(block, 'units');

    var sizeBits = sizeInBits ? parseInt(sizeInBits, 10) : 8;
    var flagsVal = flags ? parseInt(flags, 16) : 0;

    // Determine signedness: flag bit 0 set on 16-bit values indicates signed
    var isSigned = (sizeBits === 16 && (flagsVal & 0x01) !== 0);

    return {
        title: title,
        parentCmd: parseInt(parentCmd, 16),
        offset: parseInt(packetOffset, 16),
        sizeBits: sizeBits,
        signed: isSigned,
        equation: equation || 'X',
        units: units || '',
        isBitmask: false
    };
}

/**
 * Parses a single ADXBITMASK XML block into a channel definition.
 * @param {string} block - XML text of one ADXBITMASK element
 * @returns {Object|null} Channel definition or null if incomplete
 */
function parseAdxBitmask(block) {
    var title = extractAttr(block, 'title');
    var parentCmd = extractTag(block, 'parentcmdidhash');
    var packetOffset = extractTag(block, 'packetoffset');

    if (!title || !parentCmd || !packetOffset) return null;

    return {
        title: title,
        parentCmd: parseInt(parentCmd, 16),
        offset: parseInt(packetOffset, 16),
        sizeBits: 8,
        signed: false,
        equation: 'X',
        units: '',
        isBitmask: true
    };
}

// ---------------------------------------------------------------------------
// XML extraction helpers
// ---------------------------------------------------------------------------

function extractAttr(block, name) {
    var re = new RegExp(name + '="([^"]*)"');
    var m = block.match(re);
    return m ? m[1] : null;
}

function extractTag(block, tagName) {
    var re = new RegExp('<' + tagName + '>([^<]*)</' + tagName + '>');
    var m = block.match(re);
    return m ? m[1].trim() : null;
}

function extractMathEquation(block) {
    var m = block.match(/<MATH equation="([^"]*)"/);
    return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Equation evaluator — converts ADX math expressions to functions
// ---------------------------------------------------------------------------

/**
 * Compiles an ADX equation string into a callable function.
 * Supports: X, constants, +, -, *, /, parentheses.
 *
 * @param {string} equation - ADX equation (e.g., "X*0.7376", "X/16", "X-40", "100-X")
 * @returns {function(number): number} Compiled transform function
 */
function compileEquation(equation) {
    if (!equation || equation === 'X' || equation === 'x') {
        return function (x) { return x; };
    }

    // Normalize: lowercase x -> X for consistency
    var expr = equation.replace(/x/g, 'X');

    // Safety check: only allow numbers, X, operators, parens, spaces, dots
    if (!/^[X0-9+\-*/().  ]+$/.test(expr)) {
        return function (x) { return x; };
    }

    try {
        // Replace X with the parameter name
        var body = expr.replace(/X/g, 'v');
        var fn = new Function('v', 'return (' + body + ');');
        // Test it doesn't throw
        fn(1);
        return fn;
    } catch (e) {
        return function (x) { return x; };
    }
}

// ---------------------------------------------------------------------------
// XDL Binary Parser
// ---------------------------------------------------------------------------

/**
 * XDL file header offsets and sizes.
 */
var XDL_HEADER = {
    VERSION: 0,           // u32 - format version
    DATA_START: 4,        // u32 - byte offset where data records begin
    FILE_SIZE_REF: 8,     // u32 - file size + 1
    YEAR: 12,             // u16
    MONTH: 14,            // u16
    DAY: 18,              // u16
    HOUR: 20,             // u16
    MINUTE: 22,           // u16
    SECOND: 24,           // u16
    SUBSECOND: 26,        // u16 - milliseconds or fractional
    TOTAL_RECORDS: 36,    // u32
    NUM_COMMANDS: 40,     // u32
    CMD_TABLE_START: 44   // first command entry begins here
};

var XDL_CMD_ENTRY_SIZE = 51;  // bytes per command table entry
var XDL_CMD_HASH_OFFSET = 0;  // u32 hash within entry
var XDL_CMD_NAME_OFFSET = 4;  // 16-byte ASCII name within entry
var XDL_CMD_NAME_LENGTH = 16;
var XDL_CMD_PARAMS_OFFSET = 20; // 31 bytes of params

var XDL_RECORD_HEADER_SIZE = 12; // next_ptr(4) + timestamp(4) + cmd_idx(2) + marker(2)

/**
 * Parses an XDL binary file using ADX channel definitions.
 *
 * @param {ArrayBuffer} buffer - Raw .xdl file contents
 * @param {Object} adxDef - Parsed ADX definition from parseAdx()
 * @param {function} [progressCallback] - Called with (recordsProcessed, totalRecords)
 * @returns {Object} Parsed log data
 *   - columnNames: string[] - channel names (first is "Time")
 *   - data: number[][] - row-based numeric data
 *   - metadata: { date, totalRecords, numCommands, commands }
 */
function parseXdl(buffer, adxDef, progressCallback) {
    var view = new DataView(buffer);

    // --- Parse file header ---
    var version = view.getUint32(XDL_HEADER.VERSION, true);
    var dataStart = view.getUint32(XDL_HEADER.DATA_START, true);
    var totalRecords = view.getUint32(XDL_HEADER.TOTAL_RECORDS, true);
    var numCommands = view.getUint32(XDL_HEADER.NUM_COMMANDS, true);

    if (totalRecords === 0) {
        throw new Error('XDL file contains no records');
    }
    if (numCommands === 0) {
        throw new Error('XDL file contains no command definitions');
    }

    var recordSize = Math.floor((buffer.byteLength - dataStart) / totalRecords);
    if (recordSize < XDL_RECORD_HEADER_SIZE + 1) {
        throw new Error('XDL record size too small: ' + recordSize);
    }
    var payloadSize = recordSize - XDL_RECORD_HEADER_SIZE;

    // Parse timestamp from header
    var year = view.getUint16(XDL_HEADER.YEAR, true);
    var month = view.getUint16(XDL_HEADER.MONTH, true);
    var day = view.getUint16(XDL_HEADER.DAY, true);
    var hour = view.getUint16(XDL_HEADER.HOUR, true);
    var minute = view.getUint16(XDL_HEADER.MINUTE, true);
    var second = view.getUint16(XDL_HEADER.SECOND, true);

    // --- Parse command table ---
    var commands = [];
    for (var c = 0; c < numCommands; c++) {
        var entryOffset = XDL_HEADER.CMD_TABLE_START + c * XDL_CMD_ENTRY_SIZE;
        var cmdHash = view.getUint32(entryOffset + XDL_CMD_HASH_OFFSET, true);

        // Read command name (16 bytes, null-terminated ASCII)
        var nameBytes = [];
        for (var nb = 0; nb < XDL_CMD_NAME_LENGTH; nb++) {
            var b = view.getUint8(entryOffset + XDL_CMD_NAME_OFFSET + nb);
            if (b === 0) break;
            nameBytes.push(b);
        }
        var cmdName = String.fromCharCode.apply(null, nameBytes);

        // Read interval from params
        var paramsOffset = entryOffset + XDL_CMD_PARAMS_OFFSET;
        var interval = view.getUint32(paramsOffset + 4, true);

        commands.push({
            index: c,
            hash: cmdHash,
            name: cmdName,
            interval: interval
        });
    }

    // --- Match ADX channels to XDL commands ---
    var channelsByCmd = [];  // channelsByCmd[cmdIndex] = [channel defs]
    for (var ci = 0; ci < commands.length; ci++) {
        var cmdHash = commands[ci].hash;
        var adxCmd = adxDef.commands[cmdHash];
        if (adxCmd) {
            // Filter channels that fit within the payload
            var validChannels = [];
            for (var chi = 0; chi < adxCmd.channels.length; chi++) {
                var ch = adxCmd.channels[chi];
                var endByte = ch.offset + (ch.sizeBits / 8);
                if (endByte <= payloadSize) {
                    validChannels.push(ch);
                }
            }
            channelsByCmd.push(validChannels);
        } else {
            channelsByCmd.push([]);
        }
    }

    // --- Build column list (deduplicate by title) ---
    // Use insertion order: cmd0 channels, then cmd1, then cmd2
    var columnNames = ['Time'];
    var columnDefs = [null]; // null placeholder for Time column
    var titleToColIdx = {};  // track which column index each title maps to

    for (var ci = 0; ci < commands.length; ci++) {
        var chs = channelsByCmd[ci];
        for (var chi = 0; chi < chs.length; chi++) {
            var ch = chs[chi];
            if (!titleToColIdx.hasOwnProperty(ch.title)) {
                titleToColIdx[ch.title] = columnNames.length;
                columnNames.push(ch.title);
                columnDefs.push({
                    cmdIndex: ci,
                    offset: ch.offset,
                    sizeBits: ch.sizeBits,
                    signed: ch.signed,
                    transform: compileEquation(ch.equation),
                    equation: ch.equation
                });
            }
        }
    }

    var numCols = columnNames.length;

    // --- Parse data records ---
    // Strategy: maintain a "current values" array that gets updated per-command
    // Each record updates only the channels belonging to its command.
    // We emit one output row per record (matching TunerPro CSV behavior).

    var data = new Array(totalRecords);
    var currentValues = new Float64Array(numCols);

    // Initialize current values by applying each channel's transform to raw=0
    // This matches TunerPro's behavior where channels show their transformed
    // zero-state before the first command record arrives.
    for (var col = 1; col < numCols; col++) {
        var def = columnDefs[col];
        if (def) {
            currentValues[col] = def.transform(0);
        }
    }

    // Build lookup: for each command index, which columns does it update?
    var cmdColMap = []; // cmdColMap[cmdIdx] = [{colIdx, payloadOffset, sizeBits, signed, transform}]
    for (var ci = 0; ci < commands.length; ci++) {
        var entries = [];
        var chs = channelsByCmd[ci];
        for (var chi = 0; chi < chs.length; chi++) {
            var ch = chs[chi];
            var colIdx = titleToColIdx[ch.title];
            if (colIdx !== undefined) {
                entries.push({
                    colIdx: colIdx,
                    payloadOffset: ch.offset,
                    sizeBits: ch.sizeBits,
                    signed: ch.signed,
                    transform: compileEquation(ch.equation)
                });
            }
        }
        cmdColMap.push(entries);
    }

    var lastProgress = 0;

    for (var r = 0; r < totalRecords; r++) {
        var recOffset = dataStart + r * recordSize;

        // Parse record header
        var timestampMs = view.getUint32(recOffset + 4, true);
        var cmdIdx = view.getUint16(recOffset + 8, true);

        // Update time column (convert ms to seconds)
        currentValues[0] = timestampMs / 1000.0;

        // Read payload and update channels for this command
        if (cmdIdx < cmdColMap.length) {
            var payloadOffset = recOffset + XDL_RECORD_HEADER_SIZE;
            var entries = cmdColMap[cmdIdx];

            for (var e = 0; e < entries.length; e++) {
                var entry = entries[e];
                var byteOff = payloadOffset + entry.payloadOffset;

                var rawValue;
                if (entry.sizeBits === 16) {
                    if (entry.signed) {
                        rawValue = view.getInt16(byteOff, true);
                    } else {
                        rawValue = view.getUint16(byteOff, true);
                    }
                } else {
                    // 8-bit
                    if (entry.signed) {
                        rawValue = view.getInt8(byteOff);
                    } else {
                        rawValue = view.getUint8(byteOff);
                    }
                }

                currentValues[entry.colIdx] = entry.transform(rawValue);
            }
        }

        // Emit row (copy current state)
        var row = new Array(numCols);
        for (var col = 0; col < numCols; col++) {
            row[col] = currentValues[col];
        }
        data[r] = row;

        // Progress reporting
        if (progressCallback) {
            var processed = r + 1;
            if (processed - lastProgress >= 5000 || processed === totalRecords) {
                lastProgress = processed;
                progressCallback(processed, totalRecords);
            }
        }
    }

    return {
        columnNames: columnNames,
        data: data,
        metadata: {
            version: version,
            date: year + '-' + pad2(month) + '-' + pad2(day) + ' ' +
                  pad2(hour) + ':' + pad2(minute) + ':' + pad2(second),
            totalRecords: totalRecords,
            numCommands: numCommands,
            recordSize: recordSize,
            commands: commands.map(function (cmd) {
                return { hash: '0x' + cmd.hash.toString(16).toUpperCase(), name: cmd.name, interval: cmd.interval };
            })
        }
    };
}

function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
}

// ---------------------------------------------------------------------------
// Exports (for use in Web Workers or Node.js)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseAdx: parseAdx, parseXdl: parseXdl, compileEquation: compileEquation };
}
