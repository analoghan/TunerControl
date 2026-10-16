/**
 * test-harness.js — Tests for lib/xlsx.js, harness/harness-model.js and harness/harness-tune.js.
 */

// A small harness in the same block layout as a real harness workbook.
function hxRows(blocks) {
  var rows = [];
  blocks.forEach(function (b) {
    rows.push([b.title]);
    b.header.forEach(function (h) { rows.push(h); });
    rows.push(b.columns);
    b.rows.forEach(function (r) { rows.push(r); });
    rows.push([]);
  });
  return rows;
}

var HX_PIN_COLUMNS = ['Location', 'Pin', 'Conductor Part Number', 'Conductor Description', 'Engine Function', 'MoTeC Function',
  'Remote Connection', 'Status'];

function hxWorkbook() {
  var w22 = ['M22759/32-22-9', '22 AWG White'];
  return { sheets: [
    { name: 'ECU', rows: hxRows([{
      title: 'MoTeC M142 C - 34 Way', header: [['CONNECTOR', 'Superseal 34'], ['BOOT', 'SSB'], ['NOTES', 'ECU']],
      columns: HX_PIN_COLUMNS,
      rows: [
        ['14', 'SSC', w22[0], w22[1], 'APP Signal 1', 'AV1', 'PEDAL.1', ''],
        ['15', 'SSC', w22[0], w22[1], 'MAP Pressure Signal', 'AV2', 'MAP.2', ''],
        ['16', 'SSC', w22[0], w22[1], 'Spare', 'AV4', 'SPARE.1', ''],
        ['9', 'SSC', 'M22759/32-22-8', '22 AWG Gray', '5V Reference B', 'Sensor 5V B', 'SPL.5V', '']
      ] }, {
      title: 'MoTeC M142 D - 26 Way', header: [['CONNECTOR', 'Superseal 26']], columns: HX_PIN_COLUMNS,
      rows: [['3', 'SSC', w22[0], w22[1], 'Inlet Air Temp Signal', 'AT1', 'IAT.1', ''],
             ['4', 'SSC', 'Sealing Pin', 'N/A', 'Unused', 'N/A', 'N/A', 'N/A']]
    }]) },
    { name: 'Engine', rows: hxRows([
      { title: 'MAP', header: [['CONNECTOR', 'Bosch'], ['MATE CONN', 'X']], columns: HX_PIN_COLUMNS.slice(0, 5).concat(['Notes', 'Remote Connection', 'Status']),
        rows: [['1', 'T', 'M22759/32-22-8', '22 AWG Gray', '5V', '', 'SPL.5V', ''],
               ['2', 'T', w22[0], w22[1], 'MAP Signal', '', 'm142.c.15', '']] },
      { title: 'PEDAL', header: [['CONNECTOR', 'DTM']], columns: HX_PIN_COLUMNS,
        rows: [['1', 'T', 'M22759/32-22-5', w22[1], 'APP 1', '', 'M142.C.14', '']] },
      { title: 'IAT', header: [['CONNECTOR', 'DTM']], columns: HX_PIN_COLUMNS,
        rows: [['1', 'T', w22[0], w22[1], 'IAT Signal', '', 'M142.D.4', '']] }
    ]) },
    { name: 'Splices', rows: hxRows([
      { title: 'SPL.5V', header: [['SPLICE', 'Open Barrel'], ['BOOT', 'SCL']],
        columns: ['Location', 'Conductor Part Number', 'Conductor Description', 'Function'],
        rows: [['M142.C.9', 'M22759/32-22-8', '22 AWG Gray', 'From ECU'], ['MAP.1', 'M22759/32-22-8', '22 AWG Gray', 'MAP 5V'],
               ['SPL.5V2', 'M22759/32-22-8', '22 AWG Gray', 'Chain']] },
      { title: 'SPL.5V2', header: [['SPLICE', 'Open Barrel']],
        columns: ['Location', 'Conductor Part Number', 'Conductor Description', 'Function'],
        rows: [['SPL.5V', 'M22759/32-22-8', '22 AWG Gray', 'Chain'], ['CHASSIS', 'M22759/32-22-8', '22 AWG Gray', 'Lug']] }
    ]) },
    { name: 'Notes', rows: [['Anything else'], ['is ignored']] }
  ] };
}

function hxFind(issues, where, text) {
  return issues.filter(function (i) { return i.where === where && i.message.indexOf(text) >= 0; });
}

