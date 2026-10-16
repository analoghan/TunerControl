/**
 * run-server-tests.js — Tests for server/db.js and server/server.js.
 * Run: node tests/run-server-tests.js   (Node 22.13+; uses node:sqlite, so not part of the browser suite)
 */

'use strict';

var fs = require('fs');
var vm = require('vm');
var assert = require('assert');
var crypto = require('crypto');

process.env.TUNERCONTROL_TOKEN = 'test-token';
var parser = require('../lib/m1pkg-parser.js');
var TuneStore = require('../server/db.js').TuneStore;
var createServer = require('../server/server.js').createServer;

// Reuse the synthetic package builder and fixtures from the browser parser tests.
var sandbox = {
    atob: function (s) { return Buffer.from(s, 'base64').toString('latin1'); },
    describe: function () {}, it: function () {}, assert: assert,
    xzDecompress: require('../lib/xz-decoder.js').xzDecompress, xzFindStream: require('../lib/xz-decoder.js').xzFindStream
};
for (var k in parser) sandbox[k] = parser[k];
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/test-m1pkg-parser.js', 'utf8'), sandbox);
var V1 = sandbox.m1tPackage(sandbox.M1T_V1), V2 = sandbox.m1tPackage(sandbox.M1T_V2);

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('imports a package and returns it shaped like parseM1Pkg', function () {
    var store = new TuneStore(':memory:');
    var r = store.importFile(sha(V1), 'v1.m1pkg', V1);
    assert.strictEqual(r.duplicate, false);
    assert.strictEqual(r.record.tuneName, 'Tune V1');
    var pkg = store.getPackage(sha(V1));
    assert.deepStrictEqual(pkg.items, parser.parseM1Pkg(V1).items);
    assert.strictEqual(pkg.selections[0].name, 'Bosch 980');
    assert.deepStrictEqual(Buffer.from(store.getFile(sha(V1)).data), Buffer.from(V1));
});

test('detects duplicates and orders packages by save time', function () {
    var store = new TuneStore(':memory:');
    store.importFile(sha(V2), 'v2.m1pkg', V2);
    store.importFile(sha(V1), 'v1.m1pkg', V1);
    assert.strictEqual(store.importFile(sha(V1), 'again.m1pkg', V1).duplicate, true);
    assert.strictEqual(store.listSummaries().length, 2);
});

test('records per-cell history across packages', function () {
    var store = new TuneStore(':memory:');
    store.importFile(sha(V1), 'v1.m1pkg', V1);
    store.importFile(sha(V2), 'v2.m1pkg', V2);
    var h = store.history('Engine.Map & Trim', 'V[2,0]');
    assert.strictEqual(h.length, 2);
    assert.ok(Math.abs(h[0].value - 0.7) < 1e-6 && Math.abs(h[1].value - 0.75) < 1e-6);
    var pins = store.history('Engine.Switch Resource', '');
    assert.strictEqual(pins[1].text_value, '0x0000,0x0000,0x652a,0x0000,0x0000');
    assert.strictEqual(store.history('Engine.Polarity', '')[1].text_value, 'Inverting');
});

test('deleting a package removes its items and cells', function () {
    var store = new TuneStore(':memory:');
    store.importFile(sha(V1), 'v1.m1pkg', V1);
    assert.strictEqual(store.deletePackage(sha(V1)), true);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM cells').get().n, 0);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
    assert.strictEqual(store.deletePackage(sha(V1)), false);
});

test('backup round-trips packages and resource names', function () {
    var a = new TuneStore(':memory:');
    a.importFile(sha(V1), 'v1.m1pkg', V1);
    a.setResourceName('M142|0x0000,0x0000,0x6541,0x0000,0x0000', 'E888 AVI2');
    var b = new TuneStore(':memory:');
    assert.strictEqual(b.importBackup(JSON.parse(JSON.stringify(a.exportBackup()))), 1);
    assert.deepStrictEqual(b.getPackage(sha(V1)).items, a.getPackage(sha(V1)).items);
    assert.strictEqual(b.listResourceNames()['M142|0x0000,0x0000,0x6541,0x0000,0x0000'], 'E888 AVI2');
    assert.strictEqual(b.importBackup(a.exportBackup()), 0);
    assert.throws(function () { b.importBackup({ format: 'other' }); }, /Not a TunerControl M1 backup/);
});

test('re-parses packages stored with an older parser version', function () {
    var store = new TuneStore(':memory:');
    store.importFile(sha(V1), 'v1.m1pkg', V1);
    store.db.prepare('UPDATE packages SET parser_version = 0').run();
    assert.strictEqual(store.reparseStale(), 1);
    assert.strictEqual(store.reparseStale(), 0);
    assert.strictEqual(store.getPackage(sha(V1)).items.length, parser.parseM1Pkg(V1).items.length);
});

