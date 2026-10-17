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

describe('XLSX — pictures', function () {
  var png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

  it('writes pictures next to cells and reads back their anchors, sizes and bytes', function () {
    var sheets = [{ name: 'S', rows: [['a']], images: [{ row: 3, col: 8, cx: 300 * 9525, cy: 200 * 9525, mime: 'image/png', data: png }] },
                  { name: 'T', rows: [['b']] }];
    return readXlsx(writeXlsx(sheets)).then(function (wb) {
      assert.equal(wb.sheets[0].images.length, 1);
      var im = wb.sheets[0].images[0];
      assert.deepEqual([im.row, im.col, im.cx, im.cy, im.mime], [3, 8, 300 * 9525, 200 * 9525, 'image/png']);
      assert.deepEqual(Array.from(im.data), Array.from(png));
      assert.deepEqual(wb.sheets[1].images, []);
    });
  });

  it('attaches pictures to the block beside them and exports them again', function () {
    var wb = hxWorkbook();
    wb.sheets[1].images = [
      { row: 1, col: 8, cx: 9525 * 100, cy: 9525 * 50, mime: 'image/png', data: png },     // beside MAP
      { row: 7, col: 8, cx: 9525 * 80, cy: 9525 * 80, mime: 'image/png', data: png }       // beside PEDAL
    ];
    var m = harnessFromWorkbook(wb, 'T');
    var map = m.connectors.filter(function (c) { return c.id === 'MAP'; })[0];
    var pedal = m.connectors.filter(function (c) { return c.id === 'PEDAL'; })[0];
    assert.deepEqual([map.images.length, pedal.images.length], [1, 1]);
    assert.deepEqual([map.images[0].w, map.images[0].h], [100, 50]);
    // Stored images are exported from the bytes map.
    map.images[0] = { id: 'img1', mime: 'image/png', w: 100, h: 50, caption: '' };
    return readXlsx(writeXlsx(harnessToWorkbook(m, { img1: png }))).then(function (out) {
      var again = harnessFromWorkbook(out, 'T');
      assert.equal(again.connectors.filter(function (c) { return c.id === 'MAP'; })[0].images.length, 1);
      assert.equal(again.connectors.filter(function (c) { return c.id === 'PEDAL'; })[0].images.length, 1);
    });
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

  it('accepts Unterminated as an intentional one-ended wire, on a pin or in a splice', function () {
    var idx = harnessIndex(m);
    assert.equal(harnessResolve(idx, 'Unterminated').terminal, 'Unterminated');
    assert.equal(harnessResolve(idx, 'unterminated (shield, ECU end)').note, 'shield, ECU end');
    assert.equal(harnessResolve(idx, 'N/A').terminal, undefined);
    var pin = m.connectors[0].pins[2], wire = m.splices[1].wires[1];
    pin.remote = 'Unterminated';
    wire.end = 'Unterminated';
    var u = harnessCheck(m);
    assert.equal(hxFind(u, 'M142.C.16', '').length, 0, 'no issue for an unterminated wired cavity');
    assert.equal(hxFind(u, 'SPL.5V2', 'no location').length, 0, 'an unterminated splice wire is valid');
    pin.remote = 'N/A';
    assert.equal(hxFind(harnessCheck(m), 'M142.C.16', 'write Unterminated').length, 1, 'N/A with a wire still warns');
    pin.wirePn = 'Sealing Pin'; pin.wire = 'N/A'; pin.remote = 'Unterminated';
    assert.equal(hxFind(harnessCheck(m), 'M142.C.16', 'no wire listed').length, 1);
    pin.wirePn = 'Unused'; pin.wire = 'Unused'; pin.remote = 'Unused';
    assert.equal(hxFind(harnessCheck(m), 'M142.C.16', '').length, 0, 'a cavity marked Unused throughout is not a wire');
    pin.wirePn = 'M22759/32-22-9'; pin.wire = '22 AWG White'; pin.remote = 'SPARE.1';
    wire.end = 'CHASSIS';
  });

  it('accepts Eyelet and Battery ends, with a note or polarity', function () {
    var idx = harnessIndex(m);
    var e = harnessResolve(idx, 'Eyelet (engine block ground)');
    assert.equal(e.kind, 'none'); assert.equal(e.terminal, 'Eyelet'); assert.equal(e.note, 'engine block ground');
    e = harnessResolve(idx, 'Chassis Ground (Eyelet)');
    assert.equal(e.terminal, 'Eyelet'); assert.equal(e.note, 'Chassis Ground');
    assert.equal(harnessResolve(idx, 'Battery +').label, 'Battery +');
    assert.equal(harnessResolve(idx, 'battery-').polarity, '\u2212');
    assert.equal(harnessResolve(idx, 'Battery (neg)').label, 'Battery \u2212');
    assert.equal(harnessResolve(idx, 'Battery Positive (main feed)').note, 'main feed');
    assert.equal(harnessResolve(idx, 'Battery').label, 'Battery');
    assert.equal(harnessResolve(idx, 'Battery Box').kind, 'external', 'only the keyword itself');
    var pin = m.connectors[0].pins[2], wire = m.splices[1].wires[1];
    pin.remote = 'Battery +'; wire.end = 'Eyelet';
    var u = harnessCheck(m);
    assert.equal(hxFind(u, 'M142.C.16', '').length, 0, 'a wired cavity to the battery is valid');
    assert.equal(hxFind(u, 'SPL.5V2', '').length, 0, 'a splice wire to an eyelet is valid');
    pin.wirePn = 'N/A'; pin.wire = 'N/A';
    assert.equal(hxFind(harnessCheck(m), 'M142.C.16', 'Marked Battery but no wire listed').length, 1);
    pin.wirePn = 'M22759/32-22-9'; pin.wire = '22 AWG White'; pin.remote = 'SPARE.1';
    wire.end = 'CHASSIS';
    m.connectors[3].pins[0].remote = 'Eyelet';   // PEDAL.1, which M142.C.14 points at
    var i = hxFind(harnessCheck(m), 'M142.C.14', 'goes to Eyelet');
    m.connectors[3].pins[0].remote = 'M142.C.14';
    assert.equal(i.length, 1);
  });

  it('reports a wire pointing at an Unterminated end', function () {
    m.connectors[3].pins[0].remote = 'Unterminated';   // PEDAL.1, which M142.C.14 points at
    var i = hxFind(harnessCheck(m), 'M142.C.14', 'goes to nothing (Unterminated)');
    m.connectors[3].pins[0].remote = 'M142.C.14';
    assert.equal(i.length, 1);
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
    io('Fuel.Temperature.Sensor.Resource.Value', slot2('0x6555')),             // unnamed
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

  it('lists every resource name used on a shared pin', function () {
    var hybrid = { items: [io('Throttle.Servo.Bank 1.Position.Sensor.Main.Digital.Decode Resource.Value', ['0x6402', '0x0000', '0x6465', '0x0000', '0x6442']),
                           io('Throttle.Servo.Bank 1 Position Sensor Main Resource.Value', slot2('0x6477')),
                           io('Throttle.Servo.Bank 1 Position Sensor Tracking Resource.Value', slot2('0x6478'))] };
    var d08 = harnessTuneCompare(m, hybrid, 'M142', {}).rows.filter(function (x) { return x.pin === 'M142 D08'; })[0];
    assert.equal(d08.resource, 'UDIG3, UDIG3 Hybrid A, UDIG3 Hybrid B');
    assert.equal(d08.tune.length, 3);
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
    assert.deepEqual(r.unnamed, [{ ids: '0x6555', tune: ['Fuel.Temperature.Sensor'] }]);
  });

  it('uses user-entered resource names', function () {
    var named = harnessTuneCompare(m, pkg, 'M142', { 'M142|0x0000,0x0000,0x6555,0x0000,0x0000': 'AT4' });
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

describe('Harness — wiring diagrams', function () {
  var m = harnessFromWorkbook(hxWorkbook(), 'Test');

  it('reads wire colour, stripe and gauge from the description', function () {
    var a = hdWireStyle('22 AWG White/Pink (Shielded 2)');
    assert.deepEqual([a.color, a.stripe, a.label, a.shield], ['#f4f4f4', '#ec5f9a', '22 AWG White/Pink', true]);
    var b = hdWireStyle('14 AWG Red');
    assert.ok(b.width > hdWireStyle('22 AWG Red').width, 'heavier gauge draws thicker');
    assert.equal(hdWireStyle('Shield (Shielded 2)').label, 'Shield');
    assert.equal(hdWireStyle('Empty').label, '');
  });

  it('draws a connector with wires to every pin and splice it reaches', function () {
    var d = harnessBlockDiagram(m, 'M142.C');
    assert.ok(/^<svg /.test(d.svg));
    ['PEDAL', 'MAP', 'SPL.5V'].forEach(function (id) { assert.ok(d.svg.indexOf('data-node="' + id + '"') >= 0, id); });
    assert.ok(d.svg.indexOf('data-endpoint="M142.C.15"') >= 0);
    assert.ok(d.svg.indexOf('data-endpoint="MAP.2"') >= 0);
    assert.ok(d.svg.indexOf('Not in this harness') >= 0, 'SPARE.1 is not in this harness');
    assert.equal((d.svg.match(/class="wire"/g) || []).length, 6, 'C14, C15, C16, C9, then the splice on to MAP.1 and SPL.5V2');
  });

  it('draws Unterminated, Eyelet and Battery wires as stubs with their symbol', function () {
    m.connectors[0].pins[2].remote = 'Unterminated';
    m.connectors[0].pins[1].remote = 'Eyelet (block)';
    m.connectors[0].pins[0].remote = 'Battery -';
    var d = harnessBlockDiagram(m, 'M142.C');
    m.connectors[0].pins[2].remote = 'SPARE.1';
    m.connectors[0].pins[1].remote = 'MAP.2';
    m.connectors[0].pins[0].remote = 'PEDAL.1';
    assert.ok(d.svg.indexOf('class="terminal unterminated"') >= 0);
    assert.ok(d.svg.indexOf('class="terminal eyelet"') >= 0 && d.svg.indexOf('<circle') >= 0);
    assert.ok(d.svg.indexOf('class="terminal battery"') >= 0 && d.svg.indexOf('Battery \u2212') >= 0);
    assert.ok(d.svg.indexOf('Eyelet (block)') >= 0, 'the note is in the tooltip');
    assert.ok(d.svg.indexOf('Not in this harness') < 0, 'not drawn as a missing block');
  });

  it('follows splices one step to their far ends', function () {
    var d = harnessBlockDiagram(m, 'MAP');
    assert.ok(d.svg.indexOf('data-node="SPL.5V"') >= 0);
    assert.ok(d.svg.indexOf('data-endpoint="M142.C.9"') >= 0, 'the ECU 5V on the far side of the splice');
  });

  it('draws the overview with each wire counted once', function () {
    var d = harnessOverviewDiagram(m, { hardware: 'M142' });
    var edge = d.svg.match(/data-a="M142.C" data-b="SPL.5V"><title>[^<]*: (\d+) wire/);
    assert.ok(edge, 'M142.C ↔ SPL.5V bundle');
    assert.equal(edge[1], '1');
    assert.ok(d.svg.indexOf('data-node="SPL.5V2"') >= 0);
  });

  it('explains a missing block', function () {
    assert.ok(harnessBlockDiagram(m, 'NOPE').svg.indexOf('No connector or splice named NOPE') >= 0);
  });
});

describe('Harness — systems of harnesses', function () {
  function conn(id, part, mate, pins) {
    return { id: id, title: id, sheet: 's', connector: part, mateConn: mate, columns: [], images: [],
      pins: pins.map(function (p) { return { cavity: p[0], terminal: '', wirePn: p[1] ? 'W' : '', wire: p[1] ? '22 AWG White' : '',
        function: p[2] || '', note: '', remote: p[3] || '', status: '' }; }) };
  }
  // Engine: ECU pin C14 → bulkhead A. Chassis: bulkhead A → pedal, B wired only on this side, C function differs.
  var engine = { name: 'Engine', sheets: [], splices: [], connectors: [
    conn('M142.C', 'Superseal', '', [['14', true, 'APP Signal', 'BULK.A']]),
    conn('BULK', 'MS-95S', 'MS-95P', [['A', true, 'APP Signal', 'M142.C.14'], ['B', false, 'Spare', ''], ['C', true, 'Brake Switch', 'M142.C.14']])
  ] };
  var chassis = { name: 'Chassis', sheets: [], splices: [], connectors: [
    conn('BULK', 'MS-95P', 'MS-95S', [['A', true, 'APP Signal 1', 'PEDAL.1'], ['B', true, 'Fan Relay', 'FAN.1'], ['C', true, 'AC Request', 'AC.1']]),
    conn('PEDAL', 'DTM', '', [['1', true, 'APP', 'BULK.A']]),
    conn('OTHER', 'X', 'Y', [])
  ] };
  var members = [{ id: 'e', name: 'Engine', model: engine }, { id: 'c', name: 'Chassis', model: chassis }];

  it('maps MoTeC expander titles and treats Unused as no connection', function () {
    assert.equal(harnessConnectorId('MoTeC E888 B - 26 Way'), 'E888.B');
    assert.equal(harnessConnectorId('MoTeC M142 A - 34 Way'), 'M142.A');
    assert.equal(harnessResolve(harnessIndex(engine), 'Unused').kind, 'none');
  });

  it('splits a sheet that holds the other half of a mating pair into its own harness', function () {
    var model = { name: 'C', sheets: [{ name: 'Main', kind: 'connectors' }, { name: 'Sub', kind: 'connectors' }], splices: [], connectors: [
      Object.assign(conn('TRANS', 'DTM06', 'DTM04', []), { sheet: 'Main' }), Object.assign(conn('A', '', '', []), { sheet: 'Main' }),
      Object.assign(conn('TRANS', 'DTM04', 'DTM06', []), { sheet: 'Sub' }), Object.assign(conn('VSS', '', '', []), { sheet: 'Sub' })] };
    assert.deepEqual(harnessSplitCandidates(model), [{ sheet: 'Sub', shared: ['TRANS'] }]);
    var sp = harnessSplitSheet(model, 'Sub', 'C - Sub');
    assert.deepEqual(sp.main.connectors.map(function (c) { return c.id; }), ['TRANS', 'A']);
    assert.deepEqual(sp.sub.connectors.map(function (c) { return c.id; }), ['TRANS', 'VSS']);
    assert.equal(sp.sub.name, 'C - Sub');
  });

  it('joins same-name connectors whose part numbers mate, and honours rejected and manual links', function () {
    var m = harnessMates(members, {});
    assert.equal(m.mates.length, 1);
    assert.deepEqual([m.mates[0].a.connector, m.mates[0].source, m.mates[0].parts], ['BULK', 'auto', 'mate']);
    var link = { a: { harness: 'e', connector: 'BULK' }, b: { harness: 'c', connector: 'BULK' } };
    var off = harnessMates(members, { rejected: [link] });
    assert.equal(off.mates.length, 0);
    assert.equal(off.suggestions[0].source, 'rejected');
    var manual = harnessMates(members, { manual: [{ a: { harness: 'e', connector: 'M142.C' }, b: { harness: 'c', connector: 'OTHER' } }] });
    assert.equal(manual.mates.length, 2);
    assert.equal(manual.mates[1].source, 'manual');
    assert.equal(hsysPartsMate({ connector: 'A', mateConn: 'B' }, { connector: 'C', mateConn: 'D' }), 'conflict');
    assert.equal(hsysPartsMate({ connector: '', mateConn: '' }, { connector: 'C', mateConn: '' }), 'unknown');
  });

  it('checks both sides of every joined cavity', function () {
    var issues = harnessSystemChecks(members, harnessMates(members, {}).mates);
    assert.equal(issues.length, 2);
    assert.ok(/B has a wire on the Chassis BULK side but none on the Engine BULK side/.test(issues[0].message), issues[0].message);
    assert.ok(/"Brake Switch" in Engine but "AC Request" in Chassis/.test(issues[1].message), issues[1].message);
    assert.deepEqual(issues[0].other, { harness: 'c', where: 'BULK.B' });
  });

  it('traces a circuit across the join and draws it', function () {
    var g = harnessSystemGraph(members, harnessMates(members, {}).mates);
    var t = harnessTrace(g, 'e|M142.C.14');
    assert.deepEqual(t.nodes.map(function (n) { return n.key + ':' + n.depth; }).sort(),
      ['c|BULK.A:2', 'c|BULK.C:2', 'c|PEDAL.1:3', 'c|?AC.1:3', 'e|BULK.A:1', 'e|BULK.C:1', 'e|M142.C.14:0'].sort(), 'AC.1 is outside the chassis harness');
    assert.equal(t.edges.filter(function (e) { return e.kind === 'mate'; }).length, 2);
    assert.equal(harnessTrace(g, 'e|NOPE.1'), null);
    var d = harnessTraceDiagram(t);
    assert.ok(d.svg.indexOf('data-trace="c|PEDAL.1"') >= 0);
    assert.ok(d.svg.indexOf('⇄ mated') >= 0);
    assert.ok(harnessSystemDiagram(members, harnessMates(members, {}).mates).svg.indexOf('data-harness="c"') >= 0);
  });

  it('compares a tune against every harness in a system', function () {
    var e888 = { name: 'Chassis', sheets: [], splices: [], connectors: [conn('E888.A', 'S', '', [['32', true, 'Throttle Pedal Main', 'PEDAL.1']])] };
    var pkg = { items: [{ name: 'Throttle.Pedal.Sensor Main Resource', type: 'io_resource', value: ['0x0000', '0x0000', '0x654c', '0x0000', '0x0000'] }] };
    var one = harnessTuneCompare(engine, pkg, 'M142', {});
    assert.equal(one.rows[0].status, 'no-connector');
    var both = harnessTuneCompare([{ name: 'Engine', model: engine }, { name: 'Chassis', model: e888 }], pkg, 'M142', {});
    var row = both.rows.filter(function (r) { return r.pin === 'E888 A32'; })[0];
    assert.deepEqual([row.status, row.harnessName], ['ok', 'Chassis']);
  });
});
