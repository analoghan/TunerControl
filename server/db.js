/**
 * server/db.js — SQLite storage for imported M1 packages (Node's built-in node:sqlite).
 *
 * Tables
 *   packages       one row per imported .m1pkg (id = SHA-256 of the file, same as the browser;
 *                  pk = compact integer key used by the other tables)
 *   selections     calibration library selections per package
 *   item_names     item name ↔ integer id, so the large tables don't repeat long names
 *   items          one row per parameter/table/IO resource per package (full parsed item as JSON)
 *   cells          one row per individual value (scalar, axis site or table cell) for SQL queries
 *   resource_names user names for I/O resources, key = 'HARDWARE|signature'
 *   harnesses      wiring harness designs (harness/ page); id is a random UUID; revision = highest revision
 *                  number ever saved (numbers are not reused after a revision is deleted)
 *   harness_revisions every saved version of a harness (full model as JSON), newest = harnesses.revision
 *   harness_images connector/splice pictures, id = SHA-256 of the bytes (shared by all revisions)
 * View
 *   cell_values    cells joined with tune and item names — the easiest table for ad-hoc SQL
 */

'use strict';

var fs = require('fs');
var path = require('path');
var DatabaseSync = require('node:sqlite').DatabaseSync;
var parser = require('../lib/m1pkg-parser.js');

var SCHEMA_VERSION = 3;
var SCHEMA = [
    'CREATE TABLE IF NOT EXISTS packages (' +
    '  pk INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, file_name TEXT, file_size INTEGER, imported_at TEXT NOT NULL,' +
    '  parser_version INTEGER, tune_name TEXT, modified TEXT, serial INTEGER, hardware TEXT,' +
    '  firmware_name TEXT, firmware_version TEXT, firmware_id TEXT,' +
    '  summary_json TEXT NOT NULL, file BLOB)',
    'CREATE TABLE IF NOT EXISTS selections (' +
    '  package_pk INTEGER NOT NULL REFERENCES packages(pk) ON DELETE CASCADE,' +
    '  slot TEXT NOT NULL, name TEXT, version TEXT, raw TEXT, PRIMARY KEY (package_pk, slot))',
    'CREATE TABLE IF NOT EXISTS item_names (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)',
    'CREATE TABLE IF NOT EXISTS items (' +
    '  package_pk INTEGER NOT NULL REFERENCES packages(pk) ON DELETE CASCADE,' +
    '  name_id INTEGER NOT NULL REFERENCES item_names(id),' +
    '  kind TEXT, type TEXT, unit TEXT, display_unit TEXT, data_json TEXT NOT NULL,' +
    '  PRIMARY KEY (package_pk, name_id))',
    'CREATE TABLE IF NOT EXISTS cells (' +
    '  package_pk INTEGER NOT NULL REFERENCES packages(pk) ON DELETE CASCADE,' +
    '  name_id INTEGER NOT NULL, cell_key TEXT NOT NULL, value REAL, text_value TEXT,' +
    '  PRIMARY KEY (package_pk, name_id, cell_key)) WITHOUT ROWID',
    'CREATE INDEX IF NOT EXISTS cells_by_item ON cells (name_id, cell_key)',
    'CREATE INDEX IF NOT EXISTS packages_by_modified ON packages (modified)',
    'CREATE TABLE IF NOT EXISTS resource_names (key TEXT PRIMARY KEY, name TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS harnesses (' +
    '  id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, revision INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS harness_revisions (' +
    '  harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE, revision INTEGER NOT NULL,' +
    '  saved TEXT NOT NULL, note TEXT, data_json TEXT NOT NULL, PRIMARY KEY (harness_id, revision))',
    'CREATE TABLE IF NOT EXISTS harness_images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created TEXT NOT NULL)',
    'CREATE VIEW IF NOT EXISTS cell_values AS' +
    '  SELECT p.id AS package_id, p.tune_name, p.modified, n.name AS item_name, c.cell_key, c.value, c.text_value' +
    '  FROM cells c JOIN packages p ON p.pk = c.package_pk JOIN item_names n ON n.id = c.name_id'
];

