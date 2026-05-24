/**
 * Unit tests for analyzeFuelPressure function in injector/worker.js
 */

describe('analyzeFuelPressure', function () {

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

    it('returns null when fuel_press_di channel is not available', function () {
        var channels = makeChannels({ fuel_press_di: -1 });
        var data = [[2000, 1.0, 1.5]];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result, null);
    });

    it('converts dMPa to bar by multiplying by 100', function () {
        // Columns: [rpm, fuel_press_di]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1 });
        var data = [
            [2000, 1.5],   // 1.5 dMPa = 150 bar
            [2000, 2.0],   // 2.0 dMPa = 200 bar
            [2000, 1.0],   // 1.0 dMPa = 100 bar
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.minBar, 100);
        assert.equal(result.maxBar, 200);
        assert.closeTo(result.meanBar, 150, 0.01);
    });

    it('computes pressure statistics (min, max, mean, std) in bar', function () {
        // Columns: [rpm, fuel_press_di]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1 });
        var data = [
            [2000, 1.5],   // 150 bar
            [2000, 1.5],   // 150 bar
            [2000, 2.0],   // 200 bar
            [2000, 1.0],   // 100 bar
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.minBar, 100);
        assert.equal(result.maxBar, 200);
        assert.closeTo(result.meanBar, 150, 0.01);
        assert.ok(result.stdBar > 0);
    });

    it('counts samples below 150 bar', function () {
        // Columns: [rpm, fuel_press_di]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1 });
        var data = [
            [2000, 1.5],   // 150 bar — NOT below 150
            [2000, 1.49],  // 149 bar — below 150
            [2000, 2.0],   // 200 bar — NOT below 150
            [2000, 1.0],   // 100 bar — below 150
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.below150BarCount, 2);
        assert.closeTo(result.below150BarPct, 50.0, 0.01);
    });

    it('computes pressure error vs aim when aim channel available', function () {
        // Columns: [rpm, fuel_press_di, fuel_press_di_aim]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, fuel_press_di_aim: 2 });
        var data = [
            [2000, 1.5, 1.5],   // error = 0 bar
            [2000, 1.6, 1.5],   // error = 10 bar
            [2000, 1.4, 1.5],   // error = -10 bar
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.closeTo(result.meanErrorBar, 0, 0.01);
        assert.ok(result.stdErrorBar !== null);
        assert.ok(result.stdErrorBar > 0);
    });

    it('returns null error stats when aim channel not available', function () {
        // Columns: [rpm, fuel_press_di]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, fuel_press_di_aim: -1 });
        var data = [
            [2000, 1.5],
            [2000, 2.0],
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.meanErrorBar, null);
        assert.equal(result.stdErrorBar, null);
        assert.equal(result.largeErrorCount, null);
    });

    it('counts large error samples (|error| > 20 bar)', function () {
        // Columns: [rpm, fuel_press_di, fuel_press_di_aim]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, fuel_press_di_aim: 2 });
        var data = [
            [2000, 1.5, 1.5],    // error = 0 bar — not large
            [2000, 1.75, 1.5],   // error = 25 bar — large
            [2000, 1.2, 1.5],    // error = -30 bar — large
            [2000, 1.52, 1.5],   // error = 2 bar — not large
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.largeErrorCount, 2);
    });

    it('generates HPFP diagnostic when >1000 samples exceed 20 bar error', function () {
        // Columns: [rpm, fuel_press_di, fuel_press_di_aim]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, fuel_press_di_aim: 2 });
        // Create 1001 samples with large error
        var data = [];
        for (var i = 0; i < 1001; i++) {
            data.push([2000, 1.75, 1.5]);  // error = 25 bar
        }
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.largeErrorCount, 1001);
        var hpfpDiag = result.diagnostics.find(function (d) {
            return d.indexOf('HPFP WARNING') !== -1;
        });
        assert.ok(hpfpDiag, 'Expected HPFP diagnostic message');
        assert.ok(hpfpDiag.indexOf('1001') !== -1, 'Expected count in diagnostic');
    });

    it('does NOT generate HPFP diagnostic when exactly 1000 samples exceed 20 bar error', function () {
        // Columns: [rpm, fuel_press_di, fuel_press_di_aim]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, fuel_press_di_aim: 2 });
        var data = [];
        for (var i = 0; i < 1000; i++) {
            data.push([2000, 1.75, 1.5]);  // error = 25 bar
        }
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.largeErrorCount, 1000);
        var hpfpDiag = result.diagnostics.find(function (d) {
            return d.indexOf('HPFP WARNING') !== -1;
        });
        assert.equal(hpfpDiag, undefined);
    });

    it('computes mean pressure during lean spikes', function () {
        // Columns: [rpm, fuel_press_di, lambda_b1]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, lambda_b1: 2 });
        var data = [
            [2000, 1.5, 1.10],   // lean spike, 150 bar
            [2000, 2.0, 1.00],   // not lean, 200 bar
            [2000, 1.0, 1.10],   // lean spike, 100 bar
            [2000, 2.0, 1.00],   // not lean, 200 bar
        ];
        var result = analyzeFuelPressure(data, channels);
        // Lean spike mean = (150 + 100) / 2 = 125 bar
        assert.closeTo(result.leanSpikeFPMeanBar, 125, 0.01);
        // Overall mean = (150 + 200 + 100 + 200) / 4 = 162.5 bar
        assert.closeTo(result.overallFPMeanBar, 162.5, 0.01);
    });

    it('generates fuel delivery diagnostic when lean-spike pressure is >10 bar below overall', function () {
        // Columns: [rpm, fuel_press_di, lambda_b1]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, lambda_b1: 2 });
        var data = [
            [2000, 1.2, 1.10],   // lean spike, 120 bar
            [2000, 2.0, 1.00],   // not lean, 200 bar
            [2000, 1.3, 1.10],   // lean spike, 130 bar
            [2000, 2.0, 1.00],   // not lean, 200 bar
        ];
        var result = analyzeFuelPressure(data, channels);
        // Lean spike mean = (120 + 130) / 2 = 125 bar
        // Overall mean = (120 + 200 + 130 + 200) / 4 = 162.5 bar
        // Drop = 162.5 - 125 = 37.5 bar > 10
        var fuelDiag = result.diagnostics.find(function (d) {
            return d.indexOf('fuel delivery may be insufficient') !== -1;
        });
        assert.ok(fuelDiag, 'Expected fuel delivery diagnostic message');
    });

    it('does NOT generate fuel delivery diagnostic when drop is <= 10 bar', function () {
        // Columns: [rpm, fuel_press_di, lambda_b1]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, lambda_b1: 2 });
        var data = [
            [2000, 1.5, 1.10],   // lean spike, 150 bar
            [2000, 1.6, 1.00],   // not lean, 160 bar
            [2000, 1.5, 1.10],   // lean spike, 150 bar
            [2000, 1.6, 1.00],   // not lean, 160 bar
        ];
        var result = analyzeFuelPressure(data, channels);
        // Lean spike mean = 150, overall mean = 155, drop = 5 bar <= 10
        var fuelDiag = result.diagnostics.find(function (d) {
            return d.indexOf('fuel delivery may be insufficient') !== -1;
        });
        assert.equal(fuelDiag, undefined);
    });

    it('returns null leanSpikeFPMeanBar when no lambda channel available', function () {
        // Columns: [rpm, fuel_press_di]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, lambda_b1: -1, lambda_avg: -1 });
        var data = [
            [2000, 1.5],
            [2000, 2.0],
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.leanSpikeFPMeanBar, null);
    });

    it('returns null leanSpikeFPMeanBar when no lean spikes occur', function () {
        // Columns: [rpm, fuel_press_di, lambda_b1]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, lambda_b1: 2 });
        var data = [
            [2000, 1.5, 1.00],   // not lean
            [2000, 2.0, 0.95],   // not lean
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.leanSpikeFPMeanBar, null);
    });

    it('skips NaN pressure values', function () {
        // Columns: [rpm, fuel_press_di]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1 });
        var data = [
            [2000, 1.5],       // 150 bar
            [2000, NaN],       // skip
            [2000, 2.0],       // 200 bar
        ];
        var result = analyzeFuelPressure(data, channels);
        assert.closeTo(result.meanBar, 175, 0.01);
        assert.equal(result.below150BarCount, 0);
    });

    it('sets channelUsed to fuel_press_di', function () {
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1 });
        var data = [[2000, 1.5]];
        var result = analyzeFuelPressure(data, channels);
        assert.equal(result.channelUsed, 'fuel_press_di');
    });

    it('prefers lambda_b1 over lambda_avg for lean spike correlation', function () {
        // Columns: [rpm, fuel_press_di, lambda_b1, lambda_avg]
        var channels = makeChannels({ rpm: 0, fuel_press_di: 1, lambda_b1: 2, lambda_avg: 3 });
        var data = [
            [2000, 1.5, 1.10, 1.00],   // lean by b1, not by avg
            [2000, 2.0, 1.00, 1.10],   // not lean by b1, lean by avg
        ];
        var result = analyzeFuelPressure(data, channels);
        // Only first sample is lean (using lambda_b1)
        assert.closeTo(result.leanSpikeFPMeanBar, 150, 0.01);
    });
});
