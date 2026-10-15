/**
 * test-m1-resource-names.js — Unit tests for m1-config/resource-names.js.
 */

describe('M1 Config — I/O resource names', function () {

  var none = ['0x0000', '0x0000', '0x0000', '0x0000', '0x0000'];

  function slot2(id) { return ['0x0000', '0x0000', id, '0x0000', '0x0000']; }

  it('names FIRMWARE0-31', function () {
    assert.equal(m1cResourceName(slot2('0x6524'), 'M142').name, 'FIRMWARE4');
    assert.equal(m1cResourceName(['0x65a0', '0x0000', '0x6520', '0x0000', '0x0000'], 'M142').name, 'FIRMWARE0');
    assert.equal(m1cResourceName(slot2('0x652a'), 'M142').name, 'FIRMWARE10');
    assert.equal(m1cResourceName(slot2('0x653f'), 'M142').name, 'FIRMWARE31');
    assert.equal(m1cResourceName(slot2('0x6541'), 'M142'), null);
  });

  it('names local analogue voltage and temperature inputs', function () {
    assert.equal(m1cResourceName(slot2('0x6200'), 'M142').name, 'AVI1');
    assert.equal(m1cResourceName(slot2('0x6201'), 'M142').name, 'AVI2');
    assert.equal(m1cResourceName(slot2('0x6210'), 'M142').name, 'AVI17');
    assert.equal(m1cResourceName(slot2('0x6211'), 'M142').name, 'AT1');
    assert.equal(m1cResourceName(slot2('0x6216'), 'M142').name, 'AT6');
    assert.equal(m1cResourceName(slot2('0x6217'), 'M142'), null);
  });

  it('names direct injectors in A/B pairs and low side ignition outputs', function () {
    var cyl = {
      1: ['0x640f', '0x6110', '1A'], 6: ['0x6410', '0x6111', '1B'], 8: ['0x6411', '0x6112', '2A'],
      5: ['0x6412', '0x6113', '2B'], 7: ['0x6413', '0x6114', '3A'], 4: ['0x6414', '0x6115', '3B'],
      2: ['0x6415', '0x6116', '4A'], 3: ['0x6416', '0x6117', '4B']
    };
    Object.keys(cyl).forEach(function (c) {
      var ids = ['0x0000', cyl[c][0], cyl[c][1], '0x0000', '0x0000'];
      assert.equal(m1cResourceName(ids, 'M142').name, 'Direct Injector ' + cyl[c][2] + '-', 'cylinder ' + c);
    });
    assert.equal(m1cResourceName(['0x0000', '0x6420', '0x611c', '0x0000', '0x0000'], 'M142').name, 'Low Side Ignition 1');
    assert.equal(m1cResourceName(['0x0000', '0x6427', '0x6123', '0x0000', '0x0000'], 'M142').name, 'Low Side Ignition 8');
  });

  it('names PDM byte/mask outputs and E888 outputs', function () {
    function slot1(id) { return ['0x0000', id, '0x0000', '0x0000', '0x0000']; }
    assert.equal(m1cResourceName(slot1('0x6567'), 'M142').name, 'PDM Byte 0, Mask 01');
    assert.equal(m1cResourceName(slot1('0x656f'), 'M142').name, 'PDM Byte 1, Mask 01');
    assert.equal(m1cResourceName(slot1('0x6577'), 'M142').name, 'PDM Byte 2, Mask 01');
    assert.equal(m1cResourceName(slot1('0x6566'), 'M142').name, 'PDM Byte 0, Mask 02');
    assert.equal(m1cResourceName(slot1('0x6560'), 'M142').name, 'PDM Byte 0, Mask 80');
    assert.equal(m1cResourceName(slot1('0x6579'), 'M142').name, 'E888 Output 2');
    assert.equal(m1cResourceName(slot1('0x657f'), 'M142').name, 'E888 Output 8');
    assert.equal(m1cResourceName(slot1('0x6580'), 'M142'), null);
  });

  it('does not guess for other hardware', function () {
    assert.equal(m1cResourceName(slot2('0x6524'), 'M150'), null);
  });

  it('uses confirmed exact signatures', function () {
    assert.equal(m1cResourceName(slot2('0x654c'), 'M142').name, 'E888 AVI7');
    assert.equal(m1cResourceName(slot2('0x6550'), 'M142').name, 'E888 AVI8');
    assert.equal(m1cResourceName(slot2('0x6540'), 'M142').name, 'E888 AVI1');

    assert.equal(m1cResourceName(['0x0000', '0x640f', '0x6110', '0x0000', '0x644c'], 'M142').name, 'Direct Injector 1A-');
  });

  it('prefers user names keyed by hardware and full signature', function () {
    var ids = ['0x0000', '0x0000', '0x6524', '0x0000', '0x0000'];
    var user = { 'M142|0x0000,0x0000,0x6524,0x0000,0x0000': 'Front brake (FW4)' };
    assert.deepEqual(m1cResourceName(ids, 'M142', user), { name: 'Front brake (FW4)', source: 'user' });
    assert.equal(m1cResourceName(ids, 'M142', {}).source, 'rule');
  });

  it('formats labels with the raw IDs', function () {
    assert.equal(m1cResourceLabel(['0x0000', '0x0000', '0x6524', '0x0000', '0x0000'], 'M142'), 'FIRMWARE4 (0x6524)');
    assert.equal(m1cResourceLabel(['0x0000', '0x0000', '0x6554', '0x0000', '0x0000'], 'M142'), '0x6554');
    assert.equal(m1cResourceLabel(none, 'M142'), 'Not assigned');
    assert.equal(m1cResourceName(none, 'M142'), null);
  });
});
