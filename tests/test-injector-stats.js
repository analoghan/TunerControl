/**
 * Unit tests for analyzeLeanSpikes function in injector/worker.js
 */

describe('analyzeLeanSpikes', function () {

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

    it('returns null when no lambda channel is available', function () {
        var channels = makeChannels({ rpm: 0, lambda_b1: -1, lambda_b2: -1, lambda_avg: -1 });
        var data = [[2000, 1.0]];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result, null);
    });

    it('counts lean events where lambda > 1.06', function () {
        // Columns: [rpm, lambda_b1]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1 });
        var data = [
            [2000, 1.00],  // not lean
            [2000, 1.06],  // not lean (must exceed, not equal)
            [2000, 1.07],  // lean
            [2000, 1.10],  // lean
            [2000, 0.95],  // not lean
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.leanEventCount, 2);
        assert.equal(result.totalSamples, 5);
    });

    it('prefers lambda_b1 over lambda_avg', function () {
        // Columns: [rpm, lambda_b1, lambda_avg]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, lambda_avg: 2 });
        var data = [
            [2000, 1.07, 1.00],  // lean by b1, not by avg
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.lambdaChannelUsed, 'lambda_b1');
        assert.equal(result.leanEventCount, 1);
    });

    it('falls back to lambda_avg when lambda_b1 not available', function () {
        // Columns: [rpm, lambda_avg]
        var channels = makeChannels({ rpm: 0, lambda_b1: -1, lambda_avg: 1 });
        var data = [
            [2000, 1.07],  // lean
            [2000, 1.00],  // not lean
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.lambdaChannelUsed, 'lambda_avg');
        assert.equal(result.leanEventCount, 1);
    });

    it('categorizes lean events by bank when both banks available', function () {
        // Columns: [rpm, lambda_b1, lambda_b2]
        // Primary lambda is lambda_b1, so a sample is "lean" only if B1 > 1.06
        // Bank categorization then checks both B1 and B2 within lean events
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, lambda_b2: 2 });
        var data = [
            [2000, 1.10, 1.10],  // lean (B1>1.06), both banks lean
            [2000, 1.10, 1.00],  // lean (B1>1.06), only B1 lean
            [2000, 1.10, 1.10],  // lean (B1>1.06), both banks lean
            [2000, 1.10, 1.08],  // lean (B1>1.06), both banks lean
            [2000, 1.00, 1.00],  // not lean (B1 not > 1.06)
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.leanEventCount, 4);
        assert.equal(result.bothBanksLean, 3);
        assert.equal(result.onlyB1Lean, 1);
        assert.equal(result.onlyB2Lean, 0);
    });

    it('bank categorization sums to total lean count', function () {
        // Columns: [rpm, lambda_b1, lambda_b2]
        // When lambda_b1 is primary, b1Lean is always true for lean events
        // So only "both" and "only-B1" are possible
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, lambda_b2: 2 });
        var data = [
            [2000, 1.10, 1.10],  // both
            [2000, 1.10, 1.00],  // only B1
            [2000, 1.10, 1.10],  // both
            [2000, 1.10, 1.10],  // both
            [2000, 1.10, 1.00],  // only B1
        ];
        var result = analyzeLeanSpikes(data, channels);
        var bankSum = result.bothBanksLean + result.onlyB1Lean + result.onlyB2Lean;
        assert.equal(bankSum, result.leanEventCount);
    });

    it('returns null bank categorization when only one bank available', function () {
        // Columns: [rpm, lambda_b1]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, lambda_b2: -1 });
        var data = [
            [2000, 1.10],
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.bothBanksLean, null);
        assert.equal(result.onlyB1Lean, null);
        assert.equal(result.onlyB2Lean, null);
    });

    it('distributes lean spikes across RPM bins', function () {
        // Columns: [rpm, lambda_b1]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1 });
        var data = [
            [500, 1.10],   // bin 0 (<800)
            [1000, 1.10],  // bin 1 (800-1.2k)
            [2500, 1.10],  // bin 4 (2-2.5k)
            [6000, 1.10],  // bin 8 (5.5k+)
            [2500, 1.00],  // not lean, bin 4
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.rpmDistribution[0].spikes, 1);
        assert.equal(result.rpmDistribution[0].band, '<800');
        assert.equal(result.rpmDistribution[1].spikes, 1);
        assert.equal(result.rpmDistribution[4].spikes, 1);
        assert.equal(result.rpmDistribution[4].total, 2);  // 2 samples in this bin
        assert.equal(result.rpmDistribution[8].spikes, 1);
    });

    it('counts low PW events and lean spikes with low PW', function () {
        // Columns: [rpm, lambda_b1, inj_pw]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_pw: 2 });
        var data = [
            [2000, 1.10, 0.5],   // lean + low PW
            [2000, 1.10, 1.2],   // lean + normal PW
            [2000, 1.00, 0.6],   // not lean + low PW
            [2000, 1.10, 0.7],   // lean + low PW
            [2000, 1.00, 2.0],   // not lean + normal PW
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.lowPWEvents, 3);       // 3 samples with PW < 0.8
        assert.equal(result.leanWithLowPW, 2);     // 2 lean spikes with low PW
        assert.closeTo(result.leanWithLowPWPct, 66.67, 0.1);  // 2/3 * 100
    });

    it('returns null PW fields when inj_pw channel not available', function () {
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_pw: -1 });
        var data = [
            [2000, 1.10],
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.lowPWEvents, null);
        assert.equal(result.leanWithLowPW, null);
        assert.equal(result.leanWithLowPWPct, null);
    });

    it('generates diagnostic messages for bank distribution', function () {
        // Columns: [rpm, lambda_b1, lambda_b2]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, lambda_b2: 2 });
        // All lean events are both-banks (100% > 70%)
        var data = [
            [2000, 1.10, 1.10],
            [2000, 1.10, 1.10],
            [2000, 1.10, 1.10],
            [2000, 1.00, 1.00],
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.ok(result.diagnostics.length > 0);
        assert.ok(result.diagnostics[0].indexOf('system-wide fueling issue') !== -1);
    });

    it('generates diagnostic messages for low-PW correlation', function () {
        // Columns: [rpm, lambda_b1, inj_pw]
        var channels = makeChannels({ rpm: 0, lambda_b1: 1, inj_pw: 2 });
        // All lean spikes coincide with low PW (100% > 50%)
        var data = [
            [2000, 1.10, 0.5],
            [2000, 1.10, 0.6],
            [2000, 1.00, 2.0],
        ];
        var result = analyzeLeanSpikes(data, channels);
        var lowPWDiag = result.diagnostics.find(function (d) {
            return d.indexOf('XDI instability zone') !== -1;
        });
        assert.ok(lowPWDiag, 'Expected a low-PW diagnostic message');
    });

    it('computes correct leanEventPct', function () {
        var channels = makeChannels({ rpm: 0, lambda_b1: 1 });
        var data = [
            [2000, 1.10],
            [2000, 1.00],
            [2000, 1.10],
            [2000, 1.00],
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.closeTo(result.leanEventPct, 50.0, 0.01);
    });

    it('handles empty data array', function () {
        var channels = makeChannels({ rpm: 0, lambda_b1: 1 });
        var data = [];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.leanEventCount, 0);
        assert.equal(result.totalSamples, 0);
        assert.equal(result.leanEventPct, 0);
    });

    it('handles data with no lean events', function () {
        var channels = makeChannels({ rpm: 0, lambda_b1: 1 });
        var data = [
            [2000, 1.00],
            [2000, 0.95],
            [2000, 1.06],  // exactly 1.06 is NOT lean (must exceed)
        ];
        var result = analyzeLeanSpikes(data, channels);
        assert.equal(result.leanEventCount, 0);
        assert.equal(result.leanEventPct, 0);
    });
});
