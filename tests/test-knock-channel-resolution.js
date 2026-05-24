/**
 * Tests for knock/worker.js resolveChannels() — channel resolution logic.
 * Validates Requirements 1.4, 2.6
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

console.log('resolveChannels — basic resolution:');

check('resolves all channels when all are present', function() {
    const columns = [
        'Time', 'Ignition Cylinder 1 Knock Level', 'Ignition Cylinder 2 Knock Level',
        'Ignition Cylinder 3 Knock Level', 'Ignition Cylinder 4 Knock Level',
        'Ignition Cylinder 5 Knock Level', 'Ignition Cylinder 6 Knock Level',
        'Ignition Cylinder 7 Knock Level', 'Ignition Cylinder 8 Knock Level',
        'Ignition Timing', 'Ignition Timing Compensation',
        'Engine Speed', 'Inlet Manifold Pressure', 'Throttle Position',
        'Gear', 'Coolant Temperature'
    ];

    const result = resolveChannels(columns);

    if (result.resolved.knock_cyl_1 !== 1) throw new Error('knock_cyl_1 expected 1, got ' + result.resolved.knock_cyl_1);
    if (result.resolved.knock_cyl_2 !== 2) throw new Error('knock_cyl_2 expected 2, got ' + result.resolved.knock_cyl_2);
    if (result.resolved.knock_cyl_3 !== 3) throw new Error('knock_cyl_3 expected 3, got ' + result.resolved.knock_cyl_3);
    if (result.resolved.knock_cyl_4 !== 4) throw new Error('knock_cyl_4 expected 4, got ' + result.resolved.knock_cyl_4);
    if (result.resolved.knock_cyl_5 !== 5) throw new Error('knock_cyl_5 expected 5, got ' + result.resolved.knock_cyl_5);
    if (result.resolved.knock_cyl_6 !== 6) throw new Error('knock_cyl_6 expected 6, got ' + result.resolved.knock_cyl_6);
    if (result.resolved.knock_cyl_7 !== 7) throw new Error('knock_cyl_7 expected 7, got ' + result.resolved.knock_cyl_7);
    if (result.resolved.knock_cyl_8 !== 8) throw new Error('knock_cyl_8 expected 8, got ' + result.resolved.knock_cyl_8);
    if (result.resolved.ign_timing !== 9) throw new Error('ign_timing expected 9, got ' + result.resolved.ign_timing);
    if (result.resolved.ign_timing_comp !== 10) throw new Error('ign_timing_comp expected 10, got ' + result.resolved.ign_timing_comp);
    if (result.resolved.rpm !== 11) throw new Error('rpm expected 11, got ' + result.resolved.rpm);
    if (result.resolved.map !== 12) throw new Error('map expected 12, got ' + result.resolved.map);
    if (result.resolved.tps !== 13) throw new Error('tps expected 13, got ' + result.resolved.tps);
    if (result.resolved.gear !== 14) throw new Error('gear expected 14, got ' + result.resolved.gear);
    if (result.resolved.coolant_temp !== 15) throw new Error('coolant_temp expected 15, got ' + result.resolved.coolant_temp);
    if (result.warnings.length !== 0) throw new Error('Expected 0 warnings, got ' + result.warnings.length);
});

check('performs case-insensitive matching', function() {
    const columns = [
        'Time', 'ignition cylinder 1 knock level', 'ENGINE SPEED', 'GEAR'
    ];

    const result = resolveChannels(columns);

    if (result.resolved.knock_cyl_1 !== 1) throw new Error('knock_cyl_1 expected 1, got ' + result.resolved.knock_cyl_1);
    if (result.resolved.rpm !== 2) throw new Error('rpm expected 2, got ' + result.resolved.rpm);
    if (result.resolved.gear !== 3) throw new Error('gear expected 3, got ' + result.resolved.gear);
});

check('handles leading/trailing whitespace in column names', function() {
    const columns = [
        '  Time  ', '  Ignition Cylinder 1 Knock Level  ', '  Engine Speed  '
    ];

    const result = resolveChannels(columns);

    if (result.resolved.knock_cyl_1 !== 1) throw new Error('knock_cyl_1 expected 1, got ' + result.resolved.knock_cyl_1);
    if (result.resolved.rpm !== 2) throw new Error('rpm expected 2, got ' + result.resolved.rpm);
});

check('returns -1 for channels not found', function() {
    const columns = ['Time', 'Engine Speed'];

    const result = resolveChannels(columns);

    if (result.resolved.knock_cyl_1 !== -1) throw new Error('knock_cyl_1 expected -1, got ' + result.resolved.knock_cyl_1);
    if (result.resolved.gear !== -1) throw new Error('gear expected -1, got ' + result.resolved.gear);
    if (result.resolved.ign_timing !== -1) throw new Error('ign_timing expected -1, got ' + result.resolved.ign_timing);
});

console.log('\nresolveChannels — knock channel warnings:');

check('generates warnings for all 8 missing knock channels', function() {
    const columns = ['Time', 'Engine Speed', 'Gear'];

    const result = resolveChannels(columns);

    if (result.warnings.length !== 8) throw new Error('Expected 8 warnings, got ' + result.warnings.length);
    for (let n = 1; n <= 8; n++) {
        const expected = 'Missing knock channel: Ignition Cylinder ' + n + ' Knock Level';
        if (!result.warnings.some(function(w) { return w === expected; })) {
            throw new Error('Missing warning for cylinder ' + n);
        }
    }
});

check('generates warnings only for missing knock channels', function() {
    const columns = [
        'Time', 'Ignition Cylinder 1 Knock Level', 'Ignition Cylinder 3 Knock Level',
        'Ignition Cylinder 5 Knock Level', 'Ignition Cylinder 7 Knock Level'
    ];

    const result = resolveChannels(columns);

    // Should have warnings for cylinders 2, 4, 6, 8
    if (result.warnings.length !== 4) throw new Error('Expected 4 warnings, got ' + result.warnings.length);
    if (!result.warnings.some(function(w) { return w.includes('Cylinder 2'); })) throw new Error('Missing warning for cyl 2');
    if (!result.warnings.some(function(w) { return w.includes('Cylinder 4'); })) throw new Error('Missing warning for cyl 4');
    if (!result.warnings.some(function(w) { return w.includes('Cylinder 6'); })) throw new Error('Missing warning for cyl 6');
    if (!result.warnings.some(function(w) { return w.includes('Cylinder 8'); })) throw new Error('Missing warning for cyl 8');
});

check('no warnings when all 8 knock channels present', function() {
    const columns = [
        'Time',
        'Ignition Cylinder 1 Knock Level', 'Ignition Cylinder 2 Knock Level',
        'Ignition Cylinder 3 Knock Level', 'Ignition Cylinder 4 Knock Level',
        'Ignition Cylinder 5 Knock Level', 'Ignition Cylinder 6 Knock Level',
        'Ignition Cylinder 7 Knock Level', 'Ignition Cylinder 8 Knock Level'
    ];

    const result = resolveChannels(columns);

    if (result.warnings.length !== 0) throw new Error('Expected 0 warnings, got ' + result.warnings.length);
});

console.log('\nresolveChannels — optional channels do NOT generate warnings:');

check('missing gear does not generate a warning', function() {
    const columns = [
        'Time',
        'Ignition Cylinder 1 Knock Level', 'Ignition Cylinder 2 Knock Level',
        'Ignition Cylinder 3 Knock Level', 'Ignition Cylinder 4 Knock Level',
        'Ignition Cylinder 5 Knock Level', 'Ignition Cylinder 6 Knock Level',
        'Ignition Cylinder 7 Knock Level', 'Ignition Cylinder 8 Knock Level',
        'Engine Speed'
    ];

    const result = resolveChannels(columns);

    if (result.warnings.length !== 0) throw new Error('Expected 0 warnings, got ' + result.warnings.length);
    if (result.resolved.gear !== -1) throw new Error('gear should be -1');
});

check('missing ign_timing_comp does not generate a warning', function() {
    const columns = [
        'Time',
        'Ignition Cylinder 1 Knock Level', 'Ignition Cylinder 2 Knock Level',
        'Ignition Cylinder 3 Knock Level', 'Ignition Cylinder 4 Knock Level',
        'Ignition Cylinder 5 Knock Level', 'Ignition Cylinder 6 Knock Level',
        'Ignition Cylinder 7 Knock Level', 'Ignition Cylinder 8 Knock Level',
        'Engine Speed', 'Ignition Timing'
    ];

    const result = resolveChannels(columns);

    if (result.warnings.length !== 0) throw new Error('Expected 0 warnings, got ' + result.warnings.length);
    if (result.resolved.ign_timing_comp !== -1) throw new Error('ign_timing_comp should be -1');
});

check('missing rpm, map, tps, coolant_temp do not generate warnings', function() {
    const columns = [
        'Time',
        'Ignition Cylinder 1 Knock Level', 'Ignition Cylinder 2 Knock Level',
        'Ignition Cylinder 3 Knock Level', 'Ignition Cylinder 4 Knock Level',
        'Ignition Cylinder 5 Knock Level', 'Ignition Cylinder 6 Knock Level',
        'Ignition Cylinder 7 Knock Level', 'Ignition Cylinder 8 Knock Level'
    ];

    const result = resolveChannels(columns);

    if (result.warnings.length !== 0) throw new Error('Expected 0 warnings, got ' + result.warnings.length);
    if (result.resolved.rpm !== -1) throw new Error('rpm should be -1');
    if (result.resolved.map !== -1) throw new Error('map should be -1');
    if (result.resolved.tps !== -1) throw new Error('tps should be -1');
    if (result.resolved.coolant_temp !== -1) throw new Error('coolant_temp should be -1');
});

console.log('\nresolveChannels — partial knock channels:');

check('analysis can proceed with partial knock channels', function() {
    const columns = [
        'Time', 'Ignition Cylinder 1 Knock Level', 'Ignition Cylinder 4 Knock Level',
        'Engine Speed', 'Inlet Manifold Pressure'
    ];

    const result = resolveChannels(columns);

    // Should resolve the channels that are present
    if (result.resolved.knock_cyl_1 !== 1) throw new Error('knock_cyl_1 expected 1');
    if (result.resolved.knock_cyl_4 !== 2) throw new Error('knock_cyl_4 expected 2');
    if (result.resolved.rpm !== 3) throw new Error('rpm expected 3');
    if (result.resolved.map !== 4) throw new Error('map expected 4');

    // Should have warnings for missing knock channels
    if (result.warnings.length !== 6) throw new Error('Expected 6 warnings, got ' + result.warnings.length);
});

check('alternative ign_timing_comp name resolves correctly', function() {
    const columns = [
        'Time', 'Ignition Timing Comp', 'Engine Speed'
    ];

    const result = resolveChannels(columns);

    if (result.resolved.ign_timing_comp !== 1) throw new Error('ign_timing_comp expected 1, got ' + result.resolved.ign_timing_comp);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
