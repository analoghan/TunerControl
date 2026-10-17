/**
 * lib/backup.js — Full backup and restore of everything TunerControl stores, on the server or in this browser.
 * Needs m1-config/tune-api.js, m1-config/tune-db.js, harness/harness-store.js and history/run-store.js.
 *
 * Backup file (JSON, the same format from either backend; server/db.js exportBackup):
 *   { format: 'tunercontrol-backup', version: 2, exportedAt, source: 'server' | 'browser',
 *     packages: [parsed tune with its summary fields], packageFiles: [{ id, name, data (base64 .m1pkg) }],
 *     resourceNames: { key: name }  (I/O resource names and the M1 Config Viewer's labels),
 *     runs: [tuning history run], harnesses: [{ id, name, created, updated, revision, revisions: [{ revision, saved, note, data }] }],
 *     harnessSystems: [{ id, name, updated, harnesses, manual, rejected, canNetworks }], harnessImages: [{ id, mime, data (base64) }],
 *     settings: { localStorage key: value }  (page preferences of this browser; not the API token) }
 * Restoring adds what is missing and keeps what is already stored (same id), so it is safe to run twice; resource names, labels
 * and settings are set from the backup (counted only when they change). Older M1-only backups
 * ('tunercontrol-m1-backup') restore too.
 *
 *   bkBackend()        → Promise<'server' | 'browser' | 'none'>
 *   bkExport()         → Promise<backup>
 *   bkImport(backup)   → Promise<counts { packages, resourceNames, runs, harnesses, revisions, systems, images, settings }>
 *   bkContents(backup) → [[label, count]] of what a backup holds
 */

var BK_FORMAT = 'tunercontrol-backup';
var bkBackendPromise = null;

function bkBackend() {
    if (bkBackendPromise) return bkBackendPromise;
    bkBackendPromise = detectTuneServer().then(function (server) {
        if (server) return 'server';
        return openTuneDb().then(function () { return 'browser'; }, function () { return 'none'; });
    }).then(function (b) {
        // The harness and history stores pick the same backend.
        hsBackend = b === 'none' ? 'memory' : b;
        return b;
    });
    return bkBackendPromise;
}

function bkToBase64(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
}

function bkFromBase64(text) {
    var bin = atob(text), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** Page preferences in localStorage (the API token stays out of backups). */
function bkSettings() {
    var out = {};
    try {
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k !== TUNE_TOKEN_KEY) out[k] = localStorage.getItem(k);
        }
    } catch (e) { /* storage blocked */ }
    return out;
}

function bkExport() {
    return bkBackend().then(function (b) {
        if (b === 'none') throw new Error('No storage is available here (private window?), so there is nothing to back up.');
        return b === 'server' ? tuneApi('GET', 'backup') : bkExportBrowser();
    }).then(function (backup) {
        backup.settings = bkSettings();
        return backup;
    });
}

function bkExportBrowser() {
    var backup = { format: BK_FORMAT, version: 2, exportedAt: new Date().toISOString(), source: 'browser' };
    return listTunePackages().then(function (list) {
        return Promise.all(list.map(function (p) {
            return Promise.all([loadTunePackage(p.id), loadTuneFile(p.id)]);
        }));
    }).then(function (pkgs) {
        backup.packages = pkgs.map(function (x) { return x[0]; });
        backup.packageFiles = pkgs.filter(function (x) { return x[1] && x[1].data; }).map(function (x) {
            return { id: x[0].id, name: x[1].name, data: bkToBase64(x[1].data) };
        });
        return listResourceNames();
    }).then(function (names) {
        backup.resourceNames = names;
        return rsList(null, true);
    }).then(function (runs) {
        backup.runs = runs;
        return hsTx(['harnesses', 'revisions', 'systems', 'images'], 'readonly', function (tx) {
            return Promise.all(['harnesses', 'revisions', 'systems', 'images'].map(function (n) { return hsReq(tx.objectStore(n).getAll()); }));
        });
    }).then(function (r) {
        var revs = {};
        r[1].forEach(function (x) { (revs[x.harnessId] = revs[x.harnessId] || []).push({ revision: x.revision, saved: x.saved, note: x.note || '', data: x.data }); });
        backup.harnesses = r[0].map(function (h) {
            return { id: h.id, name: h.name, created: h.created, updated: h.updated, revision: h.revision,
                     revisions: (revs[h.id] || []).sort(function (a, b) { return a.revision - b.revision; }) };
        });
        backup.harnessSystems = r[2];
        return Promise.all(r[3].map(function (im) {
            return im.data.arrayBuffer().then(function (buf) { return { id: im.id, mime: im.mime, data: bkToBase64(buf) }; });
        }));
    }).then(function (images) {
        backup.harnessImages = images;
        return backup;
    });
}

function bkCheck(backup) {
    if (!backup || (backup.format !== BK_FORMAT && backup.format !== 'tunercontrol-m1-backup') || !Array.isArray(backup.packages)) {
        throw new Error('Not a TunerControl backup file');
    }
}

