/**
 * Integration test for the knock worker analysis pipeline (task 6.2).
 * Verifies that handleAnalyzeCsv, handleAnalyzeLd, and handleReanalyze
 * correctly wire the full analysis pipeline.
 */
const vm = require('vm');
const fs = require('fs');

// Load worker.js source
const code = fs.readFileSync(__dirname + '/../knock/worker.js', 'utf8');

// Mock self and postMessage
let messages = [];
const context = {
    self: {
        onmessage: null,
        postMessage: function(msg) { messages.push(msg); }
    },
    console: console,
    Math: Math,
    String: String,
    Array: Array,
    Object: Object,
    Number: Number,
    Map: Map,
    Float64Array: Float64Array,
    DataView: DataView,
    ArrayBuffer: ArrayBuffer,
    Infinity: Infinity,
    NaN: NaN,
    isNaN: isNaN,
    parseInt: parseInt,
    parseFloat: parseFloat,
    Error: Error
};

const sandbox = vm.createContext(context);
vm.runInContext(code, sandbox);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log('  \u2713 ' + msg);
        passed++;
    } else {
        console.log('  \u2717 FAIL: ' + msg);
        failed++;
    }
}

// --- Test 1: CSV analysis with default threshold ---
console.log('Test 1: CSV analysis pipeline with default threshold (5)');
messages = [];

const csvText = [
    'Time,Engine Speed,Inlet Manifold Pressure,Ignition Cylinder 1 Knock Level,Ignition Cylinder 2 Knock Level,Ignition Cylinder 3 Knock Level,Ignition Cylinder 4 Knock Level,Ignition Cylinder 5 Knock Level,Ignition Cylinder 6 Knock Level,Ignition Cylinder 7 Knock Level,Ignition Cylinder 8 Knock Level,Ignition Timing,Throttle Position',
    's,rpm,kPa,%,%,%,%,%,%,%,%,dBTDC,%',
    '0.0,3000,100,2,3,10,1,0,0,0,0,25,50',
    '0.05,3100,105,1,2,15,0,0,0,0,0,24,55',
    '0.1,3200,110,0,0,8,0,0,0,0,0,23,60',
    '0.15,3300,115,0,0,3,0,0,0,0,0,22,65'
].join('\n');

sandbox.self.onmessage({ data: { type: 'analyze', logText: csvText } });

const resultMsg = messages.find(function(m) { return m.type === 'result'; });
assert(resultMsg !== undefined, 'Result message posted');

if (resultMsg) {
    const analysis = resultMsg.analysis;
    const chartData = resultMsg.chartData;

    // Structure checks
    assert(analysis.channelMapping !== undefined, 'channelMapping present');
    assert(Array.isArray(analysis.channelWarnings), 'channelWarnings is array');
    assert(analysis.cylinderDistribution !== undefined, 'cylinderDistribution present');
    assert(analysis.heatmapData !== undefined, 'heatmapData present');
    assert(analysis.timingCorrelation !== undefined, 'timingCorrelation present');
    assert(analysis.worstConditions !== undefined, 'worstConditions present');
    assert(Array.isArray(analysis.timingRecommendations), 'timingRecommendations is array');
    assert(Array.isArray(analysis.diagnostics), 'diagnostics is array');
    assert(analysis.threshold === 5, 'threshold is 5 (default)');

    // Channel mapping checks
    assert(analysis.channelMapping.knock_cyl_1 === true, 'knock_cyl_1 found');
    assert(analysis.channelMapping.rpm === true, 'rpm found');
    assert(analysis.channelMapping.gear === false, 'gear not found (not in CSV)');

    // Event classification: threshold=5, cyl3 has 10,15,8 (all > 5), row3 has 3 (not > 5)
    assert(analysis.cylinderDistribution.total === 3, 'total events = 3 (cyl3: 10,15,8 > 5)');
    assert(analysis.cylinderDistribution.counts[2] === 3, 'cylinder 3 has 3 events');
    assert(analysis.cylinderDistribution.counts[0] === 0, 'cylinder 1 has 0 events');

    // Heatmap structure
    assert(analysis.heatmapData.rpmBins.length === 16, '16 RPM bin boundaries');
    assert(analysis.heatmapData.loadBins.length === 26, '26 load bin boundaries');
    assert(analysis.heatmapData.counts.length === 15, '15 RPM bins');
    assert(analysis.heatmapData.counts[0].length === 25, '25 load bins per RPM bin');

    // Timing correlation structure
    assert(analysis.timingCorrelation.perRpmBin.length === 15, '15 RPM bin timing entries');
    assert(analysis.timingCorrelation.perCylinder.length === 8, '8 cylinder timing entries');

    // retardStats should be null (no timing comp channel)
    assert(analysis.retardStats === null, 'retardStats null (no timing comp channel)');

    // Chart data structure
    assert(Array.isArray(chartData.knockEvents), 'chartData.knockEvents is array');
    assert(chartData.knockEvents.length === 3, 'chartData has 3 knock events');
    assert(chartData.cylinderDistribution !== undefined, 'chartData.cylinderDistribution present');
    assert(chartData.heatmapData !== undefined, 'chartData.heatmapData present');
    assert(chartData.retardTimeSeries === null, 'chartData.retardTimeSeries null');
    assert(chartData.timingCorrelation !== undefined, 'chartData.timingCorrelation present');

    // Diagnostics
    assert(analysis.diagnostics.length > 0, 'diagnostics generated');

    // Timing recommendations
    assert(analysis.timingRecommendations.length === 8, '8 timing recommendations');
}

