/**
 * Unit tests for analyzeInjectionTiming function in injector/worker.js
 */

describe('analyzeInjectionTiming', function () {

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

    it('returns null when inj_timing channel is not available', function () {
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: -1 });
        var data = [[2000, 1.0]];
        var result = analyzeInjectionTiming(data, channels);
        assert.equal(result, null);
    });

    it('computes min, max, mean timing statistics', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [
            [2000, 1.0, 200],
            [2000, 1.0, 300],
            [2000, 1.0, 250],
            [2000, 1.0, 350],
            [2000, 1.0, 150],
        ];
        var result = analyzeInjectionTiming(data, channels);
        assert.equal(result.min, 150);
        assert.equal(result.max, 350);
        assert.closeTo(result.mean, 250, 0.01);
    });

    it('counts samples in optimal window (240-320 dBTDC)', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [
            [2000, 1.0, 240],  // in optimal (inclusive)
            [2000, 1.0, 280],  // in optimal
            [2000, 1.0, 320],  // in optimal (inclusive)
            [2000, 1.0, 239],  // below optimal
            [2000, 1.0, 321],  // above optimal
        ];
        var result = analyzeInjectionTiming(data, channels);
        assert.equal(result.inOptimalCount, 3);
        assert.closeTo(result.inOptimalPct, 60.0, 0.01);
    });

    it('counts samples in compression stroke zone (< 180 dBTDC)', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [
            [2000, 1.0, 100],  // in compression
            [2000, 1.0, 179],  // in compression
            [2000, 1.0, 180],  // NOT in compression (boundary)
            [2000, 1.0, 250],  // not in compression
        ];
        var result = analyzeInjectionTiming(data, channels);
        assert.equal(result.inCompressionCount, 2);
        assert.closeTo(result.inCompressionPct, 50.0, 0.01);
    });

    it('generates compression stroke diagnostic when >5% in compression', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        // 2 out of 10 = 20% in compression
        var data = [
            [2000, 1.0, 100],
            [2000, 1.0, 150],
            [2000, 1.0, 250],
            [2000, 1.0, 260],
            [2000, 1.0, 270],
            [2000, 1.0, 280],
            [2000, 1.0, 290],
            [2000, 1.0, 300],
            [2000, 1.0, 310],
            [2000, 1.0, 320],
        ];
        var result = analyzeInjectionTiming(data, channels);
        assert.ok(result.diagnostics.length > 0);
        assert.ok(result.diagnostics[0].indexOf('compression stroke') !== -1);
        assert.ok(result.diagnostics[0].indexOf('20.0%') !== -1);
    });

    it('does not generate compression diagnostic when <=5% in compression', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        // 1 out of 20 = 5% exactly — should NOT trigger (must exceed 5%)
        var data = [];
        data.push([2000, 1.0, 100]); // 1 in compression
        for (var i = 0; i < 19; i++) {
            data.push([2000, 1.0, 280]);
        }
        var result = analyzeInjectionTiming(data, channels);
        var compressionDiag = result.diagnostics.filter(function (d) {
            return d.indexOf('compression stroke') !== -1;
        });
        assert.equal(compressionDiag.length, 0);
    });

    it('computes mean and median timing during lean spikes', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [
            [2000, 1.10, 200],  // lean spike
            [2000, 1.10, 220],  // lean spike
            [2000, 1.10, 240],  // lean spike
            [2000, 1.00, 300],  // not lean
            [2000, 1.00, 280],  // not lean
        ];
        var result = analyzeInjectionTiming(data, channels);
        // Lean timings: [200, 220, 240], mean = 220, median = 220
        assert.closeTo(result.leanSpikeMeanTiming, 220, 0.01);
        assert.closeTo(result.leanSpikeMedianTiming, 220, 0.01);
    });

    it('generates late-timing diagnostic when mean lean-spike timing < 240', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [
            [2000, 1.10, 180],  // lean spike, late timing
            [2000, 1.10, 200],  // lean spike, late timing
            [2000, 1.10, 220],  // lean spike, late timing
            [2000, 1.00, 300],  // not lean
        ];
        var result = analyzeInjectionTiming(data, channels);
        // Mean lean timing = 200 < 240
        var lateDiag = result.diagnostics.filter(function (d) {
            return d.indexOf('Late injection timing') !== -1;
        });
        assert.equal(lateDiag.length, 1);
        assert.ok(lateDiag[0].indexOf('200.0 dBTDC') !== -1);
    });

    it('does not generate late-timing diagnostic when mean lean-spike timing >= 240', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [
            [2000, 1.10, 260],  // lean spike, good timing
            [2000, 1.10, 280],  // lean spike, good timing
            [2000, 1.00, 300],  // not lean
        ];
        var result = analyzeInjectionTiming(data, channels);
        var lateDiag = result.diagnostics.filter(function (d) {
            return d.indexOf('Late injection timing') !== -1;
        });
        assert.equal(lateDiag.length, 0);
    });

    it('returns null lean spike timing when no lambda channel available', function () {
        // Columns: [rpm, inj_timing] — no lambda
        var channels = makeChannels({ rpm: 0, lambda_b1: -1, lambda_avg: -1, inj_timing: 1 });
        var data = [
            [2000, 280],
            [2000, 300],
        ];
        var result = analyzeInjectionTiming(data, channels);
        assert.equal(result.leanSpikeMeanTiming, null);
        assert.equal(result.leanSpikeMedianTiming, null);
    });

    it('returns null lean spike timing when no lean spikes occur', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [
            [2000, 1.00, 280],
            [2000, 0.95, 300],
        ];
        var result = analyzeInjectionTiming(data, channels);
        assert.equal(result.leanSpikeMeanTiming, null);
        assert.equal(result.leanSpikeMedianTiming, null);
    });

    it('skips NaN timing values', function () {
        // Columns: [rpm, lambda_b1, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [
            [2000, 1.0, 280],
            [2000, 1.0, NaN],
            [2000, 1.0, 300],
        ];
        var result = analyzeInjectionTiming(data, channels);
        // Only 2 valid timing values
        assert.equal(result.inOptimalCount, 2); // 280 and 300 are both in [240, 320]
        assert.closeTo(result.mean, 290, 0.01);
    });

    it('returns channelUsed as inj_timing', function () {
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_timing: 2 });
        var data = [[2000, 1.0, 280]];
        var result = analyzeInjectionTiming(data, channels);
        assert.equal(result.channelUsed, 'inj_timing');
    });

    it('prefers lambda_b1 over lambda_avg for lean spike correlation', function () {
        // Columns: [rpm, lambda_b1, lambda_avg, inj_timing]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, lambda_avg: 2, inj_timing: 3 });
        var data = [
            [2000, 1.10, 1.00, 200],  // lean by b1, not by avg
            [2000, 1.00, 1.10, 300],  // not lean by b1, lean by avg
        ];
        var result = analyzeInjectionTiming(data, channels);
        // Should use lambda_b1, so only first row is a lean spike
        assert.closeTo(result.leanSpikeMeanTiming, 200, 0.01);
    });
});
