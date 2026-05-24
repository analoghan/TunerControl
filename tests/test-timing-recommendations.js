/**
 * Unit tests for computeTimingRecommendations function.
 * Run with: node tests/test-timing-recommendations.js
 * Validates: Requirements 9.1, 9.2, 9.3, 9.5
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

const computeTimingRecommendations = sandbox.computeTimingRecommendations;

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error('  FAIL: ' + message);
    }
}

function assertApprox(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) <= tolerance) {
        passed++;
    } else {
        failed++;
        console.error('  FAIL: ' + message + ' (expected ' + expected + ', got ' + actual + ')');
    }
}

// Test 1: Total is zero — return empty array
console.log('Test 1: Total is zero returns empty array');
const result1 = computeTimingRecommendations({ counts: [0, 0, 0, 0, 0, 0, 0, 0], total: 0 });
assert(Array.isArray(result1), 'Should return an array');
assert(result1.length === 0, 'Should return empty array when total is 0');

// Test 2: All cylinders equal counts — all get 0 degrees
console.log('Test 2: All cylinders equal counts');
const result2 = computeTimingRecommendations({ counts: [5, 5, 5, 5, 5, 5, 5, 5], total: 40 });
assert(result2.length === 8, 'Should return 8 recommendations');
for (let i = 0; i < 8; i++) {
    assert(result2[i].cylinderIndex === i + 1, 'Cylinder index should be ' + (i + 1));
    assert(result2[i].reductionDeg === 0, 'All should be 0 when counts are equal');
}

// Test 3: One cylinder has all events, rest have zero
console.log('Test 3: One cylinder has all events');
const result3 = computeTimingRecommendations({ counts: [10, 0, 0, 0, 0, 0, 0, 0], total: 10 });
assert(result3.length === 8, 'Should return 8 recommendations');
assert(result3[0].reductionDeg === 5, 'Cylinder 1 (max) should get 5 degrees');
for (let i = 1; i < 8; i++) {
    assert(result3[i].reductionDeg === 0, 'Cylinder ' + (i + 1) + ' (min) should get 0 degrees');
}

// Test 4: Proportional scaling
console.log('Test 4: Proportional scaling');
// counts: [0, 5, 10, 15, 20, 25, 30, 35]
// minCount = 0, maxCount = 35
// cyl1: (0-0)/(35-0)*5 = 0
// cyl2: (5-0)/(35-0)*5 = 0.714... → 0.7
// cyl3: (10-0)/(35-0)*5 = 1.428... → 1.4
// cyl4: (15-0)/(35-0)*5 = 2.142... → 2.1
// cyl5: (20-0)/(35-0)*5 = 2.857... → 2.9
// cyl6: (25-0)/(35-0)*5 = 3.571... → 3.6
// cyl7: (30-0)/(35-0)*5 = 4.285... → 4.3
// cyl8: (35-0)/(35-0)*5 = 5.0
const result4 = computeTimingRecommendations({ counts: [0, 5, 10, 15, 20, 25, 30, 35], total: 140 });
assertApprox(result4[0].reductionDeg, 0, 0.01, 'Cyl 1 should be 0');
assertApprox(result4[1].reductionDeg, 0.7, 0.01, 'Cyl 2 should be 0.7');
assertApprox(result4[2].reductionDeg, 1.4, 0.01, 'Cyl 3 should be 1.4');
assertApprox(result4[3].reductionDeg, 2.1, 0.01, 'Cyl 4 should be 2.1');
assertApprox(result4[4].reductionDeg, 2.9, 0.01, 'Cyl 5 should be 2.9');
assertApprox(result4[5].reductionDeg, 3.6, 0.01, 'Cyl 6 should be 3.6');
assertApprox(result4[6].reductionDeg, 4.3, 0.01, 'Cyl 7 should be 4.3');
assertApprox(result4[7].reductionDeg, 5.0, 0.01, 'Cyl 8 should be 5.0');

// Test 5: Cap at 5 degrees (formula naturally caps since max ratio is 1.0 * 5 = 5)
console.log('Test 5: Cap at 5 degrees');
const result5 = computeTimingRecommendations({ counts: [1, 100, 1, 1, 1, 1, 1, 1], total: 107 });
assert(result5[1].reductionDeg === 5, 'Max cylinder should be capped at 5');
assert(result5[0].reductionDeg === 0, 'Min cylinder should be 0');

// Test 6: Cylinder with fewest events gets 0
console.log('Test 6: Cylinder with fewest events gets 0');
// minCount = 3 (cyl 4), maxCount = 20 (cyl 1)
const result6 = computeTimingRecommendations({ counts: [20, 10, 5, 3, 8, 15, 12, 7], total: 80 });
assert(result6[3].reductionDeg === 0, 'Cylinder 4 (fewest) should get 0 degrees');
assert(result6[0].reductionDeg === 5, 'Cylinder 1 (most) should get 5 degrees');
// cyl2: (10-3)/(20-3)*5 = 7/17*5 = 2.058... → 2.1
assertApprox(result6[1].reductionDeg, 2.1, 0.01, 'Cyl 2 should be ~2.1');

// Test 7: Output structure
console.log('Test 7: Output structure');
const result7 = computeTimingRecommendations({ counts: [10, 5, 3, 8, 2, 7, 6, 4], total: 45 });
assert(result7.length === 8, 'Should always return 8 recommendations');
for (let i = 0; i < 8; i++) {
    assert(result7[i].cylinderIndex === i + 1, 'cylinderIndex should be ' + (i + 1));
    assert(typeof result7[i].reductionDeg === 'number', 'reductionDeg should be a number');
    assert(result7[i].reductionDeg >= 0, 'reductionDeg should be >= 0');
    assert(result7[i].reductionDeg <= 5, 'reductionDeg should be <= 5');
}

// Summary
console.log('\n--- Results ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed!');
}
