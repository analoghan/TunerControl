/**
 * test-m1-config-format.js — Unit tests for m1-config/format.js display helpers.
 */

function m1fTable() {
  return {
    name: 'Fuel.Timing.Primary.Main', kind: 'Table', type: 'f32', unit: 'deg', displayUnit: 'dBTDC', dps: 1,
    tags: ['Engine', 'Tune'],
    axes: [
      { axis: 'X', input: 'Engine.Speed', unit: 'deg/s', displayUnit: 'rpm', dps: 0, maxSites: 3, sites: 2, values: [0, 6000, 6000] },
      { axis: 'Y', input: 'Inlet.Manifold.Pressure', unit: 'Pa', displayUnit: 'kPa', dps: 1, maxSites: 2, sites: 2, values: [0, 100000] }
    ],
    values: [-300, -310, 0, -305, -315, 0]
  };
}

describe('M1 Config format — unit conversion', function () {

  it('converts known display units', function () {
    assert.equal(m1cConvert(6000, { unit: 'deg/s', displayUnit: 'rpm' }).value, 1000);
    assert.equal(m1cConvert(101300, { unit: 'Pa', displayUnit: 'kPa' }).value, 101.3);
    assert.equal(m1cConvert(-310, { unit: 'deg', displayUnit: 'dBTDC' }).value, 310);
    assert.closeTo(m1cConvert(0.025, { unit: 's', displayUnit: 'ms' }).value, 25, 1e-9);
    assert.equal(m1cConvert(0.5, { unit: 'ratio', displayUnit: '%' }).unit, '%');
  });

  it('keeps the stored unit when the conversion is unknown', function () {
    var c = m1cConvert(-30, { unit: 'deg', displayUnit: 'dADV', dps: 1 });
    assert.equal(c.value, -30);
    assert.equal(c.unit, 'deg');
    assert.equal(c.dps, null);
  });

  it('formats numbers with display decimals or trimmed precision', function () {
    assert.equal(m1cFormatNumber(1.23456, 2), '1.23');
    assert.equal(m1cFormatNumber(0.1 + 0.2, null), '0.3');
    assert.equal(m1cFormatNumber(42000, null), '42000');
  });
});

describe('M1 Config format — item values', function () {

  it('formats enums, IO resources and converted scalars', function () {
    assert.equal(m1cFormatValue({ type: 'enum' }, 1, 'Inverting'), 'Inverting');
    assert.equal(m1cFormatValue({ type: 'io_resource' }, ['0x0000', '0x0000', '0x652a', '0x0000', '0x0000']), '0x652a');
    assert.equal(m1cFormatValue({ type: 'io_resource' }, ['0x0000', '0x0000', '0x0000', '0x0000', '0x0000']), 'Not assigned');
    assert.equal(m1cFormatValue({ type: 'f32', unit: 'deg/s', displayUnit: 'rpm', dps: 0 }, 42000), '7000');
    assert.equal(m1cUnit({ type: 'f32', unit: 'deg/s', displayUnit: 'rpm' }), 'rpm');
    assert.equal(m1cUnit({ type: 'enum' }), '');
  });

  it('builds the used portion of a table grid in display units', function () {
    var g = m1cTableGrid(m1fTable());
    assert.deepEqual(g.x, [0, 1000]);
    assert.deepEqual(g.y, [0, 100]);
    assert.deepEqual(g.slices[0].rows, [[300, 310], [305, 315]]);
    assert.equal(m1cTableSize(m1fTable()), '2 × 2 of 3 × 2');
  });

  it('labels and formats diff cells', function () {
    var t = m1fTable();
    assert.equal(m1cCellLabel(t, 'V[1,1]'), '1000 rpm, 100.0 kPa');
    assert.equal(m1cCellLabel(t, 'X[2]'), 'X axis site 3');
    assert.equal(m1cFormatCell(t, 'V[1,1]', -315), '315.0');
    assert.equal(m1cFormatCell(t, 'X[1]', 6000), '1000');
    assert.equal(m1cFormatCell(t, 'V[0,0]', null), '—');
  });

  it('assigns items to page categories from tags and names', function () {
    assert.deepEqual(m1cCategories({ name: 'Driver.Switch 6.Input Resource', tags: ['Vehicle', 'Setup', 'Input'] }),
      ['all', 'driver', 'vehicle']);
    assert.deepEqual(m1cCategories({ name: 'Anti Lag.Mode', tags: ['Engine', 'Setup', 'Feature'] }),
      ['all', 'firmware', 'engine']);
  });
});