function TuneStore(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    var version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) throw new Error('Database ' + file + ' was created by a newer TunerControl version');
    for (var i = 0; i < SCHEMA.length; i++) this.db.exec(SCHEMA[i]);
    this.db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    this.nameIds = new Map();
}

/** Integer id for an item name, created on first use. */
TuneStore.prototype.nameId = function (name) {
    var id = this.nameIds.get(name);
    if (id !== undefined) return id;
    this.db.prepare('INSERT INTO item_names (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
    id = this.db.prepare('SELECT id FROM item_names WHERE name = ?').get(name).id;
    this.nameIds.set(name, id);
    return id;
};

TuneStore.prototype.transaction = function (fn) {
    this.db.exec('BEGIN');
    try {
        var result = fn();
        this.db.exec('COMMIT');
        return result;
    } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
    }
};

/** Summary record in the same shape the browser storage uses. */
function summaryOf(id, parsed, fileName, fileSize, importedAt) {
    return {
        id: id, fileName: fileName, fileSize: fileSize, importedAt: importedAt,
        parserVersion: parsed.parserVersion, tuneName: parsed.tuneName, modified: parsed.modified,
        serial: parsed.serial, firmware: parsed.firmware, meta: parsed.meta,
        commentLog: parsed.commentLog, selections: parsed.selections, itemCount: parsed.items.length
    };
}

