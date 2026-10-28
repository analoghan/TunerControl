/**
 * test-map-rescale.js — Tests for the MAP Rescale conversion (map-rescale/map-rescale.js) on a synthetic parsed package.
 * Run: node tests/test-map-rescale.js
 */

'use strict';

var assert = require('assert');
global.m1cConvert = require('../m1-config/format.js').m1cConvert;
var M = require('../map-rescale/map-rescale.js');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + b + ', got ' + a); }

var RPM = { axis: 'X', input: 'Engine.Speed.Reference.Engine Speed', unit: 'deg/s', displayUnit: 'rpm', dps: 0 };
function axis(base, sites, maxSites, extra) {
    return Object.assign({}, base, { sites: sites.length, maxSites: maxSites, values: sites.concat(new Array(maxSites - sites.length).fill(sites[sites.length - 1])) }, extra);
}
function mapAxis(kpaSites, maxSites, axisName) {
    return axis({ input: 'Inlet.Manifold.Pressure.Value', unit: 'Pa', displayUnit: 'kPa', dps: 0 }, kpaSites.map(function (k) { return k * 1000; }),
        maxSites, { axis: axisName || 'Y' });
}
/** 2D table rpm (2 sites) × pressure axis, value f(rpmIndex, kPa). */
function table2d(name, unit, yAxis, f, scale) {
    var x = axis(RPM, [6000, 18000], 3), values = new Array(x.maxSites * yAxis.maxSites).fill(0);
    for (var j = 0; j < yAxis.sites; j++) for (var i = 0; i < x.sites; i++) values[i + j * x.maxSites] = f(i, yAxis.values[j] * scale);
    return { name: name, kind: 'Table', unit: unit, displayUnit: unit === 'ratio' ? '%' : unit, dps: 1, axes: [x, yAxis], values: values };
}
function pkg(loadMode) {
    var ve = table2d('Engine.Efficiency.Main', 'ratio', mapAxis([20, 40, 60, 100, 160], 6), function (i, kpa) { return 0.5 + 0.002 * kpa + 0.05 * i; }, 1e-3);
    var aim = table2d('Fuel.Mixture Aim.Main', 'LA', mapAxis([0, 50, 100, 150], 5), function (i, kpa) { return 1 - 0.001 * kpa; }, 1e-3);
    var loadAx = axis({ input: 'Engine.Load.Normalised.Value', unit: 'ratio', displayUnit: '%', dps: 0 }, [0.2, 0.6, 1.0, 1.6], 5, { axis: 'Y' });
    var ign = table2d('Ignition.Timing.Main', 'deg', loadAx, function (i, pct) { return -(40 - 0.15 * pct); }, 100);
    var single = table2d('Fuel.Timing.Secondary.Main', 'deg', mapAxis([100], 4), function () { return -300; }, 1e-3);
    var trans = { name: 'Inlet.Manifold.Pressure.Sensor.Translation', kind: 'Table', unit: 'Pa', displayUnit: 'kPa', dps: 1,
        axes: [axis({ input: 'Inlet.Manifold.Pressure.Sensor.Voltage.Normalised Filtered', unit: 'V', axis: 'X' }, [0, 5], 2)], values: [-32500, 425000] };
    var est = { name: 'Inlet.Manifold.Pressure.Estimate.Main', kind: 'Table', unit: 'Pa', displayUnit: 'kPa', dps: 1,
        axes: [axis(RPM, [6000, 12000], 2, { axis: 'X' })], values: [30000, 0] };
    return { tuneName: 'synthetic', items: [ve, aim, ign, single, trans, est,
        { name: 'Engine.Load.Normalised.Mode', kind: 'Parameter', label: loadMode, value: 0 },
        { name: 'Fuel.Closed Loop.Activate.Inlet Manifold Pressure.Value', kind: 'Parameter', unit: 'Pa', value: 10000 },
        { name: 'Nitrous.Stage 1.Activate.Inlet Manifold Pressure.Hysteresis', kind: 'Parameter', unit: 'Pa', value: 5000 },
        { name: 'Nitrous.Stage 1.Activate.Inlet Manifold Pressure.Minimum', kind: 'Parameter', unit: 'Pa', value: 0 }] };
}
var FROM = M.mrLine(0, -32.5, 5, 425), TO = M.mrLine(0, -17, 5, 353);
function find(r, name) { return r.tables.filter(function (t) { return t.name === name; })[0]; }
/** Linear interpolation of a table column along axis 1 (sites in kPa via scale), clamped. */
function colAt(item, i, kpa, scale) {
    var y = item.axes[1], xs = [], ys = [];
    for (var j = 0; j < y.sites; j++) { xs.push(y.values[j] * scale); ys.push(item.values[i + j * item.axes[0].maxSites]); }
    if (kpa <= xs[0]) return ys[0];
    for (j = 1; j < xs.length; j++) if (kpa <= xs[j]) return ys[j - 1] + (ys[j] - ys[j - 1]) * (kpa - xs[j - 1]) / (xs[j] - xs[j - 1]);
    return ys[ys.length - 1];
}

test('reads the translation and converts readings both ways', function () {
    var t = M.mrTranslation(pkg('Inlet Manifold Pressure'));
    near(t.offset, -32.5, 1e-9); near(t.slope, 91.5, 1e-9);
    near(M.mrConvertKpa(114.4, FROM, TO), -17 + 74 * (114.4 + 32.5) / 91.5, 1e-9);
    near(M.mrConvertKpa(M.mrConvertKpa(50, FROM, TO), TO, FROM), 50, 1e-9);
});

