/**
 * harness/harness-store.js — Storage for harness designs, plus read access to stored tunes.
 *
 * Uses the TunerControl server when the page is served by one (server/server.js, /api/harnesses),
 * otherwise IndexedDB database "tunercontrol-harness" in this browser:
 *   harnesses : { id, name, created, updated, revision, latest }  revision = highest number ever saved
 *               (not reused after a delete), latest = newest stored revision
 *   revisions : { harnessId, revision, saved, note, data }   key [harnessId, revision]
 *   images    : { id, mime, data: Blob }   connector/splice pictures, id = hash of the bytes
 *   systems   : { id, name, updated, harnesses: [ids], manual: [links], rejected: [links] }
 * Tunes for the tune comparison come from the M1 Config Viewer's storage (tune-db.js / tune-api.js).
 */

var HS_DB_NAME = 'tunercontrol-harness';
var hsBackend = 'memory';          // 'server' | 'browser' | 'memory'
var hsDbPromise = null;
var hsMemory = { harnesses: {}, revisions: {}, images: {}, systems: {} };
var hsImageUrls = {};              // image id → object URL (cached for the page's lifetime)

function hsOpenDb() {
    if (hsDbPromise) return hsDbPromise;
    hsDbPromise = new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
        var req = indexedDB.open(HS_DB_NAME, 3);
        req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('harnesses')) db.createObjectStore('harnesses', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('revisions')) {
                db.createObjectStore('revisions', { keyPath: ['harnessId', 'revision'] }).createIndex('harnessId', 'harnessId');
            }
            if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('systems')) db.createObjectStore('systems', { keyPath: 'id' });
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
    return list.then(function (rows) {
        return rows.map(function (h) { return Object.assign({}, h, { revision: h.latest || h.revision }); })
            .sort(function (a, b) { return a.updated < b.updated ? 1 : -1; });
    });
}

/** Latest or given revision: { id, name, revision, saved, note, data, revisions: [{ revision, saved, note }], latest }. */
function hsLoad(id, revision) {
    if (hsBackend === 'server') return tuneApi('GET', 'harnesses/' + encodeURIComponent(id) + (revision ? '?revision=' + revision : ''));
    function build(h, revs) {
        if (!h || !revs.length) throw new Error('Harness not found');
        var latest = Math.max.apply(null, revs.map(function (r) { return r.revision; }));
        var rev = revs.filter(function (r) { return r.revision === (revision || latest); })[0];
        if (!rev) throw new Error('Revision not found');
        return Object.assign({}, h, { revision: rev.revision, saved: rev.saved, note: rev.note, data: rev.data, latest: latest,
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
        h.revision++; h.latest = h.revision; h.name = name; h.updated = now;
        (hsMemory.revisions[id] = hsMemory.revisions[id] || []).push({ harnessId: id, revision: h.revision, saved: now, note: note || '', data: copy });
        return Promise.resolve({ id: id, revision: h.revision, saved: now });
    }
    return hsTx(['harnesses', 'revisions'], 'readwrite', function (tx) {
        var hs = tx.objectStore('harnesses');
        return (id ? hsReq(hs.get(id)) : Promise.resolve(null)).then(function (h) {
            if (!h) { id = id || hsUuid(); h = { id: id, name: name, created: now, updated: now, revision: 0 }; }
            h.revision++; h.latest = h.revision; h.name = name; h.updated = now;
            hs.put(h);
            tx.objectStore('revisions').put({ harnessId: id, revision: h.revision, saved: now, note: note || '', data: copy });
            return { id: id, revision: h.revision, saved: now };
        });
    });
}

/** Delete one revision. Resolves { latest }; rejects when it is the only revision left. */
function hsDeleteRevision(id, revision) {
    if (hsBackend === 'server') return tuneApi('DELETE', 'harnesses/' + encodeURIComponent(id) + '/revisions/' + revision);
    function check(revs) {
        if (!revs.some(function (r) { return r.revision === revision; })) throw new Error('Revision not found');
        if (revs.length <= 1) throw new Error('This is the only revision; delete the harness instead');
        return Math.max.apply(null, revs.filter(function (r) { return r.revision !== revision; }).map(function (r) { return r.revision; }));
    }
    if (hsBackend === 'memory') {
        return Promise.resolve().then(function () {
            var revs = hsMemory.revisions[id] || [], latest = check(revs);
            hsMemory.revisions[id] = revs.filter(function (r) { return r.revision !== revision; });
            hsMemory.harnesses[id].latest = latest;
            return { latest: latest };
        });
    }
    return hsTx(['harnesses', 'revisions'], 'readwrite', function (tx) {
        var revStore = tx.objectStore('revisions'), hs = tx.objectStore('harnesses');
        return Promise.all([hsReq(hs.get(id)), hsReq(revStore.index('harnessId').getAll(id))]).then(function (r) {
            var latest = check(r[1]);
            revStore.delete([id, revision]);
            r[0].latest = latest;
            hs.put(r[0]);
            return { latest: latest };
        });
    });
}

function hsDelete(id) {
    if (hsBackend === 'server') return tuneApi('DELETE', 'harnesses/' + encodeURIComponent(id));
    if (hsBackend === 'memory') {
        delete hsMemory.harnesses[id]; delete hsMemory.revisions[id];
        Object.keys(hsMemory.systems).forEach(function (k) {
            var s = hsMemory.systems[k];
            s.harnesses = s.harnesses.filter(function (h) { return h !== id; });
        });
        return Promise.resolve();
    }
    return hsTx(['harnesses', 'revisions', 'systems'], 'readwrite', function (tx) {
        tx.objectStore('harnesses').delete(id);
        var systems = tx.objectStore('systems');
        hsReq(systems.getAll()).then(function (list) {
            list.forEach(function (s) {
                if (s.harnesses.indexOf(id) < 0) return;
                s.harnesses = s.harnesses.filter(function (h) { return h !== id; });
                systems.put(s);
            });
        });
        var revs = tx.objectStore('revisions');
        return hsReq(revs.index('harnessId').getAllKeys(id)).then(function (keys) {
            keys.forEach(function (k) { revs.delete(k); });
        });
    });
}

// ---- Systems (harnesses joined by mating connectors) ----

function hsListSystems() {
    if (hsBackend === 'server') return tuneApi('GET', 'harness-systems');
    var list = hsBackend === 'memory' ? Promise.resolve(Object.keys(hsMemory.systems).map(function (k) { return hsMemory.systems[k]; }))
        : hsTx(['systems'], 'readonly', function (tx) { return hsReq(tx.objectStore('systems').getAll()); });
    return list.then(function (rows) { return rows.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }); });
}

