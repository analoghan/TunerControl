/**
 * history/run-store.js — Tuning history: saved analysis runs, on the TunerControl server when the page is served by it,
 * otherwise in this browser (IndexedDB "tunercontrol-runs"). Needs m1-config/tune-api.js.
 *
 * A run: { id, tool: 've' | 'transient' | 'knock' | 'fuel-pressure', created, logName, logTime, serial, tuneId, tuneName,
 *          note, settings, summary, data }
 *
 *   rsInit()              → Promise<'server' | 'browser' | 'none'>
 *   rsList(tool, full)    → Promise<[run]> oldest log first; full includes settings and data
 *   rsGet(id), rsSave(run), rsSetNote(id, note), rsDelete(id)
 *   rsSaveControl(el, getRun)  "Save to tuning history" button with a note field; getRun() returns the run (or a Promise)
 */

var RS_DB_NAME = 'tunercontrol-runs';
var rsBackend = null, rsDbPromise = null, rsInitPromise = null;

function rsOpenDb() {
    if (rsDbPromise) return rsDbPromise;
    rsDbPromise = new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available')); return; }
        var req = indexedDB.open(RS_DB_NAME, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('runs', { keyPath: 'id' }).createIndex('tool', 'tool'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('Could not open the tuning history')); };
    });
    rsDbPromise.catch(function () { rsDbPromise = null; });
    return rsDbPromise;
}

function rsTx(mode, fn) {
    return rsOpenDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(['runs'], mode), store = tx.objectStore('runs'), result;
            var req = fn(store);
            if (req) req.onsuccess = function () { result = req.result; };
            tx.oncomplete = function () { resolve(result); };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}

function rsInit() {
    if (rsInitPromise) return rsInitPromise;
    rsInitPromise = (typeof detectTuneServer === 'function' ? detectTuneServer() : Promise.resolve(false)).then(function (server) {
        if (server) return 'server';
        return rsOpenDb().then(function () { return 'browser'; }, function () { return 'none'; });
    }).then(function (b) { rsBackend = b; return b; });
    return rsInitPromise;
}

function rsSortKey(r) { return String(r.logTime || r.created || ''); }

function rsSummaryOnly(r) {
    var out = {};
    Object.keys(r).forEach(function (k) { if (k !== 'settings' && k !== 'data') out[k] = r[k]; });
    return out;
}

function rsList(tool, full) {
    return rsInit().then(function (b) {
        if (b === 'server') return tuneApi('GET', 'runs' + (tool || full ? '?' : '') + (tool ? 'tool=' + encodeURIComponent(tool) : '') +
            (tool && full ? '&' : '') + (full ? 'full=1' : ''));
        if (b === 'none') return [];
        return rsTx('readonly', function (s) { return tool ? s.index('tool').getAll(tool) : s.getAll(); }).then(function (rows) {
            rows = (rows || []).slice().sort(function (x, y) { return rsSortKey(x).localeCompare(rsSortKey(y)) || String(x.created).localeCompare(String(y.created)); });
            return full ? rows : rows.map(rsSummaryOnly);
        });
    });
}

function rsGet(id) {
    return rsInit().then(function (b) {
        if (b === 'server') return tuneApi('GET', 'runs/' + encodeURIComponent(id));
        return rsTx('readonly', function (s) { return s.get(id); }).then(function (r) { return r || null; });
    });
}

function rsUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function rsSave(run) {
    return rsInit().then(function (b) {
        if (b === 'none') throw new Error('No storage is available (private window?), so the run cannot be saved.');
        if (b === 'server') return tuneApi('POST', 'runs', { body: run });
        var rec = Object.assign({ created: new Date().toISOString(), note: '' }, run, { id: run.id || rsUuid() });
        return rsTx('readwrite', function (s) { return s.put(rec); }).then(function () { return rec; });
    });
}

function rsSetNote(id, note) {
    return rsInit().then(function (b) {
        if (b === 'server') return tuneApi('PUT', 'runs/' + encodeURIComponent(id), { body: { note: note } });
        return rsGet(id).then(function (r) {
            if (!r) throw new Error('Run not found');
            r.note = note;
            return rsTx('readwrite', function (s) { return s.put(r); }).then(function () { return r; });
        });
    });
}

function rsDelete(id) {
    return rsInit().then(function (b) {
        if (b === 'server') return tuneApi('DELETE', 'runs/' + encodeURIComponent(id));
        return rsTx('readwrite', function (s) { return s.delete(id); });
    });
}

/** Log facts for a run: { logName, logTime (ISO), serial } from the file (uses tsLogInfo when available). */
function rsLogFacts(file) {
    var base = { logName: file ? file.name : null, logTime: null, serial: null };
    if (!file || typeof tsLogInfo !== 'function') return Promise.resolve(base);
    return tsLogInfo(file).then(function (info) {
        return { logName: file.name, logTime: info.time ? info.time.toISOString() : null, serial: info.serial || null };
    }).catch(function () { return base; });
}

/**
 * Renders the save control into el: a note field and "Save to tuning history". getRun() → run (or Promise of one),
 * without id/created. Saving again after a save adds another run (e.g. after changing settings).
 */
function rsSaveControl(el, getRun) {
    el.classList.add('rs-save');
    el.innerHTML = '<input type="text" class="rs-note" maxlength="200" placeholder="Note (optional), e.g. before VE change" ' +
        'aria-label="Note for the tuning history"> <button type="button" class="rs-btn">Save to tuning history</button> ' +
        '<span class="rs-status" role="status"></span> <a class="rs-link" href="../history/index.html">Open tuning history</a>';
    var btn = el.querySelector('.rs-btn'), note = el.querySelector('.rs-note'), status = el.querySelector('.rs-status');
    btn.onclick = function () {
        btn.disabled = true;
        status.textContent = 'Saving…';
        status.classList.remove('rs-error');
        Promise.resolve(getRun()).then(function (run) {
            run.note = note.value.trim();
            return rsSave(run);
        }).then(function () {
            status.textContent = 'Saved' + (rsBackend === 'browser' ? ' in this browser.' : ' on the server.');
            note.value = '';
        }).catch(function (err) {
            status.textContent = 'Not saved: ' + err.message;
            status.classList.add('rs-error');
        }).then(function () { btn.disabled = false; });
    };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { rsSummaryOnly: rsSummaryOnly, rsSortKey: rsSortKey };
