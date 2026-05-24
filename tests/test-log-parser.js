/**
 * test-log-parser.js — Unit tests for Log_Parser and channel resolver.
 * Implemented in tasks 3.4 and 3.5.
 */

describe('Log_Parser — parseLog', function () {

  // Helper: build a minimal valid CSV with the "Time" header at a given row offset.
  // Prepends `prefixRows` metadata rows before the header.
  // Uses the required channels: Time, Engine Speed, Inlet Manifold Pressure,
  // Exhaust Lambda Bank 1, Exhaust Lambda Bank 2, Fuel Mixture Aim
  function buildCsv(prefixRows, dataRows) {
    var header = '"Time","Engine Speed","Inlet Manifold Pressure","Exhaust Lambda Bank 1","Exhaust Lambda Bank 2","Fuel Mixture Aim"';
    var units = 's,rpm,kPa,,,';
    var lines = [];
    for (var i = 0; i < prefixRows; i++) {
      lines.push('metadata row ' + i);
    }
    lines.push(header);
    lines.push(units);
    if (dataRows) {
      for (var j = 0; j < dataRows.length; j++) {
        lines.push(dataRows[j]);
      }
    } else {
      lines.push('0.001,1000,100,0.98,1.02,1.0');
    }
    return lines.join('\n');
  }

  // 1. "Time" header at row 0
  it('parses successfully when "Time" header is at row 0', function () {
    var csv = buildCsv(0);
    var result = parseLog(csv, function () {});
    assert.ok(result.samples.length > 0);
    assert.equal(result.samples[0].rpm, 1000);
    assert.equal(result.samples[0].map, 100);
  });

  // 2. "Time" header at row 12
  it('parses successfully when "Time" header is at row 12', function () {
    var csv = buildCsv(12);
    var result = parseLog(csv, function () {});
    assert.ok(result.samples.length > 0);
    assert.equal(result.samples[0].rpm, 1000);
    assert.equal(result.samples[0].map, 100);
  });

  // 3. "Time" header at row 24 (within the 25-row scan limit)
  it('parses successfully when "Time" header is at row 24', function () {
    var csv = buildCsv(24);
    var result = parseLog(csv, function () {});
    assert.ok(result.samples.length > 0);
    assert.equal(result.samples[0].rpm, 1000);
  });

  // 4. Missing header throws — "Time" not found in first 25 rows
  it('throws when "Time" header is not found within the first 25 rows', function () {
    // Build a CSV with 25 metadata rows and no "Time" header in the first 25
    var lines = [];
    for (var i = 0; i < 25; i++) {
      lines.push('not a header row ' + i);
    }
    // Even if "Time" appears after row 24, it should not be found
    lines.push('"Time","Engine Speed","Inlet Manifold Pressure","Exhaust Lambda Bank 1","Exhaust Lambda Bank 2","Fuel Mixture Aim"');
    lines.push('s,rpm,kPa,,,');
    lines.push('0.001,1000,100,0.98,1.02,1.0');
    var csv = lines.join('\n');
    assert.throws(function () {
      parseLog(csv, function () {});
    }, 'Time');
  });

  // 5. Units row skipped — the row immediately after "Time" header should not appear in samples
  it('skips the units row and does not include it in samples', function () {
    var csv = [
      '"Time","Engine Speed","Inlet Manifold Pressure","Exhaust Lambda Bank 1","Exhaust Lambda Bank 2","Fuel Mixture Aim"',
      's,rpm,kPa,,,',
      '0.001,2000,80,0.98,1.02,1.0',
      '0.002,3000,90,0.99,1.01,1.0'
    ].join('\n');
    var result = parseLog(csv, function () {});
    // Units row has "s" in the Time column which would be NaN if parsed as data.
    // We should only have 2 data samples.
    assert.equal(result.samples.length, 2);
    assert.equal(result.samples[0].rpm, 2000);
    assert.equal(result.samples[1].rpm, 3000);
  });

  // 6. Blank rows after units row skipped
  it('skips blank rows between units row and first data row', function () {
    var csv = [
      '"Time","Engine Speed","Inlet Manifold Pressure","Exhaust Lambda Bank 1","Exhaust Lambda Bank 2","Fuel Mixture Aim"',
      's,rpm,kPa,,,',
      '',
      '   ',
      ',,,,',
      '0.005,1500,95,0.97,1.03,1.0'
    ].join('\n');
    var result = parseLog(csv, function () {});
    assert.equal(result.samples.length, 1);
    assert.equal(result.samples[0].rpm, 1500);
    assert.equal(result.samples[0].map, 95);
  });

  // 7. Scientific-notation values parsed correctly
  it('parses scientific-notation values correctly', function () {
    var csv = [
      '"Time","Engine Speed","Inlet Manifold Pressure","Exhaust Lambda Bank 1","Exhaust Lambda Bank 2","Fuel Mixture Aim"',
      's,rpm,kPa,,,',
      '1.00000000000000000e+00,1.00000000895353912e+03,1.01325000000000000e+02,9.80000000000000000e-01,1.02000000000000000e+00,1.00000000000000000e+00'
    ].join('\n');
    var result = parseLog(csv, function () {});
    assert.equal(result.samples.length, 1);
    assert.closeTo(result.samples[0].rpm, 1000.00000089535, 1e-5);
    assert.closeTo(result.samples[0].map, 101.325, 1e-3);
    assert.closeTo(result.samples[0].lambdaB1, 0.98, 1e-9);
    assert.closeTo(result.samples[0].lambdaB2, 1.02, 1e-9);
    assert.closeTo(result.samples[0].lambdaTarget, 1.0, 1e-9);
  });

});

