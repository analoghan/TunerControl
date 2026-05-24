/**
 * Test script for knock/charts.js renderCylinderBarChart function.
 * Run with: node tests/test-cylinder-bar-chart.js
 */

const fs = require('fs');
const code = fs.readFileSync(__dirname + '/../knock/charts.js', 'utf8');

// Mock browser globals
global.window = { devicePixelRatio: 2 };

// Track canvas drawing calls for verification
var drawCalls = [];
var textCalls = [];

function createMockCanvas() {
    drawCalls = [];
    textCalls = [];
    var mockCtx = {
        scale: function() {},
        save: function() {},
        restore: function() {},
        clearRect: function() {},
        fillRect: function(x, y, w, h) {
            drawCalls.push({ type: 'fillRect', x: x, y: y, w: w, h: h, fillStyle: mockCtx.fillStyle });
        },
        fillText: function(text, x, y) {
            textCalls.push({ text: text, x: x, y: y, fillStyle: mockCtx.fillStyle, textAlign: mockCtx.textAlign });
        },
        beginPath: function() {},
        moveTo: function() {},
        lineTo: function() {},
        stroke: function() {},
        rotate: function() {},
        translate: function() {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
    };
    return {
        width: 800,
        height: 400,
        style: {},
        getContext: function() { return mockCtx; },
        _ctx: mockCtx,
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

// --- Test 1: Zero-event case displays message ---
var canvas1 = createMockCanvas();
var zeroDist = {
    counts: [0, 0, 0, 0, 0, 0, 0, 0],
    percentages: [0, 0, 0, 0, 0, 0, 0, 0],
    total: 0,
    ranking: [0, 1, 2, 3, 4, 5, 6, 7]
};

renderCylinderBarChart(canvas1, zeroDist);

var foundMessage = textCalls.some(function(call) {
    return call.text === 'No knock events detected';
});
assert(foundMessage, 'Zero-event case should display "No knock events detected" message');

// Should NOT have cylinder labels when total is 0
var foundCylLabel = textCalls.some(function(call) {
    return call.text === '1' || call.text === '2';
});
// The only text should be the message
var nonMessageTexts = textCalls.filter(function(call) {
    return call.text !== 'No knock events detected';
});
assert(nonMessageTexts.length === 0, 'Zero-event case should only show the message, no other labels');

// --- Test 2: Normal case with data ---
var canvas2 = createMockCanvas();
var normalDist = {
    counts: [10, 5, 20, 3, 8, 15, 2, 7],
    percentages: [14.3, 7.1, 28.6, 4.3, 11.4, 21.4, 2.9, 10.0],
    total: 70,
    ranking: [2, 5, 0, 4, 7, 1, 3, 6]
};

renderCylinderBarChart(canvas2, normalDist);

// Should have 8 cylinder number labels (center-aligned, below x-axis)
var cylLabels = textCalls.filter(function(call) {
    return /^[1-8]$/.test(call.text) && call.textAlign === 'center';
});
assert(cylLabels.length === 8, 'Should have 8 cylinder number labels, got ' + cylLabels.length);

// Should have 8 percentage labels
var pctLabels = textCalls.filter(function(call) {
    return call.text.indexOf('%') !== -1;
});
assert(pctLabels.length === 8, 'Should have 8 percentage labels, got ' + pctLabels.length);

// Verify percentage label content for cylinder 3 (index 2, highest count)
var cyl3Pct = pctLabels.find(function(call) {
    return call.text === '28.6%';
});
assert(cyl3Pct !== undefined, 'Should have percentage label "28.6%" for cylinder 3');

// Verify the highest-count cylinder (index 2) gets barHighlight color
var highlightBars = drawCalls.filter(function(call) {
    return call.type === 'fillRect' && call.fillStyle === '#ff6b7a';
});
// There should be at least one bar with highlight color (the highest count cylinder)
assert(highlightBars.length >= 1, 'Should have at least one highlighted bar (highest count cylinder)');

// Verify normal bars use barFill color
var normalBars = drawCalls.filter(function(call) {
    return call.type === 'fillRect' && call.fillStyle === '#4a9eff';
});
assert(normalBars.length >= 1, 'Should have bars with normal fill color');

// --- Test 3: All cylinders equal count ---
var canvas3 = createMockCanvas();
var equalDist = {
    counts: [5, 5, 5, 5, 5, 5, 5, 5],
    percentages: [12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5, 12.5],
    total: 40,
    ranking: [0, 1, 2, 3, 4, 5, 6, 7]
};

renderCylinderBarChart(canvas3, equalDist);

// When all counts are equal, the first cylinder (index 0) should be highlighted
// because the loop finds the first max
var equalPctLabels = textCalls.filter(function(call) {
    return call.text === '12.5%';
});
assert(equalPctLabels.length === 8, 'Equal distribution should show 8 identical percentage labels');

// --- Test 4: Single cylinder with all events ---
var canvas4 = createMockCanvas();
var singleDist = {
    counts: [0, 0, 0, 100, 0, 0, 0, 0],
    percentages: [0, 0, 0, 100.0, 0, 0, 0, 0],
    total: 100,
    ranking: [3, 0, 1, 2, 4, 5, 6, 7]
};

renderCylinderBarChart(canvas4, singleDist);

var singlePctLabels = textCalls.filter(function(call) {
    return call.text === '100.0%';
});
assert(singlePctLabels.length === 1, 'Single cylinder case should have one 100.0% label');

var zeroPctLabels = textCalls.filter(function(call) {
    return call.text === '0.0%';
});
assert(zeroPctLabels.length === 7, 'Single cylinder case should have seven 0.0% labels');

// --- Summary ---
console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed!');
}
