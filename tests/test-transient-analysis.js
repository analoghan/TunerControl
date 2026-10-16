/**
 * test-transient-analysis.js — Tests for the Transient Fuel Analyzer maths: transient-fuel/worker.js
 * (event detection, lambda excursions, recommendations) and transient-fuel/film-correct.js (table corrections).
 */

// 100 Hz log: steady at 30 kPa, MAP steps to 80 kPa at t = 2 s (over 0.1 s), then steady.
function tfLog(lambdaAt, extra) {
  var out = [];
  for (var i = 0; i < 600; i++) {
    var t = i * 0.01, map = t < 2 ? 30 : t < 2.1 ? 30 + (t - 2) * 500 : 80;
    out.push(Object.assign({ time: t, map: map, rpm: 2500, tps: map, coolant: 90, lambdaTarget: 1.0,
      lambda: lambdaAt ? lambdaAt(t) : 1.0, overrunState: 0, fuelCutCount: 5 }, extra ? extra(t) : {}));
  }
  return out;
}
var TF_SETTINGS = { mapRateThreshold: 200, minMapChange: 20, mapWindow: 500, lambdaTarget: 1.0 };

describe('Transient Fuel — lambda excursions', function () {
  it('measures a tip-in lean spike beyond both the starting and the settled lambda, not the target', function () {
    // Settles 3% rich of target at the new load (a VE matter); spikes to 1.07 just after the step.
    var events = detectTransientEvents(tfLog(function (t) { return t < 2 ? 1.0 : t < 2.3 ? 1.07 : 0.97; }), TF_SETTINGS);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tip-in');
    assert.closeTo(events[0].leanSpike, 7, 0.1, 'beyond the higher (starting) level');
    assert.equal(events[0].richOvershoot, 0);
    assert.equal(events[0].richBefore, 0);
  });

  it('does not count a steady difference between the start and end loads as a spike or dip', function () {
    var richStart = detectTransientEvents(tfLog(function (t) { return t < 2.1 ? 0.88 : 1.0; }), TF_SETTINGS)[0];
    assert.equal(richStart.richBefore, 0);
    assert.equal(richStart.leanSpike, 0);
    var leanStart = detectTransientEvents(tfLog(function (t) { return t < 2.1 ? 1.06 : 1.0; }), TF_SETTINGS)[0];
    assert.equal(leanStart.leanSpike, 0);
  });

  it('measures a rich dip before the lean peak, and MAP overshoot', function () {
    var events = detectTransientEvents(tfLog(function (t) {
      return t < 2 ? 1 : t < 2.2 ? 0.9 : t < 2.5 ? 1.06 : 1.0;
    }, function (t) { return t >= 2.1 && t < 2.3 ? { map: 95 } : {}; }), TF_SETTINGS);
    assert.closeTo(events[0].richBefore, 10, 0.1);
    assert.closeTo(events[0].leanSpike, 6, 0.1);
    assert.equal(events[0].mapPeak, 95);
    assert.equal(mapOvershoot(events[0]), 15);
  });

  it('measures the spike from the start of the event, while MAP is still rising', function () {
    var events = detectTransientEvents(tfLog(function (t) { return t >= 2.0 && t < 2.08 ? 1.12 : 1.0; }), TF_SETTINGS);
    assert.closeTo(events[0].leanSpike, 12, 0.1);
  });

  it('counts going rich after the lean peak as overshoot', function () {
    var events = detectTransientEvents(tfLog(function (t) {
      return t < 2 ? 1 : t < 2.2 ? 1.08 : t < 2.6 ? 0.92 : 1.0;
    }), TF_SETTINGS);
    assert.closeTo(events[0].leanSpike, 8, 0.1);
    assert.closeTo(events[0].richOvershoot, 8, 0.1);
    // Recovery runs from the event start (when MAP began to change) to lambda settling at 2.6 s.
    var expected = (2.6 - events[0].time) * 1000;
    assert.ok(Math.abs(events[0].recoveryTime - expected) <= 20, events[0].recoveryTime + ' vs ' + expected);
  });

  it('skips events overlapping overrun, a fuel cut or fuel-cut lambda', function () {
    var overrun = detectTransientEvents(tfLog(null, function (t) { return { overrunState: t > 1.2 && t < 1.5 ? 1 : 0 }; }), TF_SETTINGS);
    assert.equal(overrun.length, 0);
    assert.equal(overrun.skippedFuelCut, 1);
    var counter = detectTransientEvents(tfLog(null, function (t) { return { fuelCutCount: t < 1.5 ? 255 : 0 }; }), TF_SETTINGS);
    assert.equal(counter.length, 0, 'a wrapping counter is a cut too');
    var lean = detectTransientEvents(tfLog(function (t) { return t > 2.2 && t < 2.4 ? 8 : 1; }), TF_SETTINGS);
    assert.equal(lean.length, 0);
    var clean = detectTransientEvents(tfLog(null, function (t) { return { overrunState: t < 0.5 ? 1 : 0 }; }), TF_SETTINGS);
    assert.equal(clean.length, 1, 'a cut long before the event does not matter');
  });
});

