/**
 * harness/harness-store.js — Storage for harness designs, plus read access to stored tunes.
 *
 * Uses the TunerControl server when the page is served by one (server/server.js, /api/harnesses),
 * otherwise IndexedDB database "tunercontrol-harness" in this browser:
 *   harnesses : { id, name, created, updated, revision }
 *   revisions : { harnessId, revision, saved, note, data }   key [harnessId, revision]
 * Tunes for the tune comparison come from the M1 Config Viewer's storage (tune-db.js / tune-api.js).
 */

var HS_DB_NAME = 'tunercontrol-harness';
var hsBackend = 'memory';          // 'server' | 'browser' | 'memory'
var hsDbPromise = null;
var hsMemory = { harnesses: {}, revisions: {} };

function hsOpenDb() {
    if (hsDbPromise) return hsDbPromise;
    hsDbPromise = new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
        var req = indexedDB.open(HS_DB_NAME, 1);
        req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('harnesses')) db.createObjectStore('harnesses', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('revisions')) {
                db.createObjectStore('revisions', { keyPath: ['harnessId', 'revision'] }).createIndex('harnessId', 'harnessId');
            }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('Could not open the harness database')); };
    });
    hsDbPromise.catch(function () { hsDbPromise = null; });
    return hsDbPromise;
}

function hsTx(stores, mode, fn) {
    return hsOpenDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(stores, mode), result;
            Promise.resolve(fn(tx)).then(function (r) { result = r; }, reject);
            tx.oncomplete = function () { resolve(result); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
        });
    });
}

function hsReq(req) {
    return new Promise(function (resolve, reject) {
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}

function hsUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

/** Pick the backend: 'server' when served by TunerControl, else 'browser' (IndexedDB), else 'memory'. */
function hsChooseBackend() {
    return detectTuneServer().then(function (server) {
        if (server) return 'server';
        return hsOpenDb().then(function () { return 'browser'; }, function () { return 'memory'; });
    }).then(function (b) { hsBackend = b; return b; });
}

/** Harness summaries, newest first. */
function hsList() {
    if (hsBackend === 'server') return tuneApi('GET', 'harnesses');
    var list = hsBackend === 'browser'
        ? hsTx(['harnesses'], 'readonly', function (tx) { return hsReq(tx.objectStore('harnesses').getAll()); })
        : Promise.resolve(Object.keys(hsMemory.harnesses).map(function (k) { return hsMemory.harnesses[k]; }));
    return list.then(function (rows) { return rows.sort(function (a, b) { return a.updated < b.updated ? 1 : -1; }); });
}

/** Latest or given revision: { id, name, revision, saved, note, data, revisions: [{ revision, saved, note }], latest }. */
function hsLoad(id, revision) {
    if (hsBackend === 'server') return tuneApi('GET', 'harnesses/' + encodeURIComponent(id) + (revision ? '?revision=' + revision : ''));
    function build(h, revs) {
        if (!h) throw new Error('Harness not found');
        var rev = revs.filter(function (r) { return r.revision === (revision || h.revision); })[0];
        if (!rev) throw new Error('Revision not found');
        return Object.assign({}, h, { revision: rev.revision, saved: rev.saved, note: rev.note, data: rev.data, latest: h.revision,
            revisions: revs.map(function (r) { return { revision: r.revision, saved: r.saved, note: r.note }; })
                .sort(function (a, b) { return b.revision - a.revision; }) });
    }
    if (hsBackend === 'memory') return Promise.resolve().then(function () { return build(hsMemory.harnesses[id], hsMemory.revisions[id] || []); });
    return hsTx(['harnesses', 'revisions'], 'readonly', function (tx) {
        return Promise.all([hsReq(tx.objectStore('harnesses').get(id)),
                            hsReq(tx.objectStore('revisions').index('harnessId').getAll(id))]);
    }).then(function (r) { return build(r[0], r[1]); });
}

/** Save a new revision; id null creates a harness. Resolves { id, revision, saved }. */
function hsSave(id, name, data, note) {
    if (hsBackend === 'server') {
        return tuneApi(id ? 'PUT' : 'POST', 'harnesses' + (id ? '/' + encodeURIComponent(id) : ''),
            { body: { name: name, data: data, note: note || '' } });
    }
    var now = new Date().toISOString();
    var copy = JSON.parse(JSON.stringify(data));
    if (hsBackend === 'memory') {
        var h = id ? hsMemory.harnesses[id] : null;
        if (!h) { id = hsUuid(); h = hsMemory.harnesses[id] = { id: id, name: name, created: now, updated: now, revision: 0 }; }
        h.revision++; h.name = name; h.updated = now;
        (hsMemory.revisions[id] = hsMemory.revisions[id] || []).push({ harnessId: id, revision: h.revision, saved: now, note: note || '', data: copy });
        return Promise.resolve({ id: id, revision: h.revision, saved: now });
    }
    return hsTx(['harnesses', 'revisions'], 'readwrite', function (tx) {
        var hs = tx.objectStore('harnesses');
        return (id ? hsReq(hs.get(id)) : Promise.resolve(null)).then(function (h) {
            if (!h) { id = id || hsUuid(); h = { id: id, name: name, created: now, updated: now, revision: 0 }; }
            h.revision++; h.name = name; h.updated = now;
            hs.put(h);
            tx.objectStore('revisions').put({ harnessId: id, revision: h.revision, saved: now, note: note || '', data: copy });
            return { id: id, revision: h.revision, saved: now };
        });
    });
}

function hsDelete(id) {
    if (hsBackend === 'server') return tuneApi('DELETE', 'harnesses/' + encodeURIComponent(id));
    if (hsBackend === 'memory') { delete hsMemory.harnesses[id]; delete hsMemory.revisions[id]; return Promise.resolve(); }
    return hsTx(['harnesses', 'revisions'], 'readwrite', function (tx) {
        tx.objectStore('harnesses').delete(id);
        var revs = tx.objectStore('revisions');
        return hsReq(revs.index('harnessId').getAllKeys(id)).then(function (keys) {
            keys.forEach(function (k) { revs.delete(k); });
        });
    });
}

// ---- Tunes (read-only, from the M1 Config Viewer's storage) ----

function hsTunes() {
    if (hsBackend === 'server') return apiListPackages();
    if (hsBackend === 'browser') return listTunePackages().catch(function () { return []; });
    return Promise.resolve([]);
}

function hsTune(id) {
    return hsBackend === 'server' ? apiLoadPackage(id) : loadTunePackage(id);
}

function hsResourceNames() {
    if (hsBackend === 'server') return apiListResourceNames();
    if (hsBackend === 'browser') return listResourceNames().catch(function () { return {}; });
    return Promise.resolve({});
}
