/**
 * Tests for knock/worker.js computeTimingCorrelation() — timing correlation analysis.
 * Validates Requirements 5.2, 5.3
 */
const fs = require('fs');
const path = require('path');

// Load knock worker.js and extract functions for testing
const workerCode = fs.readFileSync(path.join(__dirname, '..', 'knock', 'worker.js'), 'utf8');
// Remove the self.onmessage block that references 'self'
const safeCode = workerCode.replace(/self\.onmessage\s*=\s*function[\s\S]*$/, '');
eval(safeCode);

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('  \u2713 ' + name); }
    catch(e) { failed++; console.log('  \u2717 ' + name + ': ' + e.message); }
}

console.log('computeTimingCorrelation — basic structure:');

check('returns perRpmBin with 15 entries', function() {
    var result = computeTimingCorrelation([]);
    if (result.perRpmBin.length !== 15) throw new Error('Expected 15 entries, got ' + result.perRpmBin.length);
});

check('returns perCylinder with 8 entries', function() {
    var result = computeTimingCorrelation([]);
    if (result.perCylinder.length !== 8) throw new Error('Expected 8 entries, got ' + result.perCylinder.length);
});

check('empty events returns all zeros', function() {
    var result = computeTimingCorrelation([]);
    for (var i = 0; i < 15; i++) {
        if (result.perRpmBin[i].mean !== 0) throw new Error('perRpmBin[' + i + '].mean expected 0');
        if (result.perRpmBin[i].max !== 0) throw new Error('perRpmBin[' + i + '].max expected 0');
        if (result.perRpmBin[i].count !== 0) throw new Error('perRpmBin[' + i + '].count expected 0');
    }
    for (var j = 0; j < 8; j++) {
        if (result.perCylinder[j].mean !== 0) throw new Error('perCylinder[' + j + '].mean expected 0');
        if (result.perCylinder[j].max !== 0) throw new Error('perCylinder[' + j + '].max expected 0');
        if (result.perCylinder[j].count !== 0) throw new Error('perCylinder[' + j + '].count expected 0');
    }
});

console.log('\ncomputeTimingCorrelation — per RPM bin:');

check('single event in RPM bin 2 (1000-1500 RPM)', function() {
    var events = [
        { rpm: 1200, cylinderIndex: 1, ignTiming: 25 }
    ];
    var result = computeTimingCorrelation(events);
    // RPM 1200 → bin 2 (floor(1200/500) = 2)
    if (result.perRpmBin[2].mean !== 25) throw new Error('mean expected 25, got ' + result.perRpmBin[2].mean);
    if (result.perRpmBin[2].max !== 25) throw new Error('max expected 25, got ' + result.perRpmBin[2].max);
    if (result.perRpmBin[2].count !== 1) throw new Error('count expected 1, got ' + result.perRpmBin[2].count);
});

check('multiple events in same RPM bin compute correct mean and max', function() {
    var events = [
        { rpm: 3100, cylinderIndex: 1, ignTiming: 20 },
        { rpm: 3200, cylinderIndex: 2, ignTiming: 30 },
        { rpm: 3400, cylinderIndex: 3, ignTiming: 25 }
    ];
    var result = computeTimingCorrelation(events);
    // RPM 3100-3400 → bin 6 (floor(3100/500)=6, floor(3200/500)=6, floor(3400/500)=6)
    if (result.perRpmBin[6].count !== 3) throw new Error('count expected 3, got ' + result.perRpmBin[6].count);
    if (result.perRpmBin[6].max !== 30) throw new Error('max expected 30, got ' + result.perRpmBin[6].max);
    var expectedMean = (20 + 30 + 25) / 3;
    if (Math.abs(result.perRpmBin[6].mean - expectedMean) > 0.0001) throw new Error('mean expected ' + expectedMean + ', got ' + result.perRpmBin[6].mean);
});

check('events in different RPM bins are separated correctly', function() {
    var events = [
        { rpm: 1000, cylinderIndex: 1, ignTiming: 15 },
        { rpm: 5000, cylinderIndex: 2, ignTiming: 35 }
    ];
    var result = computeTimingCorrelation(events);
    // RPM 1000 → bin 2, RPM 5000 → bin 10
    if (result.perRpmBin[2].count !== 1) throw new Error('bin 2 count expected 1');
    if (result.perRpmBin[2].mean !== 15) throw new Error('bin 2 mean expected 15');
    if (result.perRpmBin[10].count !== 1) throw new Error('bin 10 count expected 1');
    if (result.perRpmBin[10].mean !== 35) throw new Error('bin 10 mean expected 35');
});

console.log('\ncomputeTimingCorrelation — per cylinder:');

check('single event for cylinder 3', function() {
    var events = [
        { rpm: 2000, cylinderIndex: 3, ignTiming: 22 }
    ];
    var result = computeTimingCorrelation(events);
    // cylinderIndex 3 → index 2
    if (result.perCylinder[2].mean !== 22) throw new Error('mean expected 22, got ' + result.perCylinder[2].mean);
    if (result.perCylinder[2].max !== 22) throw new Error('max expected 22, got ' + result.perCylinder[2].max);
    if (result.perCylinder[2].count !== 1) throw new Error('count expected 1, got ' + result.perCylinder[2].count);
});

