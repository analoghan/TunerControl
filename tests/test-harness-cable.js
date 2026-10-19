/**
 * test-harness-cable.js — Tests for harness/harness-cable.js: cable types from part numbers and descriptions, grouping wires into
 * cables, the Cable column, and the cable checks across a join (harness-system.js).
 */

function hcbPin(cavity, wirePn, wire, fn, remote, cable) {
  return { cavity: cavity, terminal: 'SSC-N', wirePn: wirePn, wire: wire, function: fn, note: '', remote: remote, chassis: '', cable: cable || '' };
}

/**
 * An ECU with two CAN pairs to a bulkhead (same two connectors, so cavity order and colour split them), a knock sensor whose return
 * and shield go to a ground splice, a shielded triple from a crank sensor with an untyped shield row, and an Ethernet pair.
 */
function hcbModel() {
  var STP = 'M27500/22TG2T14';
  return { name: 'T', sheets: [], connectors: [
    { id: 'ECU', title: '', sheet: '', connector: '', pins: [
      hcbPin('1', 'TSB-3C', '22 AWG White (3 Wire Shielded)', 'Crank', 'CKP.1'),
      hcbPin('7', STP, '22 AWG White (Shielded 2)', 'Knock 1', 'KNOCK.1'),
      hcbPin('28', STP, '22 AWG White (Shielded 2)', 'CAN 3 High', 'BULK.W'),
      hcbPin('29', STP, '22 AWG White/Blue (Shielded 2)', 'CAN 3 Low', 'BULK.X'),
      hcbPin('30', STP, '22 AWG White (Shielded 2)', 'CAN 2 High', 'BULK.L'),
      hcbPin('31', STP, '22 AWG White/Blue (Shielded 2)', 'CAN 2 Low', 'BULK.M'),
      hcbPin('40', 'Ethernet Cable', 'Ethernet Green/White', 'Eth TX+', 'ETH.1'),
      hcbPin('41', 'Ethernet Cable', 'Ethernet Green', 'Eth TX-', 'ETH.2'),
      hcbPin('50', 'M22759/32-22-9', '22 AWG White', 'Plain wire', 'BULK.A')] },
    { id: 'BULK', title: '', sheet: '', connector: '', pins: [
      hcbPin('A', 'M22759/32-22-9', '22 AWG White', 'Plain wire', 'ECU.50'),
      hcbPin('L', STP, '22 AWG White (Shielded 2)', 'CAN 2 High', 'ECU.30'),
      hcbPin('M', STP, '22 AWG White/Blue (Shielded 2)', 'CAN 2 Low', 'ECU.31'),
      hcbPin('W', STP, '22 AWG White (Shielded 2)', 'CAN 3 High', 'ECU.28'),
      hcbPin('X', STP, '22 AWG White/Blue (Shielded 2)', 'CAN 3 Low', 'ECU.29')] },
    { id: 'KNOCK', title: '', sheet: '', connector: '', pins: [
      hcbPin('1', STP, '22 AWG White (2 Wire Shielded)', 'Knock signal', 'ECU.7'),
      hcbPin('2', STP, '22 AWG White/Blue (2 Wire Shielded)', 'Knock ground', 'SPL.0V'),
      hcbPin('SHIELD', STP, 'Shield', 'Knock shield', 'SPL.0V')] },
    { id: 'CKP', title: '', sheet: '', connector: '', pins: [
      hcbPin('1', 'TSB-3C', '22 AWG White (3 Wire Shielded)', 'Crank signal', 'ECU.1'),
      hcbPin('2', 'TSB-3C', '22 AWG White/Blue (3 Wire Shielded)', 'Crank ground', 'SPL.0V'),
      hcbPin('3', 'TSB-3C', '22 AWG White/Orange (3 Wire Shielded)', 'Crank 5V', 'Unterminated'),
      hcbPin('SHIELD', 'TSB-3C', 'Shield', 'Crank shield', 'SPL.0V')] },
    { id: 'ETH', title: '', sheet: '', connector: '', pins: [
      hcbPin('1', 'Ethernet Cable', 'Ethernet Green/White', 'TX+', 'ECU.40'),
      hcbPin('2', 'Ethernet Cable', 'Ethernet Green', 'TX-', 'ECU.41')] }],
    splices: [{ id: 'SPL.0V', sheet: '', type: '', boot: '', wires: [
      { end: 'KNOCK.2', wirePn: STP, wire: '22 AWG White/Blue (2 Wire Shielded)', function: '' },
      { end: 'KNOCK.SHIELD', wirePn: STP, wire: 'Shield', function: '' },
      { end: 'CKP.2', wirePn: 'TSB-3C', wire: '22 AWG White/Blue (3 Wire Shielded)', function: '' },
      { end: 'CKP.SHIELD', wirePn: 'TSB-3C', wire: 'Shield', function: '' }] }] };
}