describe('XLSX — readXlsx / writeXlsx', function () {
  it('round-trips text, empty cells, special characters and multiple sheets', function () {
    var sheets = [
      { name: 'A & <B>', rows: [['x', '', 'y & z'], [], ['', 'ü日本', '"quoted"']], bold: [0], widths: [10, 20] },
      { name: 'Second', rows: [['1', '2.5']] }
    ];
    return readXlsx(writeXlsx(sheets)).then(function (wb) {
      assert.deepEqual(wb.sheets.map(function (s) { return s.name; }), ['A & <B>', 'Second']);
      assert.deepEqual(wb.sheets[0].rows, [['x', '', 'y & z'], [], ['', 'ü日本', '"quoted"']]);
      assert.deepEqual(wb.sheets[1].rows, [['1', '2.5']]);
    });
  });

  it('converts column letters', function () {
    assert.equal(xlsxColumn('A1'), 0);
    assert.equal(xlsxColumn('Z9'), 25);
    assert.equal(xlsxColumn('AB3'), 27);
    assert.equal(xlsxColumnName(27), 'AB');
    assert.equal(xlsxColumnName(0), 'A');
  });

  it('rejects files that are not workbooks', function () {
    return readXlsx(new Uint8Array([1, 2, 3, 4])).then(function () { throw new Error('should fail'); },
      function (err) { assert.ok(/not an \.xlsx/i.test(err.message), err.message); });
  });
});

describe('Harness — workbook import and export', function () {
  it('reads connector and splice blocks with their headers and rows', function () {
    var m = harnessFromWorkbook(hxWorkbook(), 'Test');
    assert.deepEqual(m.connectors.map(function (c) { return c.id; }), ['M142.C', 'M142.D', 'MAP', 'PEDAL', 'IAT']);
    assert.deepEqual(m.splices.map(function (s) { return s.id; }), ['SPL.5V', 'SPL.5V2']);
    assert.deepEqual(m.sheets.map(function (s) { return s.name + ':' + s.kind; }), ['ECU:connectors', 'Engine:connectors', 'Splices:splices']);
    var c = m.connectors[0];
    assert.equal(c.title, 'MoTeC M142 C - 34 Way');
    assert.equal(c.connector, 'Superseal 34');
    assert.equal(c.boot, 'SSB');
    assert.equal(c.columns[5], 'MoTeC Function');
    assert.deepEqual(c.pins[1], { cavity: '15', terminal: 'SSC', wirePn: 'M22759/32-22-9', wire: '22 AWG White',
      function: 'MAP Pressure Signal', note: 'AV2', remote: 'MAP.2', status: '' });
    assert.equal(m.connectors[2].columns[5], 'Notes');
    assert.equal(m.splices[0].type, 'Open Barrel');
    assert.equal(m.splices[0].wires.length, 3);
  });

  it('exports the same layout so a re-import gives the same model', function () {
    var m = harnessFromWorkbook(hxWorkbook(), 'Test');
    return readXlsx(writeXlsx(harnessToWorkbook(m))).then(function (wb) {
      var again = harnessFromWorkbook(wb, 'Test');
      assert.deepEqual(again.connectors, m.connectors);
      assert.deepEqual(again.splices, m.splices);
    });
  });

  it('explains what is missing when a workbook has no blocks', function () {
    assert.throws(function () { harnessFromWorkbook({ sheets: [{ name: 'x', rows: [['a']] }] }); }, 'No connector or splice blocks');
  });
});

