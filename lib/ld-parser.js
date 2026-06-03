/**
 * lib/ld-parser.js — MoTeC .ld Binary Log Parser (shared utility)
 * Extracted for use across multiple tools without loading the full knock worker.
 */

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

function readChannelData(buffer, chan) {
    if (!chan.dataType || chan.bytesPerSample === 0) return new Float64Array(chan.nData);
    var result = new Float64Array(chan.nData), view = new DataView(buffer), offset = chan.dataPtr;
    for (var i = 0; i < chan.nData; i++) {
        if (offset + chan.bytesPerSample > buffer.byteLength) break;
        switch (chan.dataType) {
            case 'float32': result[i] = view.getFloat32(offset, true); break;
            case 'float16': result[i] = decodeFloat16(view.getUint16(offset, true)); break;
            case 'int16': result[i] = view.getInt16(offset, true); break;
            case 'int32': result[i] = view.getInt32(offset, true); break;
            default: result[i] = 0;
        }
        offset += chan.bytesPerSample;
    }
    return result;
}

function parseLdFile(buffer, progressCallback) {
    var view = new DataView(buffer);
    var metaPtr = view.getUint32(8, true), dataPtr = view.getUint32(12, true), numChanns = view.getUint32(86, true);
    if (metaPtr === 0 || numChanns === 0) throw new Error('Invalid .ld file: no channel metadata found');

    var CHAN_HEADER_SIZE = 124, channels = [], ptr = metaPtr;
    for (var ch = 0; ch < numChanns && ptr !== 0; ch++) {
        if (ptr + CHAN_HEADER_SIZE > buffer.byteLength) break;
        var nextPtr = view.getUint32(ptr + 4, true);
        var chanDataPtr = view.getUint32(ptr + 8, true), nData = view.getUint32(ptr + 12, true);
        var dtypeA = view.getUint16(ptr + 18, true), dtypeVal = view.getUint16(ptr + 20, true), freq = view.getUint16(ptr + 22, true);
        var shift = view.getInt16(ptr + 24, true), mul = view.getInt16(ptr + 26, true), scale = view.getInt16(ptr + 28, true), dec = view.getInt16(ptr + 30, true);
        var name = readString(view, ptr + 32, 32), shortName = readString(view, ptr + 64, 8), unit = readString(view, ptr + 72, 12);
        var bytesPerSample = 0, dataType = null;
        if (dtypeA === 0x07) { if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'float16'; } else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'float32'; } }
        else if (dtypeA === 0 || dtypeA === 0x03 || dtypeA === 0x05) { if (dtypeVal === 2) { bytesPerSample = 2; dataType = 'int16'; } else if (dtypeVal === 4) { bytesPerSample = 4; dataType = 'int32'; } }
        channels.push({ name: name, shortName: shortName, unit: unit, freq: freq, dataPtr: chanDataPtr, nData: nData, dataType: dataType, bytesPerSample: bytesPerSample, shift: shift, mul: mul, scale: scale, dec: dec });
        ptr = nextPtr;
    }
    if (channels.length === 0) throw new Error('No channels found in .ld file');

    var maxFreq = 0;
    for (var i = 0; i < channels.length; i++) { if (channels[i].freq > maxFreq) maxFreq = channels[i].freq; }
    var baseSamples = 0;
    for (var i = 0; i < channels.length; i++) { if (channels[i].freq === maxFreq) { baseSamples = channels[i].nData; break; } }
    if (baseSamples === 0) throw new Error('Could not determine sample count from .ld file');

    var columnNames = ['Time'], channelData = [];
    var timeArr = new Float64Array(baseSamples), dt = 1.0 / maxFreq;
    for (var t = 0; t < baseSamples; t++) timeArr[t] = t * dt;
    channelData.push(timeArr);

    for (var ci = 0; ci < channels.length; ci++) {
        var chan = channels[ci];
        columnNames.push(normalizeLdChannelNameWithUnit(chan.name, chan.shortName));
        var rawData = readChannelData(buffer, chan);
        var transformed = new Float64Array(rawData.length), decFactor = Math.pow(10, -chan.dec);
        for (var s = 0; s < rawData.length; s++) transformed[s] = (rawData[s] / chan.scale * decFactor + chan.shift) * chan.mul;
        if (chan.freq === maxFreq) { channelData.push(transformed); }
        else { var ratio = maxFreq / chan.freq; var upsampled = new Float64Array(baseSamples); for (var u = 0; u < baseSamples; u++) upsampled[u] = transformed[Math.min(Math.floor(u / ratio), transformed.length - 1)]; channelData.push(upsampled); }
        if (progressCallback) progressCallback(ci + 1, channels.length);
    }

    var numCols = columnNames.length, data = new Array(baseSamples);
    for (var r = 0; r < baseSamples; r++) { var row = new Array(numCols); for (var c = 0; c < numCols; c++) row[c] = channelData[c][r]; data[r] = row; }
    return { columnNames: columnNames, data: data, maxFreq: maxFreq };
}