function hcbByName(cables, name) { return cables.filter(function (c) { return c.name === name; })[0]; }
function hcbEnds(cable) { return cable.wires.map(function (w) { return w.from.label + '>' + w.to.label; }).sort(); }

describe('Harness — cable types', function () {
  it('decodes M27500 part numbers: conductors and shield', function () {
    var t = harnessCableType(null, 'M27500/22TG2T14', '');
    assert.deepEqual([t.conductors, t.shielded, t.short, t.label], [2, true, 'STP', 'Shielded twisted pair']);
    assert.equal(harnessCableType(null, 'M27500-20SB3U00', '').short, '3C', 'U = no shield');
    assert.equal(harnessCableType(null, 'M27500-22TG2U00', '').label, 'Unshielded twisted pair');
    assert.equal(harnessCableType(null, 'M27500/22TG2T14 (2x)', '').conductors, 2, 'a "(2x)" count after the part number');
    assert.equal(harnessCableType(null, 'M22759/32-22-9', '22 AWG White'), null, 'a single wire');
  });

  it('reads the user\'s list and the description', function () {
    assert.equal(harnessCableType(null, 'Ethernet Cable', 'Ethernet Green'), null);
    var t = harnessCableType({ cableTypes: [{ pn: 'ethernet cable', conductors: 2, shielded: false }] }, 'Ethernet Cable', 'Ethernet Green');
    assert.deepEqual([t.conductors, t.shielded, t.source], [2, false, 'list']);
    assert.deepEqual([harnessCableType(null, 'TSB-3C', '22 AWG White (3 Wire Shielded)').short, harnessCableType(null, 'X', '22 AWG Red (Shielded 2)').short], ['3C S', 'STP']);
    assert.equal(harnessCableType(null, 'X', '20 AWG Black (Twisted Pair)').short, 'UTP');
  });

  it('tells conductors from shields by the description', function () {
    assert.deepEqual(['22 AWG White/Blue (Shielded 2)', '22 AW White (3 Wire Shielded)', 'Shield (Shielded 2)', 'Shield Braid', 'Drain'].map(harnessCableColor),
      ['white/blue', 'white', 'shield', 'shield', 'shield']);
  });
});

