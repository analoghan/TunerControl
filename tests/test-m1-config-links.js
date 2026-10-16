/**
 * test-m1-config-links.js — Cross-references between settings (m1-config/links.js), the Config Viewer's Follow view.
 */
describe('M1 Config — following references', function () {
  function en(name, label) { return { name: name, kind: 'Parameter', type: 'enum', value: 1, label: label, tags: [] }; }
  function res(name, ids) { return { name: name, kind: 'IOResourceParameter', type: 'io_resource', value: ids, tags: [] }; }
  function num(name) { return { name: name, kind: 'Parameter', type: 'f32', value: 1, tags: [] }; }
  var FW5 = ['0x0000', '0x0000', '0x6525', '0x0000', '0x0000'];
  var items = [
    en('Brake.Switch.Index.Value', 'Driver Switch 8'),
    res('Driver.Switch 8.Input Resource', FW5), en('Driver.Switch 8.Type', 'Normal'), num('Driver.Switch 8.Input.Threshold.Value'),
    en('CAN.Receive.Custom.Message 1.Signal 2.Resource', 'Firmware 5'), num('CAN.Receive.Custom.Message 1.Signal 2.Start Bit'),
    en('Fuel.Pump.Switch.Index.Value', 'Driver Keypad Button 7'), num('Driver.CAN Keypad.Button 7.Mode'), num('Driver.CAN Keypad.Button 1.Mode'),
    en('Driver.CAN Keypad.Button 3.Linked Up Button', 'Button 1'),
    { name: 'Fuel.Mixture Aim.Main', kind: 'Table', type: 'f32', tags: [], values: [1],
      axes: [{ axis: 'Z', input: 'Driver.Fuel Mixture Aim Main Switch.Value', maxSites: 1, sites: 1, values: [0] }] },
    en('Driver.Fuel Mixture Aim Main Switch.Index.Value', 'Driver Switch 5'),
    en('Engine.Overrun.Mode', 'Enabled')
  ];
  function resName(ids) { return ids[2] === '0x6525' ? 'FIRMWARE5' : null; }
  var ix = m1lBuildIndex(items, resName);

  it('follows an enum value to the group it names', function () {
    var e = m1lEntity(ix, 'g:Driver.Switch 8');
    assert.deepEqual(e.usedBy.map(function (r) { return r.from; }), ['Brake.Switch.Index.Value']);
    assert.equal(m1lValueTarget(ix, items[0]), 'g:Driver.Switch 8');
  });

  it('ties an I/O resource to every assignment and enum value naming it', function () {
    var e = m1lEntity(ix, 'r:firmware5');
    assert.equal(e.title, 'FIRMWARE5');
    assert.deepEqual(e.usedBy.map(function (r) { return r.from; }).sort(),
      ['CAN.Receive.Custom.Message 1.Signal 2.Resource', 'Driver.Switch 8.Input Resource']);
    assert.deepEqual(m1lEntity(ix, 'g:Driver.Switch 8').uses.map(function (r) { return r.to; }), ['r:firmware5']);
  });

  it('matches labels whose words appear in a longer group path', function () {
    assert.equal(m1lValueTarget(ix, items[6]), 'g:Driver.CAN Keypad.Button 7');
  });

  it('resolves a short label against the item\'s own neighbourhood', function () {
    assert.equal(m1lValueTarget(ix, items[9]), 'g:Driver.CAN Keypad.Button 1');
  });

  it('follows a table axis to the setting group whose channel it reads', function () {
    var e = m1lEntity(ix, 'g:Driver.Fuel Mixture Aim Main Switch');
    assert.ok(e.usedBy.some(function (r) { return r.from === 'Fuel.Mixture Aim.Main' && r.kind === 'axis'; }));
    assert.deepEqual(e.members.map(function (it) { return it.name; }), ['Driver.Fuel Mixture Aim Main Switch.Index.Value'], 'the .Value item belongs to the switch');
  });

  it('ignores labels that name nothing and references to the item\'s own group', function () {
    assert.equal(m1lValueTarget(ix, items[12]), null);
    assert.equal(m1lValueTarget(ix, items[2]), null);
  });

  it('lists a group\'s parents and settings', function () {
    var e = m1lEntity(ix, 'g:CAN.Receive.Custom.Message 1.Signal 2');
    assert.deepEqual(e.parents.map(function (p) { return p.title; }), ['CAN', 'CAN.Receive', 'CAN.Receive.Custom', 'CAN.Receive.Custom.Message 1']);
    assert.equal(e.memberCount, 2);
    assert.equal(m1lEntity(ix, 'g:Nope'), null);
  });

  it('puts a .Value item in the group it belongs to', function () {
    assert.equal(m1lOwnerGroup('Brake.Switch.Index.Value'), 'Brake.Switch');
    assert.equal(m1lOwnerGroup('Driver.Switch 8.Input Resource'), 'Driver.Switch 8');
    assert.equal(m1lOwnerGroup('Engine.Speed'), 'Engine');
  });

  it('lists each FIRMWARE channel with the CAN signal writing it and the inputs reading it', function () {
    var more = items.concat([
      { name: 'CAN.Receive.Custom.Message 1.CAN Bus', kind: 'Parameter', type: 'enum', value: 2, label: 'CAN Bus 2', tags: [] },
      { name: 'CAN.Receive.Custom.Message 1.CAN ID', kind: 'Parameter', type: 'u32', value: 690, tags: [] },
      { name: 'CAN.Receive.Custom.Message 1.Signal 2.Length', kind: 'Parameter', type: 's32', value: 8, tags: [] }
    ]);
    var rows = m1lFirmwareTable(m1lBuildIndex(more, resName));
    assert.equal(rows.length, 32);
    var fw5 = rows[5];
    assert.equal(fw5.sources.length, 1);
    assert.equal(fw5.sources[0].can.bus, 'CAN Bus 2');
    assert.equal(fw5.sources[0].can.id, 690);
    assert.equal(fw5.sources[0].can.length, 8);
    assert.deepEqual(fw5.targets.map(function (t) { return t.ref.from; }), ['Driver.Switch 8.Input Resource']);
    assert.deepEqual(fw5.targets[0].usedBy.map(function (u) { return u.from; }), ['Brake.Switch.Index.Value']);
    assert.equal(rows[6].sources.length + rows[6].targets.length, 0);
  });
});
