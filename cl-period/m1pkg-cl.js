/**
 * cl-period/m1pkg-cl.js — Closed-loop settings from a MoTeC M1 package (.m1pkg), for the Closed-Loop Period page.
 * Needs ve-table/m1pkg-ve.js (m1pkgVeClosedLoopPeriod).
 *
 * m1pkgClPeriod(pkg) → { tuneName, period: { flow: [g/s], ms: [ms], cylinders } | null, gain: % | null }
 */

function m1pkgClPeriod(pkg) {
    var gain = null;
    for (var i = 0; i < pkg.items.length; i++) {
        var it = pkg.items[i];
        if (it.name === 'Fuel.Closed Loop.Control.Trim.Gain.Value') gain = typeof it.value === 'number' ? it.value * 100 : it.values ? it.values[0] * 100 : null;
    }
    var period = m1pkgVeClosedLoopPeriod(pkg);
    if (period) {   // stored as kg/s and s: 0.00999… → 10 g/s
        period.flow = period.flow.map(function (x) { return Math.round(x * 100) / 100; });
        period.ms = period.ms.map(function (x) { return Math.round(x * 10) / 10; });
    }
    return { tuneName: pkg.tuneName || null, period: period, gain: gain };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { m1pkgClPeriod: m1pkgClPeriod };
