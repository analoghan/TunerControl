/**
 * test-harness-build.js — Tests for harness/harness-build.js: cut list, BOM, optional wire lengths, CSV.
 */

function hbPin(cavity, terminal, wirePn, wire, fn, remote) {
  return { cavity: cavity, terminal: terminal, wirePn: wirePn, wire: wire, function: fn, note: '', remote: remote };
}

function hbModel() {
  return { name: 'T', sheets: [], connectors: [
    { id: 'ECU', title: '', sheet: '', connector: 'DTM06-4S', boot: 'RB290', pins: [
      hbPin('1', 'SSC-N', 'M22759-22-9', '22 AWG White', 'Sensor signal', 'SENS.1'),
      hbPin('2', 'SSC-N', 'M22759-22-0', '22 AWG Black', 'Sensor ground', 'SPL.GND'),
      hbPin('3', 'SSC-N', 'M22759-18-0', '18 AWG Black', 'Power ground', 'Eyelet (engine block)'),
      hbPin('4', '', 'Sealing Pin', 'N/A', 'N/A', 'N/A')] },
    { id: 'SENS', title: '', sheet: '', connector: 'DTM06-4S', boot: '', pins: [
      hbPin('1', '0462-201', 'M22759-22-9', '22 AWG White (Shielded 2)', 'Signal', 'ECU.1'),
      hbPin('2', '0462-201', 'M22759-22-0', '22 AWG Black', 'Ground', 'SPL.GND'),
      hbPin('3', '0462-201', 'M22759-22-2', '22 AWG Red', '5V', 'GONE.7')] }],
    splices: [{ id: 'SPL.GND', sheet: '', type: 'Open Barrel', boot: 'SCL', wires: [
      { end: 'ECU.2', wirePn: 'M22759-22-0', wire: '22 AWG Black', function: '' },
      { end: 'SENS.2', wirePn: 'M22759-22-0', wire: '22 AWG Black', function: '' },
      { end: 'SPL.B', wirePn: 'M22759-22-0', wire: '22 AWG Black', function: '' }] },
      { id: 'SPL.B', sheet: '', type: 'Open Barrel', boot: '', wires: [
      { end: 'SPL.GND', wirePn: 'M22759-22-0', wire: '22 AWG Black', function: '' }] }] };
}

function hbByFrom(wires, from) { return wires.filter(function (w) { return w.from.label === from; }); }

describe('Harness — cut list', function () {
  it('lists each wire once, joining both ends', function () {
    var w = harnessCutList(hbModel());
    // ECU.1–SENS.1, ECU.2–SPL.GND, ECU.3–eyelet, SENS.2–SPL.GND, SENS.3–GONE.7, SPL.GND–SPL.B
    assert.equal(w.length, 6, JSON.stringify(w.map(function (x) { return x.from.label + '→' + x.to.label; })));
    var a = hbByFrom(w, 'ECU.1')[0];
    assert.deepEqual([a.to.label, a.from.terminal, a.to.terminal, a.wirePn, a.wire], ['SENS.1', 'SSC-N', '0462-201', 'M22759-22-9', '22 AWG White']);
    assert.equal(a.problem, '', 'the same wire described with shield wording is not a problem');
    assert.equal(hbByFrom(w, 'SENS.1').length, 0, 'not listed again from the other end');
    assert.equal(a.key, hbWireKey('SENS.1', 'ECU.1'));
  });

  it('pairs wires into a splice with the splice row, and splice to splice once', function () {
    var w = harnessCutList(hbModel());
    assert.equal(hbByFrom(w, 'ECU.2')[0].to.label, 'SPL.GND');
    assert.equal(hbByFrom(w, 'SPL.GND').length, 1, 'only the SPL.GND → SPL.B row is left from the splice side');
    assert.equal(hbByFrom(w, 'SPL.GND')[0].to.label, 'SPL.B');
    assert.equal(hbByFrom(w, 'SPL.B').length, 0);
  });

  it('shows single-ended wires and ends that are missing or disagree', function () {
    var m = hbModel(), w = harnessCutList(m);
    var eye = hbByFrom(w, 'ECU.3')[0];
    assert.deepEqual([eye.to.kind, eye.to.label], ['terminal', 'Eyelet (engine block)']);
    assert.equal(eye.problem, '');
    assert.ok(/GONE\.7.*not in this harness/.test(hbByFrom(w, 'SENS.3')[0].problem));
    m.connectors[1].pins[0].wirePn = 'M22759-20-9';
    assert.ok(/different wires \(M22759-22-9 \/ M22759-20-9\)/.test(hbByFrom(harnessCutList(m), 'ECU.1')[0].problem));
    m.connectors[1].pins[0].wirePn = 'Empty'; m.connectors[1].pins[0].wire = 'Empty';
    assert.ok(/SENS\.1\) lists no wire/.test(hbByFrom(harnessCutList(m), 'ECU.1')[0].problem));
    assert.equal(hbByFrom(harnessCutList(m), 'ECU.4').length, 0, 'a sealed cavity is not a wire');
    m = hbModel();
    m.connectors[1].pins[0].remote = '';   // SENS.1 doesn't say where it goes, but ECU.1 points at it
    var w2 = harnessCutList(m);
    assert.equal(hbByFrom(w2, 'SENS.1').length, 0, 'not listed again as a wire with no other end');
    assert.equal(hbByFrom(w2, 'ECU.1')[0].to.label, 'SENS.1');
    m.connectors[0].pins[0].remote = '';
    assert.equal(hbByFrom(harnessCutList(m), 'SENS.1')[0].problem, 'No other end is given.', 'when nothing points at it either');
  });
});

