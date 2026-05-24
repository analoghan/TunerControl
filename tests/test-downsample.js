/**
 * Tests for downsampleForCharts() in injector/worker.js
 */

describe('downsampleForCharts', function () {

    // Helper: build a channels object with given indices
    function makeChannels(overrides) {
        return Object.assign({
            time: 0,
            rpm: 1,
            lambda_b1: 2,
            lambda_b2: 3,
            inj_pw: 4,
            fuel_press_di: 5,
            fuel_press_di_aim: 6,
            inj_timing: 7,
        }, overrides || {});
    }

    // Helper: generate data rows
    function makeData(numRows, numCols) {
        var data = [];
        for (var i = 0; i < numRows; i++) {
            var row = [];
            for (var c = 0; c < numCols; c++) {
                row.push(i * 10 + c);
            }
            data.push(row);
        }
        return data;
    }

    it('computes downsampleStep = max(1, floor(data.length / maxPoints))', function () {
        var data = makeData(300, 8);
        var channels = makeChannels();
        var result = downsampleForCharts(data, channels, 100);
        // floor(300 / 100) = 3
        assert.equal(result.downsampleStep, 3);
    });

    it('downsampleStep is 1 when data.length <= maxPoints', function () {
        var data = makeData(50, 8);
        var channels = makeChannels();
        var result = downsampleForCharts(data, channels, 100);
        assert.equal(result.downsampleStep, 1);
    });

    it('output arrays never exceed maxPoints elements', function () {
        var data = makeData(500, 8);
        var channels = makeChannels();
        var maxPoints = 100;
        var result = downsampleForCharts(data, channels, maxPoints);
        assert.ok(result.time.length <= maxPoints, 'time exceeds maxPoints');
        assert.ok(result.rpm.length <= maxPoints, 'rpm exceeds maxPoints');
        assert.ok(result.lambdaB1.length <= maxPoints, 'lambdaB1 exceeds maxPoints');
    });

    it('returns null for channels with index -1', function () {
        var data = makeData(10, 8);
        var channels = makeChannels({
            lambda_b2: -1,
            inj_pw: -1,
            fuel_press_di_aim: -1,
            inj_timing: -1,
        });
        var result = downsampleForCharts(data, channels, 100);
        assert.equal(result.lambdaB2, null);
        assert.equal(result.injPW, null);
        assert.equal(result.fuelPressDIAim, null);
        assert.equal(result.injTiming, null);
    });

    it('converts fuel pressure from dMPa to bar (×100)', function () {
        // Row with fuel_press_di at index 5 = value 1.5 dMPa -> 150 bar
        var data = [[0, 3000, 1.0, 1.0, 2.0, 1.5, 1.6, 300]];
        var channels = makeChannels();
        var result = downsampleForCharts(data, channels, 100);
        assert.closeTo(result.fuelPressDI[0], 150, 0.001);
        assert.closeTo(result.fuelPressDIAim[0], 160, 0.001);
    });

    it('returns empty arrays for time and rpm when data is empty', function () {
        var data = [];
        var channels = makeChannels();
        var result = downsampleForCharts(data, channels, 100);
        assert.deepEqual(result.time, []);
        assert.deepEqual(result.rpm, []);
        assert.equal(result.downsampleStep, 1);
    });

    it('uses THRESHOLDS.MAX_CHART_POINTS as default maxPoints', function () {
        var data = makeData(300000, 8);
        var channels = makeChannels();
        var result = downsampleForCharts(data, channels);
        // floor(300000 / 150000) = 2
        assert.equal(result.downsampleStep, 2);
        assert.ok(result.time.length <= 150000);
    });

    it('uniformly samples every Nth element', function () {
        // 9 rows, maxPoints=3 -> step = floor(9/3) = 3
        // Should pick indices 0, 3, 6
        var data = [];
        for (var i = 0; i < 9; i++) {
            data.push([i, i * 100, 0, 0, 0, 0, 0, 0]);
        }
        var channels = makeChannels();
        var result = downsampleForCharts(data, channels, 3);
        assert.equal(result.downsampleStep, 3);
        assert.deepEqual(result.time, [0, 3, 6]);
        assert.deepEqual(result.rpm, [0, 300, 600]);
    });

    it('includes all expected fields in the returned object', function () {
        var data = makeData(5, 8);
        var channels = makeChannels();
        var result = downsampleForCharts(data, channels, 100);
        assert.ok('time' in result);
        assert.ok('lambdaB1' in result);
        assert.ok('lambdaB2' in result);
        assert.ok('injPW' in result);
        assert.ok('fuelPressDI' in result);
        assert.ok('fuelPressDIAim' in result);
        assert.ok('rpm' in result);
        assert.ok('injTiming' in result);
        assert.ok('downsampleStep' in result);
    });
});
