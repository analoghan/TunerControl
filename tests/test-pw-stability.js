/**
 * Unit tests for analyzePWStability function in injector/worker.js
 */

describe('analyzePWStability', function () {

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
            cl_trim_b1: -1,
            cl_trim_b2: -1,
            fuel_mix_aim: -1,
            warnings: []
        };
    }

    it('returns null when inj_pw channel is not available', function () {
        var channels = makeChannels({ rpm: 0, inj_pw: -1 });
        var data = [[2000, 1.0]];
        var result = analyzePWStability(data, channels);
        assert.equal(result, null);
    });

    it('returns null when no valid PW values above 0.05', function () {
        // Columns: [rpm, inj_pw]
        var channels = makeChannels({ rpm: 0, inj_pw: 1 });
        var data = [
            [2000, 0.01],
            [2000, 0.05],  // not > 0.05
            [2000, 0.03],
        ];
        var result = analyzePWStability(data, channels);
        assert.equal(result, null);
    });

    it('filters out PW values <= 0.05 (off events)', function () {
        // Columns: [rpm, inj_pw]
        var channels = makeChannels({ rpm: 0, inj_pw: 1 });
        var data = [
            [2000, 0.01],   // excluded (off event)
            [2000, 0.05],   // excluded (not > 0.05)
            [2000, 1.0],    // included
            [2000, 1.5],    // included
            [2000, 2.0],    // included
        ];
        var result = analyzePWStability(data, channels);
        // Only 3 valid values: 1.0, 1.5, 2.0
        assert.equal(result.min, 1.0);
        assert.equal(result.max, 2.0);
        assert.closeTo(result.mean, 1.5, 0.001);
        assert.equal(result.median, 1.5);
    });

    it('computes correct statistics for known data', function () {
        // Columns: [inj_pw]
        var channels = makeChannels({ rpm: -1, inj_pw: 0 });
        var data = [
            [0.5],
            [0.6],
            [0.7],
            [0.8],
            [0.9],
            [1.0],
            [1.1],
            [1.2],
            [1.3],
            [1.4],
        ];
        var result = analyzePWStability(data, channels);
        assert.equal(result.min, 0.5);
        assert.equal(result.max, 1.4);
        assert.closeTo(result.mean, 0.95, 0.001);
        assert.closeTo(result.median, 0.95, 0.001);  // average of 0.9 and 1.0
        // stdDev for [0.5..1.4] step 0.1
        assert.closeTo(result.stdDev, 0.2872, 0.001);
    });

    it('computes 5th and 1st percentiles correctly', function () {
        // Columns: [inj_pw] - 100 values from 0.1 to 10.0
        var channels = makeChannels({ rpm: -1, inj_pw: 0 });
        var data = [];
        for (var i = 1; i <= 100; i++) {
            data.push([i * 0.1]);
        }
        var result = analyzePWStability(data, channels);
        // 5th percentile: position = 0.05 * 99 = 4.95
        // value at index 4 = 0.5, index 5 = 0.6
        // interpolated: 0.5 + 0.95 * (0.6 - 0.5) = 0.595
        assert.closeTo(result.pct5th, 0.595, 0.001);
        // 1st percentile: position = 0.01 * 99 = 0.99
        // value at index 0 = 0.1, index 1 = 0.2
        // interpolated: 0.1 + 0.99 * (0.2 - 0.1) = 0.199
        assert.closeTo(result.pct1st, 0.199, 0.001);
    });

    it('counts values below 0.8 ms threshold', function () {
        // Columns: [inj_pw]
        var channels = makeChannels({ rpm: -1, inj_pw: 0 });
        var data = [
            [0.5],   // below
            [0.6],   // below
            [0.7],   // below
            [0.79],  // below
            [0.8],   // NOT below (not strictly less than)
            [1.0],
            [1.5],
        ];
        var result = analyzePWStability(data, channels);
        assert.equal(result.belowThresholdCount, 4);
        assert.closeTo(result.belowThresholdPct, (4 / 7) * 100, 0.01);
    });

    it('generates SEVERE diagnostic when pct5th < 0.7', function () {
        // Columns: [inj_pw] - all values around 0.5-0.6 ms
        var channels = makeChannels({ rpm: -1, inj_pw: 0 });
        var data = [];
        for (var i = 0; i < 100; i++) {
            data.push([0.5 + Math.random() * 0.1]);  // 0.5 to 0.6
        }
        // Force known values for deterministic test
        data = [
            [0.5], [0.5], [0.5], [0.5], [0.5],
            [0.6], [0.6], [0.6], [0.6], [0.6],
        ];
        var result = analyzePWStability(data, channels);
        // 5th percentile of [0.5,0.5,0.5,0.5,0.5,0.6,0.6,0.6,0.6,0.6]
        // sorted: same. pos = 0.05 * 9 = 0.45, index 0 = 0.5, index 1 = 0.5 → 0.5
        assert.ok(result.pct5th < 0.7);
        assert.ok(result.diagnostics[0].indexOf('SEVERE') !== -1);
        assert.ok(result.diagnostics[0].indexOf('well below') !== -1);
    });

    it('generates WARNING diagnostic when pct5th is between 0.7 and 0.8', function () {
        // Columns: [inj_pw] - values that give 5th percentile around 0.75
        var channels = makeChannels({ rpm: -1, inj_pw: 0 });
        var data = [
            [0.75], [0.75], [0.75], [0.75], [0.75],
            [1.0], [1.0], [1.0], [1.0], [1.0],
            [1.5], [1.5], [1.5], [1.5], [1.5],
            [2.0], [2.0], [2.0], [2.0], [2.0],
        ];
        var result = analyzePWStability(data, channels);
        // 5th percentile: pos = 0.05 * 19 = 0.95, index 0 = 0.75, index 1 = 0.75 → 0.75
        assert.ok(result.pct5th >= 0.7 && result.pct5th < 0.8);
        assert.ok(result.diagnostics[0].indexOf('WARNING') !== -1);
        assert.ok(result.diagnostics[0].indexOf('approaches') !== -1);
    });

    it('generates HEALTHY diagnostic when pct5th >= 0.8', function () {
        // Columns: [inj_pw] - all values above 0.8
        var channels = makeChannels({ rpm: -1, inj_pw: 0 });
        var data = [
            [0.9], [1.0], [1.1], [1.2], [1.3],
            [1.4], [1.5], [1.6], [1.7], [1.8],
        ];
        var result = analyzePWStability(data, channels);
        assert.ok(result.pct5th >= 0.8);
        assert.ok(result.diagnostics[0].indexOf('HEALTHY') !== -1);
        assert.ok(result.diagnostics[0].indexOf('above') !== -1);
    });

    it('includes channelUsed field in result', function () {
        var channels = makeChannels({ rpm: -1, inj_pw: 0 });
        var data = [[1.0], [1.5], [2.0]];
        var result = analyzePWStability(data, channels);
        assert.equal(result.channelUsed, 'inj_pw');
    });

    it('excludes NaN values from analysis', function () {
        var channels = makeChannels({ rpm: -1, inj_pw: 0 });
        var data = [
            [NaN],
            [1.0],
            [NaN],
            [2.0],
            [3.0],
        ];
        var result = analyzePWStability(data, channels);
        // Only 3 valid values: 1.0, 2.0, 3.0
        assert.equal(result.min, 1.0);
        assert.equal(result.max, 3.0);
        assert.closeTo(result.mean, 2.0, 0.001);
    });
});

describe('countBelow', function () {
    it('counts elements strictly below threshold in sorted array', function () {
        var sorted = [0.3, 0.5, 0.7, 0.8, 0.9, 1.0, 1.5];
        assert.equal(countBelow(sorted, 0.8), 3);
    });

    it('returns 0 when no elements are below threshold', function () {
        var sorted = [1.0, 1.5, 2.0];
        assert.equal(countBelow(sorted, 0.5), 0);
    });

    it('returns full length when all elements are below threshold', function () {
        var sorted = [0.1, 0.2, 0.3];
        assert.equal(countBelow(sorted, 1.0), 3);
    });

    it('handles empty array', function () {
        assert.equal(countBelow([], 1.0), 0);
    });

    it('does not count elements equal to threshold', function () {
        var sorted = [0.5, 0.8, 0.8, 1.0];
        assert.equal(countBelow(sorted, 0.8), 1);
    });
});
