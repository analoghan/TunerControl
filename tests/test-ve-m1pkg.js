/**
 * test-ve-m1pkg.js — Tests for ve-table/m1pkg-ve.js (VE table input from a .m1pkg).
 */

describe('VE Table — m1pkgVeTableCsv', function () {

  // Parsed-package shape as produced by parseM1Pkg: 3 × 2 used sites of a 4 × 3 table, one Z slice.
  function vePkg(overrides) {
    var o = overrides || {};
    return {
      tuneName: 'Tune V55',
      items: [{
        name: 'Engine.Efficiency.Main', kind: 'Table', unit: o.unit || 'ratio',
        axes: [
          { axis: 'X', input: 'Engine.Speed.Reference.Engine Speed', unit: 'deg/s', maxSites: 4, sites: 3,
            values: [0, 3000, 6000, 0] },
          { axis: 'Y', input: o.yInput || 'Inlet.Manifold.Pressure.Value', unit: 'Pa', maxSites: 3, sites: 2,
            values: [20000, 100000, 0] },
          { axis: 'Z', input: 'Ambient.Pressure.Value', unit: 'Pa', maxSites: 5, sites: o.zSites || 1,
            values: [100000, 100000, 100000, 100000, 100000] }
        ],
        // X fastest: row y=0 (20 kPa) then y=1 (100 kPa); 4th column and 3rd row unused.
        values: [0.30, 0.40, 0.50, 9, 0.60, 0.70, 0.80, 9, 9, 9, 9, 9]
      }]
    };
  }

  it('renders an M1 v2 CSV that parseVETable reads back in rpm, kPa and %', function () {
    var r = m1pkgVeTableCsv(vePkg());
    assert.equal(r.tuneName, 'Tune V55');
    assert.deepEqual([r.rpmSites, r.mapSites], [3, 2]);
    var lines = r.csv.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['M1,v2', 'Body,%', 'Cols,rpm,Eng Speed', 'Rows,kPa,Inlet Man Pres']);
    var t = parseVETable(r.csv);
    assert.deepEqual(t.rpmBreakpoints, [0, 500, 1000]);
    assert.deepEqual(t.mapBreakpoints, [100, 20], 'highest pressure first, like M1 Tune');
    assert.closeTo(t.values[0][0], 60, 1e-9);
    assert.closeTo(t.values[1][2], 50, 1e-9);
  });

  it('formats numbers like M1 Tune exports', function () {
    assert.equal(m1veScientific(57.2041153907775879), '5.72041153907775879e+01');
    assert.equal(m1veScientific(0), '0.00000000000000000e+00');
  });

  it('rejects packages without a usable RPM × MAP efficiency table', function () {
    assert.throws(function () { m1pkgVeTableCsv({ items: [] }); }, 'no Engine.Efficiency.Main');
    assert.throws(function () { m1pkgVeTableCsv(vePkg({ zSites: 2 })); }, 'slices');
    assert.throws(function () { m1pkgVeTableCsv(vePkg({ yInput: 'Throttle.Position' })); }, 'Y axis');
    assert.throws(function () { m1pkgVeTableCsv(vePkg({ unit: 'kg' })); }, 'ratios');
  });
});
