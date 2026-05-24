/**
 * Unit tests for analyzeClosedLoop function in injector/worker.js
 */

describe('analyzeClosedLoop', function () {

    // Helper to build a channels object with specified indices
    function makeChannels(opts) {
        return {
            time: opts.time !== undefined ? opts.time : -1,
            rpm: opts.rpm !== undefined ? opts.rpm : 0,
            map: opts.map !== undefined ? opts.map : -1,
            lambda_b1: opts.lambda_b1 !== undefined ? opts.lambda_b1 : -1,
            lambda_b2: opts.lambda_b2 !== undefined ? opts.lambda_b2 : -1,
            lambda_avg: opts.lambda_avg !== undefined ? opts.lambda_avg : -1,
            inj_pw: opts.inj_pw !== undefined ? opts.inj_pw : -1,
            inj_timing: opts.inj_timing !== undefined ? opts.inj_timing : -1,
            tps: opts.tps !== undefined ? opts.tps : -1,
            fuel_press_di: opts.fuel_press_di !== undefined ? opts.fuel_press_di : -1,
            fuel_press_di_aim: opts.fuel_press_di_aim !== undefined ? opts.fuel_press_di_aim : -1,
            coolant_temp: -1,
            iat: -1,
            cl_trim_b1: opts.cl_trim_b1 !== undefined ? opts.cl_trim_b1 : -1,
            cl_trim_b2: opts.cl_trim_b2 !== undefined ? opts.cl_trim_b2 : -1,
            fuel_mix_aim: -1,
            warnings: []
        };
    }

    it('returns both banks null and empty diagnostics when both channels missing', function () {
        var channels = makeChannels({ rpm: 0, cl_trim_b1: -1, cl_trim_b2: -1 });
        var data = [[2000], [3000]];
        var result = analyzeClosedLoop(data, channels);
        assert.equal(result.bank1, null);
        assert.equal(result.bank2, null);
        assert.deepEqual(result.diagnostics, []);
    });

    it('computes mean, std, min, max for Bank 1', function () {
        // Columns: [rpm, cl_trim_b1]
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1 });
        var data = [
            [2000, 2.0],
            [2000, 4.0],
            [2000, 6.0],
            [2000, 8.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        assert.closeTo(result.bank1.mean, 5.0, 0.001);
        assert.closeTo(result.bank1.min, 2.0, 0.001);
        assert.closeTo(result.bank1.max, 8.0, 0.001);
        // std = sqrt(((2-5)^2 + (4-5)^2 + (6-5)^2 + (8-5)^2) / 4) = sqrt((9+1+1+9)/4) = sqrt(5) ≈ 2.236
        assert.closeTo(result.bank1.std, Math.sqrt(5), 0.001);
    });

    it('computes mean, std, min, max for Bank 2', function () {
        // Columns: [rpm, cl_trim_b2]
        var channels = makeChannels({ rpm: 0, cl_trim_b2: 1 });
        var data = [
            [2000, -3.0],
            [2000, -1.0],
            [2000, 1.0],
            [2000, 3.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        assert.equal(result.bank1, null);
        assert.closeTo(result.bank2.mean, 0.0, 0.001);
        assert.closeTo(result.bank2.min, -3.0, 0.001);
        assert.closeTo(result.bank2.max, 3.0, 0.001);
        // std = sqrt(((−3)^2 + (−1)^2 + 1^2 + 3^2) / 4) = sqrt((9+1+1+9)/4) = sqrt(5) ≈ 2.236
        assert.closeTo(result.bank2.std, Math.sqrt(5), 0.001);
    });

    it('generates rich diagnostic when mean < -5%', function () {
        // Columns: [rpm, cl_trim_b1]
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1 });
        var data = [
            [2000, -6.0],
            [2000, -6.0],
            [2000, -6.0],
            [2000, -6.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        assert.ok(result.diagnostics.length > 0);
        assert.ok(result.diagnostics[0].indexOf('rich') !== -1);
        assert.ok(result.diagnostics[0].indexOf('Bank 1') !== -1);
    });

    it('generates lean diagnostic when mean > 5%', function () {
        // Columns: [rpm, cl_trim_b1]
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1 });
        var data = [
            [2000, 7.0],
            [2000, 7.0],
            [2000, 7.0],
            [2000, 7.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        assert.ok(result.diagnostics.length > 0);
        assert.ok(result.diagnostics[0].indexOf('lean') !== -1);
        assert.ok(result.diagnostics[0].indexOf('Bank 1') !== -1);
    });

    it('does not generate rich/lean diagnostic when |mean| <= 5%', function () {
        // Columns: [rpm, cl_trim_b1]
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1 });
        var data = [
            [2000, 5.0],
            [2000, 5.0],
            [2000, 5.0],
            [2000, 5.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        // mean is exactly 5.0, which is NOT > 5, so no diagnostic
        var richLeanDiags = result.diagnostics.filter(function (d) {
            return d.indexOf('rich') !== -1 || d.indexOf('lean') !== -1;
        });
        assert.equal(richLeanDiags.length, 0);
    });

    it('generates inconsistent fueling diagnostic when std > 4%', function () {
        // Columns: [rpm, cl_trim_b1]
        // Need values with std > 4. Use values: -10, 10, -10, 10 → mean=0, std=10
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1 });
        var data = [
            [2000, -10.0],
            [2000, 10.0],
            [2000, -10.0],
            [2000, 10.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        var inconsistentDiags = result.diagnostics.filter(function (d) {
            return d.indexOf('inconsistent fueling') !== -1;
        });
        assert.equal(inconsistentDiags.length, 1);
        assert.ok(inconsistentDiags[0].indexOf('Bank 1') !== -1);
    });

    it('does not generate inconsistent fueling diagnostic when std <= 4%', function () {
        // Columns: [rpm, cl_trim_b1]
        // Values: 1, 2, 3, 2 → mean=2, std=sqrt(((1-2)^2+(2-2)^2+(3-2)^2+(2-2)^2)/4) = sqrt(2/4) = sqrt(0.5) ≈ 0.707
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1 });
        var data = [
            [2000, 1.0],
            [2000, 2.0],
            [2000, 3.0],
            [2000, 2.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        var inconsistentDiags = result.diagnostics.filter(function (d) {
            return d.indexOf('inconsistent fueling') !== -1;
        });
        assert.equal(inconsistentDiags.length, 0);
    });

    it('handles both banks with diagnostics for each', function () {
        // Columns: [rpm, cl_trim_b1, cl_trim_b2]
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1, cl_trim_b2: 2 });
        var data = [
            [2000, 7.0, -8.0],
            [2000, 7.0, -8.0],
            [2000, 7.0, -8.0],
            [2000, 7.0, -8.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        assert.ok(result.bank1 !== null);
        assert.ok(result.bank2 !== null);
        assert.closeTo(result.bank1.mean, 7.0, 0.001);
        assert.closeTo(result.bank2.mean, -8.0, 0.001);
        // Should have diagnostics for both banks
        var b1Diag = result.diagnostics.filter(function (d) { return d.indexOf('Bank 1') !== -1; });
        var b2Diag = result.diagnostics.filter(function (d) { return d.indexOf('Bank 2') !== -1; });
        assert.ok(b1Diag.length > 0);
        assert.ok(b2Diag.length > 0);
        // Bank 1 is lean (mean > 5), Bank 2 is rich (mean < -5)
        assert.ok(b1Diag[0].indexOf('lean') !== -1);
        assert.ok(b2Diag[0].indexOf('rich') !== -1);
    });

    it('skips NaN values in trim data', function () {
        // Columns: [rpm, cl_trim_b1]
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1 });
        var data = [
            [2000, 2.0],
            [2000, NaN],
            [2000, 4.0],
            [2000, NaN],
            [2000, 6.0],
        ];
        var result = analyzeClosedLoop(data, channels);
        // Only 3 valid values: 2, 4, 6 → mean=4, min=2, max=6
        assert.closeTo(result.bank1.mean, 4.0, 0.001);
        assert.closeTo(result.bank1.min, 2.0, 0.001);
        assert.closeTo(result.bank1.max, 6.0, 0.001);
    });

    it('returns bank as null when all values are NaN', function () {
        // Columns: [rpm, cl_trim_b1]
        var channels = makeChannels({ rpm: 0, cl_trim_b1: 1 });
        var data = [
            [2000, NaN],
            [2000, NaN],
        ];
        var result = analyzeClosedLoop(data, channels);
        assert.equal(result.bank1, null);
    });
});
