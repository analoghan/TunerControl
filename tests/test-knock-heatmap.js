/**
 * Test script for knock/charts.js renderKnockHeatmap function.
 * Run with: node tests/test-knock-heatmap.js
 */

const fs = require('fs');
const code = fs.readFileSync(__dirname + '/../knock/charts.js', 'utf8');

// Mock browser globals
global.window = { devicePixelRatio: 2 };

// Track canvas operations
var drawCalls = [];

function createMockCanvas(w, h) {
    var ctx = {
        scale: function() {},
        save: function() {},
        restore: function() {},
        beginPath: function() {},
        moveTo: function() {},
        lineTo: function() {},
        stroke: function() {},
        arc: function() {},
        rotate: function() {},
        translate: function() {},
        fillRect: function(x, y, w, h) {
            drawCalls.push({ op: 'fillRect', x: x, y: y, w: w, h: h, fillStyle: ctx.fillStyle });
        },
        strokeRect: function(x, y, w, h) {
            drawCalls.push({ op: 'strokeRect', x: x, y: y, w: w, h: h });
        },
        fillText: function(text, x, y) {
            drawCalls.push({ op: 'fillText', text: text, x: x, y: y });
        },
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
    };
    return {
        width: w,
        height: h,
        style: {},
        getContext: function() { return ctx; },
    };
}

// Evaluate the module in global scope
eval(code);

var passed = 0;
var failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + msg);
    }
}

// --- Test 1: Zero-count heatmap shows "no data" message ---
drawCalls = [];
var canvas1 = createMockCanvas(800, 400);

var emptyHeatmap = {
    rpmBins: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500],
    loadBins: [],
    counts: [],
};
// Build 15x25 zero counts
for (var i = 0; i < 15; i++) {
    emptyHeatmap.counts.push([]);
    for (var j = 0; j < 25; j++) {
        emptyHeatmap.counts[i].push(0);
    }
}
for (var k = 0; k <= 25; k++) {
    emptyHeatmap.loadBins.push(k * 10);
}

renderKnockHeatmap(canvas1, emptyHeatmap);

var noDataMsg = drawCalls.filter(function(c) {
    return c.op === 'fillText' && c.text === 'No knock events available for visualization';
});
assert(noDataMsg.length === 1, 'Should display "No knock events available for visualization" when all counts are zero');

// --- Test 2: Non-zero counts render colored cells ---
drawCalls = [];
var canvas2 = createMockCanvas(800, 400);

var heatmapWithData = {
    rpmBins: [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500],
    loadBins: [],
    counts: [],
};
for (var i = 0; i < 15; i++) {
    heatmapWithData.counts.push([]);
    for (var j = 0; j < 25; j++) {
        heatmapWithData.counts[i].push(0);
    }
}
for (var k = 0; k <= 25; k++) {
    heatmapWithData.loadBins.push(k * 10);
}

// Set some non-zero counts
heatmapWithData.counts[3][5] = 10;   // RPM bin 3 (1500-2000), Load bin 5 (50-60 kPa)
heatmapWithData.counts[7][12] = 5;   // RPM bin 7 (3500-4000), Load bin 12 (120-130 kPa)
heatmapWithData.counts[10][20] = 15; // RPM bin 10 (5000-5500), Load bin 20 (200-210 kPa)

renderKnockHeatmap(canvas2, heatmapWithData);

// Should NOT show "no data" message
var noDataMsg2 = drawCalls.filter(function(c) {
    return c.op === 'fillText' && c.text === 'No knock events available for visualization';
});
assert(noDataMsg2.length === 0, 'Should NOT display no-data message when counts exist');

// Should have fillRect calls for the 3 non-zero cells (plus background + legend)
var fillRects = drawCalls.filter(function(c) { return c.op === 'fillRect'; });
// At minimum: 1 background clear + 3 heatmap cells + legend gradient steps
assert(fillRects.length > 3, 'Should have fillRect calls for heatmap cells and legend, got ' + fillRects.length);

// --- Test 3: Zero-count cells are NOT filled ---
// The function skips cells with count === 0, so we should only see 3 heatmap cell fills
// (plus background and legend). Let's count non-background, non-legend fills.
// Background fill is the first one (full canvas clear).
// After that, heatmap cells come before legend gradient.
// We can verify by checking that we don't have 15*25 = 375 cell fills.
assert(fillRects.length < 375, 'Should NOT fill all 375 cells, only non-zero ones');

// --- Test 4: Color scale legend is drawn ---
var legendLabels = drawCalls.filter(function(c) {
    return c.op === 'fillText' && c.text === 'Count';
});
assert(legendLabels.length === 1, 'Should draw "Count" label on color scale legend');

// Max count label should appear
var maxLabel = drawCalls.filter(function(c) {
    return c.op === 'fillText' && c.text === '15';
});
assert(maxLabel.length >= 1, 'Should display max count (15) on legend');

// --- Test 5: Axis labels are drawn ---
var xAxisLabel = drawCalls.filter(function(c) {
    return c.op === 'fillText' && c.text === 'Engine Speed (RPM)';
});
assert(xAxisLabel.length === 1, 'Should draw X-axis label "Engine Speed (RPM)"');

var yAxisLabel = drawCalls.filter(function(c) {
    return c.op === 'fillText' && c.text === 'Inlet Manifold Pressure (kPa)';
});
assert(yAxisLabel.length === 1, 'Should draw Y-axis label "Inlet Manifold Pressure (kPa)"');

// --- Test 6: interpolateColor helper works correctly ---
var colorMid = interpolateColor('#000000', '#ffffff', 0.5);
assert(colorMid === 'rgb(128,128,128)', 'Midpoint interpolation should be gray, got ' + colorMid);

var colorLow = interpolateColor('#000000', '#ffffff', 0);
assert(colorLow === 'rgb(0,0,0)', 'Low end should be black, got ' + colorLow);

var colorHigh = interpolateColor('#000000', '#ffffff', 1);
assert(colorHigh === 'rgb(255,255,255)', 'High end should be white, got ' + colorHigh);

// --- Summary ---
console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed!');
}
