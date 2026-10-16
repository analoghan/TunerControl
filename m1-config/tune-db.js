/**
 * m1-config/tune-db.js — Browser (IndexedDB) storage for imported M1 packages.
 *
 * Stores (database "tunercontrol-m1"):
 *   packages : one summary record per imported .m1pkg, keyed by SHA-256 of the file
 *              { id, fileName, fileSize, importedAt, parserVersion, tuneName, modified, serial,
 *                firmware, meta, commentLog, selections, itemCount }
 *   items    : { id, items }  — the full parsed item list for that package
 *   files    : { id, name, data }  — the original file bytes, so packages can be re-parsed
 *              when the parser improves (see parserVersion)
 *   resourceNames : { key, name }  — user names for I/O resources, key = 'HARDWARE|signature', and the Config Viewer's
 *              labels, key = 'label|<entity key>' (e.g. 'label|g:Auxiliary.Output 3')
 * Data stays in this browser; exportTuneDb/importTuneDb give JSON backups.
 */

var TUNE_DB_NAME = 'tunercontrol-m1';
var TUNE_DB_VERSION = 2;
var tuneDbPromise = null;

function openTuneDb() {
    if (tuneDbPromise) return tuneDbPromise;
    tuneDbPromise = new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser')); return; }
        var req = indexedDB.open(TUNE_DB_NAME, TUNE_DB_VERSION);
        req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('packages')) {
                db.createObjectStore('packages', { keyPath: 'id' }).createIndex('modified', 'modified');
            }
            if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('resourceNames')) db.createObjectStore('resourceNames', { keyPath: 'key' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('Could not open the tune database')); };
    });
    tuneDbPromise.catch(function () { tuneDbPromise = null; });
    return tuneDbPromise;
}

function tuneDbRequest(req) {
    return new Promise(function (resolve, reject) {
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}

function tuneDbTransaction(stores, mode, fn) {
    return openTuneDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(stores, mode), result;
            Promise.resolve(fn(tx)).then(function (r) { result = r; }, reject);
            tx.oncomplete = function () { resolve(result); };
            tx.onerror = function () { reject(tx.error); };
            tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
        });
    });
}

/** Stable package id: SHA-256 of the file (FNV-1a fallback where WebCrypto is unavailable). */
function tuneDbFileId(buffer) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
        return crypto.subtle.digest('SHA-256', buffer).then(function (hash) {
            return Array.prototype.map.call(new Uint8Array(hash), function (b) {
                return ('0' + b.toString(16)).slice(-2);
            }).join('');
        });
    }
    var bytes = new Uint8Array(buffer), h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
    return Promise.resolve('fnv-' + h.toString(16) + '-' + bytes.length);
}

function tuneDbSummary(id, parsed, fileName, fileSize) {
    return {
        id: id, fileName: fileName, fileSize: fileSize, importedAt: new Date().toISOString(),
        parserVersion: parsed.parserVersion, tuneName: parsed.tuneName, modified: parsed.modified,
        serial: parsed.serial, firmware: parsed.firmware, meta: parsed.meta,
        commentLog: parsed.commentLog, selections: parsed.selections, itemCount: parsed.items.length
    };
}

/**
 * Save a parsed package. Resolves { record, duplicate } — duplicate is true when the same file
 * was already imported (the existing record is returned unchanged).
 */
function saveTunePackage(id, parsed, fileName, fileBuffer) {
    return tuneDbTransaction(['packages', 'items', 'files'], 'readwrite', function (tx) {
        var packages = tx.objectStore('packages');
        return tuneDbRequest(packages.get(id)).then(function (existing) {
            if (existing) return { record: existing, duplicate: true };
            var record = tuneDbSummary(id, parsed, fileName, fileBuffer ? fileBuffer.byteLength : null);
            packages.put(record);
            tx.objectStore('items').put({ id: id, items: parsed.items });
            if (fileBuffer) tx.objectStore('files').put({ id: id, name: fileName, data: fileBuffer });
            return { record: record, duplicate: false };
        });
    });
}

/** All package summaries, oldest first by tune modified time. */
function listTunePackages() {
    return tuneDbTransaction(['packages'], 'readonly', function (tx) {
        return tuneDbRequest(tx.objectStore('packages').getAll());
    }).then(sortTunePackages);
}