describe('Harness — cables', function () {
  it('splits wires between the same two connectors by cavity order and colour', function () {
    var r = harnessCables(hcbModel());
    assert.deepEqual(hcbEnds(hcbByName(r.cables, 'BULK L, M')), ['ECU.30>BULK.L', 'ECU.31>BULK.M']);
    assert.deepEqual(hcbEnds(hcbByName(r.cables, 'BULK W, X')), ['ECU.28>BULK.W', 'ECU.29>BULK.X']);
    assert.equal(r.byEndpoint['ECU.29'].name, 'BULK W, X');
    assert.equal(r.byEndpoint['ECU.50'], undefined, 'a plain wire is in no cable');
  });

  it('joins a return and shield that go to a splice through the sensor connector', function () {
    var knock = hcbByName(harnessCables(hcbModel()).cables, 'KNOCK 1, 2, SHIELD');
    assert.ok(knock, 'one cable at the knock sensor');
    assert.deepEqual([knock.conductors.length, knock.shields.length, knock.type.short], [2, 1, 'STP']);
    assert.deepEqual(knock.problems, []);
  });

  it('counts an untyped shield row as its part number\'s cable, and notes missing conductors and shields', function () {
    var m = hcbModel(), ckp = hcbByName(harnessCables(m).cables, 'CKP 1, 2, 3, SHIELD');
    assert.deepEqual([ckp.conductors.length, ckp.shields.length, ckp.type.short], [3, 1, '3C S']);
    m.connectors[3].pins.pop();   // no CKP.SHIELD row
    m.splices[0].wires.pop();
    ckp = hcbByName(harnessCables(m).cables, 'CKP 1, 2, 3');
    assert.ok(ckp.problems.some(function (p) { return p.severity === 'info' && /shield is not grounded/.test(p.message); }));
    var can = hcbByName(harnessCables(hcbModel()).cables, 'BULK L, M');
    assert.ok(can.problems.some(function (p) { return /No shield or drain/.test(p.message); }));
  });

  it('lists cable-like part numbers it can\'t read, and groups them once they are in the list', function () {
    var m = hcbModel(), r = harnessCables(m);
    assert.deepEqual(r.untyped, [{ pn: 'Ethernet Cable', count: 2 }]);
    m.cableTypes = [{ pn: 'Ethernet Cable', conductors: 2, shielded: false }];
    r = harnessCables(m);
    assert.deepEqual(r.untyped, []);
    assert.equal(hcbByName(r.cables, 'ETH 1, 2').type.short, 'UTP');
  });

  it('follows the Cable column: a name fixes the cable, "-" leaves a wire out, conflicting ends are an error', function () {
    var m = hcbModel();
    m.connectors[0].pins[2].cable = 'CAN3';   // ECU.28
    m.connectors[1].pins[4].cable = 'CAN3';   // BULK.X
    m.connectors[0].pins[4].cable = '-';      // ECU.30
    var r = harnessCables(m), can3 = hcbByName(r.cables, 'CAN3');
    assert.ok(can3.explicit);
    assert.deepEqual(hcbEnds(can3), ['ECU.28>BULK.W', 'ECU.29>BULK.X']);
    assert.equal(r.byEndpoint['ECU.30'], undefined);
    m.connectors[1].pins[3].cable = 'Other';  // BULK.W, the other end of ECU.28
    assert.ok(harnessCables(m).cables.some(function (c) { return c.problems.some(function (p) { return p.severity === 'error' && /name different cables/.test(p.message); }); }));
  });

  it('names the detected cables in the Cable column and renames them', function () {
    var m = hcbModel(), r = harnessCables(m);
    harnessNameCables(m, r.cables);
    assert.equal(m.connectors[2].pins[1].cable, 'KNOCK 1, 2, SHIELD', 'both ends of each wire');
    assert.equal(m.connectors[0].pins[1].cable, 'KNOCK 1, 2, SHIELD');
    assert.ok(harnessCables(m).cables.every(function (c) { return c.explicit; }));
    harnessRenameCable(m, 'knock 1, 2, shield', 'Knock 1');
    assert.equal(m.connectors[0].pins[1].cable, 'Knock 1');
    assert.equal(hcbByName(harnessCables(m).cables, 'Knock 1').wires.length, 3);
  });

  it('keeps the Cable column through the workbook and puts it in the cut list', function () {
    var m = hcbModel();
    m.connectors[2].pins[0].cable = 'Knock 1';
    var again = harnessFromWorkbook({ sheets: harnessToWorkbook(m).map(function (s) { return { name: s.name, rows: s.rows }; }) }, 'T');
    var knock = again.connectors.filter(function (c) { return c.id === 'KNOCK'; })[0];
    assert.deepEqual(knock.pins.map(function (p) { return p.cable; }), ['Knock 1', '', '']);
    assert.ok(harnessPinExportFields(knock).indexOf('cable') >= 0);
    assert.equal(harnessPinExportFields(again.connectors.filter(function (c) { return c.id === 'ETH'; })[0]).indexOf('cable'), -1, 'no column without a name');
    var wires = harnessCutList(m);
    harnessCables(m, wires);
    assert.ok(/,Knock 1,/.test(harnessCutListCsv(m, wires)));
  });

  it('draws the twist and shield in the block diagram', function () {
    var m = hcbModel(), svg = harnessBlockDiagram(m, 'KNOCK', { cables: harnessCables(m).byEndpoint }).svg;
    assert.ok(/class="cable"/.test(svg) && /<ellipse/.test(svg) && />STP</.test(svg));
    assert.ok(!/class="cable"/.test(harnessBlockDiagram(m, 'KNOCK', {}).svg), 'only when asked');
  });

  it('flags a cable whose conductors are swapped across a mated connector', function () {
    var STP = 'M27500/22TG2T14';
    function side(id, part, mate, pins) { return { id: id, name: id, model: { name: id, sheets: [], splices: [], connectors: [{ id: 'CHAS', title: '', connector: part, mateConn: mate, pins: pins }] } }; }
    var a = side('Chassis', 'MS3474', 'MS3476', [hcbPin('R', STP, '22 AWG White (Shielded 2)', 'VSS Signal', 'Unterminated'),
      hcbPin('S', STP, '22 AWG White/Blue (Shielded 2)', 'VSS Return', 'Unterminated'), hcbPin('T', STP, 'Shield (Shielded 2)', 'VSS Shield', 'Unterminated')]);
    var b = side('Engine', 'MS3476', 'MS3474', [hcbPin('R', STP, '22 AWG White/Blue (Shielded 2)', 'VSS Return', 'Unterminated'),
      hcbPin('S', STP, 'Shield (Shielded 2)', 'VSS Shield', 'Unterminated'), hcbPin('T', STP, '22 AWG White (Shielded 2)', 'VSS Signal', 'Unterminated')]);
    var members = [a, b], issues = harnessSystemChecks(members, harnessMates(members, {}).mates);
    assert.deepEqual(issues.filter(function (i) { return /swapped/.test(i.message); }).map(function (i) { return i.where; }), ['CHAS.R', 'CHAS.S', 'CHAS.T']);
    b.model.connectors[0].pins = a.model.connectors[0].pins.map(function (p) { return Object.assign({}, p); });
    assert.equal(harnessSystemChecks(members, harnessMates(members, {}).mates).length, 0, 'the same conductor on both sides');
  });
});
