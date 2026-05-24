/**
 * Test script for knock/charts.js renderKnockVsRpmScatter function.
 * Run with: node tests/test-knock-scatter.js
 */

const fs = require('fs');
const code = fs.readFileSync(__dirname + '/../knock/charts.js', 'utf8');

// Mock browser globals
global.window = { devicePixelRatio: 1 };

// Mock canvas context that records calls
function createMockCtx() {
    var calls = [];
    return {
        calls: calls,
        scale: function() {},
        save: function() { calls.push({ fn: 'save' }); },
        restore: function() { calls.push({ fn: 'restore' }); },
        clearRect: function(x, y, w, h) { calls.push({ fn: 'clearRect', args: [x, y, w, h] }); },
        fillRect: function(x, y, w, h) { calls.push({ fn: 'fillRect', args: [x, y, w, h] }); },
        fillText: function(text, x, y) { calls.push({ fn: 'fillText', args: [text, x, y] }); },
        beginPath: function() { calls.push({ fn: 'beginPath' }); },
        moveTo: function(x, y) { calls.push({ fn: 'moveTo', args: [x, y] }); },
        lineTo: function(x, y) { calls.push({ fn: 'lineTo', args: [x, y] }); },
        stroke: function() { calls.push({ fn: 'stroke' }); },
        arc: function(x, y, r, s, e) { calls.push({ fn: 'arc', args: [x, y, r, s, e] }); },
        fill: function() { calls.push({ fn: 'fill' }); },
        rotate: function() {},
        translate: function() {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
    };
}

function createMockCanvas(width, height) {
    var mockCtx = createMockCtx();
    return {
        width: width || 800,
        height: height || 400,
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

// --- Test 1: Zero events shows message ---
(function() {
    var canvas = createMockCanvas(800, 400);
    renderKnockVsRpmScatter(canvas, []);
    var ctx = canvas._ctx;
    var fillTextCalls = ctx.calls.filter(function(c) { return c.fn === 'fillText'; });
    var hasMessage = fillTextCalls.some(function(c) {
        return c.args[0] === 'No knock events available for visualization';
    });
    assert(hasMessage, 'Zero events should display "No knock events available for visualization"');
})();

// --- Test 2: Null events shows message ---
(function() {
    var canvas = createMockCanvas(800, 400);
    renderKnockVsRpmScatter(canvas, null);
    var ctx = canvas._ctx;
    var fillTextCalls = ctx.calls.filter(function(c) { return c.fn === 'fillText'; });
    var hasMessage = fillTextCalls.some(function(c) {
        return c.args[0] === 'No knock events available for visualization';
    });
    assert(hasMessage, 'Null events should display "No knock events available for visualization"');
})();

// --- Test 3: Events with valid RPM draw scatter points ---
(function() {
    var events = [
        { rpm: 3000, knockLevel: 50 },
        { rpm: 5000, knockLevel: 75 },
        { rpm: 1000, knockLevel: 20 },
    ];
    var canvas = createMockCanvas(800, 400);
    renderKnockVsRpmScatter(canvas, events);
    var ctx = canvas._ctx;
    var arcCalls = ctx.calls.filter(function(c) { return c.fn === 'arc'; });
    assert(arcCalls.length === 3, 'Should draw 3 scatter points, got ' + arcCalls.length);

    // Verify radius is 3
    arcCalls.forEach(function(call, idx) {
        assert(call.args[2] === 3, 'Point ' + idx + ' radius should be 3, got ' + call.args[2]);
    });
})();

// --- Test 4: Events with null RPM are skipped ---
(function() {
    var events = [
        { rpm: 3000, knockLevel: 50 },
        { rpm: null, knockLevel: 75 },
        { rpm: 5000, knockLevel: 20 },
        { rpm: null, knockLevel: 10 },
    ];
    var canvas = createMockCanvas(800, 400);
    renderKnockVsRpmScatter(canvas, events);
    var ctx = canvas._ctx;
    var arcCalls = ctx.calls.filter(function(c) { return c.fn === 'arc'; });
    assert(arcCalls.length === 2, 'Should draw 2 scatter points (skip null RPM), got ' + arcCalls.length);
})();

// --- Test 5: Events with undefined RPM are skipped ---
(function() {
    var events = [
        { rpm: 3000, knockLevel: 50 },
        { rpm: undefined, knockLevel: 75 },
    ];
    var canvas = createMockCanvas(800, 400);
    renderKnockVsRpmScatter(canvas, events);
    var ctx = canvas._ctx;
    var arcCalls = ctx.calls.filter(function(c) { return c.fn === 'arc'; });
    assert(arcCalls.length === 1, 'Should draw 1 scatter point (skip undefined RPM), got ' + arcCalls.length);
})();

// --- Test 6: Axis labels are correct ---
(function() {
    var events = [{ rpm: 3000, knockLevel: 50 }];
    var canvas = createMockCanvas(800, 400);
    renderKnockVsRpmScatter(canvas, events);
    var ctx = canvas._ctx;
    var fillTextCalls = ctx.calls.filter(function(c) { return c.fn === 'fillText'; });
    var texts = fillTextCalls.map(function(c) { return c.args[0]; });
    assert(texts.indexOf('Engine Speed (RPM)') !== -1, 'Should have X-axis label "Engine Speed (RPM)"');
    assert(texts.indexOf('Knock Level (%)') !== -1, 'Should have Y-axis label "Knock Level (%)"');
})();

// --- Test 7: All events with null RPM still shows empty (no points drawn) ---
(function() {
    var events = [
        { rpm: null, knockLevel: 50 },
        { rpm: null, knockLevel: 75 },
    ];
    var canvas = createMockCanvas(800, 400);
    renderKnockVsRpmScatter(canvas, events);
    var ctx = canvas._ctx;
    var arcCalls = ctx.calls.filter(function(c) { return c.fn === 'arc'; });
    assert(arcCalls.length === 0, 'Should draw 0 scatter points when all RPM are null');
})();

// --- Summary ---
console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed!');
}