describe('Transient Fuel — recommendations', function () {
  function tipIn(lean, rich, mapTo, recovery, richBefore, mapPeak) {
    return { type: 'tip-in', leanSpike: lean, richOvershoot: rich, leanAfter: 0, mapTo: mapTo || 90, recoveryTime: recovery || 300,
             richBefore: richBefore || 0, mapPeak: mapPeak || mapTo || 90 };
  }
  function tipOut(rich, leanAfter) {
    return { type: 'tip-out', leanSpike: 0, richOvershoot: rich, leanAfter: leanAfter || 0, mapTo: 30, recoveryTime: 300 };
  }
  var TC = { currentTimeConstants: { fastPct: 30, fastIncrease: 0.1, fastDecrease: 0.15, slowIncrease: 0.25, slowDecrease: 0.1 } };
  function texts(recs) { return recs.map(function (r) { return r.text; }).join('\n'); }

  it('blames lean-only tip-ins on the table, and changes no time constants', function () {
    var t = texts(generateRecommendations([tipIn(8, 0), tipIn(9, 1), tipIn(7, 0), tipIn(8, 0)], TC));
    assert.ok(/Fuel Film Primary too low at 80-100 kPa/.test(t));
    assert.ok(!/Suggested time constants/.test(t));
  });

  it('reports rich-then-lean tip-ins and keeps them out of the "too low" advice', function () {
    var events = [tipIn(8, 0, 90, 300, 9), tipIn(7, 0, 90, 300, 9), tipIn(8, 1, 90, 300, 7), tipIn(9, 0, 90, 300, 8, 105), tipIn(1, 1)];
    var t = texts(generateRecommendations(events, TC));
    assert.ok(/RICH, THEN LEAN on 4 of 5 tip-ins/.test(t), t);
    assert.ok(/In 1 of them MAP overshoots its final value by 15 kPa/.test(t), t);
    assert.ok(!/Fuel Film Primary too low/.test(t));
    assert.ok(/Fast Increase: 0.1s → 0.13s/.test(t) && /Fast Percentage: 30% → 20%/.test(t), 'up-front compensation too strong');
  });

  it('flags rich-only tip-ins as too much film', function () {
    assert.ok(/Fuel Film Primary too high at 80-100 kPa/.test(texts(generateRecommendations([tipIn(0, 8), tipIn(1, 7)], TC))));
  });

  it('treats lean-then-rich as timing and only shortens the Increase constants', function () {
    var t = texts(generateRecommendations([tipIn(6, 6), tipIn(5, 5), tipIn(6, 7), tipIn(5, 6)], TC));
    assert.ok(/TIMING MISMATCH/.test(t));
    assert.ok(/Fast Increase: 0.1s → 0.07s/.test(t) && /Slow Increase: 0.25s → 0.1[78]s/.test(t) && /Fast Percentage: 30% → 40%/.test(t), t);
    assert.ok(!/Decrease: /.test(t), 'Decrease constants do not act on tip-in');
  });

  it('points tip-out problems at the Decrease constants', function () {
    var ins = [tipIn(1, 1), tipIn(1, 1), tipIn(1, 1), tipIn(1, 1)];
    var rich = texts(generateRecommendations(ins.concat([tipOut(8), tipOut(9)]), TC));
    assert.ok(/Rich on tip-out/.test(rich) && /Slow Decrease: 0.1s → 0.07s/.test(rich));
    var lean = texts(generateRecommendations(ins.concat([tipOut(0, 8), tipOut(0, 9)]), TC));
    assert.ok(/Lean after tip-out/.test(lean) && /Slow Decrease: 0.1s → 0.13s/.test(lean));
  });

  it('reports a good calibration when nothing stands out', function () {
    assert.equal(generateRecommendations([tipIn(1, 1), tipIn(2, 1)], TC)[0].severity, 'good');
  });
});

describe('Transient Fuel — table corrections', function () {
  var table = { breakpoints: [30, 60, 90], values: [20, 100, 160] };
  function run(scale, offset, events) {
    return computeFuelFilmCorrections({ ffTable: table, tipIns: events }, { ffScale: scale, ffOffset: offset });
  }

  it('converts the film change back to table units using the scale', function () {
    // Effective film at 90 kPa = 160 × 26% + 30 = 71.6 ul; a 10% lean spike asks for +7.16 ul effective,
    // which is +27.5 table units at 26% scale (applied at 75%).
    var r = run(26, 30, [{ mapTo: 90, leanSpike: 10 }]);
    assert.closeTo(r.corrections[2], 7.16 / 0.26, 0.1);
    assert.closeTo(r.corrected[2], 160 + (7.16 / 0.26) * 0.75, 0.1);
    assert.equal(r.corrected[0], 20, 'cells without events are unchanged');
  });

  it('matches the old behaviour at 100% scale and caps one step at +50%', function () {
    var r = run(100, 0, [{ mapTo: 30, leanSpike: 25 }]);
    assert.closeTo(r.corrections[0], 5, 1e-9, 'a 20 ul film is raised 25%');
    // At 1% scale the 160-unit cell is only 1.6 ul of film: the step it asks for exceeds +50%.
    var capped = run(1, 0, [{ mapTo: 90, leanSpike: 25 }]);
    assert.equal(capped.corrected[2], 240, '+50% cap');
  });

  it('leaves out lean spikes that follow a rich dip', function () {
    assert.deepEqual(run(26, 30, [{ mapTo: 90, leanSpike: 10, richBefore: 8 }]).corrected, [20, 100, 160]);
  });

  it('ignores small spikes', function () {
    assert.deepEqual(run(26, 30, [{ mapTo: 60, leanSpike: 2 }]).corrected, [20, 100, 160]);
  });
});