describe('Harness — BOM and optional lengths', function () {
  it('counts connectors, boots, splices, terminals, plugs, wire ends and wire', function () {
    var b = harnessBom(hbModel());
    function q(list, part) { var x = list.filter(function (y) { return y.part === part; })[0]; return x ? x.count : 0; }
    assert.equal(q(b.connectors, 'DTM06-4S'), 2);
    assert.deepEqual(b.connectors[0].used, ['ECU', 'SENS']);
    assert.equal(q(b.boots, 'RB290'), 1);
    assert.equal(q(b.boots, 'SCL'), 1);
    assert.equal(q(b.splices, 'Open Barrel'), 2);
    assert.equal(q(b.terminals, 'SSC-N'), 3);
    assert.equal(q(b.terminals, '0462-201'), 3);
    assert.equal(q(b.plugs, 'Sealing Pin'), 1);
    assert.equal(q(b.ends, 'Eyelet (ring terminal)'), 1);
    assert.equal(q(b.wire, 'M22759-22-0 — 22 AWG Black'), 3, 'ECU.2, SENS.2 and SPL.GND–SPL.B');
  });

  it('needs no lengths, and totals only the ones entered', function () {
    var m = hbModel();
    var none = harnessBom(m).wire.filter(function (x) { return /22-0/.test(x.part); })[0];
    assert.deepEqual([none.length, none.missingLengths], [0, 3]);
    var w = harnessCutList(m);
    m.lengthUnit = 'mm';
    harnessSetLength(m, hbByFrom(w, 'ECU.2')[0].key, 450);
    harnessSetLength(m, hbByFrom(w, 'SENS.2')[0].key, '120');
    harnessSetLength(m, hbByFrom(w, 'ECU.1')[0].key, '');
    assert.equal(Object.keys(m.wireLengths).length, 2, 'a blank length is not stored');
    var row = harnessBom(m).wire.filter(function (x) { return /22-0/.test(x.part); })[0];
    assert.deepEqual([row.length, row.missingLengths], [570, 1]);
    assert.equal(hbByFrom(harnessCutList(m), 'ECU.2')[0].length, 450);
    assert.ok(harnessBomCsv(m).indexOf('570 mm (1 without a length)') >= 0);
    harnessSetLengthUnit(m, 'in');
    assert.equal(hbByFrom(harnessCutList(m), 'ECU.2')[0].length, 17.717, 'switching the unit converts what is entered');
    harnessSetLengthUnit(m, 'mm');
    assert.equal(hbByFrom(harnessCutList(m), 'ECU.2')[0].length, 450);
  });

  it('keeps lengths when a connector is renamed, and writes CSV with quoting', function () {
    var m = hbModel(), key = harnessCutList(m)[0].key;
    harnessSetLength(m, key, 300);
    harnessRenameLengths(m, 'ECU', 'M142.A');
    m.connectors[0].id = 'M142.A';
    m.connectors[1].pins[0].remote = 'M142.A.1';
    assert.equal(hbByFrom(harnessCutList(m), 'M142.A.1')[0].length, 300);
    var csv = harnessCutListCsv(m);
    assert.equal(csv.split('\r\n')[0], '#,From,From terminal,To,To terminal,Wire part number,Wire,Cable,Function,Length (mm),Note');
    assert.ok(csv.indexOf('"22 AWG White (Shielded 2)"') < 0 && csv.indexOf('Eyelet (engine block)') >= 0);
    assert.equal(hbCsv(['a'], [['x, "y"']]), 'a\r\n"x, ""y"""\r\n');
  });
});