/** Create (id null) or update a system { name, harnesses, manual, rejected }. Resolves the stored record. */
function hsSaveSystem(id, system) {
    var body = { name: system.name, harnesses: system.harnesses || [], manual: system.manual || [], rejected: system.rejected || [] };
    if (hsBackend === 'server') {
        return tuneApi(id ? 'PUT' : 'POST', 'harness-systems' + (id ? '/' + encodeURIComponent(id) : ''), { body: body });
    }
    var rec = Object.assign({ id: id || hsUuid(), updated: new Date().toISOString() }, JSON.parse(JSON.stringify(body)));
    if (hsBackend === 'memory') { hsMemory.systems[rec.id] = rec; return Promise.resolve(rec); }
    return hsTx(['systems'], 'readwrite', function (tx) { tx.objectStore('systems').put(rec); return rec; });
}

function hsDeleteSystem(id) {
    if (hsBackend === 'server') return tuneApi('DELETE', 'harness-systems/' + encodeURIComponent(id));
    if (hsBackend === 'memory') { delete hsMemory.systems[id]; return Promise.resolve(); }
    return hsTx(['systems'], 'readwrite', function (tx) { tx.objectStore('systems').delete(id); });
}

// ---- Images ----

/** Store image bytes (Uint8Array or Blob). Resolves the image id; the same bytes always get the same id. */
function hsPutImage(data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    if (hsBackend === 'server') {
        return tuneApi('POST', 'harness-images', { body: blob, headers: { 'Content-Type': mime } }).then(function (r) { return r.id; });
    }
    return blob.arrayBuffer().then(tuneDbFileId).then(function (id) {
        if (hsBackend === 'memory') { hsMemory.images[id] = { id: id, mime: mime, data: blob }; return id; }
        return hsTx(['images'], 'readwrite', function (tx) {
            tx.objectStore('images').put({ id: id, mime: mime, data: blob });
            return id;
        });
    });
}

function hsImageBlob(id) {
    if (hsBackend === 'server') {
        return tuneApi('GET', 'harness-images/' + encodeURIComponent(id), { raw: true }).then(function (r) { return r.blob(); });
    }
    var get = hsBackend === 'memory' ? Promise.resolve(hsMemory.images[id])
        : hsTx(['images'], 'readonly', function (tx) { return hsReq(tx.objectStore('images').get(id)); });
    return get.then(function (rec) {
        if (!rec) throw new Error('Image ' + id.slice(0, 12) + '… is not stored here');
        return rec.data;
    });
}

/** Object URL for showing an image (fetched with the API token when needed). */
function hsImageUrl(id) {
    if (hsImageUrls[id]) return Promise.resolve(hsImageUrls[id]);
    return hsImageBlob(id).then(function (blob) { return (hsImageUrls[id] = URL.createObjectURL(blob)); });
}

function hsImageBytes(id) {
    return hsImageBlob(id).then(function (b) { return b.arrayBuffer(); }).then(function (a) { return new Uint8Array(a); });
}

/** Replace freshly imported images ({ data, mime, … }) in a model with stored ones ({ id, mime, … }). */
function hsStoreModelImages(model, onProgress) {
    var pending = [];
    model.connectors.concat(model.splices).forEach(function (b) {
        (b.images || []).forEach(function (im) { if (im.data) pending.push(im); });
    });
    var done = 0;
    return pending.reduce(function (p, im) {
        return p.then(function () {
            return hsPutImage(im.data, im.mime).then(function (id) {
                im.id = id;
                delete im.data;
                if (onProgress) onProgress(++done, pending.length);
            });
        });
    }, Promise.resolve()).then(function () { return pending.length; });
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