// ---------------------------------------------------------------------------
// Task 3.5 — Channel Resolver unit tests (via parseLog)
// Validates: Requirements 4.9, 4.10, 4.11, 4.12
// ---------------------------------------------------------------------------

describe('Channel Resolver (via parseLog)', function () {

    // Helper: no-op progress callback
    function noop() {}

    // Helper: build a minimal valid CSV with the given column names and one data row.
    // `columns` is an array of column name strings.
    // `values` is an array of numeric strings matching the columns.
    function buildCsv(columns, values) {
        var header = columns.map(function (c) { return '"' + c + '"'; }).join(',');
        var units = columns.map(function () { return ''; }).join(',');
        var dataRow = values.join(',');
        return header + '\n' + units + '\n' + dataRow + '\n';
    }

    // The 8 canonical columns and matching data values
    var ALL_COLUMNS = [
        'Time',
        'Engine Speed',
        'Inlet Manifold Pressure',
        'Exhaust Lambda Bank 1',
        'Exhaust Lambda Bank 2',
        'Exhaust Lambda',
        'Fuel Mixture Aim',
        'Fuel Closed Loop Control Bank 1 Trim',
        'Fuel Closed Loop Control Bank 2 Trim'
    ];
    var ALL_VALUES = ['0.001', '1000', '100', '0.98', '1.02', '1.0', '1.0', '0.5', '-0.3'];

    // ----- Test 1: All 8 channels present -----
    it('all 8 channels present — parses without warnings', function () {
        var csv = buildCsv(ALL_COLUMNS, ALL_VALUES);
        var result = parseLog(csv, noop);
        assert.ok(result.samples.length > 0);
        assert.equal(result.channelWarnings.length, 0);
    });

    // ----- Test 2: RPM missing throws -----
    it('RPM channel missing — throws error', function () {
        var columns = ALL_COLUMNS.filter(function (c) { return c !== 'Engine Speed'; });
        var values = ALL_VALUES.slice(0, 1).concat(ALL_VALUES.slice(2)); // remove index 1
        var csv = buildCsv(columns, values);
        assert.throws(function () { parseLog(csv, noop); }, 'Engine Speed');
    });

    // ----- Test 3: MAP missing throws -----
    it('MAP channel missing — throws error', function () {
        var columns = ALL_COLUMNS.filter(function (c) { return c !== 'Inlet Manifold Pressure'; });
        var values = [ALL_VALUES[0], ALL_VALUES[1]].concat(ALL_VALUES.slice(3)); // remove index 2
        var csv = buildCsv(columns, values);
        assert.throws(function () { parseLog(csv, noop); }, 'Inlet Manifold Pressure');
    });

    // ----- Test 4: Both lambda banks absent with Avg present — uses Avg -----
    it('both lambda banks absent with Avg present — parses successfully', function () {
        // Keep: Time, Engine Speed, Inlet Manifold Pressure, Exhaust Lambda, Fuel Mixture Aim
        var columns = [
            'Time',
            'Engine Speed',
            'Inlet Manifold Pressure',
            'Exhaust Lambda',
            'Fuel Mixture Aim',
            'Fuel Closed Loop Control Bank 1 Trim',
            'Fuel Closed Loop Control Bank 2 Trim'
        ];
        var values = ['0.001', '1000', '100', '1.0', '1.0', '0.5', '-0.3'];
        var csv = buildCsv(columns, values);
        var result = parseLog(csv, noop);
        assert.ok(result.samples.length > 0);
        // lambdaAvg should be used (non-NaN)
        assert.ok(!isNaN(result.samples[0].lambdaAvg));
    });

    // ----- Test 5: Both lambda banks absent AND Avg absent — throws -----
    it('both lambda banks absent and Avg also absent — throws error', function () {
        // Only: Time, Engine Speed, Inlet Manifold Pressure, Fuel Mixture Aim
        var columns = [
            'Time',
            'Engine Speed',
            'Inlet Manifold Pressure',
            'Fuel Mixture Aim',
            'Fuel Closed Loop Control Bank 1 Trim',
            'Fuel Closed Loop Control Bank 2 Trim'
        ];
        var values = ['0.001', '1000', '100', '1.0', '0.5', '-0.3'];
        var csv = buildCsv(columns, values);
        assert.throws(function () { parseLog(csv, noop); }, 'lambda');
    });

    // ----- Test 6: CL trim B1 missing emits warning -----
    it('CL trim B1 missing — emits warning', function () {
        var columns = [
            'Time',
            'Engine Speed',
            'Inlet Manifold Pressure',
            'Exhaust Lambda',
            'Fuel Mixture Aim',
            'Fuel Closed Loop Control Bank 2 Trim'
        ];
        var values = ['0.001', '1000', '100', '1.0', '1.0', '-0.3'];
        var csv = buildCsv(columns, values);
        var result = parseLog(csv, noop);
        assert.ok(result.samples.length > 0);
        // Should have a warning about Bank 1 Trim
        var hasB1Warning = result.channelWarnings.some(function (w) {
            return w.indexOf('Bank 1 Trim') !== -1;
        });
        assert.ok(hasB1Warning, 'Expected a warning about missing CL_Trim_B1');
    });

    // ----- Test 7: CL trim B2 missing emits warning -----
    it('CL trim B2 missing — emits warning', function () {
        var columns = [
            'Time',
            'Engine Speed',
            'Inlet Manifold Pressure',
            'Exhaust Lambda',
            'Fuel Mixture Aim',
            'Fuel Closed Loop Control Bank 1 Trim'
        ];
        var values = ['0.001', '1000', '100', '1.0', '1.0', '0.5'];
        var csv = buildCsv(columns, values);
        var result = parseLog(csv, noop);
        assert.ok(result.samples.length > 0);
        // Should have a warning about Bank 2 Trim
        var hasB2Warning = result.channelWarnings.some(function (w) {
            return w.indexOf('Bank 2 Trim') !== -1;
        });
        assert.ok(hasB2Warning, 'Expected a warning about missing CL_Trim_B2');
    });
});
