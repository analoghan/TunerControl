/**
 * knock/m1pkg-knock.js — Knock settings from a MoTeC M1 package (.m1pkg), for the Knock Analyzer.
 *
 * m1pkgKnock(pkg) → {
 *   tuneName,
 *   threshold: { rpm: [..], load: [..] | null, values: [[% per rpm site] per load site] } | null   (Knock.Threshold)
 *   ignitionAxes: { rpm: [..], load: [..], loadInput } | null    (Ignition.Timing.Main sites, to bin knock like the table)
 *   inputs: ['Knock Input 1', …] per cylinder (index 0 = cylinder 1) | null
 *   trimLimit, trimGain: first site, as stored (the tune shows both in degrees) | null
 *   frequencies: [A, B, C, D] Hz | null      mode: Knock Mode label, e.g. 'Enable A B C D' | null
 *   notes: [string]
 * }
 * Package values are SI: engine speed in deg/s (÷ 6 → rpm), ratios (× 100 → %).
 */

function m1knItem(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

function m1knAxis(item, axis) {
    var a = (item.axes || []).filter(function (x) { return x.axis === axis; })[0];
    return a && a.sites > 0 ? a : null;
}

function m1knSites(a, scale) {
    return a.values.slice(0, a.sites).map(function (v) { return Math.round(v * scale * 1000) / 1000; });
}

function m1pkgKnock(pkg) {
    var out = { tuneName: pkg.tuneName, threshold: null, ignitionAxes: null, inputs: null, trimLimit: null, trimGain: null, notes: [] };

    var th = m1knItem(pkg, 'Knock.Threshold');
    if (th && th.kind === 'Table') {
        var x = m1knAxis(th, 'X'), y = m1knAxis(th, 'Y');
        if (x && x.unit === 'deg/s') {
            var ny = y && y.sites > 1 && /Engine\.Load\.Normalised/.test(y.input || '') ? y.sites : 1;
            var values = [];
            for (var iy = 0; iy < ny; iy++) {
                var row = [];
                for (var ix = 0; ix < x.sites; ix++) row.push(th.values[ix + iy * x.maxSites] * 100);
                values.push(row);
            }
            out.threshold = { rpm: m1knSites(x, 1 / 6), load: ny > 1 ? m1knSites(y, 1) : null, values: values };
            if (y && y.sites > 1 && ny === 1) out.notes.push('Knock Threshold also varies by ' + y.input + '; only its first site is used.');
        } else {
            out.notes.push('Knock Threshold is not indexed by engine speed; enter the threshold by hand.');
        }
    } else if (th) {
        out.threshold = { rpm: [0], load: null, values: [[th.values ? th.values[0] * 100 : th.value * 100]] };
    }

    var ign = m1knItem(pkg, 'Ignition.Timing.Main');
    if (ign && ign.kind === 'Table') {
        var ix2 = m1knAxis(ign, 'X'), iy2 = m1knAxis(ign, 'Y');
        if (ix2 && ix2.unit === 'deg/s') {
            out.ignitionAxes = { rpm: m1knSites(ix2, 1 / 6), load: iy2 ? m1knSites(iy2, 1) : null, loadInput: iy2 ? iy2.input : null };
        }
    }

    var inputs = [];
    for (var c = 1; c <= 8; c++) {
        var res = m1knItem(pkg, 'Knock.Cylinder ' + c + '.Resource.Value');
        var ids = res && (Array.isArray(res.value) ? res.value : null);
        var id = ids ? ids.map(function (s) { return parseInt(s, 16); }).filter(function (n) { return n >= 0x6100 && n <= 0x6103; })[0] : undefined;
        inputs.push(id !== undefined ? 'Knock Input ' + (id - 0x6100 + 1) : null);
    }
    if (inputs.some(Boolean)) out.inputs = inputs;

    function first(name) {
        var it = m1knItem(pkg, name);
        if (!it) return null;
        return it.values ? it.values[0] : typeof it.value === 'number' ? it.value : null;
    }
    out.trimLimit = first('Knock.Trim.Limit');
    out.trimGain = first('Knock.Trim.Gain');
    out.frequencies = ['A', 'B', 'C', 'D'].map(function (k) { return first('Knock.Frequency ' + k); });
    if (!out.frequencies.some(function (f) { return f > 0; })) out.frequencies = null;
    var mode = m1knItem(pkg, 'Knock.Mode');
    out.mode = mode ? mode.label || null : null;
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { m1pkgKnock: m1pkgKnock };
