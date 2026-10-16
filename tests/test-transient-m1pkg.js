/**
 * test-transient-m1pkg.js — Tests for transient-fuel/m1pkg-film.js (fuel film settings from a .m1pkg).
 */

describe('Transient Fuel — m1pkgFuelFilm', function () {

  function table(name, input, unit, xUnit, xs, ys, maxSites) {
    var n = maxSites || 11, xv = xs.slice(), yv = ys.slice();
    while (xv.length < n) { xv.push(0); yv.push(0); }
    return { name: name, kind: 'Table', unit: unit,
             axes: [{ axis: 'X', input: input, unit: xUnit, maxSites: n, sites: xs.length, values: xv }], values: yv };
  }
  function tc(name, ys, xs) {
    return table('Fuel.Film.Primary.' + name + '.Value', 'Coolant.Temperature.Value', 's', 'C', xs || [0], ys);
  }
  // Shapes and SI units as parseM1Pkg returns them for an M142 tune.
  function filmPkg(extra) {
    return { tuneName: 'Tune V55', items: [
      table('Fuel.Film.Primary.Main.Value', 'Inlet.Manifold.Pressure.Value', 'm3', 'Pa',
            [0, 20000, 100000, 500000], [0, 2.15e-8, 2.19e-7, 1.25e-6], 21),
      { name: 'Fuel.Film.Primary.Scale.Value', kind: 'Parameter', unit: 'ratio', value: 0.26 },
      { name: 'Fuel.Film.Primary.Offset.Value', kind: 'Parameter', unit: 'm3', value: 3e-8 },
      { name: 'Fuel.Film.Primary.Reference Engine Speed.Value', kind: 'Parameter', unit: 'deg/s', value: 15000 },
      table('Fuel.Film.Primary.Fast.Part.Value', 'Engine.Speed.Reference.Engine Speed', 'ratio', 'deg/s', [0], [0.3]),
      tc('Fast.Increase Time Constant', [0.1]),
      tc('Fast.Decrease Time Constant', [0.15]),
      tc('Slow.Increase Time Constant', [0.25]),
      extra || tc('Slow.Decrease Time Constant', [0.1])
    ] };
  }

  it('reads the main table in kPa and ul, ignoring unused sites', function () {
    var f = m1pkgFuelFilm(filmPkg());
    assert.equal(f.tuneName, 'Tune V55');
    assert.deepEqual(f.table.breakpoints, [0, 20, 100, 500]);
    assert.equal(f.table.values.length, 4);
    assert.closeTo(f.table.values[1], 21.5, 1e-6);
    assert.closeTo(f.table.values[3], 1250, 1e-6);
  });

  it('converts scale, offset, fast part and time constants to the analyzer inputs', function () {
    var f = m1pkgFuelFilm(filmPkg());
    assert.closeTo(f.ffScale, 26, 1e-9);
    assert.closeTo(f.ffOffset, 30, 1e-9);
    assert.closeTo(f.timeConstants.fastPct, 30, 1e-9);
    assert.deepEqual([f.timeConstants.fastIncrease, f.timeConstants.fastDecrease,
                      f.timeConstants.slowIncrease, f.timeConstants.slowDecrease], [0.1, 0.15, 0.25, 0.1]);
    assert.equal(f.notes.length, 0);
  });

  it('reads temperature-dependent time constants at a warm engine and says so', function () {
    var f = m1pkgFuelFilm(filmPkg(tc('Slow.Decrease Time Constant', [1, 0.5, 0.2], [20, 80, 100])));
    assert.closeTo(f.timeConstants.slowDecrease, 0.35, 1e-9);
    assert.equal(f.notes.length, 1);
    assert.ok(f.notes[0].indexOf('90 °C') >= 0);
  });

  it('rejects packages without a manifold pressure fuel film table', function () {
    assert.throws(function () { m1pkgFuelFilm({ items: [] }); }, 'no Fuel Film Primary Main');
    var p = filmPkg();
    p.items[0].axes[0].input = 'Throttle.Position';
    assert.throws(function () { m1pkgFuelFilm(p); }, 'not a manifold pressure table');
  });
});