test('stores harness revisions and deletes them with the harness', function () {
    var store = new TuneStore(':memory:');
    var model = { name: 'H', sheets: [], connectors: [{ id: 'X1', pins: [] }], splices: [] };
    var a = store.saveHarness(null, 'Engine', model, 'import');
    model.connectors.push({ id: 'X2', pins: [] });
    var b = store.saveHarness(a.id, 'Engine harness', model, 'added X2');
    assert.deepStrictEqual([a.revision, b.revision], [1, 2]);
    var latest = store.getHarness(a.id);
    assert.strictEqual(latest.name, 'Engine harness');
    assert.strictEqual(latest.data.connectors.length, 2);
    assert.deepStrictEqual(latest.revisions.map(function (r) { return r.note; }), ['added X2', 'import']);
    assert.strictEqual(store.getHarness(a.id, 1).data.connectors.length, 1);
    assert.strictEqual(store.saveHarness('missing', 'x', model, ''), null);
    assert.strictEqual(store.deleteHarness(a.id), true);
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM harness_revisions').get().n, 0);
});

test('HTTP API: harnesses', function () {
    var server = createServer(new TuneStore(':memory:'));
    return new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); }).then(function () {
        var base = 'http://127.0.0.1:' + server.address().port + '/api/harnesses';
        var headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
        var model = { name: 'H', sheets: [], connectors: [], splices: [] }, id;
        return fetch(base, { method: 'POST', headers: headers, body: JSON.stringify({ name: 'Engine', data: model, note: 'new' }) })
            .then(function (r) { assert.strictEqual(r.status, 201); return r.json(); })
            .then(function (j) {
                id = j.id;
                return fetch(base + '/' + id, { method: 'PUT', headers: headers, body: JSON.stringify({ name: 'Engine', data: model }) });
            })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                assert.strictEqual(j.revision, 2);
                return fetch(base, { method: 'POST', headers: headers, body: JSON.stringify({ name: 'Bad', data: {} }) });
            })
            .then(function (r) {
                assert.strictEqual(r.status, 400);
                return fetch(base + '/' + id + '?revision=1', { headers: headers });
            })
            .then(function (r) { return r.json(); })
            .then(function (h) {
                assert.deepStrictEqual([h.revision, h.latest, h.revisions.length], [1, 2, 2]);
                return fetch(base + '/' + id, { method: 'DELETE', headers: headers });
            })
            .then(function (r) {
                assert.strictEqual(r.status, 204);
                return fetch(base, { headers: headers });
            })
            .then(function (r) { return r.json(); })
            .then(function (list) { assert.deepStrictEqual(list, []); })
            .finally(function () { server.close(); });
    });
});

test('HTTP API: token, upload, list and private paths', function () {
    var server = createServer(new TuneStore(':memory:'));
    return new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); }).then(function () {
        var base = 'http://127.0.0.1:' + server.address().port;
        var auth = { Authorization: 'Bearer test-token' };
        return fetch(base + '/api/health').then(function (r) { return r.json(); }).then(function (j) {
            assert.deepStrictEqual([j.ok, j.auth], [true, true]);
            return fetch(base + '/api/packages');
        }).then(function (r) {
            assert.strictEqual(r.status, 401);
            return fetch(base + '/api/packages', {
                method: 'POST', body: V1, headers: Object.assign({ 'X-File-Name': encodeURIComponent('v1 tune.m1pkg') }, auth)
            });
        }).then(function (r) {
            assert.strictEqual(r.status, 201);
            return r.json();
        }).then(function (j) {
            assert.strictEqual(j.record.fileName, 'v1 tune.m1pkg');
            return fetch(base + '/api/packages', { method: 'POST', body: new Uint8Array([1, 2, 3]), headers: auth });
        }).then(function (r) {
            assert.strictEqual(r.status, 422);
            return fetch(base + '/api/packages/' + sha(V1), { headers: auth });
        }).then(function (r) { return r.json(); }).then(function (pkg) {
            assert.strictEqual(pkg.items.length, parser.parseM1Pkg(V1).items.length);
            return Promise.all(['/server/db.js', '/files/', '/data/x.db', '/.git/config', '/%2e%2e/server/db.js']
                .map(function (p) { return fetch(base + p).then(function (r) { return r.status; }); }));
        }).then(function (codes) {
            assert.deepStrictEqual(codes, [404, 404, 404, 404, 404]);
            return fetch(base + '/m1-config/');
        }).then(function (r) {
            assert.strictEqual(r.status, 200);
        }).finally(function () { server.close(); });
    });
});

(async function () {
    var failed = 0;
    for (var i = 0; i < tests.length; i++) {
        try { await tests[i].fn(); console.log('PASS', tests[i].name); }
        catch (err) { failed++; console.log('FAIL', tests[i].name, '\n  ', err && err.message); }
    }
    console.log((tests.length - failed) + '/' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
