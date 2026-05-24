/**
 * Unit tests for generateDiagnostics function.
 * Run with: node tests/test-diagnostics.js
 */

// Extract the function from worker.js by loading it in a simulated environment
const fs = require('fs');
const vm = require('vm');

const workerCode = fs.readFileSync(__dirname + '/../knock/worker.js', 'utf8');

// Create a sandbox with a mock self object
const sandbox = {
    self: { onmessage: null, postMessage: function() {} },
    postMessage: function() {},
    Math: Math,
    String: String,
    Array: Array,
    Float64Array: Float64Array,
    DataView: DataView,
    Map: Map,
    Object: Object,
    console: console,
    NaN: NaN,
    isNaN: isNaN,
    parseFloat: parseFloat,
    Infinity: Infinity,
    Number: Number
};

vm.createContext(sandbox);
vm.runInContext(workerCode, sandbox);

// Get the function from the sandbox
const generateDiagnostics = sandbox.generateDiagnostics;

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + message);
    }
}

// Test 1: Zero total events returns "no knock events" message
console.log('Test 1: Zero total events');
const dist1 = {
    counts: [0, 0, 0, 0, 0, 0, 0, 0],
    percentages: [0, 0, 0, 0, 0, 0, 0, 0],
    total: 0,
    ranking: [1, 2, 3, 4, 5, 6, 7, 8]
};
const worst1 = { worstRpmBin: null, worstLoadBin: null, worstGear: null };
const result1 = generateDiagnostics(dist1, worst1, null);
assert(result1.length === 1, 'Should return exactly 1 message, got ' + result1.length);
assert(result1[0] === 'No knock events detected at the current threshold.', 'Message should match expected text, got: ' + result1[0]);

// Test 2: Single cylinder with all events, RPM and load data available
console.log('Test 2: Single cylinder with RPM and load data');
const dist2 = {
    counts: [0, 0, 10, 0, 0, 0, 0, 0],
    percentages: [0, 0, 100, 0, 0, 0, 0, 0],
    total: 10,
    ranking: [3, 1, 2, 4, 5, 6, 7, 8]
};
const worst2 = {
    worstRpmBin: { binIndex: 6, rpmRange: '3000-3500 RPM', count: 10 },
    worstLoadBin: { binIndex: 15, loadRange: '150-160 kPa', count: 10 },
    worstGear: { gear: 3, count: 10 }
};
const result2 = generateDiagnostics(dist2, worst2, null);
assert(result2.length === 3, 'Should return 3 messages, got ' + result2.length);
assert(result2[0] === 'Cylinder 3 has the highest knock activity at 100% of total events.', 'Cylinder message mismatch: ' + result2[0]);
assert(result2[1] === 'Most knock events occur in the 3000-3500 RPM RPM band (10 events).', 'RPM message mismatch: ' + result2[1]);
assert(result2[2] === 'Most knock events occur in the 150-160 kPa load range (10 events).', 'Load message mismatch: ' + result2[2]);

// Test 3: Events present but no RPM data (worstRpmBin is null)
console.log('Test 3: No RPM data available');
const dist3 = {
    counts: [5, 3, 0, 0, 0, 0, 0, 0],
    percentages: [62.5, 37.5, 0, 0, 0, 0, 0, 0],
    total: 8,
    ranking: [1, 2, 3, 4, 5, 6, 7, 8]
};
const worst3 = {
    worstRpmBin: null,
    worstLoadBin: { binIndex: 20, loadRange: '200-210 kPa', count: 8 },
    worstGear: null
};
const result3 = generateDiagnostics(dist3, worst3, null);
assert(result3.length === 2, 'Should return 2 messages (no RPM), got ' + result3.length);
assert(result3[0] === 'Cylinder 1 has the highest knock activity at 62.5% of total events.', 'Cylinder message mismatch: ' + result3[0]);
assert(result3[1] === 'Most knock events occur in the 200-210 kPa load range (8 events).', 'Load message mismatch: ' + result3[1]);

// Test 4: Events present but no load data (worstLoadBin is null)
console.log('Test 4: No load data available');
const dist4 = {
    counts: [0, 0, 0, 0, 7, 0, 0, 0],
    percentages: [0, 0, 0, 0, 100, 0, 0, 0],
    total: 7,
    ranking: [5, 1, 2, 3, 4, 6, 7, 8]
};
const worst4 = {
    worstRpmBin: { binIndex: 10, rpmRange: '5000-5500 RPM', count: 7 },
    worstLoadBin: null,
    worstGear: null
};
const result4 = generateDiagnostics(dist4, worst4, null);
assert(result4.length === 2, 'Should return 2 messages (no load), got ' + result4.length);
assert(result4[0] === 'Cylinder 5 has the highest knock activity at 100% of total events.', 'Cylinder message mismatch: ' + result4[0]);
assert(result4[1] === 'Most knock events occur in the 5000-5500 RPM RPM band (7 events).', 'RPM message mismatch: ' + result4[1]);

// Test 5: Both RPM and load null — only cylinder message
console.log('Test 5: No RPM and no load data');
const dist5 = {
    counts: [2, 2, 0, 0, 0, 0, 0, 0],
    percentages: [50, 50, 0, 0, 0, 0, 0, 0],
    total: 4,
    ranking: [1, 2, 3, 4, 5, 6, 7, 8]
};
const worst5 = {
    worstRpmBin: null,
    worstLoadBin: null,
    worstGear: null
};
const result5 = generateDiagnostics(dist5, worst5, null);
assert(result5.length === 1, 'Should return 1 message (only cylinder), got ' + result5.length);
assert(result5[0] === 'Cylinder 1 has the highest knock activity at 50% of total events.', 'Cylinder message mismatch: ' + result5[0]);

// Test 6: retardStats provided (should not affect output currently)
console.log('Test 6: retardStats provided');
const dist6 = {
    counts: [0, 0, 0, 0, 0, 0, 3, 5],
    percentages: [0, 0, 0, 0, 0, 0, 37.5, 62.5],
    total: 8,
    ranking: [8, 7, 1, 2, 3, 4, 5, 6]
};
const worst6 = {
    worstRpmBin: { binIndex: 4, rpmRange: '2000-2500 RPM', count: 5 },
    worstLoadBin: { binIndex: 8, loadRange: '80-90 kPa', count: 6 },
    worstGear: null
};
const retard6 = { nonZeroCount: 10, maxRetard: 3.5, meanDuringKnock: 1.2, timeSeries: { time: [], values: [] } };
const result6 = generateDiagnostics(dist6, worst6, retard6);
assert(result6.length === 3, 'Should return 3 messages, got ' + result6.length);
assert(result6[0] === 'Cylinder 8 has the highest knock activity at 62.5% of total events.', 'Cylinder message mismatch: ' + result6[0]);

// Summary
console.log('\n--- Results ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed!');
}
