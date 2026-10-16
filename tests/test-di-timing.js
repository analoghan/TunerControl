/**
 * test-di-timing.js — DI Injection Timing: valve events and start of injection (di-timing/di-calc.js, checked against the
 * GM Gen V calculator's SOI sheet), limit advice, and reading the timing settings from a tune (di-timing/m1pkg-di.js).
 */

describe('DI timing — valve events and start of injection', function () {
  // The GM Gen V Excel Calculator's own example: 229/244 @ 0.050", 118 LSA, 114 ICL.
  var ev = diValveEvents({ intakeDur: 229, exhaustDur: 244, lsa: 118, icl: 114 });

  it('matches the spreadsheet at 0.050" and seat to seat (+52°)', function () {
    assert.deepEqual([ev.at050.ivoBTDC, ev.at050.ivcABDC, ev.at050.evoBBDC, ev.at050.evcATDC, ev.at050.ecl, ev.at050.overlap], [0.5, 48.5, 64, 0, 122, 0.5]);
    assert.deepEqual([ev.at006.ivoBTDC, ev.at006.ivcABDC, ev.at006.evoBBDC, ev.at006.evcATDC, ev.at006.overlap], [26.5, 74.5, 90, 26, 52.5]);
  });

  it('places the events on the M1 dBTDC scale', function () {
    assert.deepEqual(ev.at006.dBTDC, { ivo: 386.5, ivc: 105.5, evo: 630, evc: 334 });
  });

  it('recommends the spreadsheet\'s start of injection: 43.75° ATDC = 316.25 dBTDC', function () {
    var r = diRecommendSoi(ev.at006);
    assert.equal(r.atdc, 43.75);
    assert.equal(r.dBTDC, 316.25);
    assert.equal(r.limitedByEvc, false);
  });

  it('never starts before the exhaust valve seats, and at least 20° ATDC', function () {
    // Big overlap: exhaust closes 49° ATDC (seat to seat), later than the spreadsheet point.
    var big = diValveEvents({ intakeDur: 260, exhaustDur: 270, lsa: 108, icl: 104 }).at006;
    var r = diRecommendSoi(big);
    assert.equal(r.atdc, big.evcATDC + 5);
    assert.equal(r.limitedByEvc, true);
    var tiny = diValveEvents({ intakeDur: 150, exhaustDur: 150, lsa: 120, icl: 120 }).at006;
    assert.ok(diRecommendSoi(tiny).atdc >= 20);
  });

  it('accepts seat-to-seat durations and a cam phaser that moves both lobes', function () {
    var s = diValveEvents({ intakeDur: 281, exhaustDur: 296, basis: '006', lsa: 118, icl: 114 });
    assert.deepEqual(s.at006.dBTDC, ev.at006.dBTDC);
    var adv = diValveEvents({ intakeDur: 229, exhaustDur: 244, lsa: 118, icl: 114, phaser: 4, phaserMovesExhaust: true }).at006;
    assert.equal(adv.ivoBTDC, 30.5, 'intake opens 4° earlier');
    assert.equal(adv.evcATDC, 22, 'exhaust closes 4° earlier too');
    assert.equal(adv.overlap, 52.5, 'single cam: overlap unchanged');
  });
});

