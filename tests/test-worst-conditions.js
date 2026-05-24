/**
 * test-worst-conditions.js — Unit tests for identifyWorstConditions().
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4
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

console.log('identifyWorstConditions — RPM bin identification:');

check('identifies RPM bin with highest count', function() {
    var events = [
        { rpm: 3100, load: 100, gear: 3 },
        { rpm: 3200, load: 100, gear: 3 },
        { rpm: 3300, load: 100, gear: 3 },
        { rpm: 5100, load: 100, gear: 4 },
        { rpm: 5200, load: 100, gear: 4 }
    ];
    var result = identifyWorstConditions(events);
    if (result.worstRpmBin.binIndex !== 6) throw new Error('Expected binIndex 6, got ' + result.worstRpmBin.binIndex);
    if (result.worstRpmBin.rpmRange !== '3000-3500 RPM') throw new Error('Expected "3000-3500 RPM", got "' + result.worstRpmBin.rpmRange + '"');
    if (result.worstRpmBin.count !== 3) throw new Error('Expected count 3, got ' + result.worstRpmBin.count);
});

check('uses lowest index tie-break for RPM bins', function() {
    var events = [
        { rpm: 1000, load: 50, gear: 2 },
        { rpm: 2000, load: 50, gear: 2 }
    ];
    var result = identifyWorstConditions(events);
    // Both bins have count 1, lowest index (bin 2 for 1000 RPM) wins
    if (result.worstRpmBin.binIndex !== 2) throw new Error('Expected binIndex 2, got ' + result.worstRpmBin.binIndex);
    if (result.worstRpmBin.rpmRange !== '1000-1500 RPM') throw new Error('Expected "1000-1500 RPM", got "' + result.worstRpmBin.rpmRange + '"');
});

check('returns null worstRpmBin when no events have rpm data', function() {
    var events = [
        { rpm: null, load: 100, gear: 3 },
        { rpm: null, load: 110, gear: 3 }
    ];
    var result = identifyWorstConditions(events);
    if (result.worstRpmBin !== null) throw new Error('Expected null worstRpmBin');
});

console.log('\nidentifyWorstConditions — Load bin identification:');

check('identifies load bin with highest count', function() {
    var events = [
        { rpm: 3000, load: 105, gear: 3 },
        { rpm: 3000, load: 108, gear: 3 },
        { rpm: 3000, load: 107, gear: 3 },
        { rpm: 3000, load: 55, gear: 2 }
    ];
    var result = identifyWorstConditions(events);
    if (result.worstLoadBin.binIndex !== 10) throw new Error('Expected binIndex 10, got ' + result.worstLoadBin.binIndex);
    if (result.worstLoadBin.loadRange !== '100-110 kPa') throw new Error('Expected "100-110 kPa", got "' + result.worstLoadBin.loadRange + '"');
    if (result.worstLoadBin.count !== 3) throw new Error('Expected count 3, got ' + result.worstLoadBin.count);
});

check('uses lowest index tie-break for load bins', function() {
    var events = [
        { rpm: 3000, load: 50, gear: 2 },
        { rpm: 3000, load: 100, gear: 3 }
    ];
    var result = identifyWorstConditions(events);
    // Both bins have count 1, lowest index (bin 5 for 50 kPa) wins
    if (result.worstLoadBin.binIndex !== 5) throw new Error('Expected binIndex 5, got ' + result.worstLoadBin.binIndex);
});

check('returns null worstLoadBin when no events have load data', function() {
    var events = [
        { rpm: 3000, load: null, gear: 3 },
        { rpm: 4000, load: null, gear: 4 }
    ];
    var result = identifyWorstConditions(events);
    if (result.worstLoadBin !== null) throw new Error('Expected null worstLoadBin');
});

console.log('\nidentifyWorstConditions — Gear identification:');

check('identifies gear with highest count', function() {
    var events = [
        { rpm: 3000, load: 100, gear: 3 },
        { rpm: 3000, load: 100, gear: 3 },
        { rpm: 3000, load: 100, gear: 3 },
        { rpm: 3000, load: 100, gear: 4 },
        { rpm: 3000, load: 100, gear: 4 }
    ];
    var result = identifyWorstConditions(events);
    if (result.worstGear.gear !== 3) throw new Error('Expected gear 3, got ' + result.worstGear.gear);
    if (result.worstGear.count !== 3) throw new Error('Expected count 3, got ' + result.worstGear.count);
});

check('uses lowest gear tie-break', function() {
    var events = [
        { rpm: 3000, load: 100, gear: 3 },
        { rpm: 3000, load: 100, gear: 4 }
    ];
    var result = identifyWorstConditions(events);
    // Both gears have count 1, lowest gear (3) wins
    if (result.worstGear.gear !== 3) throw new Error('Expected gear 3, got ' + result.worstGear.gear);
});

check('returns null worstGear when no events have gear data', function() {
    var events = [
        { rpm: 3000, load: 100, gear: null },
        { rpm: 4000, load: 110, gear: null }
    ];
    var result = identifyWorstConditions(events);
    if (result.worstGear !== null) throw new Error('Expected null worstGear');
});

check('handles empty events array', function() {
    var result = identifyWorstConditions([]);
    if (result.worstRpmBin !== null) throw new Error('Expected null worstRpmBin');
    if (result.worstLoadBin !== null) throw new Error('Expected null worstLoadBin');
    if (result.worstGear !== null) throw new Error('Expected null worstGear');
});

check('handles mixed null and valid data', function() {
    var events = [
        { rpm: 3000, load: null, gear: 3 },
        { rpm: null, load: 100, gear: null },
        { rpm: 3000, load: 100, gear: 3 }
    ];
    var result = identifyWorstConditions(events);
    // RPM: 2 events at bin 6 (3000 RPM)
    if (result.worstRpmBin.binIndex !== 6) throw new Error('Expected RPM binIndex 6, got ' + result.worstRpmBin.binIndex);
    if (result.worstRpmBin.count !== 2) throw new Error('Expected RPM count 2, got ' + result.worstRpmBin.count);
    // Load: 2 events at bin 10 (100 kPa)
    if (result.worstLoadBin.binIndex !== 10) throw new Error('Expected load binIndex 10, got ' + result.worstLoadBin.binIndex);
    if (result.worstLoadBin.count !== 2) throw new Error('Expected load count 2, got ' + result.worstLoadBin.count);
    // Gear: 2 events at gear 3
    if (result.worstGear.gear !== 3) throw new Error('Expected gear 3, got ' + result.worstGear.gear);
    if (result.worstGear.count !== 2) throw new Error('Expected gear count 2, got ' + result.worstGear.count);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
