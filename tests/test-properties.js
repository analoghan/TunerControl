/**
 * test-properties.js — Property-based tests (Properties 1–10) using fast-check.
 * Implemented in tasks 2.2, 2.5, 3.2, 4.2, 4.5, 6.2, 6.3, 6.4, 7.2, 9.4.
 */

// Feature: ve-table-tuning-webapp, Property 1: Scientific notation round-trip
// **Validates: Requirements 3.6, 8.3, 8.6**
describe('Property 1: Scientific notation round-trip', function () {
  property(
    'formatScientific round-trip preserves value within 1e-9',
    fc.float({ noNaN: true, noDefaultInfinity: true }),
    function (value) {
      var formatted = formatScientific(value);
      var parsed = parseFloat(formatted);
      assert.closeTo(parsed, value, 1e-9,
        'formatScientific(' + value + ') = "' + formatted + '" parsed back to ' + parsed
      );
    }
  );
});

// Feature: ve-table-tuning-webapp, Property 3: Nearest-breakpoint assignment is minimal distance
describe('Property 3: Nearest-breakpoint assignment is minimal distance', function () {
  property(
    'findNearestBreakpoint returns the index that minimises distance, tie-breaks to lower index',
    fc.tuple(
      fc.float({ noNaN: true, noDefaultInfinity: true }),
      fc.array(fc.integer(), { minLength: 1 })
    ),
    function (tuple) {
      var value = tuple[0];
      var rawArr = tuple[1];

      // Deduplicate and sort ascending
      var unique = Array.from(new Set(rawArr));
      unique.sort(function (a, b) { return a - b; });

      // Need at least 1 breakpoint after dedup
      if (unique.length === 0) return;

      // Skip if value is not finite (extra safety)
      if (!isFinite(value)) return;

      var breakpoints = unique;
      var result = findNearestBreakpoint(value, breakpoints);

      // Result must be a valid index
      assert.ok(result >= 0 && result < breakpoints.length,
        'Expected valid index, got ' + result + ' for breakpoints length ' + breakpoints.length);

      // Compute the distance at the returned index
      var bestDist = Math.abs(value - breakpoints[result]);

      // Assert minimality: no other index has a strictly smaller distance
      for (var i = 0; i < breakpoints.length; i++) {
        var dist = Math.abs(value - breakpoints[i]);
        assert.ok(dist >= bestDist,
          'Index ' + i + ' has distance ' + dist + ' which is less than returned index ' +
          result + ' distance ' + bestDist);
      }

      // Assert tie-breaking: if another index has the same distance, it must be a higher index
      for (var j = 0; j < breakpoints.length; j++) {
        var djist = Math.abs(value - breakpoints[j]);
        if (djist === bestDist && j !== result) {
          assert.ok(j > result,
            'Tie-break violated: index ' + j + ' has same distance as returned index ' +
            result + ' but is lower');
        }
      }
    }
  );
});

// Feature: ve-table-tuning-webapp, Property 4: Hit count conservation
describe('Property 4: Hit count conservation', function () {
    // **Validates: Requirements 5.3, 5.4**

    const RPM_BREAKPOINTS = [0, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000];
    const MAP_BREAKPOINTS = [10, 15, 20, 25, 30, 35, 40, 50, 55, 60, 70, 80, 90, 100, 110, 120, 140, 160, 180, 200, 220, 240, 260, 280];

    const fc = window.fc;

    // Arbitrary for a sample with finite RPM and MAP values
    const sampleArb = fc.record({
        rpm: fc.double({ min: -1000, max: 10000, noNaN: true }),
        map: fc.double({ min: -50, max: 350, noNaN: true }),
    });

    property(
        'sum of all cell counts equals number of valid samples accumulated',
        fc.array(sampleArb, { minLength: 0, maxLength: 200 }),
        function (samples) {
            var grid = createAccumulatorGrid(MAP_BREAKPOINTS, RPM_BREAKPOINTS);
            var validCount = 0;

            for (var i = 0; i < samples.length; i++) {
                var s = samples[i];
                var rpmIdx = findNearestBreakpoint(s.rpm, RPM_BREAKPOINTS);
                var mapIdx = findNearestBreakpoint(s.map, MAP_BREAKPOINTS);

                // Skip if either returns -1 (NaN case — shouldn't happen with noNaN, but be safe)
                if (rpmIdx === -1 || mapIdx === -1) continue;

                accumulateSample(grid, mapIdx, rpmIdx, 0);
                validCount++;
            }

            // Sum all cell counts in the grid
            var totalCounts = 0;
            for (var m = 0; m < grid.cells.length; m++) {
                for (var r = 0; r < grid.cells[m].length; r++) {
                    totalCounts += grid.cells[m][r].count;
                }
            }

            assert.equal(totalCounts, validCount,
                'Sum of all cell counts (' + totalCounts + ') should equal valid samples (' + validCount + ')');
        },
        { numRuns: 100 }
    );
});

