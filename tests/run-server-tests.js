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
    assert.strictEqual(b.importBackup(JSON.parse(JSON.stringify(a.exportBackup()))).packages, 1);
    assert.deepStrictEqual(b.getPackage(sha(V1)).items, a.getPackage(sha(V1)).items);
    assert.deepStrictEqual(Buffer.from(b.getFile(sha(V1)).data), Buffer.from(V1), 'the original .m1pkg comes back too');
    assert.strictEqual(b.listResourceNames()['M142|0x0000,0x0000,0x6541,0x0000,0x0000'], 'E888 AVI2');
    assert.strictEqual(b.importBackup(a.exportBackup()).packages, 0);
    assert.throws(function () { b.importBackup({ format: 'other' }); }, /Not a TunerControl backup/);
    // An older M1-only backup (no files, no harnesses) still restores.
    var old = { format: 'tunercontrol-m1-backup', version: 1, packages: [a.getPackage(sha(V1))], resourceNames: { 'label|g:Fuel': 'Fuel' } };
    var c = new TuneStore(':memory:');
    assert.strictEqual(c.importBackup(old).packages, 1);
    assert.strictEqual(c.listResourceNames()['label|g:Fuel'], 'Fuel');
});

test('full backup: harnesses with every revision, systems with CAN networks, images, history', function () {
    var a = new TuneStore(':memory:');
    a.importFile(sha(V1), 'v1.m1pkg', V1);
    var model = { name: 'H', sheets: [], connectors: [{ id: 'X1', pins: [], images: [{ id: sha(Buffer.from('png')), mime: 'image/png' }] }], splices: [] };
    var h = a.saveHarness(null, 'Engine', model, 'import');
    model.connectors.push({ id: 'X2', pins: [] });
    a.saveHarness(h.id, 'Engine', model, 'added X2');
    a.saveHarness(h.id, 'Engine', model, 'third');
    a.deleteHarnessRevision(h.id, 2);
    var sys = a.saveHarnessSystem(null, { name: 'Car', harnesses: [h.id], canNetworks: [{ id: 'n1', name: 'CAN 1', hubs: [], devices: [] }] });
    a.putHarnessImage(sha(Buffer.from('png')), 'image/png', new Uint8Array(Buffer.from('png')));
    a.saveRun({ tool: 'knock', logName: 'a.ld', summary: { events: 0 } });
    var backup = JSON.parse(JSON.stringify(a.exportBackup()));
    assert.strictEqual(backup.format, 'tunercontrol-backup');
    var b = new TuneStore(':memory:');
    assert.deepStrictEqual(b.importBackup(backup), { packages: 1, resourceNames: 0, runs: 1, harnesses: 1, revisions: 2, systems: 1, images: 1 });
    var got = b.getHarness(h.id);
    assert.deepStrictEqual(got.revisions.map(function (r) { return r.revision + ' ' + r.note; }), ['3 third', '1 import'], 'revisions keep their numbers and notes');
    assert.deepStrictEqual(got.data, model);
    assert.strictEqual(b.saveHarness(h.id, 'Engine', model, 'next').revision, 4, 'numbering carries on');
    var s2 = b.listHarnessSystems()[0];
    assert.deepStrictEqual([s2.id, s2.harnesses, s2.canNetworks[0].name], [sys.id, [h.id], 'CAN 1']);
    assert.deepStrictEqual(Buffer.from(b.getHarnessImage(sha(Buffer.from('png'))).data).toString(), 'png');
    assert.deepStrictEqual(b.importBackup(backup), { packages: 0, resourceNames: 0, runs: 0, harnesses: 0, revisions: 0, systems: 0, images: 0 },
        'restoring twice adds nothing');
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

test('deletes single harness revisions without reusing their numbers', function () {
    var store = new TuneStore(':memory:');
    var model = { name: 'H', sheets: [], connectors: [], splices: [] };
    var id = store.saveHarness(null, 'H', model, 'one').id;
    store.saveHarness(id, 'H', model, 'two');
    store.saveHarness(id, 'H', model, 'three');
    assert.deepStrictEqual(store.deleteHarnessRevision(id, 2), { latest: 3 });
    assert.deepStrictEqual(store.getHarness(id).revisions.map(function (r) { return r.revision; }), [3, 1]);
    assert.deepStrictEqual(store.deleteHarnessRevision(id, 3), { latest: 1 });
    assert.strictEqual(store.getHarness(id).revision, 1);
    assert.strictEqual(store.listHarnesses()[0].revision, 1);
    assert.strictEqual(store.saveHarness(id, 'H', model, 'four').revision, 4, 'numbers are not reused');
    assert.strictEqual(store.deleteHarnessRevision(id, 2), null);
    store.deleteHarnessRevision(id, 1);
    assert.throws(function () { store.deleteHarnessRevision(id, 4); }, /only revision/);
});

test('stores harness systems and drops deleted harnesses from them', function () {
    var store = new TuneStore(':memory:');
    var model = { name: 'H', sheets: [], connectors: [], splices: [] };
    var a = store.saveHarness(null, 'Engine', model, '').id, b = store.saveHarness(null, 'Chassis', model, '').id;
    var link = { a: { harness: a, connector: 'CHAS.A' }, b: { harness: b, connector: 'CHAS.A' } };
    var sys = store.saveHarnessSystem(null, { name: 'Car', harnesses: [a, b], manual: [link] });
    assert.deepStrictEqual(store.listHarnessSystems()[0].harnesses, [a, b]);
    assert.deepStrictEqual(store.listHarnessSystems()[0].manual, [link]);
    store.deleteHarness(b);
    assert.deepStrictEqual(store.listHarnessSystems()[0].harnesses, [a]);
    assert.strictEqual(store.saveHarnessSystem('missing', { name: 'x', harnesses: [] }), null);
    assert.strictEqual(store.deleteHarnessSystem(sys.id), true);
    assert.deepStrictEqual(store.listHarnessSystems(), []);
});

test('HTTP API: harness systems', function () {
    var server = createServer(new TuneStore(':memory:'));
    return new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); }).then(function () {
        var base = 'http://127.0.0.1:' + server.address().port + '/api/harness-systems';
        var headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, id;
        return fetch(base, { method: 'POST', headers: headers, body: JSON.stringify({ name: 'Car', harnesses: ['h1'] }) })
            .then(function (r) { assert.strictEqual(r.status, 201); return r.json(); })
            .then(function (s) {
                id = s.id;
                assert.deepStrictEqual([s.name, s.harnesses, s.manual, s.rejected], ['Car', ['h1'], [], []]);
                assert.deepStrictEqual(s.canNetworks, []);
                return fetch(base + '/' + id, { method: 'PUT', headers: headers, body: JSON.stringify({ name: 'Car 2', harnesses: ['h1', 'h2'],
                    canNetworks: [{ id: 'n1', name: 'CAN 1', bitrate: 1000, devices: [{ id: 'd1', name: 'M142', termination: true }] }] }) });
            })
            .then(function (r) { return r.json(); })
            .then(function (s) {
                assert.deepStrictEqual(s.harnesses, ['h1', 'h2']);
                assert.strictEqual(s.canNetworks[0].devices[0].name, 'M142', 'CAN networks are kept with the system');
                return fetch(base, { method: 'POST', headers: headers, body: JSON.stringify({ name: 'Bad' }) });
            })
            .then(function (r) {
                assert.strictEqual(r.status, 400);
                return fetch(base + '/' + id, { method: 'DELETE', headers: headers });
            })
            .then(function (r) { assert.strictEqual(r.status, 204); })
            .finally(function () { server.close(); });
    });
});

