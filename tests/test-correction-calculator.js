/**
 * test-correction-calculator.js — Tests for the VE correction maths in ve-table/worker.js:
 * computeSampleCorrection, axisWeights and the analyzeVE pipeline.
 */

describe('VE correction — computeSampleCorrection', function () {
  function sample(o) {
    return Object.assign({ lambdaB1: NaN, lambdaB2: NaN, lambdaAvg: NaN, lambdaTarget: 1.0, clTrimB1: NaN, clTrimB2: NaN }, o);
  }

  it('asks for more fuel when the engine runs lean', function () {
    var r = computeSampleCorrection(sample({ lambdaB1: 1.10, lambdaTarget: 1.00 }));
    assert.closeTo(r.correction, 10, 1e-9);
    assert.closeTo(r.lambdaError, 10, 1e-9);
  });

  it('asks for less fuel when the engine runs rich', function () {
    var r = computeSampleCorrection(sample({ lambdaB1: 0.85, lambdaTarget: 0.865 }));
    assert.ok(r.correction < 0);
    assert.closeTo(r.correction, (0.85 / 0.865 - 1) * 100, 1e-9);
  });

  it('adds the closed-loop trim already applied (positive trim = fuel added)', function () {
    // Trim -8% was pulling fuel and the mixture is still 1.7% rich: the table needs both.
    var r = computeSampleCorrection(sample({ lambdaB1: 0.85, lambdaB2: 0.85, lambdaTarget: 0.865, clTrimB1: -8, clTrimB2: -8 }));
    assert.closeTo(r.correction, (0.92 * 0.85 / 0.865 - 1) * 100, 1e-9);
    assert.ok(r.correction < -9.5 && r.correction > -9.7);
    // On target with trim: the trim is the whole correction.
    assert.closeTo(computeSampleCorrection(sample({ lambdaB1: 1, lambdaTarget: 1, clTrimB1: 5 })).correction, 5, 1e-9);
  });

  it('averages the banks and falls back to overall lambda', function () {
    assert.closeTo(computeSampleCorrection(sample({ lambdaB1: 1.0, lambdaB2: 1.2 })).lambdaActual, 1.1, 1e-12);
    assert.equal(computeSampleCorrection(sample({ lambdaB2: 0.95 })).lambdaActual, 0.95);
    assert.equal(computeSampleCorrection(sample({ lambdaAvg: 0.97 })).lambdaActual, 0.97);
  });

  it('is invalid without a measured lambda or a target', function () {
    assert.equal(computeSampleCorrection(sample({})).isValid, false);
    assert.equal(computeSampleCorrection(sample({ lambdaB1: 1, lambdaTarget: NaN })).isValid, false);
  });
});

describe('VE correction — axisWeights', function () {
  var axis = makeAxis([280, 100, 50, 20]);   // M1 exports MAP highest first

  it('shares a sample between the two surrounding breakpoints', function () {
    var w = axisWeights(75, axis);
    assert.deepEqual(w.map(function (x) { return x[0]; }), [2, 1]);
    assert.closeTo(w[0][1], 0.5, 1e-12);
    assert.closeTo(w[1][1], 0.5, 1e-12);
    assert.closeTo(axisWeights(60, axis)[0][1], 0.8, 1e-12);
  });

  it('gives a breakpoint or an end of the axis the whole sample', function () {
    assert.deepEqual(axisWeights(100, axis), [[1, 1]]);
    assert.deepEqual(axisWeights(10, axis), [[3, 1]]);
    assert.deepEqual(axisWeights(400, axis), [[0, 1]]);
    assert.equal(axisWeights(NaN, axis), null);
  });
});