// --- Test 2: Reanalyze with new threshold ---
console.log('\nTest 2: Reanalyze with threshold 12');
messages = [];

sandbox.self.onmessage({ data: { type: 'reanalyze', threshold: 12 } });

const reResult = messages.find(function(m) { return m.type === 'result'; });
assert(reResult !== undefined, 'Reanalyze result message posted');

if (reResult) {
    // With threshold 12: only cyl3=15 > 12 (row1)
    assert(reResult.analysis.cylinderDistribution.total === 1, 'reanalyze: 1 event (only 15 > 12)');
    assert(reResult.analysis.threshold === 12, 'reanalyze threshold = 12');
    assert(reResult.chartData.knockEvents.length === 1, 'chartData has 1 event');
}

// --- Test 3: Reanalyze with threshold 0 (all non-zero are events) ---
console.log('\nTest 3: Reanalyze with threshold 0');
messages = [];

sandbox.self.onmessage({ data: { type: 'reanalyze', threshold: 0 } });

const zeroResult = messages.find(function(m) { return m.type === 'result'; });
assert(zeroResult !== undefined, 'Threshold 0 result posted');

if (zeroResult) {
    // With threshold 0: any knock level > 0 is an event
    // Row 0: cyl1=2, cyl2=3, cyl3=10, cyl4=1 → 4 events
    // Row 1: cyl1=1, cyl2=2, cyl3=15 → 3 events
    // Row 2: cyl3=8 → 1 event
    // Row 3: cyl3=3 → 1 event
    // Total: 4 + 3 + 1 + 1 = 9
    assert(zeroResult.analysis.cylinderDistribution.total === 9, 'threshold 0: 9 events total');
    assert(zeroResult.analysis.threshold === 0, 'threshold stored as 0');
}

// --- Test 4: Error handling - reanalyze without data ---
console.log('\nTest 4: Error handling');

// Create a fresh context to test error case
let messages2 = [];
const context2 = {
    self: {
        onmessage: null,
        postMessage: function(msg) { messages2.push(msg); }
    },
    console: console,
    Math: Math,
    String: String,
    Array: Array,
    Object: Object,
    Number: Number,
    Map: Map,
    Float64Array: Float64Array,
    DataView: DataView,
    ArrayBuffer: ArrayBuffer,
    Infinity: Infinity,
    NaN: NaN,
    isNaN: isNaN,
    parseInt: parseInt,
    parseFloat: parseFloat,
    Error: Error
};
const sandbox2 = vm.createContext(context2);
vm.runInContext(code, sandbox2);

sandbox2.self.onmessage({ data: { type: 'reanalyze', threshold: 5 } });
const errMsg = messages2.find(function(m) { return m.type === 'error'; });
assert(errMsg !== undefined, 'Error posted when reanalyzing without loaded data');
assert(errMsg && errMsg.message.indexOf('No data loaded') !== -1, 'Error message mentions no data loaded');

// --- Test 5: Empty file error ---
console.log('\nTest 5: Empty file error');
messages2 = [];
sandbox2.self.onmessage({ data: { type: 'analyze', logText: '' } });
const emptyErr = messages2.find(function(m) { return m.type === 'error'; });
assert(emptyErr !== undefined, 'Error posted for empty file');
assert(emptyErr && emptyErr.message === 'File contains no data', 'Error message: File contains no data');

// --- Test 6: Progress messages posted ---
console.log('\nTest 6: Progress messages during analysis');
messages = [];
sandbox.self.onmessage({ data: { type: 'reanalyze', threshold: 5 } });
const progressMsgs = messages.filter(function(m) { return m.type === 'progress'; });
assert(progressMsgs.length > 0, 'Progress messages posted during analysis');
assert(progressMsgs.some(function(m) { return m.phase === 'Resolving channels'; }), 'Resolving channels phase');
assert(progressMsgs.some(function(m) { return m.phase === 'Classifying knock events'; }), 'Classifying knock events phase');
assert(progressMsgs.some(function(m) { return m.phase === 'Preparing results'; }), 'Preparing results phase');

// --- Test 7: Warning messages for missing channels ---
console.log('\nTest 7: Warning messages for missing knock channels');

let messages3 = [];
const context3 = {
    self: {
        onmessage: null,
        postMessage: function(msg) { messages3.push(msg); }
    },
    console: console,
    Math: Math,
    String: String,
    Array: Array,
    Object: Object,
    Number: Number,
    Map: Map,
    Float64Array: Float64Array,
    DataView: DataView,
    ArrayBuffer: ArrayBuffer,
    Infinity: Infinity,
    NaN: NaN,
    isNaN: isNaN,
    parseInt: parseInt,
    parseFloat: parseFloat,
    Error: Error
};
const sandbox3 = vm.createContext(context3);
vm.runInContext(code, sandbox3);

// CSV with only 2 knock channels
const partialCsv = [
    'Time,Engine Speed,Ignition Cylinder 1 Knock Level,Ignition Cylinder 2 Knock Level',
    's,rpm,%,%',
    '0.0,3000,10,5',
    '0.05,3100,8,3'
].join('\n');

sandbox3.self.onmessage({ data: { type: 'analyze', logText: partialCsv } });
const warnings = messages3.filter(function(m) { return m.type === 'warning'; });
assert(warnings.length === 6, '6 warnings for 6 missing knock channels (3-8)');

// --- Summary ---
console.log('\n--- Results ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
if (failed === 0) {
    console.log('All tests passed!');
} else {
    process.exit(1);
}
