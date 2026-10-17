/**
 * test-harness-pinout.js — Tests for harness/harness-pinout.js (pinout sheets) and harness/harness-diff.js (revision compare).
 * Uses hbModel() from test-harness-build.js.
 */

function hpCopy(x) { return JSON.parse(JSON.stringify(x)); }

describe('Harness — pinout sheets', function () {
  it('lists every cavity in order with where its wire goes, both ways', function () {
    var p = harnessPinouts(hbModel());
    assert.deepEqual(p.ECU.map(function (r) { return r.cavity; }), ['1', '2', '3', '4']);
    assert.deepEqual(p.ECU[0].to.map(function (e) { return e.label; }), ['SENS.1']);
    var m = hbModel();
    m.connectors[1].pins[0].remote = '';   // SENS.1 blank: ECU.1 still points at it
    assert.deepEqual(harnessPinouts(m).SENS[0].to.map(function (e) { return e.label; }), ['ECU.1']);
  });

  it('names the splice and the other ends it joins, and marks empty cavities', function () {
    var p = harnessPinouts(hbModel());
    var e = p.ECU[1].to[0];
    assert.equal(e.kind, 'splice');
    assert.deepEqual(e.others.sort(), ['SENS.2', 'SPL.B']);
    assert.ok(p.ECU[3].empty && !p.ECU[3].to.length, 'a sealing pin is an empty cavity');
    assert.equal(p.ECU[2].to[0].kind, 'terminal');
    assert.equal(p.ECU[0].look.label, '22 AWG White');
    assert.equal(p.SENS[2].to[0].kind, 'missing');
  });

  it('lists each splice with its ends', function () {
    var s = harnessSpliceSheet(hbModel());
    assert.deepEqual(s[0].ends.map(function (e) { return e.label; }).sort(), ['ECU.2', 'SENS.2', 'SPL.B']);
    assert.equal(s[1].id, 'SPL.B');
  });
});

describe('Harness — revision compare', function () {
  it('finds no differences in a copy, and ignores row order', function () {
    var a = hbModel(), b = hpCopy(a);
    b.connectors[0].pins.reverse();
    var d = harnessDiff(a, b);
    assert.ok(d.same, harnessDiffSummary(d));
    assert.equal(harnessDiffSummary(d), 'No differences.');
  });

  it('lists added, removed, changed and rewired cavities and header changes', function () {
    var a = hbModel(), b = hpCopy(a), ecu = b.connectors[0];
    ecu.pins[0].remote = 'SENS.3';
    ecu.pins[1].wire = '20 AWG Black';
    ecu.pins.splice(3, 1);
    ecu.pins.push(hbPin('5', 'SSC-N', 'M22759-22-9', '22 AWG White', 'New', ''));
    ecu.boot = 'RB291';
    b.connectors.push({ id: 'NEW', title: '', sheet: '', connector: '', boot: '', pins: [] });
    var d = harnessDiff(a, b), e = d.connectors.changed[0];
    assert.equal(e.id, 'ECU');
    assert.deepEqual(e.fields.map(function (f) { return [f.label, f.before, f.after]; }), [['Boot', 'RB290', 'RB291']]);
    var rows = {};
    e.rows.forEach(function (r) { rows[r.key] = r; });
    assert.ok(rows['1'].rewired && rows['1'].fields[0].after === 'SENS.3');
    assert.ok(!rows['2'].rewired && rows['2'].fields[0].field === 'wire');
    assert.equal(rows['4'].kind, 'removed');
    assert.equal(rows['5'].kind, 'added');
    assert.deepEqual(d.connectors.added.map(function (x) { return x.id; }), ['NEW']);
    assert.equal(d.counts.rewired, 1);
    assert.ok(/1 connector added/.test(harnessDiffSummary(d)) && /1 rewired/.test(harnessDiffSummary(d)), harnessDiffSummary(d));
  });

  it('treats a connector that changed name as a rename, without listing the references that follow it', function () {
    var a = hbModel(), b = hpCopy(a);
    b.connectors[0].id = 'M142.A';
    b.connectors[1].pins[0].remote = 'M142.A.1';
    b.splices[0].wires[0].end = 'M142.A.2';
    var d = harnessDiff(a, b);
    assert.equal(d.connectors.added.length + d.connectors.removed.length, 0);
    var e = d.connectors.changed.filter(function (x) { return x.id === 'M142.A'; })[0];
    assert.equal(e.renamedFrom, 'ECU');
    assert.equal(d.connectors.changed.length, 1, 'SENS only followed the rename, so it is not listed');
    assert.equal(d.counts.followRename, 2, 'SENS.1 and the splice end are counted');
    assert.equal(d.splices.changed.length, 0, 'the splice end only followed the rename');
    assert.equal(d.counts.rowsChanged, 0);
  });

  it('compares wire lengths and the chassis column switch', function () {
    var a = hbModel(), b = hpCopy(a);
    b.wireLengths = { 'ECU.1||SENS.1': 300 };
    b.connectors[1].chassisFunction = true;
    var d = harnessDiff(a, b);
    assert.deepEqual(d.lengths, [{ key: 'ECU.1||SENS.1', before: null, after: 300 }]);
    assert.deepEqual(d.connectors.changed[0].fields.map(function (f) { return f.after; }), ['on']);
  });
});
