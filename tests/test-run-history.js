/**
 * test-run-history.js — Tuning history: the summaries each tool stores (history/run-builders.js) and the store helpers
 * (history/run-store.js). The server side is in run-server-tests.js.
 */

describe('Tuning history — run summaries', function () {
  it('VE: mean correction, cells over 2 % and the grid', function () {
    var msg = { totalSamples: 1000, cellsAboveThreshold: 3, filteredByTime: 5,
      correctionGrid: { mapBreakpoints: [100, 50], rpmBreakpoints: [2000, 3000],
        cells: [[{ count: 60, correction: 4.123, lambdaError: 3, clTrimAvg: 1 }, { count: 10, correction: null }],
                [{ count: 80, correction: -1, lambdaError: -1, clTrimAvg: 0 }, { count: 70, correction: -2.5 }]] } };
    var r = rbVe(msg);
    assert.equal(r.summary.cells, 3);
    assert.closeTo(r.summary.meanAbsCorrection, (4.123 + 1 + 2.5) / 3, 0.01);
    assert.equal(r.summary.cellsOver2, 2);
    assert.equal(r.summary.worstCorrection, 4.12);
    assert.equal(r.data.cells[0][0].c, 4.12);
    assert.equal(r.data.cells[0][1].c, null);
    assert.equal(r.data.cells[1][1].n, 70);
    assert.deepEqual(r.data.rpmBreakpoints, [2000, 3000]);
  });

  it('Transient: averages and tip-ins by destination MAP', function () {
    var r = rbTransient({ tipInCount: 2, tipOutCount: 1, skippedFuelCut: 4, avgLeanSpike: 3.33, avgRichOvershoot: 1, richFirstTipIns: 1,
      avgRecoveryTime: 512.4, unsettledTipIns: 0, recommendations: [{ severity: 'info', text: 'x' }],
      tipIns: [{ mapTo: 85, leanSpike: 4, richOvershoot: 1, richBefore: 6 }, { mapTo: 95, leanSpike: 2, richOvershoot: 1, richBefore: 0 }] });
    assert.equal(r.summary.avgLean, 3.3);
    assert.equal(r.summary.avgRecovery, 512);
    assert.deepEqual(r.data.zones, [{ from: 80, to: 100, n: 2, lean: 3, rich: 1, richFirst: 3 }]);
    assert.equal(r.data.recommendations[0].text, 'x');
  });

  it('Knock: events, sensor check and typical level per cylinder', function () {
    var r = rbKnock({ totalEvents: 3, thresholdLabel: 'tune', cylinderDistribution: { counts: [3, 0, 0, 0, 0, 0, 0, 0], total: 3 },
      sensorHealth: { perCylinder: [{ cylinderIndex: 1, median: 0.912, p99: 3, input: 'Knock Input 1' }, { cylinderIndex: 2, median: 0.1, p99: 0.2, input: 'Knock Input 2' }],
                      weak: [{ label: 'Knock Input 2' }] },
      timingRecommendations: [{ cylinderIndex: 1, events: 3, maxRatio: 1.4, reductionDeg: 1 }], retardStats: { source: 'knockTrim', maxRetard: 2.26 } });
    assert.equal(r.summary.events, 3);
    assert.deepEqual(r.summary.weak, ['Knock Input 2']);
    assert.equal(r.summary.maxRetard, 2.3);
    assert.deepEqual(r.data.health[0], { cyl: 1, median: 0.91, p99: 3, input: 'Knock Input 1' });
    assert.deepEqual(r.data.recommendations[0], { cyl: 1, events: 3, maxRatio: 1.4, reductionDeg: 1 });
  });

  it('DI fuel pressure: tracking, response to a rising aim and the aim table', function () {
    var a = { pctWithinTolerance: 91.84, pctOvershoot: 5, pctUndershoot: 3, maxOvershoot: 64.7, maxUndershoot: -37.2, transientEvents: [1, 2],
      pump: { maxControl: 50.3 },
      railControl: { gains: { p: 0.4, i: 1.8 }, classes: { riseOver: { label: 'o', seconds: 13.3, episodes: 31, share: 37 }, riseLag: { label: 'l', seconds: 1, episodes: 3, share: 9 },
                                                          bleed: { label: 'b', seconds: 21, episodes: 29, share: 1.2 } },
                     advice: [{ severity: 'warning', text: 'w' }], cells: [[null]] } };
    var r = rbFuelPressure(a, { aim: { rpm: [1000], volume: [0], values: [[20]] } });
    assert.equal(r.summary.pctWithin, 91.8);
    assert.equal(r.summary.riseOverShare, 37);
    assert.equal(r.summary.bleedSeconds, 21);
    assert.equal(r.summary.pGain, 0.4);
    assert.equal(r.data.classes.length, 3);
    assert.deepEqual(r.data.aim.values, [[20]]);
    assert.equal(rbFuelPressure({ transientEvents: [] }).summary.riseOverShare, null, 'no tune: no rail control');
  });

  it('list entries leave out the detail; runs sort by log time', function () {
    var run = { id: 'a', tool: 've', summary: { x: 1 }, settings: { y: 2 }, data: { z: 3 } };
    assert.deepEqual(rsSummaryOnly(run), { id: 'a', tool: 've', summary: { x: 1 } });
    assert.equal(rsSortKey({ logTime: '2026-06-11T17:32:21Z', created: '2026-10-16' }), '2026-06-11T17:32:21Z');
    assert.equal(rsSortKey({ logTime: null, created: '2026-10-16' }), '2026-10-16');
  });
});