describe('Harness — connection checks', function () {
  var m = harnessFromWorkbook(hxWorkbook(), 'Test'), issues = harnessCheck(m);

  it('resolves pins, splices, case-only matches and external points', function () {
    var idx = harnessIndex(m);
    assert.equal(harnessResolve(idx, 'M142.C.15').pin.function, 'MAP Pressure Signal');
    assert.equal(harnessResolve(idx, 'SPL.5V').splice.id, 'SPL.5V');
    assert.equal(harnessResolve(idx, 'm142.c.15').caseOnly, true);
    assert.equal(harnessResolve(idx, 'CHASSIS').kind, 'external');
    assert.equal(harnessResolve(idx, 'N/A').kind, 'none');
    assert.equal(harnessResolve(idx, 'MAP.2 (X107.H)').extra, '(X107.H)');
  });

  it('reports references to nothing, with a suggestion and the row to fix', function () {
    var i = hxFind(issues, 'M142.C.16', 'SPARE.1')[0];
    assert.equal(i.severity, 'error');
    assert.equal(i.fix, null, 'no close match');
    m.connectors[0].pins[2].remote = 'MAPP.2';
    var j = hxFind(harnessCheck(m), 'M142.C.16', 'MAPP.2')[0];
    m.connectors[0].pins[2].remote = 'SPARE.1';
    assert.equal(j.fix, 'MAP.2');
    assert.deepEqual(j.ref, { kind: 'pin', block: 'M142.C', index: 2 });
  });

  it('reports ends that disagree, once per pair', function () {
    assert.equal(hxFind(issues, 'M142.C.14', 'Goes to').length + hxFind(issues, 'PEDAL.1', 'Goes to').length, 0, 'C14 ↔ PEDAL.1 agree');
    assert.equal(hxFind(issues, 'M142.D.3', 'but IAT.1 goes to "M142.D.4"').length, 1);
    assert.equal(hxFind(issues, 'IAT.1', 'but M142.D.4 goes to nothing').length, 1);
    assert.equal(hxFind(issues, 'IAT.1', 'M142.D.3').length, 0, 'the D3 ↔ IAT.1 pair is reported once');
  });

  it('warns about case-only matches and wire part numbers that differ between ends', function () {
    assert.equal(hxFind(issues, 'MAP.2', 'ignoring upper/lower case').length, 1);
    var pn = issues.filter(function (i) { return i.message.indexOf('Wire part number differs') >= 0; });
    assert.equal(pn.length, 1, 'C14/PEDAL.1 reported once');
  });

  it('checks splices list their wires and allows chained splices', function () {
    assert.equal(hxFind(issues, 'M142.C.9', 'does not list').length, 0);
    assert.equal(issues.filter(function (i) { return i.where === 'SPL.5V' && i.severity === 'error'; }).length, 0);
    assert.equal(hxFind(issues, 'SPL.5V2', 'CHASSIS')[0].severity, 'warning');
    m.splices[1].wires[0].end = 'SPL.OTHER';
    assert.equal(hxFind(harnessCheck(m), 'SPL.5V', 'does not list SPL.5V').length, 1);
    m.splices[1].wires[0].end = 'SPL.5V';
  });

  it('flags duplicate cavities and names', function () {
    m.connectors[3].pins.push({ cavity: '1', terminal: '', wirePn: '', wire: '', function: '', note: '', remote: '', status: '' });
    m.splices[1].id = 'pedal';
    var again = harnessCheck(m);
    m.connectors[3].pins.pop();
    m.splices[1].id = 'SPL.5V2';
    assert.equal(hxFind(again, 'PEDAL.1', 'more than once').length, 1);
    assert.equal(hxFind(again, 'pedal', 'more than one').length, 1);
  });
});