/** Write (or replace) everything derived from a parsed package. Call inside a transaction. */
TuneStore.prototype.writeParsed = function (summary, parsed, file) {
    var self = this, db = this.db, id = summary.id, fw = summary.firmware || {};
    db.prepare('DELETE FROM packages WHERE id = ?').run(id);
    var pk = db.prepare(
        'INSERT INTO packages (id, file_name, file_size, imported_at, parser_version, tune_name, modified, serial,' +
        ' hardware, firmware_name, firmware_version, firmware_id, summary_json, file)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, summary.fileName || null, summary.fileSize || null, summary.importedAt, summary.parserVersion || 0,
        summary.tuneName || null, summary.modified || null, summary.serial === undefined ? null : summary.serial,
        (summary.meta && summary.meta['Summary.Hardware']) || null, fw.name || null, fw.version || null,
        fw.id || null, JSON.stringify(summary), file || null).lastInsertRowid;

    var sel = db.prepare('INSERT INTO selections (package_pk, slot, name, version, raw) VALUES (?, ?, ?, ?, ?)');
    (summary.selections || []).forEach(function (s) { sel.run(pk, s.slot, s.name, s.version, s.raw); });

    var item = db.prepare('INSERT INTO items (package_pk, name_id, kind, type, unit, display_unit, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
    var cell = db.prepare('INSERT INTO cells (package_pk, name_id, cell_key, value, text_value) VALUES (?, ?, ?, ?, ?)');
    parsed.items.forEach(function (it) {
        var nameId = self.nameId(it.name);
        item.run(pk, nameId, it.kind, it.type, it.unit, it.displayUnit || null, JSON.stringify(it));
        parser.m1pkgCells(it).forEach(function (c) {
            var num = typeof c.value === 'number' && isFinite(c.value) ? c.value : null;
            var text = Array.isArray(c.value) ? c.value.join(',') : (c.label !== undefined && c.label !== null ? c.label : null);
            cell.run(pk, nameId, c.key, num, text);
        });
    });
};

/** Import a package file. Returns { record, duplicate }. */
TuneStore.prototype.importFile = function (id, fileName, bytes) {
    var existing = this.getSummary(id);
    if (existing) return { record: existing, duplicate: true };
    var parsed = parser.parseM1Pkg(bytes);
    var summary = summaryOf(id, parsed, fileName, bytes.length, new Date().toISOString());
    var self = this;
    this.transaction(function () { self.writeParsed(summary, parsed, bytes); });
    return { record: summary, duplicate: false };
};

/** Import a browser JSON backup (packages carry parsed items, no original file). Returns count added. */
TuneStore.prototype.importBackup = function (backup) {
    if (!backup || backup.format !== 'tunercontrol-m1-backup' || !Array.isArray(backup.packages)) {
        throw new Error('Not a TunerControl M1 backup file');
    }
    var self = this, added = 0;
    this.transaction(function () {
        backup.packages.forEach(function (p) {
            if (!p.id || !Array.isArray(p.items) || self.getSummary(p.id)) return;
            var summary = summaryOf(p.id, p, p.fileName, p.fileSize, p.importedAt || new Date().toISOString());
            self.writeParsed(summary, p, null);
            added++;
        });
        var names = backup.resourceNames || {};
        Object.keys(names).forEach(function (k) { self.setResourceName(k, names[k]); });
    });
    return added;
};

/** Re-parse stored files that were imported with an older parser. Returns count updated. */
TuneStore.prototype.reparseStale = function () {
    var self = this, rows = this.db.prepare(
        'SELECT id, imported_at, file_name, file FROM packages WHERE parser_version < ? AND file IS NOT NULL'
    ).all(parser.M1PKG_PARSER_VERSION);
    rows.forEach(function (r) {
        var bytes = new Uint8Array(r.file);
        var parsed = parser.parseM1Pkg(bytes);
        var summary = summaryOf(r.id, parsed, r.file_name, bytes.length, r.imported_at);
        self.transaction(function () { self.writeParsed(summary, parsed, bytes); });
    });
    return rows.length;
};

TuneStore.prototype.getSummary = function (id) {
    var row = this.db.prepare('SELECT summary_json FROM packages WHERE id = ?').get(id);
    return row ? JSON.parse(row.summary_json) : null;
};

/** Summaries, oldest first by the time the tune was saved in M1 Tune. */
TuneStore.prototype.listSummaries = function () {
    return this.db.prepare('SELECT summary_json FROM packages ORDER BY COALESCE(modified, imported_at)').all()
        .map(function (r) { return JSON.parse(r.summary_json); });
};

/** Summary plus items, shaped like parseM1Pkg output. */
TuneStore.prototype.getPackage = function (id) {
    var summary = this.getSummary(id);
    if (!summary) return null;
    summary.items = this.db.prepare(
        'SELECT i.data_json FROM items i JOIN packages p ON p.pk = i.package_pk WHERE p.id = ? ORDER BY i.rowid'
    ).all(id)
        .map(function (r) { return JSON.parse(r.data_json); });
    return summary;
};

TuneStore.prototype.getFile = function (id) {
    var row = this.db.prepare('SELECT file_name, file FROM packages WHERE id = ?').get(id);
    return row && row.file ? { name: row.file_name, data: row.file } : null;
};

TuneStore.prototype.deletePackage = function (id) {
    return this.db.prepare('DELETE FROM packages WHERE id = ?').run(id).changes > 0;
};

/**
 * Value history of one item across all packages (oldest first).
 * cellKey filters to one cell ('' for scalars, 'V[x,y]' or 'X[i]' for tables).
 */
TuneStore.prototype.history = function (itemName, cellKey) {
    var sql = 'SELECT package_id, tune_name, modified, cell_key, value, text_value FROM cell_values WHERE item_name = ?';
    var args = [itemName];
    if (cellKey !== undefined && cellKey !== null) { sql += ' AND cell_key = ?'; args.push(cellKey); }
    sql += ' ORDER BY modified, cell_key';
    var stmt = this.db.prepare(sql);
    return stmt.all.apply(stmt, args);
};

TuneStore.prototype.listResourceNames = function () {
    var map = {};
    this.db.prepare('SELECT key, name FROM resource_names').all().forEach(function (r) { map[r.key] = r.name; });
    return map;
};

TuneStore.prototype.setResourceName = function (key, name) {
    if (name) this.db.prepare('INSERT INTO resource_names (key, name) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name').run(key, name);
    else this.db.prepare('DELETE FROM resource_names WHERE key = ?').run(key);
};

/** Same format as the browser's Export backup. */
// ---------------------------------------------------------------------------
// Wiring harnesses
// ---------------------------------------------------------------------------

/** Harness summaries, newest first; revision = latest stored revision. */
TuneStore.prototype.listHarnesses = function () {
    return this.db.prepare('SELECT h.id, h.name, h.created, h.updated,' +
        ' (SELECT MAX(revision) FROM harness_revisions r WHERE r.harness_id = h.id) AS revision' +
        ' FROM harnesses h ORDER BY h.updated DESC').all()
        .map(function (r) { return Object.assign({}, r); });
};

/** Latest (or a given) revision: { id, name, created, updated, revision, saved, note, data, revisions, latest }. */
TuneStore.prototype.getHarness = function (id, revision) {
    var h = this.db.prepare('SELECT id, name, created, updated FROM harnesses WHERE id = ?').get(id);
    if (!h) return null;
    var revisions = this.db.prepare('SELECT revision, saved, note FROM harness_revisions WHERE harness_id = ? ORDER BY revision DESC')
        .all(id).map(function (r) { return Object.assign({}, r); });
    if (!revisions.length) return null;
    var latest = revisions[0].revision;
    var rev = this.db.prepare('SELECT revision, saved, note, data_json FROM harness_revisions WHERE harness_id = ? AND revision = ?')
        .get(id, revision || latest);
    if (!rev) return null;
    return Object.assign({}, h, { revision: rev.revision, saved: rev.saved, note: rev.note,
        data: JSON.parse(rev.data_json), revisions: revisions, latest: latest });
};

/**
 * Delete one revision. Returns { latest } (the newest remaining revision), null when the harness or revision
 * doesn't exist, or throws when it is the only revision left (delete the harness instead).
 */
TuneStore.prototype.deleteHarnessRevision = function (id, revision) {
    var self = this;
    return this.transaction(function () {
        var count = self.db.prepare('SELECT COUNT(*) AS n FROM harness_revisions WHERE harness_id = ?').get(id).n;
        var exists = self.db.prepare('SELECT 1 FROM harness_revisions WHERE harness_id = ? AND revision = ?').get(id, revision);
        if (!exists) return null;
        if (count <= 1) throw new Error('This is the only revision; delete the harness instead');
        self.db.prepare('DELETE FROM harness_revisions WHERE harness_id = ? AND revision = ?').run(id, revision);
        return { latest: self.db.prepare('SELECT MAX(revision) AS r FROM harness_revisions WHERE harness_id = ?').get(id).r };
    });
};

/** Save a new revision (creating the harness when id is null). Returns { id, revision }. */
TuneStore.prototype.saveHarness = function (id, name, data, note) {
    var self = this, now = new Date().toISOString();
    return this.transaction(function () {
        var h = id ? self.db.prepare('SELECT revision FROM harnesses WHERE id = ?').get(id) : null;
        if (id && !h) return null;
        var rev = h ? h.revision + 1 : 1;
        if (!h) {
            id = require('crypto').randomUUID();
            self.db.prepare('INSERT INTO harnesses (id, name, created, updated, revision) VALUES (?, ?, ?, ?, ?)')
                .run(id, name, now, now, rev);
        } else {
            self.db.prepare('UPDATE harnesses SET name = ?, updated = ?, revision = ? WHERE id = ?').run(name, now, rev, id);
        }
        self.db.prepare('INSERT INTO harness_revisions (harness_id, revision, saved, note, data_json) VALUES (?, ?, ?, ?, ?)')
            .run(id, rev, now, note || '', JSON.stringify(data));
        return { id: id, revision: rev, saved: now };
    });
};

/** Store an image (id = SHA-256 hex of the bytes); storing the same bytes again is a no-op. */
TuneStore.prototype.putHarnessImage = function (id, mime, bytes) {
    this.db.prepare('INSERT INTO harness_images (id, mime, data, created) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(id, mime, bytes, new Date().toISOString());
};

TuneStore.prototype.getHarnessImage = function (id) {
    var r = this.db.prepare('SELECT mime, data FROM harness_images WHERE id = ?').get(id);
    return r ? { mime: r.mime, data: r.data } : null;
};

TuneStore.prototype.deleteHarness = function (id) {
    return this.db.prepare('DELETE FROM harnesses WHERE id = ?').run(id).changes > 0;
};

TuneStore.prototype.exportBackup = function () {
    var self = this;
    return {
        format: 'tunercontrol-m1-backup', version: 1, exportedAt: new Date().toISOString(),
        packages: this.listSummaries().map(function (s) { return self.getPackage(s.id); }),
        resourceNames: this.listResourceNames()
    };
};

module.exports = { TuneStore: TuneStore };