test('stores tuning history runs, oldest log first, and backs them up', function () {
    var store = new TuneStore(':memory:');
    var b = store.saveRun({ tool: 've', logName: 'b.ld', logTime: '2026-06-11T17:32:21Z', tuneName: 'V55', summary: { cells: 3 },
                            settings: { steadyWindowMs: 300 }, data: { grid: [1, 2] } });
    var a = store.saveRun({ tool: 've', logName: 'a.ld', logTime: '2026-05-23T18:11:58Z', summary: { cells: 1 } });
    store.saveRun({ tool: 'knock', logName: 'a.ld', summary: { events: 0 } });
    assert.deepStrictEqual(store.listRuns('ve').map(function (r) { return r.logName; }), ['a.ld', 'b.ld']);
    assert.strictEqual(store.listRuns('ve')[1].data, undefined, 'list leaves out the detail');
    assert.deepStrictEqual(store.listRuns('ve', true)[1].data, { grid: [1, 2] });
    assert.strictEqual(store.listRuns(null).length, 3);
    assert.ok(store.setRunNote(a.id, 'before the VE change'));
    assert.strictEqual(store.getRun(a.id).note, 'before the VE change');
    assert.throws(function () { store.saveRun({ tool: 'nope', summary: {} }); });
    var copy = new TuneStore(':memory:');
    copy.importBackup(store.exportBackup());
    assert.strictEqual(copy.listRuns(null).length, 3);
    assert.deepStrictEqual(copy.getRun(b.id).settings, { steadyWindowMs: 300 });
    assert.ok(store.deleteRun(b.id));
    assert.strictEqual(store.getRun(b.id), null);
});