function bkImport(backup) {
    return bkBackend().then(function (b) {
        bkCheck(backup);
        if (b === 'none') throw new Error('No storage is available here (private window?), so a backup cannot be restored.');
        var settings = 0;
        try {
            Object.keys(backup.settings || {}).forEach(function (k) {
                if (k === TUNE_TOKEN_KEY || localStorage.getItem(k) === backup.settings[k]) return;
                localStorage.setItem(k, backup.settings[k]);
                settings++;
            });
        } catch (e) { /* storage blocked */ }
        var done = b === 'server'
            ? tuneApi('POST', 'backup', { body: Object.assign({}, backup, { settings: undefined }) }).then(function (r) { return r.counts || { packages: r.added }; })
            : bkImportBrowser(backup);
        return done.then(function (counts) { counts.settings = settings; return counts; });
    });
}

function bkImportBrowser(backup) {
    var n = { packages: 0, resourceNames: 0, runs: 0, harnesses: 0, revisions: 0, systems: 0, images: 0 }, files = {};
    (backup.packageFiles || []).forEach(function (f) { if (f && f.id && f.data) files[f.id] = f; });
    var chain = (backup.packages || []).reduce(function (p, pkg) {
        return p.then(function () {
            if (!pkg || !pkg.id || !Array.isArray(pkg.items)) return;
            var file = files[pkg.id] ? bkFromBase64(files[pkg.id].data) : null;
            return saveTunePackage(pkg.id, pkg, pkg.fileName, file ? file.buffer : null).then(function (r) {
                if (r.duplicate) return;
                n.packages++;
                // Keep the original import time.
                return tuneDbTransaction(['packages'], 'readwrite', function (tx) {
                    r.record.importedAt = pkg.importedAt || r.record.importedAt;
                    tx.objectStore('packages').put(r.record);
                });
            });
        });
    }, Promise.resolve());
    var names = backup.resourceNames || {};
    chain = chain.then(listResourceNames).then(function (have) {
        return Object.keys(names).reduce(function (p, k) {
            return p.then(function () { if (names[k] && have[k] !== names[k]) { n.resourceNames++; return saveResourceName(k, names[k]); } });
        }, Promise.resolve());
    });
    chain = (backup.runs || []).reduce(function (p, run) {
        return p.then(function () {
            if (!run || !run.id || !run.summary) return;
            return rsGet(run.id).then(function (have) { if (!have) { n.runs++; return rsSave(run); } });
        });
    }, chain);
    return chain.then(function () {
        return hsTx(['harnesses', 'revisions', 'systems', 'images'], 'readwrite', function (tx) {
            var hs = tx.objectStore('harnesses'), revs = tx.objectStore('revisions'), sys = tx.objectStore('systems'), ims = tx.objectStore('images');
            return Promise.all([hsReq(hs.getAllKeys()), hsReq(sys.getAllKeys()), hsReq(ims.getAllKeys())]).then(function (keys) {
                var haveH = {}, haveS = {}, haveI = {};
                keys[0].forEach(function (k) { haveH[k] = true; });
                keys[1].forEach(function (k) { haveS[k] = true; });
                keys[2].forEach(function (k) { haveI[k] = true; });
                (backup.harnesses || []).forEach(function (h) {
                    var list = h && h.id && !haveH[h.id] ? (h.revisions || []).filter(function (r) { return r && r.revision > 0 && r.data; }) : [];
                    if (!list.length) return;
                    var latest = Math.max.apply(null, list.map(function (r) { return r.revision; }));
                    hs.put({ id: h.id, name: h.name || 'Harness', created: h.created || list[0].saved, updated: h.updated || list[list.length - 1].saved,
                             revision: Math.max(latest, h.revision || 0), latest: latest });
                    list.forEach(function (r) {
                        revs.put({ harnessId: h.id, revision: r.revision, saved: r.saved, note: r.note || '', data: r.data });
                        n.revisions++;
                    });
                    n.harnesses++;
                });
                (backup.harnessSystems || []).forEach(function (s) {
                    if (!s || !s.id || haveS[s.id]) return;
                    sys.put({ id: s.id, name: s.name || 'System', updated: s.updated || new Date().toISOString(), harnesses: s.harnesses || [],
                              manual: s.manual || [], rejected: s.rejected || [], canNetworks: s.canNetworks || [] });
                    n.systems++;
                });
                (backup.harnessImages || []).forEach(function (im) {
                    if (!im || !im.id || !im.data || haveI[im.id]) return;
                    ims.put({ id: im.id, mime: im.mime, data: new Blob([bkFromBase64(im.data)], { type: im.mime }) });
                    n.images++;
                });
            });
        });
    }).then(function () { return n; });
}

/** What a backup holds: [[label, count]]. */
function bkContents(backup) {
    var revs = 0, nets = 0;
    (backup.harnesses || []).forEach(function (h) { revs += (h.revisions || []).length; });
    (backup.harnessSystems || []).forEach(function (s) { nets += (s.canNetworks || []).length; });
    var names = Object.keys(backup.resourceNames || {}), labels = names.filter(function (k) { return k.indexOf('label|') === 0; }).length;
    return [['Tunes', (backup.packages || []).length], ['Original .m1pkg files', (backup.packageFiles || []).length],
        ['Resource names', names.length - labels], ['Labels', labels], ['Tuning history runs', (backup.runs || []).length],
        ['Harnesses', (backup.harnesses || []).length], ['Harness revisions', revs], ['Harness systems', (backup.harnessSystems || []).length],
        ['CAN networks', nets], ['Harness pictures', (backup.harnessImages || []).length], ['Page settings', Object.keys(backup.settings || {}).length]];
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { bkToBase64: bkToBase64, bkFromBase64: bkFromBase64, bkContents: bkContents, bkCheck: bkCheck };
}
