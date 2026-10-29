/**
 * run-all.js — runs every Node test script in tests/ (the ones that require() Node modules; the rest are browser-suite
 * only) and prints one line per script, the output of any that fail, and a total. Exit code 1 if any failed.
 * Run: node tests/run-all.js [name-filter…]   e.g. node tests/run-all.js knock pulls
 */

'use strict';

var fs = require('fs');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var DIR = __dirname;
var filters = process.argv.slice(2);
var scripts = fs.readdirSync(DIR).filter(function (f) {
    if (!/^(test|run)-.*\.js$/.test(f) || f === 'run-all.js') return false;
    if (filters.length && !filters.some(function (x) { return f.indexOf(x) >= 0; })) return false;
    return /\brequire\(/.test(fs.readFileSync(path.join(DIR, f), 'utf8'));
}).sort();

var failed = [], t0 = Date.now();
scripts.forEach(function (f) {
    var start = Date.now();
    var r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(DIR, f)],
        { cwd: path.join(DIR, '..'), encoding: 'utf8', timeout: 300000 });
    var out = (r.stdout || '') + (r.stderr || '');
    var ok = r.status === 0;
    // Last "N passed…" style line, when the script prints one.
    var tally = out.split('\n').filter(function (l) { return /\d+\s+(passed|tests?)\b|passed:\s*\d+|trials passed/i.test(l); }).pop() || '';
    console.log((ok ? '  ✓ ' : '  ✗ ') + f + (tally ? '  — ' + tally.trim() : '') + '  (' + ((Date.now() - start) / 1000).toFixed(1) + ' s)');
    if (!ok) failed.push({ name: f, out: r.error ? String(r.error) : out });
});

failed.forEach(function (x) { console.log('\n===== ' + x.name + ' =====\n' + x.out.trim()); });
console.log('\n' + (scripts.length - failed.length) + ' of ' + scripts.length + ' scripts passed (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
process.exit(failed.length ? 1 : 0);