test('HTTP API: tuning history runs', function () {
    var server = createServer(new TuneStore(':memory:'));
    return new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); }).then(function () {
        var base = 'http://127.0.0.1:' + server.address().port + '/api/runs';
        var headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, id;
        return fetch(base, { method: 'POST', headers: headers, body: JSON.stringify({ tool: 'knock', logName: 'x.ld', summary: { events: 2 }, data: { d: 1 } }) })
            .then(function (r) { assert.strictEqual(r.status, 201); return r.json(); })
            .then(function (run) {
                id = run.id;
                return fetch(base + '?tool=knock&full=1', { headers: headers });
            })
            .then(function (r) { return r.json(); })
            .then(function (list) {
                assert.deepStrictEqual(list.map(function (r) { return [r.logName, r.data.d]; }), [['x.ld', 1]]);
                return fetch(base + '/' + id, { method: 'PUT', headers: headers, body: JSON.stringify({ note: 'n' }) });
            })
            .then(function (r) { return r.json(); })
            .then(function (run) {
                assert.strictEqual(run.note, 'n');
                return fetch(base, { method: 'POST', headers: headers, body: JSON.stringify({ tool: 'bad', summary: {} }) });
            })
            .then(function (r) {
                assert.strictEqual(r.status, 400);
                return fetch(base + '/' + id, { method: 'DELETE', headers: headers });
            })
            .then(function (r) { assert.strictEqual(r.status, 204); })
            .finally(function () { server.close(); });
    });
});

test('HTTP API: harness images are stored once by content hash', function () {
    var server = createServer(new TuneStore(':memory:'));
    var png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    return new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); }).then(function () {
        var base = 'http://127.0.0.1:' + server.address().port + '/api/harness-images';
        var auth = { Authorization: 'Bearer test-token' };
        function post(type) { return fetch(base, { method: 'POST', body: png, headers: Object.assign({ 'Content-Type': type }, auth) }); }
        return post('image/png').then(function (r) { assert.strictEqual(r.status, 201); return r.json(); })
            .then(function (j) {
                assert.strictEqual(j.id, sha(png));
                return post('image/png').then(function (r) { return r.json(); }).then(function (k) {
                    assert.strictEqual(k.id, j.id);
                    return fetch(base + '/' + j.id, { headers: auth });
                });
            })
            .then(function (r) {
                assert.strictEqual(r.headers.get('content-type'), 'image/png');
                return r.arrayBuffer();
            })
            .then(function (b) {
                assert.deepStrictEqual(new Uint8Array(b), png);
                return post('text/html');
            })
            .then(function (r) {
                assert.strictEqual(r.status, 415);
                return fetch(base + '/' + 'f'.repeat(64), { headers: auth });
            })
            .then(function (r) { assert.strictEqual(r.status, 404); })
            .finally(function () { server.close(); });
    });
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
                return fetch(base + '/' + id + '/revisions/2', { method: 'DELETE', headers: headers });
            })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                assert.deepStrictEqual(j, { latest: 1 });
                return fetch(base + '/' + id + '/revisions/1', { method: 'DELETE', headers: headers });
            })
            .then(function (r) {
                assert.strictEqual(r.status, 409, 'cannot delete the only revision');
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