// Feature: ve-table-tuning-webapp, Property 2: VE table parse round-trip
// **Validates: Requirements 3.6, 8.6**
describe('Property 2: VE table parse round-trip', function () {
    var fc = window.fc;

    // Generate a sorted array of unique integers of a given length within [min, max]
    function sortedUniqueInts(count, min, max) {
        return fc.array(fc.integer({ min: min, max: max }), { minLength: count * 3, maxLength: count * 5 })
            .map(function (arr) {
                var unique = Array.from(new Set(arr));
                unique.sort(function (a, b) { return a - b; });
                return unique.slice(0, count);
            })
            .filter(function (arr) { return arr.length === count; });
    }

    // Arbitrary for 20 RPM breakpoints (sorted ascending integers, 0-8000 range)
    var rpmArb = sortedUniqueInts(20, 0, 8000);

    // Arbitrary for 24 MAP breakpoints (sorted ascending integers, 10-280 range)
    var mapArb = sortedUniqueInts(24, 10, 280);

    // Arbitrary for a 24x20 grid of VE values (positive finite floats)
    var gridArb = fc.array(
        fc.array(
            fc.double({ noNaN: true, noDefaultInfinity: true, min: 0.1, max: 200 }),
            { minLength: 20, maxLength: 20 }
        ),
        { minLength: 24, maxLength: 24 }
    );

    property(
        'parseVETable round-trips arbitrary 24x20 grids within 1e-9',
        fc.tuple(rpmArb, mapArb, gridArb),
        function (tuple) {
            var rpmBreakpoints = tuple[0];
            var mapBreakpoints = tuple[1];
            var grid = tuple[2];

            // Serialise to M1 v2 CSV format
            var lines = [];
            // Row 0: M1,v2
            lines.push('M1,v2');
            // Row 1: Body,%
            lines.push('Body,%');
            // Row 2: Cols,rpm,Eng Speed
            lines.push('Cols,rpm,Eng Speed');
            // Row 3: Rows,kPa,Inlet Man Pres
            lines.push('Rows,kPa,Inlet Man Pres');
            // Row 4: (empty first field), then RPM breakpoints formatted with formatScientific
            var row4Parts = [''];
            for (var r = 0; r < rpmBreakpoints.length; r++) {
                row4Parts.push(formatScientific(rpmBreakpoints[r]));
            }
            lines.push(row4Parts.join(','));
            // Rows 5+: MAP breakpoint formatted with formatScientific, then VE values formatted with formatScientific
            for (var m = 0; m < mapBreakpoints.length; m++) {
                var rowParts = [formatScientific(mapBreakpoints[m])];
                for (var c = 0; c < grid[m].length; c++) {
                    rowParts.push(formatScientific(grid[m][c]));
                }
                lines.push(rowParts.join(','));
            }

            var csvText = lines.join('\n');

            // Parse with parseVETable
            var result = parseVETable(csvText);

            // Assert all parsed VE values are within 1e-9 of the originals
            for (var mi = 0; mi < 24; mi++) {
                for (var ri = 0; ri < 20; ri++) {
                    assert.closeTo(result.values[mi][ri], grid[mi][ri], 1e-9,
                        'VE value mismatch at [' + mi + '][' + ri + ']: ' +
                        'expected ' + grid[mi][ri] + ', got ' + result.values[mi][ri]);
                }
            }
        },
        { numRuns: 100 }
    );
});

