/**
 * test-hit-counter.js — Unit tests for Hit_Counter (createAccumulatorGrid, accumulateSample).
 * Implemented in task 4.6.
 *
 * Validates: Requirements 5.3, 5.4
 */

describe('Hit_Counter', function () {

    it('Grid initialises to all zeros', function () {
        var mapBP = [10, 20];
        var rpmBP = [500, 1000];
        var grid = createAccumulatorGrid(mapBP, rpmBP);

        // Should have 2 MAP rows x 2 RPM columns
        assert.equal(grid.cells.length, 2);
        assert.equal(grid.cells[0].length, 2);
        assert.equal(grid.cells[1].length, 2);

        // Every cell should start at count=0, correctionSum=0
        for (var m = 0; m < mapBP.length; m++) {
            for (var r = 0; r < rpmBP.length; r++) {
                assert.equal(grid.cells[m][r].count, 0,
                    'cell [' + m + '][' + r + '] count should be 0');
                assert.equal(grid.cells[m][r].correctionSum, 0,
                    'cell [' + m + '][' + r + '] correctionSum should be 0');
            }
        }
    });

    it('Exactly 50 samples in a cell (at threshold, below required count)', function () {
        var grid = createAccumulatorGrid([10, 20], [500, 1000]);

        // Accumulate exactly 50 samples into cell (0, 0)
        for (var i = 0; i < 50; i++) {
            accumulateSample(grid, 0, 0, 1.5);
        }

        // Count should be exactly 50 — this is AT the threshold,
        // meaning the cell does NOT qualify (requires strictly more than 50)
        assert.equal(grid.cells[0][0].count, 50);
        assert.equal(grid.cells[0][0].count <= HIT_THRESHOLD, true,
            '50 samples should be at or below HIT_THRESHOLD (50)');
    });

    it('Exactly 51 samples in a cell (above threshold)', function () {
        var grid = createAccumulatorGrid([10, 20], [500, 1000]);

        // Accumulate exactly 51 samples into cell (0, 0)
        for (var i = 0; i < 51; i++) {
            accumulateSample(grid, 0, 0, 2.0);
        }

        // Count should be exactly 51 — this is above the threshold
        assert.equal(grid.cells[0][0].count, 51);
        assert.ok(grid.cells[0][0].count > HIT_THRESHOLD,
            '51 samples should be above HIT_THRESHOLD (50)');
    });

});