/** Order packages oldest first by the time the tune was saved in M1 Tune (import time as fallback). */
function sortTunePackages(list) {
    return list.sort(function (a, b) {
        var x = a.modified || a.importedAt, y = b.modified || b.importedAt;
        return x < y ? -1 : x > y ? 1 : 0;
    });
}

/** Summary + items, shaped like parseM1Pkg output so diffM1Pkg works on it directly. */
function loadTunePackage(id) {
    return tuneDbTransaction(['packages', 'items'], 'readonly', function (tx) {
        return Promise.all([
            tuneDbRequest(tx.objectStore('packages').get(id)),
            tuneDbRequest(tx.objectStore('items').get(id))
        ]);
    }).then(function (r) {
        if (!r[0]) throw new Error('Package not found');
        var pkg = {};
        for (var k in r[0]) pkg[k] = r[0][k];
        pkg.items = r[1] ? r[1].items : [];
        return pkg;
    });
}

function loadTuneFile(id) {
    return tuneDbTransaction(['files'], 'readonly', function (tx) {
        return tuneDbRequest(tx.objectStore('files').get(id));
    });
}

/** Replace the parsed data of a stored package (used to re-parse with a newer parser). */
function updateTunePackage(id, parsed) {
    return tuneDbTransaction(['packages', 'items'], 'readwrite', function (tx) {
        var packages = tx.objectStore('packages');
        return tuneDbRequest(packages.get(id)).then(function (existing) {
            var record = tuneDbSummary(id, parsed, existing.fileName, existing.fileSize);
            record.importedAt = existing.importedAt;
            packages.put(record);
            tx.objectStore('items').put({ id: id, items: parsed.items });
            return record;
        });
    });
}

function deleteTunePackage(id) {
    return tuneDbTransaction(['packages', 'items', 'files'], 'readwrite', function (tx) {
        tx.objectStore('packages').delete(id);
        tx.objectStore('items').delete(id);
        tx.objectStore('files').delete(id);
    });
}

/** User-entered I/O resource names as { 'HARDWARE|signature': name }. */
function listResourceNames() {
    return tuneDbTransaction(['resourceNames'], 'readonly', function (tx) {
        return tuneDbRequest(tx.objectStore('resourceNames').getAll());
    }).then(function (rows) {
        var map = {};
        rows.forEach(function (r) { map[r.key] = r.name; });
        return map;
    });
}

/** Save a resource name; an empty name removes it. */
function saveResourceName(key, name) {
    return tuneDbTransaction(['resourceNames'], 'readwrite', function (tx) {
        if (name) tx.objectStore('resourceNames').put({ key: key, name: name });
        else tx.objectStore('resourceNames').delete(key);
    });
}

/** JSON backup of all parsed packages and resource names (original files are not included). */
function exportTuneDb() {
    return listTunePackages().then(function (list) {
        return Promise.all([
            Promise.all(list.map(function (p) { return loadTunePackage(p.id); })),
            listResourceNames()
        ]);
    }).then(function (r) {
        return {
            format: 'tunercontrol-m1-backup', version: 1, exportedAt: new Date().toISOString(),
            packages: r[0], resourceNames: r[1]
        };
    });
}

/** Restore a JSON backup. Existing packages with the same id are kept. Resolves to count added. */
function importTuneDb(backup) {
    if (!backup || backup.format !== 'tunercontrol-m1-backup' || !Array.isArray(backup.packages)) {
        return Promise.reject(new Error('Not a TunerControl M1 backup file'));
    }
    var added = 0, names = backup.resourceNames || {};
    var namesSaved = Object.keys(names).reduce(function (chain, key) {
        return chain.then(function () { return saveResourceName(key, names[key]); });
    }, Promise.resolve());
    return backup.packages.reduce(function (chain, p) {
        return chain.then(function () {
            return saveTunePackage(p.id, p, p.fileName, null).then(function (r) {
                if (!r.duplicate) {
                    added++;
                    // keep the original import time from the backup
                    return tuneDbTransaction(['packages'], 'readwrite', function (tx) {
                        r.record.importedAt = p.importedAt || r.record.importedAt;
                        tx.objectStore('packages').put(r.record);
                    });
                }
            });
        });
    }, namesSaved).then(function () { return added; });
}