// Feature: ve-table-tuning-webapp, Property 10: Channel name resolution is case-insensitive
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8**
describe('Property 10: Channel name resolution is case-insensitive', function () {

    var CHANNELS = [
        { name: 'Engine Speed',                            key: 'rpmIdx' },
        { name: 'Inlet Manifold Pressure',                key: 'mapIdx' },
        { name: 'Exhaust Lambda Bank 1',                  key: 'lambdaB1Idx' },
        { name: 'Exhaust Lambda Bank 2',                  key: 'lambdaB2Idx' },
        { name: 'Exhaust Lambda',                         key: 'lambdaAvgIdx' },
        { name: 'Fuel Mixture Aim',                       key: 'lambdaTargetIdx' },
        { name: 'Fuel Closed Loop Control Bank 1 Trim',   key: 'clTrimB1Idx' },
        { name: 'Fuel Closed Loop Control Bank 2 Trim',   key: 'clTrimB2Idx' },
    ];

    /**
     * Arbitrary that produces a random-cased version of a given string.
     * For each character, randomly choose upper or lower case.
     */
    function randomCaseArb(str) {
        // Generate an array of booleans (one per character) to decide case
        return fc.array(fc.boolean(), { minLength: str.length, maxLength: str.length })
            .map(function (bools) {
                var result = '';
                for (var i = 0; i < str.length; i++) {
                    result += bools[i] ? str[i].toUpperCase() : str[i].toLowerCase();
                }
                return result;
            });
    }

    // Build an arbitrary that produces an array of 8 random-cased channel names
    // (one per channel, in a shuffled order) along with expected index mapping.
    var channelHeaderArb = fc.tuple(
        randomCaseArb(CHANNELS[0].name),
        randomCaseArb(CHANNELS[1].name),
        randomCaseArb(CHANNELS[2].name),
        randomCaseArb(CHANNELS[3].name),
        randomCaseArb(CHANNELS[4].name),
        randomCaseArb(CHANNELS[5].name),
        randomCaseArb(CHANNELS[6].name),
        randomCaseArb(CHANNELS[7].name)
    );

    property(
        'resolveChannels matches all channels regardless of casing',
        channelHeaderArb,
        function (casedNames) {
            // Place all 8 channels in the header with a "Time" column first
            var header = ['Time'].concat(casedNames);

            var result = resolveChannels(header);

            // Each channel should resolve to its position in the header (offset by 1 for "Time")
            assert.equal(result.rpmIdx, 1,
                'RPM should be at index 1, got ' + result.rpmIdx + ' for "' + casedNames[0] + '"');
            assert.equal(result.mapIdx, 2,
                'MAP should be at index 2, got ' + result.mapIdx + ' for "' + casedNames[1] + '"');
            assert.equal(result.lambdaB1Idx, 3,
                'Lambda_B1 should be at index 3, got ' + result.lambdaB1Idx + ' for "' + casedNames[2] + '"');
            assert.equal(result.lambdaB2Idx, 4,
                'Lambda_B2 should be at index 4, got ' + result.lambdaB2Idx + ' for "' + casedNames[3] + '"');
            // Lambda_Avg is only used as fallback when BOTH B1 and B2 are absent;
            // since B1 and B2 are present, lambdaAvgIdx should be -1
            assert.equal(result.lambdaAvgIdx, -1,
                'Lambda_Avg should be -1 when B1/B2 present, got ' + result.lambdaAvgIdx);
            assert.equal(result.lambdaTargetIdx, 6,
                'Lambda_Target should be at index 6, got ' + result.lambdaTargetIdx + ' for "' + casedNames[5] + '"');
            assert.equal(result.clTrimB1Idx, 7,
                'CL_Trim_B1 should be at index 7, got ' + result.clTrimB1Idx + ' for "' + casedNames[6] + '"');
            assert.equal(result.clTrimB2Idx, 8,
                'CL_Trim_B2 should be at index 8, got ' + result.clTrimB2Idx + ' for "' + casedNames[7] + '"');
        },
        { numRuns: 100 }
    );

    // Also test the fallback case: when B1 and B2 are absent, Lambda_Avg should resolve
    property(
        'resolveChannels matches Lambda_Avg in any casing when B1/B2 absent',
        fc.tuple(
            randomCaseArb('Engine Speed'),
            randomCaseArb('Inlet Manifold Pressure'),
            randomCaseArb('Exhaust Lambda'),
            randomCaseArb('Fuel Mixture Aim'),
            randomCaseArb('Fuel Closed Loop Control Bank 1 Trim'),
            randomCaseArb('Fuel Closed Loop Control Bank 2 Trim')
        ),
        function (casedNames) {
            // Header without B1/B2 — only Lambda_Avg present
            var header = ['Time', casedNames[0], casedNames[1], casedNames[2],
                          casedNames[3], casedNames[4], casedNames[5]];

            var result = resolveChannels(header);

            assert.equal(result.rpmIdx, 1,
                'RPM should be at index 1, got ' + result.rpmIdx);
            assert.equal(result.mapIdx, 2,
                'MAP should be at index 2, got ' + result.mapIdx);
            assert.equal(result.lambdaB1Idx, -1,
                'Lambda_B1 should be -1 when absent, got ' + result.lambdaB1Idx);
            assert.equal(result.lambdaB2Idx, -1,
                'Lambda_B2 should be -1 when absent, got ' + result.lambdaB2Idx);
            assert.equal(result.lambdaAvgIdx, 3,
                'Lambda_Avg should be at index 3 as fallback, got ' + result.lambdaAvgIdx + ' for "' + casedNames[2] + '"');
            assert.equal(result.lambdaTargetIdx, 4,
                'Lambda_Target should be at index 4, got ' + result.lambdaTargetIdx);
            assert.equal(result.clTrimB1Idx, 5,
                'CL_Trim_B1 should be at index 5, got ' + result.clTrimB1Idx);
            assert.equal(result.clTrimB2Idx, 6,
                'CL_Trim_B2 should be at index 6, got ' + result.clTrimB2Idx);
        },
        { numRuns: 100 }
    );
});