test('finds MAP and Load Normalised tables only in MAP mode, skips single-site axes', function () {
    var names = M.mrFindTables(pkg('Inlet Manifold Pressure')).map(function (e) { return e.item.name + ':' + e.kind; });
    assert.deepStrictEqual(names.sort(), ['Engine.Efficiency.Main:efficiency', 'Fuel.Mixture Aim.Main:axis', 'Ignition.Timing.Main:axis',
        'Inlet.Manifold.Pressure.Estimate.Main:reading']);
    var other = M.mrFindTables(pkg('Engine Load')).map(function (e) { return e.item.name; });
    assert.ok(other.indexOf('Ignition.Timing.Main') < 0);
});

test('keep mode: same air mass and same aim/ignition at every site voltage', function () {
    var p = pkg('Inlet Manifold Pressure'), r = M.mrConvertTune(p, FROM, TO, 'keep');
    var ve = find(r, 'Engine.Efficiency.Main'), veOld = p.items[0];
    ve.oldSites.forEach(function (s, j) {
        var x = M.mrConvertKpa(s, TO, FROM);
        if (x < ve.oldSites[0]) return;   // held
        for (var i = 0; i < 2; i++) near(colAt(ve.item, i, s, 1e-3) * s, colAt(veOld, i, x, 1e-3) * x, 1e-9, 'VE×MAP at ' + s + ' kPa');
    });
    var ign = find(r, 'Ignition.Timing.Main'), ignOld = p.items[2];
    ign.oldSites.forEach(function (s) {
        near(colAt(ign.item, 0, s, 100), colAt(ignOld, 0, M.mrConvertKpa(s, TO, FROM), 100), 1e-9, 'ignition at ' + s);
    });
    assert.deepStrictEqual(ign.newSites, ign.oldSites);
});

test('keep mode holds VE sites below the old axis and fills them from the nearest converted site', function () {
    var r = M.mrConvertTune(pkg('Inlet Manifold Pressure'), FROM, TO, 'keep'), ve = find(r, 'Engine.Efficiency.Main');
    // 20 kPa now = 0.5 V, which read 13.25 kPa before (< 20): held. 40 kPa now read 30 kPa before: converted.
    assert.deepStrictEqual(ve.held.map(function (idx) { return idx.join(','); }).sort(), ['0,0', '1,0']);
    for (var i = 0; i < 2; i++) assert.strictEqual(ve.item.values[i], ve.item.values[i + ve.item.axes[0].maxSites]);
});

test('move mode: sites move to the new reading, values kept, VE × old ÷ new; exact between sites', function () {
    var p = pkg('Inlet Manifold Pressure'), r = M.mrConvertTune(p, FROM, TO, 'move');
    var aim = find(r, 'Fuel.Mixture Aim.Main');
    aim.oldSites.forEach(function (s, j) { near(aim.newSites[j], M.mrConvertKpa(s, FROM, TO), 1e-9); });
    assert.deepStrictEqual(aim.item.values, p.items[1].values);
    near(colAt(aim.item, 0, M.mrConvertKpa(75, FROM, TO), 1e-3), colAt(p.items[1], 0, 75, 1e-3), 1e-9, 'aim between sites');
    var ve = find(r, 'Engine.Efficiency.Main');
    near(ve.item.values[0], p.items[0].values[0] * 20 / M.mrConvertKpa(20, FROM, TO), 1e-12);
    assert.strictEqual(ve.held.length, 0);
});

test('settings: thresholds like a reading, hysteresis by slope, zeros left; reading tables keep 0', function () {
    var r = M.mrConvertTune(pkg('Inlet Manifold Pressure'), FROM, TO, 'keep');
    var by = {};
    r.parameters.forEach(function (p) { by[p.item.name] = p; });
    near(by['Fuel.Closed Loop.Activate.Inlet Manifold Pressure.Value'].value, M.mrConvertKpa(10, FROM, TO) * 1000, 1e-6);
    near(by['Nitrous.Stage 1.Activate.Inlet Manifold Pressure.Hysteresis'].value, 5000 * 74 / 91.5, 1e-6);
    assert.strictEqual(by['Nitrous.Stage 1.Activate.Inlet Manifold Pressure.Minimum'].value, 0);
    var est = find(r, 'Inlet.Manifold.Pressure.Estimate.Main');
    near(est.item.values[0], M.mrConvertKpa(30, FROM, TO) * 1000, 1e-6);
    assert.strictEqual(est.item.values[1], 0);
});

test('Engine Efficiency CSV in the M1 Tune layout', function () {
    var r = M.mrConvertTune(pkg('Inlet Manifold Pressure'), FROM, TO, 'keep');
    var csv = M.mrEfficiencyCsv(find(r, 'Engine.Efficiency.Main'));
    var lines = csv.split('\r\n');
    assert.deepStrictEqual(lines.slice(0, 4), ['M1,v2', 'Body,%', 'Cols,rpm,Eng Speed', 'Rows,kPa,Inlet Man Pres']);
    assert.strictEqual(lines[4], ',"1.00000000000000000e+03","3.00000000000000000e+03"');
    assert.ok(lines[5].indexOf('"1.60000000000000000e+02"') === 0, 'highest pressure first');
    assert.strictEqual(lines.length, 5 + 5 + 1);
    assert.strictEqual(csv.slice(-3), '\r\n\0');
    assert.strictEqual(M.mrSci(57.2041153907775879), '5.72041153907775879e+01');
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('  ✓ ' + t.name); } catch (e) { failed++; console.log('  ✗ ' + t.name + '\n    ' + e.message); }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
