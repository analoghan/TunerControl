/**
 * test-ve-parser.js — Unit tests for VE_Parser (parseVETable).
 * Implemented in task 2.4.
 */

describe('VE_Parser — parseVETable', function () {

  // 1. Valid M1 v2 file parses correctly (small 3×3 grid)
  it('parses a valid M1 v2 CSV with correct breakpoints and values', function () {
    // Build a minimal valid M1 v2 CSV: 4-row header + RPM row + 3 MAP data rows
    var lines = [
      'M1,v2',
      'Body,%',
      'Cols,rpm,Eng Speed',
      'Rows,kPa,Inlet Man Pres',
      ',"5.00000000000000000e+02","1.00000000000000000e+03","1.50000000000000000e+03"',
      '"2.00000000000000000e+01","5.72041153907775879e+01","6.10000000000000000e+01","6.50000000000000000e+01"',
      '"3.00000000000000000e+01","7.00000000000000000e+01","7.50000000000000000e+01","8.00000000000000000e+01"',
      '"4.00000000000000000e+01","8.20000000000000000e+01","8.70000000000000000e+01","9.20000000000000000e+01"'
    ];
    var csv = lines.join('\n');

    var result = parseVETable(csv);

    // RPM breakpoints: 500, 1000, 1500 (rounded from scientific notation)
    assert.equal(result.rpmBreakpoints.length, 3);
    assert.equal(result.rpmBreakpoints[0], 500);
    assert.equal(result.rpmBreakpoints[1], 1000);
    assert.equal(result.rpmBreakpoints[2], 1500);

    // MAP breakpoints: 20, 30, 40 (rounded from scientific notation)
    assert.equal(result.mapBreakpoints.length, 3);
    assert.equal(result.mapBreakpoints[0], 20);
    assert.equal(result.mapBreakpoints[1], 30);
    assert.equal(result.mapBreakpoints[2], 40);

    // VE values: check first row values
    assert.equal(result.values.length, 3);
    assert.equal(result.values[0].length, 3);
    assert.closeTo(result.values[0][0], 57.2041153907775879, 1e-9);
    assert.closeTo(result.values[0][1], 61.0, 1e-9);
    assert.closeTo(result.values[0][2], 65.0, 1e-9);

    // Check second row
    assert.closeTo(result.values[1][0], 70.0, 1e-9);
    assert.closeTo(result.values[1][1], 75.0, 1e-9);
    assert.closeTo(result.values[1][2], 80.0, 1e-9);

    // Raw strings are preserved
    assert.ok(result.rpmRawStrings.length === 3);
    assert.ok(result.mapRawStrings.length === 3);
    assert.ok(result.valueRawStrings.length === 3);
    assert.ok(result.valueRawStrings[0].length === 3);
  });

  // 2. Wrong header throws
  it('throws an error when CSV does not start with M1,v2', function () {
    var csv = 'WRONG,HEADER\nBody,%\nCols,rpm,Eng Speed\nRows,kPa,Inlet Man Pres\n,500\n20,50';
    assert.throws(function () {
      parseVETable(csv);
    }, 'M1');
  });

  it('throws an error when first field is empty', function () {
    var csv = ',v2\nBody,%\nCols,rpm,Eng Speed\nRows,kPa,Inlet Man Pres\n,500\n20,50';
    assert.throws(function () {
      parseVETable(csv);
    }, 'M1');
  });

  // 3. Non-numeric cell throws
  it('throws an error when a VE data cell is non-numeric', function () {
    var lines = [
      'M1,v2',
      'Body,%',
      'Cols,rpm,Eng Speed',
      'Rows,kPa,Inlet Man Pres',
      ',"5.00000000000000000e+02","1.00000000000000000e+03"',
      '"2.00000000000000000e+01","5.72041153907775879e+01","abc"'
    ];
    var csv = lines.join('\n');

    assert.throws(function () {
      parseVETable(csv);
    }, 'non-numeric');
  });

  it('throws an error when a MAP breakpoint is non-numeric', function () {
    var lines = [
      'M1,v2',
      'Body,%',
      'Cols,rpm,Eng Speed',
      'Rows,kPa,Inlet Man Pres',
      ',"5.00000000000000000e+02"',
      '"bad","5.72041153907775879e+01"'
    ];
    var csv = lines.join('\n');

    assert.throws(function () {
      parseVETable(csv);
    }, 'non-numeric');
  });

  // 4. Grid is 24 rows × 20 cols
  it('correctly parses a full 24×20 grid and verifies dimensions', function () {
    // Build a full-size M1 v2 CSV with 20 RPM breakpoints and 24 MAP breakpoints
    var rpmValues = [0, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000,
                     3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000];
    var mapValues = [10, 15, 20, 25, 30, 35, 40, 50, 55, 60,
                     70, 80, 90, 100, 110, 120, 140, 160, 180, 200,
                     220, 240, 260, 280];

    // Header rows
    var lines = [
      'M1,v2',
      'Body,%',
      'Cols,rpm,Eng Speed',
      'Rows,kPa,Inlet Man Pres'
    ];

    // RPM breakpoints row (row 4): empty label + 20 RPM values in scientific notation
    var rpmRow = '';
    for (var r = 0; r < rpmValues.length; r++) {
      rpmRow += ',"' + rpmValues[r].toExponential(17) + '"';
    }
    lines.push(rpmRow);

    // Data rows (24 MAP rows × 20 VE values)
    for (var m = 0; m < mapValues.length; m++) {
      var row = '"' + mapValues[m].toExponential(17) + '"';
      for (var c = 0; c < rpmValues.length; c++) {
        // Use a deterministic VE value based on position
        var veVal = 50 + m * 2 + c * 0.5;
        row += ',"' + veVal.toExponential(17) + '"';
      }
      lines.push(row);
    }

    var csv = lines.join('\n');
    var result = parseVETable(csv);

    // Verify dimensions
    assert.equal(result.rpmBreakpoints.length, 20);
    assert.equal(result.mapBreakpoints.length, 24);
    assert.equal(result.values.length, 24);
    assert.equal(result.values[0].length, 20);
    assert.equal(result.values[23].length, 20);

    // Verify breakpoint values
    assert.equal(result.rpmBreakpoints[0], 0);
    assert.equal(result.rpmBreakpoints[19], 8000);
    assert.equal(result.mapBreakpoints[0], 10);
    assert.equal(result.mapBreakpoints[23], 280);

    // Verify a sample VE value
    assert.closeTo(result.values[0][0], 50.0, 1e-9);
    assert.closeTo(result.values[23][19], 50 + 23 * 2 + 19 * 0.5, 1e-9);
  });

});
