/**
 * test-ld-names.js — lib/ld-parser.js channel-name normalisation (Node: node tests/test-ld-names.js).
 * M1 writes dotted names cut at 32 characters; logs re-saved by other software use spaces. Both must map to the CSV names.
 */
var assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
var ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'ld-parser.js'), 'utf8'), ctx);
var norm = ctx.normalizeLdChannelNameWithUnit;

var passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + ': ' + e.message); }
}

console.log('ld-parser channel names:');
[['Fuel.Closed Loop.Control.Bank 1.', 'Fuel Closed Loop Control Bank 1'],
 ['Fuel.Closed Loop.Control.Bank 2.', 'Fuel Closed Loop Control Bank 2']].forEach(function (pair, i) {
    var want = 'Fuel Closed Loop Control Bank ' + (i + 1) + ' Trim';
    check('closed-loop trim bank ' + (i + 1) + ', dotted and spaced', function () {
        assert.strictEqual(norm(pair[0], '%Trim'), want);
        assert.strictEqual(norm(pair[1], '%Trim'), want);
    });
});
check('injector pulse width / angle, dotted and spaced', function () {
    ['Fuel.Cylinder 1.Primary.Output.P', 'Fuel Cylinder 1 Primary Output P'].forEach(function (n) {
        assert.strictEqual(norm(n, 'ms'), 'Fuel Cylinder 1 Primary Output Pulse Width 1');
        assert.strictEqual(norm(n, 'dBTDC'), 'Fuel Cylinder 1 Primary Output Pulse Angle 1');
    });
});
check('other names: dots become spaces, unit-specific rules need the unit', function () {
    assert.strictEqual(norm('Engine.Speed', 'rpm'), 'Engine Speed');
    assert.strictEqual(norm('Fuel.Volume.Primary', 'ul'), 'Fuel Volume Primary');
    assert.strictEqual(norm('Fuel Closed Loop Control Bank 1', ''), 'Fuel Closed Loop Control Bank 1');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
