/**
 * Unit tests for analyzeLeanSpikes in injector/worker.js: lean episodes (not samples), sorted into the
 * overrun fuel cut, injectors off without overrun (Minimum Volume) and lean while fuelling.
 */

describe('analyzeLeanSpikes', function () {

    // Columns: [time, rpm, lambda_b1, lambda_b2, inj_pw, overrun, map]
    function makeChannels(opts) {
        var c = {
            time: 0, rpm: 1, map: 6, lambda_b1: 2, lambda_b2: 3, lambda_avg: -1, inj_pw: 4, inj_timing: -1, tps: -1,
            fuel_press_di: -1, fuel_press_di_aim: -1, coolant_temp: -1, iat: -1, cl_trim_b1: -1, cl_trim_b2: -1,
            fuel_mix_aim: -1, overrun: 5, warnings: []
        };
        return Object.assign(c, opts || {});
    }

    /** Builds 100 Hz rows: segments of { s: seconds, rpm, l1, l2, pw, ov, map }. */
    function rows(segments) {
        var out = [], t = 0;
        segments.forEach(function (g) {
            for (var k = 0; k < Math.round(g.s * 100); k++, t += 0.01) {
                out.push([t, g.rpm === undefined ? 2000 : g.rpm, g.l1, g.l2 === undefined ? g.l1 : g.l2,
                    g.pw === undefined ? 1.5 : g.pw, g.ov || 0, g.map === undefined ? 40 : g.map]);
            }
        });
        return out;
    }

    it('returns null when no lambda channel is available', function () {
        var result = analyzeLeanSpikes([[0, 2000, 1, 1, 1, 0, 40]], makeChannels({ lambda_b1: -1, lambda_b2: -1, lambda_avg: -1 }));
        assert.equal(result, null);
    });

    it('counts one episode per lean stretch, not per sample', function () {
        var data = rows([{ s: 1, l1: 1.0 }, { s: 0.6, l1: 1.10 }, { s: 1, l1: 1.0 }]);
        var result = analyzeLeanSpikes(data, makeChannels());
        assert.equal(result.episodeCount, 1);
        assert.equal(result.fuelledCount, 1);
    });

    it('ignores lean stretches shorter than 0.3 s and joins gaps under 0.3 s', function () {
        var data = rows([{ s: 1, l1: 1.0 }, { s: 0.2, l1: 1.10 }, { s: 1, l1: 1.0 },
                         { s: 0.4, l1: 1.10 }, { s: 0.1, l1: 1.0 }, { s: 0.4, l1: 1.10 }, { s: 1, l1: 1.0 }]);
        var result = analyzeLeanSpikes(data, makeChannels());
        assert.equal(result.episodeCount, 1);
    });

    it('ignores lean readings with the engine stopped', function () {
        var data = rows([{ s: 2, rpm: 0, l1: 10, pw: 0 }, { s: 1, l1: 1.0 }]);
        var result = analyzeLeanSpikes(data, makeChannels());
        assert.equal(result.episodeCount, 0);
    });

    it('sorts an episode after the overrun fuel cut as overrun', function () {
        var data = rows([{ s: 1, l1: 1.0 }, { s: 0.3, l1: 1.0, ov: 2 }, { s: 0.5, l1: 2.0 }, { s: 1, l1: 1.0 }]);
        var result = analyzeLeanSpikes(data, makeChannels());
        assert.equal(result.overrunCount, 1);
        assert.equal(result.injectionOffCount, 0);
        assert.equal(result.fuelledCount, 0);
    });

    it('sorts injectors off without the overrun cut as injection-off (Minimum Volume)', function () {
        var data = rows([{ s: 1, l1: 1.0 }, { s: 0.2, l1: 1.0, pw: 0, ov: 1, map: 10, rpm: 2600 },
                         { s: 0.5, l1: 3.0, map: 10, rpm: 2600 }, { s: 1, l1: 1.0 }]);
        var result = analyzeLeanSpikes(data, makeChannels());
        assert.equal(result.injectionOffCount, 1);
        assert.equal(result.injectionOff[0].rpm, 2600);
        assert.ok(result.diagnostics[0].indexOf('Minimum Volume') !== -1);
    });

    it('splits lean-while-fuelling episodes by bank and short pulses', function () {
        var data = rows([{ s: 1, l1: 1.0 }, { s: 0.5, l1: 1.10, l2: 1.10, pw: 0.6 }, { s: 1, l1: 1.0 },
                         { s: 0.5, l1: 1.10, l2: 1.00, pw: 1.4 }, { s: 1, l1: 1.0 }]);
        var result = analyzeLeanSpikes(data, makeChannels());
        assert.equal(result.fuelledCount, 2);
        assert.equal(result.bothBanksLean, 1);
        assert.equal(result.onlyB1Lean, 1);
        assert.equal(result.onlyB2Lean, 0);
        assert.equal(result.fuelledShortPW, 1);
    });

    it('rates lean-while-fuelling episodes per minute of running in each RPM band', function () {
        var data = rows([{ s: 30, l1: 1.0, rpm: 1700 }, { s: 0.5, l1: 1.10, rpm: 1700 }, { s: 29.5, l1: 1.0, rpm: 1700 }]);
        var result = analyzeLeanSpikes(data, makeChannels());
        var band = result.rpmDistribution.filter(function (r) { return r.band === '1.5-2k'; })[0];
        assert.equal(band.spikes, 1);
        assert.closeTo(band.perMinute, 1, 0.05);
    });

    it('reports no lean episodes for a clean log', function () {
        var result = analyzeLeanSpikes(rows([{ s: 2, l1: 1.0 }]), makeChannels());
        assert.equal(result.episodeCount, 0);
        assert.ok(result.diagnostics[0].indexOf('No lean episodes') !== -1);
    });

    it('handles an empty data array', function () {
        var result = analyzeLeanSpikes([], makeChannels());
        assert.equal(result.episodeCount, 0);
    });
});