describe('VE correction — analyzeVE pipeline', function () {
  // 2 × 2 table: MAP 100/50 kPa (highest first, as M1 exports), RPM 2000/3000. 100 Hz samples from t = 70 s.
  var ve = { mapBreakpoints: [100, 50], rpmBreakpoints: [2000, 3000], values: [[80, 85], [60, 65]] };
  function log(n, f, t0) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(Object.assign({ time: (t0 || 70) + i * 0.01, rpm: 2000, map: 100, lambdaB1: 1.05, lambdaB2: 1.05, lambdaAvg: NaN,
        lambdaTarget: 1.0, clTrimB1: 0, clTrimB2: 0, coolantTemp: 90, throttlePos: 30, overrunState: 0, fuelCutCount: 0 }, f ? f(i) : {}));
    }
    return out;
  }
  function cell(res, m, r) { return res.correctionGrid.cells[m][r]; }

  it('turns a steady lean condition into a positive VE correction', function () {
    var res = analyzeVE(log(200), ve, { hitThreshold: 50 });
    assert.closeTo(cell(res, 0, 0).correction, 5, 1e-9);
    assert.closeTo(res.newValuesGrid[0][0], 84, 1e-9);
    assert.equal(cell(res, 1, 1).correction, null);
  });

  it('skips overrun / fuel cut and about a second after it', function () {
    var res = analyzeVE(log(400, function (i) {
      return i < 100 ? { overrunState: 1, lambdaB1: 9, lambdaB2: 9 } : i < 200 ? { lambdaB1: 2.5, lambdaB2: 2.5 } : {};
    }), ve, { hitThreshold: 50 });
    assert.ok(res.filteredByFuelCut >= 199 && res.filteredByFuelCut <= 201, String(res.filteredByFuelCut));
    assert.closeTo(cell(res, 0, 0).correction, 5, 1e-9);
    var counted = analyzeVE(log(400, function (i) { return { fuelCutCount: i < 150 ? 3 : 4 }; }), ve, {});
    assert.ok(counted.filteredByFuelCut >= 99 && counted.filteredByFuelCut <= 101, 'a changing cut count starts the hold-off');
  });

  it('ignores implausible lambda readings', function () {
    var res = analyzeVE(log(200, function (i) { return i % 10 === 0 ? { lambdaB1: 3, lambdaB2: 3 } : {}; }), ve,
      { hitThreshold: 50, steadyWindowMs: 0 });
    assert.equal(res.filteredByLambda, 20);
    assert.closeTo(cell(res, 0, 0).correction, 5, 1e-9);
  });

  it('uses only steady-state samples, unless disabled', function () {
    var ramp = analyzeVE(log(300, function (i) { return { map: 50 + i * 0.25 }; }), ve, { hitThreshold: 1 });   // 25 kPa/s
    assert.ok(ramp.filteredBySteady >= 30 && ramp.filteredBySteady <= 31, 'only the first 0.3 s, which has no history yet');
    var choppy = function (i) { return { map: 50 + (i % 20) * 3 }; };
    assert.ok(analyzeVE(log(300, choppy), ve, { hitThreshold: 1 }).filteredBySteady > 250);
    assert.equal(analyzeVE(log(300, choppy), ve, { hitThreshold: 1, steadyWindowMs: 0 }).filteredBySteady, 0);
  });

  it('shares samples between neighbouring cells by interpolation', function () {
    var res = analyzeVE(log(200, function () { return { map: 75, rpm: 2500 }; }), ve, { hitThreshold: 40, steadyWindowMs: 0 });
    [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(function (mr) {
      assert.equal(cell(res, mr[0], mr[1]).count, 50, 'a quarter of 200 samples');
    });
    assert.equal(res.totalSamples, 200);
  });

  it('pairs samples with the lambda reading after the delay', function () {
    // Lambda reads 1.10 only from 0.2 s onwards: with a 0.2 s delay the first samples see it too.
    var data = log(100, function (i) { return i >= 20 ? { lambdaB1: 1.1, lambdaB2: 1.1 } : { lambdaB1: 1.0, lambdaB2: 1.0 }; });
    var none = analyzeVE(data, ve, { hitThreshold: 1, steadyWindowMs: 0 });
    var delayed = analyzeVE(data, ve, { hitThreshold: 1, steadyWindowMs: 0, lambdaDelayMs: 200 });
    assert.ok(delayed.correctionGrid.cells[0][0].correction > none.correctionGrid.cells[0][0].correction);
  });

  it('smooths before applying the minimum change', function () {
    // Cells: (100 kPa, 2000) = +5%, (50 kPa, 2000) = +0.4%. With the old order the 0.4% was zeroed first and
    // pulled its neighbour down; now smoothing sees the real 0.4%.
    var data = log(200, null, 70).concat(log(200, function () { return { map: 50, lambdaB1: 1.004, lambdaB2: 1.004 }; }, 80));
    var res = analyzeVE(data, ve, { hitThreshold: 50, smoothing: 2, minChangeAmount: 1, steadyWindowMs: 0 });
    var w = Math.exp(-1 / 8);
    assert.closeTo(cell(res, 0, 0).correction, (5 + 0.4 * w) / (1 + w), 1e-6);
    assert.closeTo(cell(res, 1, 0).correction, (0.4 + 5 * w) / (1 + w), 1e-6);
  });
});
