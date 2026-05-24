/**
 * Test script for injector/charts.js utility functions and renderAllCharts logic.
 * Run with: node tests/test-charts-utils.js
 */

const fs = require('fs');
const code = fs.readFileSync(__dirname + '/../injector/charts.js', 'utf8');

// Mock browser globals
global.window = { devicePixelRatio: 2 };

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

// --- Test computeNiceRange ---

var r1 = computeNiceRange(0, 100, 5);
assert(r1.min <= 0, 'nice min should be <= 0');
assert(r1.max >= 100, 'nice max should be >= 100');
assert(r1.ticks.length > 0, 'should have ticks');
assert(r1.step > 0, 'step should be positive');

// Equal min/max
var r2 = computeNiceRange(5, 5, 5);
assert(r2.min < r2.max, 'should expand range when min==max');

// Zero range at zero
var r3 = computeNiceRange(0, 0, 5);
assert(r3.min < 0 && r3.max > 0, 'should expand around zero');

// Negative range
var r4 = computeNiceRange(-50, 50, 5);
assert(r4.min <= -50, 'nice min should cover -50');
assert(r4.max >= 50, 'nice max should cover 50');

// --- Test mapToPlot ---

var p1 = mapToPlot(50, 0, 100, 60, 760);
assert(p1 === 410, 'midpoint should map to pixel midpoint, got ' + p1);

var p2 = mapToPlot(0, 0, 100, 60, 760);
assert(p2 === 60, 'min should map to plotMin');

var p3 = mapToPlot(100, 0, 100, 60, 760);
assert(p3 === 760, 'max should map to plotMax');

// Equal min/max
var p4 = mapToPlot(5, 5, 5, 60, 760);
assert(p4 === 410, 'equal min/max should map to center');

// --- Test computePlotArea ---

var area = computePlotArea(800, 400);
assert(area.left === 60, 'left margin should be 60');
assert(area.right === 780, 'right should be width - right margin');
assert(area.top === 20, 'top margin should be 20');
assert(area.bottom === 360, 'bottom should be height - bottom margin');

// Custom margins
var area2 = computePlotArea(800, 400, { left: 80, right: 30, top: 10, bottom: 50 });
assert(area2.left === 80, 'custom left margin');
assert(area2.right === 770, 'custom right = 800 - 30');
assert(area2.top === 10, 'custom top margin');
assert(area2.bottom === 350, 'custom bottom = 400 - 50');

// --- Test renderAllCharts skip logic ---

var called = [];

// Override placeholders to track calls
renderLambdaTimeSeries = function(c, d) { called.push('lambdaTs'); };
renderPWTimeSeries = function(c, d) { called.push('pwTs'); };
renderLambdaVsPWScatter = function(c, d) { called.push('lambdaPwScatter'); };
renderFuelPressureTimeSeries = function(c, d) { called.push('fuelPressureTs'); };
renderPWHistogram = function(c, d) { called.push('pwHistogram'); };
renderLambdaRPMDensity = function(c, d) { called.push('lambdaRpmDensity'); };
renderTimingVsRPMScatter = function(c, d) { called.push('timingRpmScatter'); };

var containers = {
    lambdaTs: {},
    pwTs: {},
    lambdaPwScatter: {},
    fuelPressureTs: {},
    pwHistogram: {},
    lambdaRpmDensity: {},
    timingRpmScatter: {}
};

var chartData = {
    time: [0, 1, 2],
    lambdaB1: [1.0, 1.02, 1.08],
    lambdaB2: null,
    injPW: [1.2, 0.9, 0.7],
    fuelPressDI: null,
    fuelPressDIAim: null,
    rpm: [2000, 3000, 4000],
    injTiming: null,
    downsampleStep: 1
};

renderAllCharts(containers, chartData);

assert(called.indexOf('lambdaTs') !== -1, 'lambdaTs should render (has lambdaB1)');
assert(called.indexOf('pwTs') !== -1, 'pwTs should render (has injPW)');
assert(called.indexOf('lambdaPwScatter') !== -1, 'lambdaPwScatter should render (has lambda + PW)');
assert(called.indexOf('fuelPressureTs') === -1, 'fuelPressureTs should NOT render (no fuelPressDI)');
assert(called.indexOf('pwHistogram') !== -1, 'pwHistogram should render (has injPW)');
assert(called.indexOf('lambdaRpmDensity') !== -1, 'lambdaRpmDensity should render (has lambda + rpm)');
assert(called.indexOf('timingRpmScatter') === -1, 'timingRpmScatter should NOT render (no injTiming)');

// Test with null containers/data — should not throw
called = [];
renderAllCharts(null, chartData);
renderAllCharts(containers, null);
assert(called.length === 0, 'should not render with null args');

// Test with all data present
called = [];
var fullData = {
    time: [0, 1, 2],
    lambdaB1: [1.0, 1.02, 1.08],
    lambdaB2: [1.01, 1.03, 1.07],
    injPW: [1.2, 0.9, 0.7],
    fuelPressDI: [200, 195, 180],
    fuelPressDIAim: [200, 200, 200],
    rpm: [2000, 3000, 4000],
    injTiming: [280, 260, 300],
    downsampleStep: 1
};

renderAllCharts(containers, fullData);
assert(called.length === 7, 'all 7 charts should render with full data, got ' + called.length);

// --- Summary ---
console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed!');
}
