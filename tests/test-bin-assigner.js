/**
 * test-bin-assigner.js — Unit tests for Bin_Assigner (findNearestBreakpoint).
 * Implemented in task 4.3.
 */

describe('Bin_Assigner — findNearestBreakpoint', function () {

  // 1. Value exactly on a breakpoint
  it('returns the exact index when value matches a breakpoint', function () {
    var breakpoints = [500, 1000, 1500];
    var result = findNearestBreakpoint(1000, breakpoints);
    assert.equal(result, 1);
  });

  // 2. Value exactly between two breakpoints (tie → lower index wins)
  it('returns the lower index when value is equidistant between two breakpoints', function () {
    var breakpoints = [500, 1000];
    // 750 is exactly 250 away from both 500 and 1000 → lower index (0) wins
    var result = findNearestBreakpoint(750, breakpoints);
    assert.equal(result, 0);
  });

  // 3. Value below minimum breakpoint
  it('returns index 0 when value is below the minimum breakpoint', function () {
    var breakpoints = [0, 500, 1000];
    var result = findNearestBreakpoint(-100, breakpoints);
    assert.equal(result, 0);
  });

  // 4. Value above maximum breakpoint
  it('returns the last index when value is above the maximum breakpoint', function () {
    var breakpoints = [0, 500, 1000];
    var result = findNearestBreakpoint(9999, breakpoints);
    assert.equal(result, 2);
  });

  // 5. NaN input returns -1
  it('returns -1 when value is NaN', function () {
    var breakpoints = [0, 500, 1000];
    var result = findNearestBreakpoint(NaN, breakpoints);
    assert.equal(result, -1);
  });

});