describe('DI timing — injection checks and limits', function () {
  var e6 = diValveEvents({ intakeDur: 229, exhaustDur: 244, lsa: 118, icl: 114 }).at006;

  it('works out the end of injection from the pulse width and rpm', function () {
    assert.closeTo(diCrankDeg(6, 6400), 230.4, 1e-9, 'the spreadsheet\'s 6 ms at 6400 rpm');
    var c = diCheckInjection(316, 2, 3000, { evc: 334, spark: 30, primaryLimit: 135 });
    assert.equal(c.eoi, 280);
    assert.ok(!c.beforeEvc && !c.intoCompression && !c.truncated && !c.nearSpark);
    var late = diCheckInjection(340, 7.5, 7000, { evc: 334, spark: 30, primaryLimit: 135 });   // 315° long: ends at 25 dBTDC
    assert.ok(late.beforeEvc && late.intoCompression && late.truncated && late.nearSpark);
  });

  it('moves the start earlier only when the pulse would reach the compression stroke', function () {
    var rows = diSoiTable([1000, 4000, 8000], { soi: 316, earliest: 329, pwMs: 4, spark: 30, primaryLimit: 135, evc: 334 });
    assert.equal(rows[0].soi, 316);
    assert.equal(rows[1].soi, 316, '4 ms at 4000 rpm = 96°, ends at 220');
    assert.equal(rows[2].soi, 329, '4 ms at 8000 rpm = 192°: as early as the exhaust valve allows');
    assert.ok(rows[2].intoCompression && !rows[2].truncated);
  });

  it('flags a start limit before the exhaust valve seats, and table cells earlier than it', function () {
    var a = diLimitAdvice({ startLimit: 355, primaryLimit: 135 }, e6, 30.8, 335);
    assert.equal(a[0].severity, 'warning');
    assert.ok(/21° before the exhaust valve seats/.test(a[0].text) && /about 325 dBTDC/.test(a[0].text) && /asks for up to 335 dBTDC/.test(a[0].text), a[0].text);
    assert.equal(a[1].severity, 'good');
    assert.equal(diLimitAdvice({ startLimit: 325, primaryLimit: 35 }, e6, 30, null)[1].severity, 'warning', 'limit within 10° of the spark');
    assert.equal(diLimitAdvice({ startLimit: 340, primaryLimit: 135 }, e6, 30, null)[0].severity, 'info', 'a few degrees early, table fine: a trade-off');
    var t = diTableCheck({ rpm: [1000, 8000], map: [0, 100], values: [[310, 300], [290, 335]] }, e6);
    assert.deepEqual(t.early, [{ rpm: 8000, map: 100, soi: 335, by: 1 }]);
    assert.deepEqual(diTableCheck({ rpm: [1000], map: [100], values: [[225]] }, e6).late, [{ rpm: 1000, map: 100, soi: 225 }]);
    assert.equal(t.max, 335);
  });
});

describe('DI timing — settings from a tune', function () {
  it('reads the timing table, limits, spark and cam aim in M1 Tune\'s units', function () {
    var pkg = { tuneName: 'T', items: [
      { name: 'Fuel.Timing.Primary.Main', kind: 'Table', values: [-310, -300, 0, -290, -335, 0],
        axes: [{ axis: 'X', unit: 'deg/s', sites: 2, maxSites: 3, values: [6000, 48000, 0] }, { axis: 'Y', unit: 'Pa', sites: 2, maxSites: 2, values: [0, 100000] }] },
      { name: 'Fuel.Timing.Primary.Injection Start Limit', values: [-355] },
      { name: 'Fuel.Timing.Primary.Limit.Main', values: [-135] },
      { name: 'Fuel.Timing.Primary.Limit.Margin', value: -20 },
      { name: 'Ignition.Timing.Main', kind: 'Table', values: [-12, -30.8], axes: [{ axis: 'X', unit: 'deg/s', sites: 2, maxSites: 2, values: [0, 6000] }] },
      { name: 'Inlet.Camshaft.Aim', kind: 'Table', values: [0, -4], axes: [{ axis: 'X', unit: 'deg/s', sites: 2, maxSites: 2, values: [0, 6000] }] },
      { name: 'Engine.Cylinders', value: 8 }
    ] };
    var d = m1pkgDi(pkg);
    assert.deepEqual(d.table, { rpm: [1000, 8000], map: [0, 100], values: [[310, 300], [290, 335]] });
    assert.deepEqual([d.startLimit, d.primaryLimit, d.limitMargin, d.spark, d.cylinders], [355, 135, 20, 30.8, 8]);
    assert.deepEqual(d.camAim, { min: 0, max: 4 });
  });
});
