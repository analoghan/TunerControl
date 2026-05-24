/**
 * Tests for knock/worker.js computeTimingRetardStats() — timing retard statistics.
 * Validates Requirements 6.2, 6.3, 6.4, 6.5
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

console.log('computeTimingRetardStats — channel unavailable:');

check('returns null when ign_timing_comp is -1', function() {
    var data = [[0, 1, 2], [1, 3, 4]];
    var channels = { ign_timing_comp: -1 };
    var events = [];
    var result = computeTimingRetardStats(data, channels, events);
    if (result !== null) throw new Error('Expected null, got ' + JSON.stringify(result));
});

console.log('\ncomputeTimingRetardStats — nonZeroCount (Req 6.2):');

check('counts non-zero timing comp samples correctly', function() {
    // Column 0 = time, column 1 = timing comp
    var data = [
        [0.0, 0],
        [0.1, 2],
        [0.2, 0],
        [0.3, 3],
        [0.4, 1]
    ];
    var channels = { ign_timing_comp: 1 };
    var events = [];
    var result = computeTimingRetardStats(data, channels, events);
    if (result.nonZeroCount !== 3) throw new Error('Expected 3, got ' + result.nonZeroCount);
});

check('all zeros gives nonZeroCount of 0', function() {
    var data = [[0, 0], [1, 0], [2, 0]];
    var channels = { ign_timing_comp: 1 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.nonZeroCount !== 0) throw new Error('Expected 0, got ' + result.nonZeroCount);
});

check('all non-zero gives nonZeroCount equal to data length', function() {
    var data = [[0, 1], [1, 2], [2, 3]];
    var channels = { ign_timing_comp: 1 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.nonZeroCount !== 3) throw new Error('Expected 3, got ' + result.nonZeroCount);
});

console.log('\ncomputeTimingRetardStats — maxRetard (Req 6.3):');

check('finds maximum timing comp value', function() {
    var data = [[0, 1], [1, 5], [2, 3], [3, 2]];
    var channels = { ign_timing_comp: 1 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.maxRetard !== 5) throw new Error('Expected 5, got ' + result.maxRetard);
});

check('handles negative values correctly', function() {
    var data = [[0, -2], [1, -5], [2, -1]];
    var channels = { ign_timing_comp: 1 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.maxRetard !== -1) throw new Error('Expected -1, got ' + result.maxRetard);
});

check('single data row returns that value as max', function() {
    var data = [[0, 7]];
    var channels = { ign_timing_comp: 1 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.maxRetard !== 7) throw new Error('Expected 7, got ' + result.maxRetard);
});

console.log('\ncomputeTimingRetardStats — meanDuringKnock (Req 6.4):');

check('computes mean of ignTimingComp from events', function() {
    var data = [[0, 1], [1, 2], [2, 3]];
    var channels = { ign_timing_comp: 1 };
    var events = [
        { ignTimingComp: 2 },
        { ignTimingComp: 4 },
        { ignTimingComp: 6 }
    ];
    var result = computeTimingRetardStats(data, channels, events);
    if (result.meanDuringKnock !== 4) throw new Error('Expected 4, got ' + result.meanDuringKnock);
});

check('skips null ignTimingComp values in events', function() {
    var data = [[0, 1], [1, 2]];
    var channels = { ign_timing_comp: 1 };
    var events = [
        { ignTimingComp: null },
        { ignTimingComp: 10 },
        { ignTimingComp: null },
        { ignTimingComp: 20 }
    ];
    var result = computeTimingRetardStats(data, channels, events);
    // Mean of [10, 20] = 15
    if (result.meanDuringKnock !== 15) throw new Error('Expected 15, got ' + result.meanDuringKnock);
});

check('returns 0 when all events have null ignTimingComp', function() {
    var data = [[0, 1]];
    var channels = { ign_timing_comp: 1 };
    var events = [
        { ignTimingComp: null },
        { ignTimingComp: null }
    ];
    var result = computeTimingRetardStats(data, channels, events);
    if (result.meanDuringKnock !== 0) throw new Error('Expected 0, got ' + result.meanDuringKnock);
});

check('returns 0 when events array is empty', function() {
    var data = [[0, 5], [1, 10]];
    var channels = { ign_timing_comp: 1 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.meanDuringKnock !== 0) throw new Error('Expected 0, got ' + result.meanDuringKnock);
});

console.log('\ncomputeTimingRetardStats — timeSeries (Req 6.1):');

check('builds time series arrays from all data rows', function() {
    var data = [[0.0, 1], [0.5, 2], [1.0, 3]];
    var channels = { ign_timing_comp: 1 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.timeSeries.time.length !== 3) throw new Error('Expected 3 time entries, got ' + result.timeSeries.time.length);
    if (result.timeSeries.values.length !== 3) throw new Error('Expected 3 value entries, got ' + result.timeSeries.values.length);
    if (result.timeSeries.time[0] !== 0.0) throw new Error('time[0] expected 0.0');
    if (result.timeSeries.time[1] !== 0.5) throw new Error('time[1] expected 0.5');
    if (result.timeSeries.time[2] !== 1.0) throw new Error('time[2] expected 1.0');
    if (result.timeSeries.values[0] !== 1) throw new Error('values[0] expected 1');
    if (result.timeSeries.values[1] !== 2) throw new Error('values[1] expected 2');
    if (result.timeSeries.values[2] !== 3) throw new Error('values[2] expected 3');
});

check('timing comp at different column index', function() {
    // Column 0 = time, column 1 = rpm, column 2 = timing comp
    var data = [[0.0, 3000, 5], [0.1, 3100, 0], [0.2, 3200, 8]];
    var channels = { ign_timing_comp: 2 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.timeSeries.values[0] !== 5) throw new Error('values[0] expected 5, got ' + result.timeSeries.values[0]);
    if (result.timeSeries.values[1] !== 0) throw new Error('values[1] expected 0, got ' + result.timeSeries.values[1]);
    if (result.timeSeries.values[2] !== 8) throw new Error('values[2] expected 8, got ' + result.timeSeries.values[2]);
    if (result.nonZeroCount !== 2) throw new Error('nonZeroCount expected 2, got ' + result.nonZeroCount);
    if (result.maxRetard !== 8) throw new Error('maxRetard expected 8, got ' + result.maxRetard);
});

console.log('\ncomputeTimingRetardStats — empty data:');

check('empty data array returns zero stats with empty time series', function() {
    var data = [];
    var channels = { ign_timing_comp: 1 };
    var result = computeTimingRetardStats(data, channels, []);
    if (result.nonZeroCount !== 0) throw new Error('nonZeroCount expected 0');
    if (result.maxRetard !== 0) throw new Error('maxRetard expected 0, got ' + result.maxRetard);
    if (result.meanDuringKnock !== 0) throw new Error('meanDuringKnock expected 0');
    if (result.timeSeries.time.length !== 0) throw new Error('time series should be empty');
    if (result.timeSeries.values.length !== 0) throw new Error('values series should be empty');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
