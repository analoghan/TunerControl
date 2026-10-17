/**
 * injector/m1pkg-injector.js — Primary injector settings from a MoTeC M1 package (.m1pkg), for the Injector and Diagnostics tools.
 *
 * m1pkgInjector(pkg) → {
 *   tuneName,
 *   minVolume, minVolumeHysteresis: µl     (Fuel Injector Primary Minimum Volume [+ Hysteresis]; below it every injector stops
 *                                           until all cylinders are above Minimum Volume + Hysteresis)
 *   openTime: µs, referenceFlow: cc/min, referencePressure: bar
 *   linearisation: { volumes: [µl], pressures: [bar], values: [[µs per volume site] per pressure site] } | null
 *                                          (Fuel Injector Primary Linearisation: time added by Fuel Volume and Differential Pressure)
 *   notes: [string]
 * }
 * Package values are SI: volume m³ (× 1e9 → µl), pressure Pa / dPa (× 1e-5 → bar), time s (× 1e6 → µs), flow m³/s (× 6e7 → cc/min).
 * Tables: values[x + y × x.maxSites]. The result is plain data, so it can be posted to a worker.
 */

function m1injItem(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

function m1injNum(item, scale) {
    return item && typeof item.value === 'number' ? Math.round(item.value * scale * 1e4) / 1e4 : null;
}

function m1pkgInjector(pkg) {
    var out = { tuneName: pkg.tuneName || '', notes: [] };
    out.minVolume = m1injNum(m1injItem(pkg, 'Fuel.Injector.Primary.Minimum Volume'), 1e9);
    out.minVolumeHysteresis = m1injNum(m1injItem(pkg, 'Fuel.Injector.Primary.Minimum Volume Hysteresis.Value') ||
        m1injItem(pkg, 'Fuel.Injector.Primary.Minimum Volume Hysteresis'), 1e9);
    out.openTime = m1injNum(m1injItem(pkg, 'Fuel.Injector.Primary.Open Time'), 1e6);
    out.referenceFlow = m1injNum(m1injItem(pkg, 'Fuel.Injector.Primary.Reference Flow'), 6e7);
    out.referencePressure = m1injNum(m1injItem(pkg, 'Fuel.Injector.Primary.Reference Pressure'), 1e-5);
    out.linearisation = null;
    var lin = m1injItem(pkg, 'Fuel.Injector.Primary.Linearisation');
    if (lin && lin.values) {
        var ax = (lin.axes || []).filter(function (a) { return a.axis === 'X'; })[0], ay = (lin.axes || []).filter(function (a) { return a.axis === 'Y'; })[0];
        var nx = ax && ax.sites > 0 ? ax.sites : 1, ny = ay && ay.sites > 0 ? ay.sites : 1, xMax = ax && ax.maxSites ? ax.maxSites : nx, values = [];
        for (var y = 0; y < ny; y++) {
            var row = [];
            for (var x = 0; x < nx; x++) row.push(Math.round(lin.values[x + y * xMax] * 1e6 * 100) / 100);
            values.push(row);
        }
        out.linearisation = {
            volumeInput: ax ? ax.input : '', pressureInput: ay ? ay.input : '',
            volumes: ax && /Volume/.test(ax.input || '') ? ax.values.slice(0, nx).map(function (v) { return Math.round(v * 1e9 * 100) / 100; }) : [0],
            pressures: ay && /Pressure/.test(ay.input || '') ? ay.values.slice(0, ny).map(function (v) { return Math.round(v * 1e-5 * 10) / 10; }) : [0],
            values: values
        };
    }
    if (out.minVolume === null) out.notes.push('Fuel Injector Primary Minimum Volume not found in this tune.');
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { m1pkgInjector: m1pkgInjector };
