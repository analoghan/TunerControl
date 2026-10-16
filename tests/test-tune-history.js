/**
 * test-tune-history.js — Tests for m1-config/history.js (value history) and m1-config/tune-source.js
 * (stored tunes for other tools).
 */

describe('M1 Config — value history', function () {
  var scalar = { name: 'Fuel.Film.Primary.Offset.Value', type: 'f32', unit: 'm3', displayUnit: 'ul', dps: 1 };
  var table = { name: 'T', type: 'f32', unit: 'ratio', displayUnit: '%', dps: 1,
    axes: [{ axis: 'X', unit: 'deg/s', displayUnit: 'rpm', dps: 0, maxSites: 2, sites: 2, values: [0, 6000] }], values: [0.5, 0.6] };
  var io = { name: 'X.Resource', type: 'io_resource' };

  it('shortens tune names to their version', function () {
    assert.equal(m1hShortName('C7 Z06 LT4 - 2026 - Blake - V55'), 'V55');
    assert.equal(m1hShortName('Plain'), 'Plain');
  });

  it('converts stored values to display units and keeps gaps', function () {
    var pts = m1hPoints([
      { tuneName: 'A - V1', modified: '2026-01-01', value: 3e-8 },
      { tuneName: 'A - V2', modified: '2026-02-01', value: null },
      { tuneName: 'A - V3', modified: '2026-03-01', value: 4e-8 }
    ], scalar, '');
    assert.deepEqual(pts.map(function (p) { return p.short; }), ['V1', 'V2', 'V3']);
    assert.closeTo(pts[0].num, 30, 1e-6);
    assert.equal(pts[1].text, '—');
    assert.equal(pts[1].num, null);
  });

  it('formats table cells and axis sites with their own units', function () {
    var cell = m1hPoints([{ tuneName: 'V1', value: 0.55 }], table, 'V[1]')[0];
    assert.closeTo(cell.num, 55, 1e-9);
    var axis = m1hPoints([{ tuneName: 'V1', value: 6000 }], table, 'X[1]')[0];
    assert.closeTo(axis.num, 1000, 1e-9);
  });

  it('shows I/O assignments as text without a chart', function () {
    var pts = m1hPoints([{ tuneName: 'V1', value: ['0x0000', '0x0000', '0x6537', '0x0000', '0x0000'] },
                         { tuneName: 'V2', value: '0x0000,0x0000,0x0000,0x0000,0x0000' }], io, '',
      function (ids) { return ids.filter(function (x) { return x !== '0x0000'; }).join(',') || 'Not assigned'; });
    assert.deepEqual(pts.map(function (p) { return p.text; }), ['0x6537', 'Not assigned']);
    assert.equal(m1hChartSvg(pts, ''), '');
  });

  it('draws a chart for two or more numbers', function () {
    var pts = m1hPoints([{ tuneName: 'V1', value: 3e-8 }, { tuneName: 'V2', value: 4e-8 }], scalar, '');
    var svg = m1hChartSvg(pts, 'ul');
    assert.ok(/^<svg /.test(svg));
    assert.equal((svg.match(/<circle /g) || []).length, 2);
    assert.equal(m1hChartSvg(pts.slice(0, 1), 'ul'), '');
  });
});

describe('Stored tunes — log matching', function () {
  var tunes = [
    { id: 'v55', tuneName: 'V55', serial: 30924, modified: '2026-10-15T20:51:06Z' },
    { id: 'v54', tuneName: 'V54', serial: 30924, modified: '2026-10-13T02:11:21Z' },
    { id: 'x', tuneName: 'Other ECU', serial: 11111, modified: '2026-10-14T00:00:00Z' }
  ];

  it('parses MoTeC day-first dates', function () {
    var d = tsParseDate('11/06/2026', '17:32:21');
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 5, 11, 17, 32]);
    assert.equal(tsParseDate('', ''), null);
  });

  it('suggests the latest tune from the same ECU saved before the log', function () {
    var s = tsSuggest(tunes, { serial: 30924, time: new Date('2026-10-14T12:00:00Z') });
    assert.equal(s.tune.id, 'v54');
    assert.equal(tsSuggest(tunes, { serial: 30924, time: new Date('2026-10-20T00:00:00Z') }).tune.id, 'v55');
  });

  it('says why when nothing fits', function () {
    var early = tsSuggest(tunes, { serial: 30924, time: new Date('2026-06-11T17:32:21Z') });
    assert.equal(early.tune, null);
    assert.ok(/saved before this log/.test(early.reason));
    assert.ok(/No stored tune is from ECU #99/.test(tsSuggest(tunes, { serial: 99, time: new Date() }).reason));
    assert.ok(/date is unknown/.test(tsSuggest(tunes, { serial: 30924, time: null }).reason));
    assert.ok(/No tunes are stored/.test(tsSuggest([], { serial: 1, time: new Date() }).reason));
  });

  it('reads the serial and start time from an .ld header and from a log file name', function () {
    var buf = new Uint8Array(0x100), view = new DataView(buf.buffer);
    view.setUint32(0x46, 30924, true);
    '11/06/2026'.split('').forEach(function (c, i) { buf[0x5e + i] = c.charCodeAt(0); });
    '17:32:21'.split('').forEach(function (c, i) { buf[0x7e + i] = c.charCodeAt(0); });
    var ld = new File([buf], 'log.ld');
    var named = { name: 'S1_#30924_20260611_173221_02.csv' };
    return Promise.all([tsLogInfo(ld), tsLogInfo(named)]).then(function (r) {
      assert.equal(r[0].serial, 30924);
      assert.equal(r[0].time.getHours(), 17);
      assert.equal(r[1].serial, 30924);
      assert.equal(r[1].time.getDate(), 11);
    });
  });
});
