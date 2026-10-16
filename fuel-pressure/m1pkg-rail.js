/**
 * fuel-pressure/m1pkg-rail.js — DI rail pressure control settings from a MoTeC M1 package (.m1pkg).
 *
 * m1pkgRail(pkg) → {
 *   tuneName,
 *   aim: { rpm: [..], volume: [..] (µl per engine cycle), values: [[bar per volume site] per rpm site] } | null
 *        (Fuel.Pressure.Direct.Aim: engine speed × Fuel Volume Per Cycle Primary)
 *   pGain, iGain: as stored (ratio/Pa, ratio/(Pa·s)) | null — shown relative ("× 0.8"), so the display unit doesn't matter
 *   pGainPctPerBar, iGainPctPerBarS: the same in %/bar and %/(bar·s), for reading
 *   margin, maximum: bar | null
 *   displacement: cc per pump stroke | null, lobes
 *   notes: [string]
 * }
 * Package values are SI: Pa (÷ 1e5 → bar), m³ (× 1e9 → µl), deg/s (÷ 6 → rpm).
 */

var M1RAIL_BANK = 'Fuel.Pressure.Direct.Bank 1';

function m1rItem(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

function m1rScalar(pkg, name) {
    var it = m1rItem(pkg, name);
    if (!it) return null;
    if (typeof it.value === 'number') return it.value;
    return it.values && typeof it.values[0] === 'number' ? it.values[0] : null;
}

function m1rRound(v, dp) { var f = Math.pow(10, dp); return Math.round(v * f) / f; }

function m1pkgRail(pkg) {
    var out = { tuneName: pkg.tuneName, aim: null, pGain: null, iGain: null, pGainPctPerBar: null, iGainPctPerBarS: null,
                margin: null, maximum: null, displacement: null, lobes: null, notes: [] };

    var aim = m1rItem(pkg, 'Fuel.Pressure.Direct.Aim');
    if (aim && aim.kind === 'Table') {
        var ax = {};
        (aim.axes || []).forEach(function (a) { ax[a.axis] = a; });
        var x = ax.X, y = ax.Y;
        var volAxis = x && /Fuel\.Volume/.test(x.input || '') ? x : y && /Fuel\.Volume/.test(y.input || '') ? y : null;
        var rpmAxis = x && x.unit === 'deg/s' ? x : y && y.unit === 'deg/s' ? y : null;
        if (volAxis && rpmAxis && volAxis.sites > 0 && rpmAxis.sites > 0) {
            var volIsX = volAxis === x, values = [];
            for (var ir = 0; ir < rpmAxis.sites; ir++) {
                var row = [];
                for (var iv = 0; iv < volAxis.sites; iv++) {
                    var idx = volIsX ? iv + ir * x.maxSites : ir + iv * x.maxSites;
                    row.push(m1rRound(aim.values[idx] / 1e5, 2));
                }
                values.push(row);
            }
            out.aim = {
                rpm: rpmAxis.values.slice(0, rpmAxis.sites).map(function (v) { return m1rRound(v / 6, 1); }),
                volume: volAxis.values.slice(0, volAxis.sites).map(function (v) { return m1rRound(v * 1e9, 1); }),
                values: values, volumeInput: volAxis.input
            };
        } else {
            out.notes.push('Fuel Pressure Direct Aim is not an engine speed × fuel volume table (' +
                (aim.axes || []).map(function (a) { return a.input; }).join(', ') + '); its cells are not mapped.');
        }
    }

    out.pGain = m1rScalar(pkg, M1RAIL_BANK + '.Control.Proportional.Gain');
    out.iGain = m1rScalar(pkg, M1RAIL_BANK + '.Control.Integral.Gain');
    if (out.pGain !== null) out.pGainPctPerBar = m1rRound(out.pGain * 1e5 * 100, 4);
    if (out.iGain !== null) out.iGainPctPerBarS = m1rRound(out.iGain * 1e5 * 100, 4);
    var margin = m1rScalar(pkg, M1RAIL_BANK + '.Margin'), max = m1rScalar(pkg, M1RAIL_BANK + '.Maximum');
    out.margin = margin !== null ? m1rRound(margin / 1e5, 1) : null;
    out.maximum = max !== null ? m1rRound(max / 1e5, 1) : null;
    var disp = m1rScalar(pkg, M1RAIL_BANK + '.Pump.Displacement');
    out.displacement = disp !== null ? m1rRound(disp * 1e6, 3) : null;
    out.lobes = m1rScalar(pkg, M1RAIL_BANK + '.Pump.Camshaft Lobes');
    if (out.pGain === null && out.iGain === null) out.notes.push('No rail pressure control gains found for Bank 1.');
    return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { m1pkgRail: m1pkgRail };
