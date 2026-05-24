/**
 * Unit tests for computeCylinderDistribution function.
 * Run with: node tests/test-cylinder-distribution.js
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
    Infinity: Infinity
};

vm.createContext(sandbox);
vm.runInContext(workerCode, sandbox);

// Get the function from the sandbox
const computeCylinderDistribution = sandbox.computeCylinderDistribution;

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

function assertArrayEqual(actual, expected, message) {
    const eq = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
    assert(eq, message + ' — got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

// Test 1: Empty events array
console.log('Test 1: Empty events array');
const result1 = computeCylinderDistribution([]);
assert(result1.total === 0, 'Total should be 0');
assertArrayEqual(result1.counts, [0, 0, 0, 0, 0, 0, 0, 0], 'All counts should be 0');
assertArrayEqual(result1.percentages, [0, 0, 0, 0, 0, 0, 0, 0], 'All percentages should be 0 when total is 0');
assert(result1.ranking.length === 8, 'Ranking should have 8 elements');
// With all zeros, ranking should be ascending (tie-break)
assertArrayEqual(result1.ranking, [1, 2, 3, 4, 5, 6, 7, 8], 'Ranking with all zeros should be ascending');

// Test 2: Events on single cylinder
console.log('Test 2: Single cylinder events');
const events2 = [
    { cylinderIndex: 3 },
    { cylinderIndex: 3 },
    { cylinderIndex: 3 }
];
const result2 = computeCylinderDistribution(events2);
assert(result2.total === 3, 'Total should be 3');
assert(result2.counts[2] === 3, 'Cyl 3 count should be 3');
assert(result2.percentages[2] === 100, 'Cyl 3 percentage should be 100');
assert(result2.ranking[0] === 3, 'Cyl 3 should be ranked first');

// Test 3: Multiple cylinders with tie-breaking
console.log('Test 3: Tie-breaking (ascending cylinder index)');
const events3 = [
    { cylinderIndex: 1 },
    { cylinderIndex: 1 },
    { cylinderIndex: 5 },
    { cylinderIndex: 5 },
    { cylinderIndex: 3 }
];
const result3 = computeCylinderDistribution(events3);
assert(result3.total === 5, 'Total should be 5');
assert(result3.counts[0] === 2, 'Cyl 1 count should be 2');
assert(result3.counts[4] === 2, 'Cyl 5 count should be 2');
assert(result3.counts[2] === 1, 'Cyl 3 count should be 1');
// Cyl 1 and 5 tied at 2 — cyl 1 comes first (lower index)
assert(result3.ranking[0] === 1, 'Cyl 1 should be ranked first (tie-break)');
assert(result3.ranking[1] === 5, 'Cyl 5 should be ranked second (tie-break)');
assert(result3.ranking[2] === 3, 'Cyl 3 should be ranked third');

// Test 4: Percentage rounding to 1 decimal place
console.log('Test 4: Percentage rounding');
const events4 = [
    { cylinderIndex: 1 },
    { cylinderIndex: 1 },
    { cylinderIndex: 2 }
];
const result4 = computeCylinderDistribution(events4);
// 2/3 * 100 = 66.666... → 66.7
// 1/3 * 100 = 33.333... → 33.3
assert(result4.percentages[0] === 66.7, 'Cyl 1 should be 66.7%, got ' + result4.percentages[0]);
assert(result4.percentages[1] === 33.3, 'Cyl 2 should be 33.3%, got ' + result4.percentages[1]);

// Test 5: All 8 cylinders with different counts
console.log('Test 5: All 8 cylinders');
const events5 = [];
for (let cyl = 1; cyl <= 8; cyl++) {
    for (let i = 0; i < cyl; i++) {
        events5.push({ cylinderIndex: cyl });
    }
}
// Total = 1+2+3+4+5+6+7+8 = 36
const result5 = computeCylinderDistribution(events5);
assert(result5.total === 36, 'Total should be 36');
assert(result5.counts[0] === 1, 'Cyl 1 count should be 1');
assert(result5.counts[7] === 8, 'Cyl 8 count should be 8');
// Ranking should be 8,7,6,5,4,3,2,1 (descending by count)
assertArrayEqual(result5.ranking, [8, 7, 6, 5, 4, 3, 2, 1], 'Ranking should be descending by count');

// Test 6: Sum of counts equals total
console.log('Test 6: Count conservation');
const events6 = [
    { cylinderIndex: 2 },
    { cylinderIndex: 4 },
    { cylinderIndex: 4 },
    { cylinderIndex: 6 },
    { cylinderIndex: 6 },
    { cylinderIndex: 6 },
    { cylinderIndex: 8 },
    { cylinderIndex: 8 },
    { cylinderIndex: 8 },
    { cylinderIndex: 8 }
];
const result6 = computeCylinderDistribution(events6);
const sumCounts = result6.counts.reduce((a, b) => a + b, 0);
assert(sumCounts === result6.total, 'Sum of counts should equal total');
assert(result6.total === 10, 'Total should be 10');

// Summary
console.log('\n--- Results ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed!');
}
