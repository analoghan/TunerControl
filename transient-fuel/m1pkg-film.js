/**
 * m1pkg-film.js — Reads the primary fuel film calibration from a MoTeC M1 package (.m1pkg).
 *
 * Takes a parsed package (lib/m1pkg-parser.js) and returns Fuel Film Primary Main in the same
 * { breakpoints, values } shape as parseFuelFilmTable (kPa, ul), plus the scale, offset, fast part and
 * time constants the analyzer otherwise asks the user to type in.
 */

/** Coolant temperature at which temperature-dependent time constants are read (fully warm engine). */
var M1FILM_WARM_COOLANT_C = 90;

function m1filmFind(pkg, name) {
    for (var i = 0; i < pkg.items.length; i++) if (pkg.items[i].name === name) return pkg.items[i];
    return null;
}

/** Linear interpolation of a 1D table's used sites at x, clamped at the ends. */
function m1filmLookup(item, x) {
    var a = item.axes[0], n = a.sites, xs = a.values, ys = item.values;
    if (n === 1 || x <= xs[0]) return ys[0];
    for (var i = 1; i < n; i++) {
        if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    }
    return ys[n - 1];
}

/**
 * Returns { tuneName, table: { breakpoints, values }, ffScale, ffOffset, timeConstants, notes }.
 * Units match the analyzer's inputs: kPa, ul, %, seconds. Throws if the main table is missing or not
 * a 1D manifold pressure table.
 */
function m1pkgFuelFilm(pkg) {
    var main = m1filmFind(pkg, 'Fuel.Film.Primary.Main.Value');
    if (!main || main.kind !== 'Table') throw new Error('This package has no Fuel Film Primary Main table.');
    var x = main.axes[0];
    if (main.axes.length !== 1 || x.unit !== 'Pa' || main.unit !== 'm3' ||
        !/^Inlet\.Manifold\.Pressure/.test(x.input || '')) {
        throw new Error('Fuel Film Primary Main is not a manifold pressure table of fuel volumes (axes: ' +
            main.axes.map(function (a) { return a.input + ' [' + a.unit + ']'; }).join(', ') + ').');
    }

    var breakpoints = [], values = [];
    for (var i = 0; i < x.sites; i++) {
        breakpoints.push(x.values[i] / 1000);   // Pa → kPa
        values.push(main.values[i] * 1e9);      // m³ → ul
    }

    var notes = [], out = { tuneName: pkg.tuneName, table: { breakpoints: breakpoints, values: values }, notes: notes };

    var scale = m1filmFind(pkg, 'Fuel.Film.Primary.Scale.Value');
    var offset = m1filmFind(pkg, 'Fuel.Film.Primary.Offset.Value');
    if (scale && scale.unit === 'ratio') out.ffScale = scale.value * 100;
    if (offset && offset.unit === 'm3') out.ffOffset = offset.value * 1e9;

    // Fast part and time constants are small tables (engine speed / coolant temperature). The analyzer
    // takes one value each, so multi-site tables are read at the reference speed or a warm engine.
    var refSpeed = m1filmFind(pkg, 'Fuel.Film.Primary.Reference Engine Speed.Value');
    function scalar(name, unit, at, atLabel, factor) {
        var item = m1filmFind(pkg, 'Fuel.Film.Primary.' + name + '.Value');
        if (!item || item.kind !== 'Table' || item.axes.length !== 1 || item.unit !== unit) return undefined;
        if (item.axes[0].sites > 1) notes.push(name + ' varies with ' + item.axes[0].input + '; read at ' + atLabel + '.');
        return m1filmLookup(item, at) * factor;
    }
    var rpm = refSpeed ? refSpeed.value : 0;
    var tc = {
        fastPct: scalar('Fast.Part', 'ratio', rpm, Math.round(rpm / 6) + ' rpm (reference engine speed)', 100),
        fastIncrease: scalar('Fast.Increase Time Constant', 's', M1FILM_WARM_COOLANT_C, M1FILM_WARM_COOLANT_C + ' °C', 1),
        fastDecrease: scalar('Fast.Decrease Time Constant', 's', M1FILM_WARM_COOLANT_C, M1FILM_WARM_COOLANT_C + ' °C', 1),
        slowIncrease: scalar('Slow.Increase Time Constant', 's', M1FILM_WARM_COOLANT_C, M1FILM_WARM_COOLANT_C + ' °C', 1),
        slowDecrease: scalar('Slow.Decrease Time Constant', 's', M1FILM_WARM_COOLANT_C, M1FILM_WARM_COOLANT_C + ' °C', 1)
    };
    out.timeConstants = tc;

    // Settings the recommendations check against the firmware's guidance.
    var trim = m1filmFind(pkg, 'Fuel.Film.Primary.Trim.Engine Speed.Value');
    var minVol = m1filmFind(pkg, 'Fuel.Injector.Primary.Minimum Volume');
    var minHyst = m1filmFind(pkg, 'Fuel.Injector.Primary.Minimum Volume Hysteresis.Value');
    var clMode = m1filmFind(pkg, 'Fuel.Closed Loop.Mode');
    out.tuneChecks = {
        refSpeedRpm: refSpeed ? Math.round(refSpeed.value / 6) : null,
        speedTrimAtRefPct: trim && trim.kind === 'Table' && trim.unit === 'ratio' && refSpeed ? (m1filmLookup(trim, refSpeed.value) - 1) * 100 : null,
        minVolume: minVol && minVol.unit === 'm3' ? +(minVol.value * 1e9).toFixed(2) : null,
        minVolumeHysteresis: minHyst && minHyst.unit === 'm3' ? +(minHyst.value * 1e9).toFixed(2) : null,
        closedLoopMode: clMode ? clMode.label || null : null
    };
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { m1pkgFuelFilm: m1pkgFuelFilm, m1filmLookup: m1filmLookup };
}
