/**
 * lib/ld-parser.js — MoTeC .ld binary log reader, shared by every tool (load it before a tool's worker; works in a page,
 * a worker and Node).
 *
 *   ldReadChannels(buffer)        → channel headers [{ name, ldName, shortName, unit, freq, nData, dataPtr, dataType, bytesPerSample,
 *                                   shift, mul, scale, dec }]; name is normalised to the CSV export's name
 *   ldChannelValues(buffer, chan) → Float64Array of the channel's scaled values at its own rate
 *   parseLdColumns(buffer, onProgress) → { columnNames, units, channelData, baseSamples, maxFreq }
 *   parseLdFile(buffer, onProgress)    → { columnNames, units, data (rows, as from a CSV), maxFreq }
 *
 * Every channel is resampled to the fastest channel's rate by holding values; column 0 is Time. units[i] is the channel's unit,
 * which M1 logs keep in the short-name field.
 */

/** .ld names (dots between levels, cut at 32 characters) that don't simply become the CSV name by turning dots into spaces. */
var LD_NAME_MAP = {
    'Engine.Speed': 'Engine Speed',
    'Inlet.Manifold.Pressure': 'Inlet Manifold Pressure',
    'Exhaust.Lambda.Bank 1': 'Exhaust Lambda Bank 1',
    'Exhaust.Lambda.Bank 2': 'Exhaust Lambda Bank 2',
    'Exhaust.Lambda': 'Exhaust Lambda',
    'Throttle.Position': 'Throttle Position',
    'Fuel.Pressure.Direct.Bank 1': 'Fuel Pressure Direct Bank 1',
    'Fuel.Pressure.Direct.Bank 1.Aim': 'Fuel Pressure Direct Bank 1 Aim',
    'Coolant.Temperature': 'Coolant Temperature',
    'Inlet.Air.Temperature': 'Inlet Air Temperature',
    'Fuel.Mixture Aim': 'Fuel Mixture Aim',
};

/** The CSV name of an .ld channel; truncated names are told apart by their unit (from the short-name field). */
function normalizeLdChannelNameWithUnit(ldName, unit) {
    if (LD_NAME_MAP[ldName]) return LD_NAME_MAP[ldName];
    if (ldName === 'Fuel.Cylinder 1.Primary.Output.P' && unit === 'ms') return 'Fuel Cylinder 1 Primary Output Pulse Width 1';
    if (ldName === 'Fuel.Cylinder 1.Primary.Output.P' && unit === 'dBTDC') return 'Fuel Cylinder 1 Primary Output Pulse Angle 1';
    if (ldName === 'Fuel.Closed Loop.Control.Bank 1.' && unit === '%Trim') return 'Fuel Closed Loop Control Bank 1 Trim';
    if (ldName === 'Fuel.Closed Loop.Control.Bank 2.' && unit === '%Trim') return 'Fuel Closed Loop Control Bank 2 Trim';
    return ldName.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

function readString(view, offset, length) {
    var bytes = [];
    for (var i = 0; i < length; i++) { var b = view.getUint8(offset + i); if (b === 0) break; bytes.push(b); }
    return String.fromCharCode.apply(null, bytes).trim();
}

function decodeFloat16(h) {
    var sign = (h >> 15) & 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
    if (exp === 0) return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
    if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);
    return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function ldReadChannels(buffer) {
    var view = new DataView(buffer);
    var metaPtr = view.getUint32(8, true), numChanns = view.getUint32(86, true);
    if (metaPtr === 0 || numChanns === 0) throw new Error('Invalid .ld file: no channel metadata found');
    var CHAN_HEADER_SIZE = 124, channels = [], ptr = metaPtr;
    for (var ch = 0; ch < numChanns && ptr !== 0; ch++) {
        if (ptr + CHAN_HEADER_SIZE > buffer.byteLength) break;
        var dtypeA = view.getUint16(ptr + 18, true), dtypeVal = view.getUint16(ptr + 20, true);
        var bytesPerSample = 0, dataType = null;
        if (dtypeA === 0x07) { if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'float16'; } else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'float32'; } }
        else if (dtypeA === 0 || dtypeA === 0x03 || dtypeA === 0x05) { if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'int16'; } else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'int32'; } }
        var ldName = readString(view, ptr + 32, 32), shortName = readString(view, ptr + 64, 8);
        channels.push({
            name: normalizeLdChannelNameWithUnit(ldName, shortName), ldName: ldName, shortName: shortName, unit: readString(view, ptr + 72, 12),
            freq: view.getUint16(ptr + 22, true), nData: view.getUint32(ptr + 12, true), dataPtr: view.getUint32(ptr + 8, true),
            dataType: dataType, bytesPerSample: bytesPerSample,
            shift: view.getInt16(ptr + 24, true), mul: view.getInt16(ptr + 26, true), scale: view.getInt16(ptr + 28, true), dec: view.getInt16(ptr + 30, true)
        });
        ptr = view.getUint32(ptr + 4, true);
    }
    if (channels.length === 0) throw new Error('No channels found in .ld file');
    return channels;
}

