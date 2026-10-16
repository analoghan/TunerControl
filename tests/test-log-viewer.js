/**
 * test-log-viewer.js — Tests for the Log Viewer: log reading (log-viewer/log-file.js), filter segments
 * (log-viewer/worker.js), chart helpers (log-viewer/log-chart.js) and the per-sample VE reasons it shows.
 */

/** A minimal .ld file: channel 0 "Engine.Speed" int16 at 100 Hz, channel 1 "Throttle.Position" float32 at 10 Hz. */
function lvTestLd(rpm, tps) {
  var meta = 0x100, hdr = 124, data0 = meta + 2 * hdr, data1 = data0 + rpm.length * 2;
  var buf = new ArrayBuffer(data1 + tps.length * 4), v = new DataView(buf), u8 = new Uint8Array(buf);
  v.setUint32(8, meta, true);
  v.setUint32(86, 2, true);
  function chan(at, next, ptr, n, dtypeA, dtypeVal, freq, name, unit, scale, dec) {
    v.setUint32(at + 4, next, true); v.setUint32(at + 8, ptr, true); v.setUint32(at + 12, n, true);
    v.setUint16(at + 18, dtypeA, true); v.setUint16(at + 20, dtypeVal, true); v.setUint16(at + 22, freq, true);
    v.setInt16(at + 24, 0, true); v.setInt16(at + 26, 1, true); v.setInt16(at + 28, scale, true); v.setInt16(at + 30, dec, true);
    for (var i = 0; i < name.length; i++) u8[at + 32 + i] = name.charCodeAt(i);
    for (i = 0; i < unit.length; i++) u8[at + 72 + i] = unit.charCodeAt(i);
  }
  chan(meta, meta + hdr, data0, rpm.length, 0x03, 2, 100, 'Engine.Speed', 'rpm', 1, 0);
  chan(meta + hdr, 0, data1, tps.length, 0x07, 4, 10, 'Throttle.Position', '%', 1, 0);
  rpm.forEach(function (x, i) { v.setInt16(data0 + i * 2, x, true); });
  tps.forEach(function (x, i) { v.setFloat32(data1 + i * 4, x, true); });
  return buf;
}

describe('Log Viewer — reading logs', function () {
  it('lists .ld channels with names, units and rates, and reads them on demand', function () {
    var rpm = [], i;
    for (i = 0; i < 30; i++) rpm.push(1000 + i);
    var log = lvOpenLog(lvTestLd(rpm, [5, 10, 20]), 'x.ld');
    assert.deepEqual(log.channels.map(function (c) { return c.name + '|' + c.unit + '|' + c.freq; }),
      ['Engine Speed|rpm|100', 'Throttle Position|%|10']);
    assert.equal(log.baseFreq, 100);
    assert.closeTo(log.duration, 0.3, 1e-9);
    assert.equal(lvChannel(log, 0)[29], 1029);
    assert.deepEqual(Array.from(lvChannel(log, 1)), [5, 10, 20]);
    assert.equal(lvFind(log, 'throttle position'), 1);
  });

  it('resamples slow channels to the base rate by holding each value', function () {
    var log = lvOpenLog(lvTestLd(new Array(30).fill(900), [5, 10, 20]), 'x.ld');
    var tps = lvAtBase(log, 1), t = lvBaseTime(log);
    assert.equal(tps.length, 30);
    assert.equal(tps[9], 5);
    assert.equal(tps[10], 10);
    assert.equal(tps[29], 20);
    assert.equal(t[15], 15 * (1 / 100), 'the same times the VE tool uses');
  });

  it('reads a MoTeC CSV export', function () {
    var csv = '"Format","MoTeC CSV File"\n"Device","M1"\n\n"Time","Engine Speed","Throttle Position"\n"s","rpm","%"\n\n' +
      '0.00,1000,5\n0.01,1010,\n0.02,1020,7\n';
    var log = lvOpenLog(csv, 'x.csv');
    assert.equal(log.kind, 'csv');
    assert.equal(log.baseFreq, 100);
    assert.deepEqual(log.channels.map(function (c) { return c.name + '|' + c.unit; }), ['Engine Speed|rpm', 'Throttle Position|%']);
    assert.ok(isNaN(lvChannel(log, 1)[1]), 'empty cell → NaN');
    assert.equal(lvChannel(log, 0)[2], 1020);
    var threw = false;
    try { lvOpenLog('a,b\n1,2\n', 'x.csv'); } catch (e) { threw = true; }
    assert.ok(threw, 'not a MoTeC export');
  });
});

describe('Log Viewer — overlays', function () {
  it('turns per-sample codes into time segments', function () {
    var t = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    assert.deepEqual(lvSegments([0, 3, 3, 6, 0, 3], t, 0.1).map(function (s) { return [s[0], +s[1].toFixed(6), s[2]]; }),
      [[0.1, 0.3, 3], [0.3, 0.4, 6], [0.5, 0.6, 3]]);
    assert.deepEqual(lvSegments([0, 0], [0, 1], 1), []);
  });

  it('gets from analyzeVE the reason each sample was left out, matching its counts', function () {
    var samples = [];
    for (var i = 0; i < 300; i++) {
      samples.push({ time: 70 + i * 0.01, rpm: 2000, map: 100, lambdaB1: i < 100 ? 9 : 1.05, lambdaB2: NaN, lambdaAvg: NaN, lambdaTarget: 1,
        clTrimB1: 0, clTrimB2: 0, coolantTemp: i >= 250 ? 20 : 90, throttlePos: 30, overrunState: i < 100 ? 1 : 0, fuelCutCount: 0 });
    }
    var reasons = new Uint8Array(300), corrections = new Float32Array(300);
    var ve = { mapBreakpoints: [100, 50], rpmBreakpoints: [2000, 3000], values: [[80, 85], [60, 65]] };
    var res = analyzeVE(samples, ve, { reasons: reasons, corrections: corrections, steadyWindowMs: 0 });
    var count = function (code) { return Array.from(reasons).filter(function (r) { return r === code; }).length; };
    assert.equal(count(VE_REASON.FUEL_CUT), res.filteredByFuelCut);
    assert.equal(count(VE_REASON.COOLANT), 50);
    assert.equal(count(VE_REASON.USED), res.totalSamples);
    assert.closeTo(corrections[220], 5, 1e-5);
  });
});

describe('Log Viewer — chart helpers', function () {
  it('picks round tick values', function () {
    assert.deepEqual(lcTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
    assert.deepEqual(lcTicks(0.86, 0.99, 4), [0.86, 0.88, 0.9, 0.92, 0.94, 0.96, 0.98]);
  });

  it('formats times and values', function () {
    assert.equal(lcClock(5), '5 s');
    assert.equal(lcClock(349.5), '5:49.5');
    assert.equal(lcFmt(0.8654), '0.865');
    assert.equal(lcFmt(NaN), '—');
  });
});