describe('Harness — tune comparison', function () {
  function io(name, ids) {
    return { name: name, type: 'io_resource', value: ids };
  }
  function slot2(id) { return ['0x0000', '0x0000', id, '0x0000', '0x0000']; }
  var pkg = { items: [
    io('Inlet.Manifold.Pressure.Sensor.Resource.Value', slot2('0x6201')),      // AVI2 → C15
    io('Transmission.Temperature.Sensor Resource', slot2('0x6211')),           // AT1 → D03
    io('Fuel.Pressure.Sensor.Resource.Value', slot2('0x6203')),                // AVI4 → C17 (not wired)
    io('Throttle.Pedal.Sensor Main Resource', slot2('0x654c')),                // E888 AVI7
    io('Knock.Cylinder 1.Resource.Value', slot2('0x6100')),                    // Knock Input 1 → D07 (not wired)
    io('Fuel.Temperature.Sensor.Resource.Value', slot2('0x6480')),             // unnamed
    io('Coolant.Fan 2.Output Resource.Value', ['0x0000', '0x0000', '0x0000', '0x0000', '0x0000'])
  ] };
  var m = harnessFromWorkbook(hxWorkbook(), 'Test');
  var r = harnessTuneCompare(m, pkg, 'M142', {});
  function row(pin) { return r.rows.filter(function (x) { return x.pin === pin; })[0]; }

  it('matches tune assignments to harness cavities by connector pin', function () {
    assert.equal(row('M142 C15').status, 'ok');
    assert.deepEqual(row('M142 C15').tune, ['Inlet.Manifold.Pressure.Sensor']);
    assert.equal(row('M142 C15').harness.function, 'MAP Pressure Signal');
  });

  it('flags different functions, missing wires and connectors not in the harness', function () {
    assert.equal(row('M142 D03').status, 'check', 'transmission temp vs IAT');
    assert.equal(row('M142 C17').status, 'missing');
    assert.equal(row('M142 D07').status, 'missing', 'Knock Input 1 = D07, not wired');
    assert.equal(row('E888 A32').status, 'no-connector');
  });

  it('says when the tune uses a pin the harness marks as spare', function () {
    var sp = harnessTuneCompare(m, { items: [io('Fuel.Pressure.Sensor.Resource.Value', slot2('0x6202'))] }, 'M142', {});
    var x = sp.rows.filter(function (y) { return y.pin === 'M142 C16'; })[0];
    assert.equal(x.status, 'missing');
    assert.ok(x.note.indexOf('marks it as spare (wired to SPARE.1)') >= 0, x.note);
  });

  it('lists wired ECU inputs no tune assignment uses, but not power or spares', function () {
    assert.equal(row('M142 C14').status, 'not-in-tune');
    assert.equal(row('M142 C09'), undefined, '5V reference');
    assert.equal(row('M142 C16'), undefined, 'spare');
  });

  it('checks harness pin labels against the pinout', function () {
    assert.deepEqual(r.labelIssues, [{ where: 'M142.C.16', label: 'AV4', expected: 'av3' }]);
  });

  it('lists unnamed tune assignments separately', function () {
    assert.deepEqual(r.unnamed, [{ ids: '0x6480', tune: ['Fuel.Temperature.Sensor'] }]);
  });

  it('uses user-entered resource names', function () {
    var named = harnessTuneCompare(m, pkg, 'M142', { 'M142|0x0000,0x0000,0x6480,0x0000,0x0000': 'AT4' });
    assert.equal(named.unnamed.length, 0);
    assert.equal(named.rows.filter(function (x) { return x.pin === 'M142 D06'; })[0].status, 'missing', 'AT4 = D06, not in harness');
  });

  it('treats direct injector + pins as part of the assigned - output and checks harness labels', function () {
    var di = { items: [io('Fuel.Cylinder 1.Primary Output Resource', ['0x0000', '0x640f', '0x6110', '0x0000', '0x644c'])] };
    var model = { name: 'x', sheets: [], splices: [], connectors: [{ id: 'M142.A', sheet: 's', columns: [], pins: [
      { cavity: '6', wirePn: 'P', wire: 'W', function: 'Injector 1 Control (-)', note: 'Injector 1A -', remote: '', status: '' },
      { cavity: '7', wirePn: 'P', wire: 'W', function: 'Injector 1 Power (+)', note: 'Injector 1A +', remote: '', status: '' },
      { cavity: '1', wirePn: 'P', wire: 'W', function: 'Coolant Temp', note: 'AT6', remote: '', status: '' }
    ] }] };
    var res = harnessTuneCompare(model, di, 'M142', {});
    var plus = res.rows.filter(function (x) { return x.pin === 'M142 A07'; })[0];
    assert.equal(plus.status, 'ok');
    assert.equal(plus.resource, 'Direct Injector 1A+');
    assert.deepEqual(res.labelIssues, [{ where: 'M142.A.1', label: 'AT6', expected: 'at5' }]);
  });

  it('compares both half bridges of a bridge output', function () {
    var motor = { items: [io('Throttle.Servo.Bank 1 Motor Output Resource.Value', ['0x0000', '0x645b', '0x0000', '0x0000', '0x0000'])] };
    var model = { name: 'x', sheets: [], splices: [], connectors: [{ id: 'M142.C', sheet: 's', columns: [], pins: [
      { cavity: '18', wirePn: 'P', wire: 'W', function: 'DBW Motor -', note: 'Half Bridge Output 1', remote: '', status: '' },
      { cavity: '1', wirePn: 'P', wire: 'W', function: 'DBW Motor +', note: 'Half Bridge Output 2', remote: '', status: '' }
    ] }] };
    var res = harnessTuneCompare(model, motor, 'M142', {});
    assert.deepEqual(res.rows.map(function (x) { return x.pin + ' ' + x.resource + ' ' + x.status; }),
      ['M142 C01 Bridge Output 1 (2nd pin) ok', 'M142 C18 Bridge Output 1 ok']);
    assert.deepEqual(res.labelIssues, [], 'HB1/HB2 labels still match the datasheet');
  });

  it('compares function names by what they measure', function () {
    assert.ok(htSameFunction(['Coolant.Temperature.Sensor'], 'Coolant Temp Signal'));
    assert.ok(htSameFunction(['Inlet.Manifold.Pressure.Sensor'], 'MAP Pressure Signal'));
    assert.ok(htSameFunction(['Fuel.Cylinder 1.Primary Output'], 'Injector 1 Control (-)'));
    assert.ok(!htSameFunction(['Fuel.Cylinder 1.Primary Output'], 'Injector 6 Control (-)'));
    assert.ok(!htSameFunction(['Engine.Oil.Temperature.Sensor'], 'Ambient Temp'));
    assert.ok(htSameFunction(['Fuel.Composition.Sensor.Digital.Decode'], 'Flex Sensor Signal'));
  });
});