check('multiple events for same cylinder compute correct stats', function() {
    var events = [
        { rpm: 2000, cylinderIndex: 5, ignTiming: 10 },
        { rpm: 3000, cylinderIndex: 5, ignTiming: 20 },
        { rpm: 4000, cylinderIndex: 5, ignTiming: 30 }
    ];
    var result = computeTimingCorrelation(events);
    // cylinderIndex 5 → index 4
    if (result.perCylinder[4].count !== 3) throw new Error('count expected 3, got ' + result.perCylinder[4].count);
    if (result.perCylinder[4].max !== 30) throw new Error('max expected 30, got ' + result.perCylinder[4].max);
    var expectedMean = (10 + 20 + 30) / 3;
    if (Math.abs(result.perCylinder[4].mean - expectedMean) > 0.0001) throw new Error('mean expected ' + expectedMean + ', got ' + result.perCylinder[4].mean);
});

check('events for different cylinders are separated', function() {
    var events = [
        { rpm: 2000, cylinderIndex: 1, ignTiming: 10 },
        { rpm: 2000, cylinderIndex: 8, ignTiming: 40 }
    ];
    var result = computeTimingCorrelation(events);
    if (result.perCylinder[0].count !== 1) throw new Error('cyl 1 count expected 1');
    if (result.perCylinder[0].mean !== 10) throw new Error('cyl 1 mean expected 10');
    if (result.perCylinder[7].count !== 1) throw new Error('cyl 8 count expected 1');
    if (result.perCylinder[7].mean !== 40) throw new Error('cyl 8 mean expected 40');
});

console.log('\ncomputeTimingCorrelation — null handling:');

check('events with null ignTiming are skipped', function() {
    var events = [
        { rpm: 2000, cylinderIndex: 1, ignTiming: null },
        { rpm: 2000, cylinderIndex: 1, ignTiming: 20 }
    ];
    var result = computeTimingCorrelation(events);
    // Only one event should be counted (the one with ignTiming = 20)
    if (result.perCylinder[0].count !== 1) throw new Error('count expected 1, got ' + result.perCylinder[0].count);
    if (result.perCylinder[0].mean !== 20) throw new Error('mean expected 20, got ' + result.perCylinder[0].mean);
});

check('events with null rpm are skipped for perRpmBin but counted for perCylinder', function() {
    var events = [
        { rpm: null, cylinderIndex: 2, ignTiming: 15 }
    ];
    var result = computeTimingCorrelation(events);
    // Should not appear in any RPM bin
    for (var i = 0; i < 15; i++) {
        if (result.perRpmBin[i].count !== 0) throw new Error('perRpmBin[' + i + '] should have count 0');
    }
    // Should appear in cylinder 2 (index 1)
    if (result.perCylinder[1].count !== 1) throw new Error('perCylinder[1] count expected 1');
    if (result.perCylinder[1].mean !== 15) throw new Error('perCylinder[1] mean expected 15');
});

check('all events with null ignTiming results in zeros', function() {
    var events = [
        { rpm: 2000, cylinderIndex: 1, ignTiming: null },
        { rpm: 3000, cylinderIndex: 2, ignTiming: null }
    ];
    var result = computeTimingCorrelation(events);
    for (var i = 0; i < 15; i++) {
        if (result.perRpmBin[i].count !== 0) throw new Error('perRpmBin[' + i + '] should have count 0');
    }
    for (var j = 0; j < 8; j++) {
        if (result.perCylinder[j].count !== 0) throw new Error('perCylinder[' + j + '] should have count 0');
    }
});

console.log('\ncomputeTimingCorrelation — edge cases:');

check('RPM at bin boundary (exactly 500) goes to bin 1', function() {
    var events = [
        { rpm: 500, cylinderIndex: 1, ignTiming: 18 }
    ];
    var result = computeTimingCorrelation(events);
    // floor(500/500) = 1
    if (result.perRpmBin[1].count !== 1) throw new Error('bin 1 count expected 1, got ' + result.perRpmBin[1].count);
});

check('RPM at max (7500) clamps to bin 14', function() {
    var events = [
        { rpm: 7500, cylinderIndex: 1, ignTiming: 12 }
    ];
    var result = computeTimingCorrelation(events);
    if (result.perRpmBin[14].count !== 1) throw new Error('bin 14 count expected 1, got ' + result.perRpmBin[14].count);
    if (result.perRpmBin[14].mean !== 12) throw new Error('bin 14 mean expected 12');
});

check('negative ignTiming values are handled correctly', function() {
    var events = [
        { rpm: 2000, cylinderIndex: 1, ignTiming: -5 },
        { rpm: 2000, cylinderIndex: 1, ignTiming: 10 }
    ];
    var result = computeTimingCorrelation(events);
    // bin 4 (floor(2000/500)=4)
    if (result.perRpmBin[4].count !== 2) throw new Error('count expected 2');
    if (result.perRpmBin[4].max !== 10) throw new Error('max expected 10, got ' + result.perRpmBin[4].max);
    var expectedMean = (-5 + 10) / 2;
    if (Math.abs(result.perRpmBin[4].mean - expectedMean) > 0.0001) throw new Error('mean expected ' + expectedMean);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
