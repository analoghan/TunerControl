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
    assert.equal(m1cResourceName(slot2('0x6542'), 'M142'), null);
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

  it('names universal digital inputs from their first ID', function () {
    function udig(a, b, c) { return [a, '0x0000', b, '0x0000', c]; }
    assert.equal(m1cResourceName(udig('0x6401', '0x6464', '0x6441'), 'M142').name, 'UDIG2');
    assert.equal(m1cResourceName(udig('0x6402', '0x6465', '0x6442'), 'M142').name, 'UDIG3');
    assert.equal(m1cResourceName(udig('0x6403', '0x6466', '0x6443'), 'M142').name, 'UDIG4');
    assert.equal(m1cResourceName(udig('0x6406', '0x6469', '0x6446'), 'M142').name, 'UDIG7');
    assert.equal(m1cResourcePinFor(udig('0x6401', '0x6464', '0x6441'), 'M142'), 'M142 pin D02');
    assert.equal(m1cResourceName(slot2('0x646e'), 'M142').name, 'UDIG12', 'switch input: slot 2 only');
    assert.equal(m1cResourcePinFor(slot2('0x646e'), 'M142'), 'M142 pin B07');
  });

  it('names UDIG hybrid functions, RS232 and the remaining E888 inputs', function () {
    assert.equal(m1cResourceName(slot2('0x6477'), 'M142').name, 'UDIG3 Hybrid A');
    assert.equal(m1cResourceName(slot2('0x6478'), 'M142').name, 'UDIG3 Hybrid B');
    assert.equal(m1cResourceName(slot2('0x647f'), 'M142').name, 'UDIG7 Hybrid A');
    assert.equal(m1cResourceName(slot2('0x6480'), 'M142').name, 'UDIG7 Hybrid B');
    assert.equal(m1cResourcePinFor(slot2('0x6480'), 'M142'), 'M142 pin D14');
    assert.equal(m1cResourceName(slot2('0x648a'), 'M142').name, 'UDIG12 Hybrid B');
    var gps = ['0x0000', '0x649f', '0x0000', '0x0000', '0x0000'];
    assert.equal(m1cResourceName(gps, 'M142').name, 'RS232');
    assert.equal(m1cResourcePinFor(gps, 'M142'), 'M142 pin A21 (TX A22)');
    assert.equal(m1cResourcePinFor(slot2('0x6541'), 'M142'), 'E888 pin A23');
    assert.equal(m1cResourcePinFor(slot2('0x6554'), 'M142'), 'E888 pin B11');
  });

  it('names knock inputs, low side injectors and bridge outputs', function () {
    function slot1(a, b) { return ['0x0000', a, b || '0x0000', '0x0000', '0x0000']; }
    assert.equal(m1cResourceName(slot2('0x6100'), 'M142').name, 'Knock Input 1');
    assert.equal(m1cResourceName(slot2('0x6101'), 'M142').name, 'Knock Input 2');
    assert.equal(m1cResourcePinFor(slot2('0x6101'), 'M142'), 'M142 pin D13');
    assert.equal(m1cResourceName(slot1('0x6431', '0x6229'), 'M142').name, 'Low Side Injector 2');
    assert.equal(m1cResourcePinFor(slot1('0x6432', '0x622a'), 'M142'), 'M142 pin B09');
    assert.equal(m1cResourceName(slot1('0x645b'), 'M142').name, 'Bridge Output 1');
    assert.equal(m1cResourcePinFor(slot1('0x645b'), 'M142'), 'M142 pin C18 / C01');
    assert.equal(m1cResourceName(slot1('0x645c', '0x62a0'), 'M142').name, 'Bridge Output 2');
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

  it('adds M142 connector pins from the datasheet', function () {
    assert.equal(m1cResourceLabel(slot2('0x6201'), 'M142'), 'AVI2 (0x6201)');
    assert.equal(m1cResourcePinFor(slot2('0x6201'), 'M142'), 'M142 pin C15');
    assert.equal(m1cResourcePinFor(slot2('0x6211'), 'M142'), 'M142 pin D03');
    assert.equal(m1cResourcePinFor(['0x0000', '0x640f', '0x6110', '0x0000', '0x644c'], 'M142'), 'M142 pin A06 (+ A07)');
    assert.equal(m1cResourcePinFor(slot2('0x6524'), 'M142'), null, 'FIRMWARE has no pin');
    assert.equal(m1cResourcePinFor(slot2('0x6555'), 'M142'), null, 'unnamed has no pin');
    assert.equal(m1cResourcePin('Low Side Ignition 8', 'M142'), 'M142 pin C13');
    assert.equal(m1cResourcePin('FIRMWARE4', 'M142'), null);
    assert.equal(m1cResourcePin('AVI2', 'M150'), null);
  });

  it('finds pins for user-entered names in M1 Tune or datasheet spelling', function () {
    var ids = slot2('0x6464');
    var user = { 'M142|0x0000,0x0000,0x6464,0x0000,0x0000': 'Universal Digital Input 2' };
    assert.equal(m1cResourcePinFor(ids, 'M142', user), 'M142 pin D02');
    assert.equal(m1cResourcePin('UDIG2', 'M142'), 'M142 pin D02');
    assert.equal(m1cResourcePin('Analog Voltage Input 9', 'M142'), 'M142 pin B10');
    assert.equal(m1cResourcePin('OUT_HB4', 'M142'), 'M142 pin C32');
    assert.equal(m1cResourcePin('Knock Input 2', 'M142'), 'M142 pin D13');
    assert.equal(m1cResourcePin('Front brake', 'M142'), null);
  });

  it('adds E888 expander pins from its manual for E888 names', function () {
    assert.equal(m1cResourcePinFor(slot2('0x654c'), 'M142'), 'E888 pin A32');
    assert.equal(m1cResourcePinFor(['0x0000', '0x657f', '0x0000', '0x0000', '0x0000'], 'M142'), 'E888 pin B13');
    assert.equal(m1cResourcePin('E888 AVI1', 'M142'), 'E888 pin A22');
    assert.equal(m1cResourcePin('E888 Thermocouple 3', 'M142'), 'E888 pin A14 (- A5)');
    assert.equal(m1cResourcePin('E888 DIG5', 'M150'), 'E888 pin B12', 'E888 pins do not depend on the ECU');
    assert.equal(m1cResourcePin('E888 AVI9', 'M142'), null);
    assert.equal(m1cResourcePin('PDM Byte 0, Mask 01', 'M142'), null);
  });

  it('formats labels with the raw IDs', function () {
    assert.equal(m1cResourceLabel(['0x0000', '0x0000', '0x6524', '0x0000', '0x0000'], 'M142'), 'FIRMWARE4 (0x6524)');
    assert.equal(m1cResourceLabel(['0x0000', '0x0000', '0x6555', '0x0000', '0x0000'], 'M142'), '0x6555');
    assert.equal(m1cResourceLabel(none, 'M142'), 'Not assigned');
    assert.equal(m1cResourceName(none, 'M142'), null);
  });
});