/** Scaled values. A sample past the end of the file, or of an unknown data type, is read as a raw 0 (then scaled). */
function ldChannelValues(buffer, chan) {
    var out = new Float64Array(chan.nData), decFactor = Math.pow(10, -chan.dec), i = 0;
    if (chan.dataType && chan.bytesPerSample > 0) {
        var view = new DataView(buffer), offset = chan.dataPtr;
        for (; i < chan.nData; i++) {
            if (offset + chan.bytesPerSample > buffer.byteLength) break;
            var raw = chan.dataType === 'float32' ? view.getFloat32(offset, true) : chan.dataType === 'float16' ? decodeFloat16(view.getUint16(offset, true))
                : chan.dataType === 'int16' ? view.getInt16(offset, true) : view.getInt32(offset, true);
            out[i] = (raw / chan.scale * decFactor + chan.shift) * chan.mul;
            offset += chan.bytesPerSample;
        }
    }
    var zero = (0 / chan.scale * decFactor + chan.shift) * chan.mul;
    for (; i < chan.nData; i++) out[i] = zero;
    return out;
}

function parseLdColumns(buffer, onProgress) {
    var channels = ldReadChannels(buffer);
    var maxFreq = 0, baseSamples = 0, i;
    for (i = 0; i < channels.length; i++) if (channels[i].freq > maxFreq) maxFreq = channels[i].freq;
    for (i = 0; i < channels.length; i++) if (channels[i].freq === maxFreq) { baseSamples = channels[i].nData; break; }
    if (baseSamples === 0) throw new Error('Could not determine sample count from .ld file');

    var columnNames = ['Time'], units = ['s'], channelData = [];
    var timeArr = new Float64Array(baseSamples), dt = 1.0 / maxFreq;
    for (var t = 0; t < baseSamples; t++) timeArr[t] = t * dt;
    channelData.push(timeArr);
    for (var ci = 0; ci < channels.length; ci++) {
        var chan = channels[ci], values = ldChannelValues(buffer, chan);
        columnNames.push(chan.name);
        units.push(chan.unit || chan.shortName || '');
        if (chan.freq === maxFreq) channelData.push(values);
        else {
            var ratio = maxFreq / chan.freq, held = new Float64Array(baseSamples);
            for (var u = 0; u < baseSamples; u++) held[u] = values[Math.min(Math.floor(u / ratio), values.length - 1)];
            channelData.push(held);
        }
        if (onProgress) onProgress(ci + 1, channels.length);
    }
    return { columnNames: columnNames, units: units, channelData: channelData, baseSamples: baseSamples, maxFreq: maxFreq };
}

function parseLdFile(buffer, onProgress) {
    var p = parseLdColumns(buffer, onProgress), cols = p.channelData, numCols = cols.length, data = new Array(p.baseSamples);
    for (var r = 0; r < p.baseSamples; r++) {
        var row = new Array(numCols);
        for (var c = 0; c < numCols; c++) row[c] = cols[c][r];
        data[r] = row;
    }
    return { columnNames: p.columnNames, units: p.units, data: data, maxFreq: p.maxFreq };
}
