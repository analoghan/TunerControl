#!/usr/bin/env node
/**
 * server/server.js — TunerControl server: serves the web app and a JSON API backed by SQLite.
 * No npm dependencies; requires Node 22.13+ (node:sqlite).
 *
 * Environment
 *   PORT                 listen port (default 8080)
 *   HOST                 listen address (default 127.0.0.1; use 0.0.0.0 to accept LAN connections)
 *   TUNERCONTROL_DB      SQLite file (default <repo>/data/tunercontrol.db)
 *   TUNERCONTROL_TOKEN   if set, every /api request except /api/health needs
 *                        "Authorization: Bearer <token>"
 *
 * API
 *   GET    /api/health                       { ok, auth, parserVersion }
 *   GET    /api/packages                     package summaries, oldest first
 *   POST   /api/packages                     body = .m1pkg bytes, header X-File-Name → { record, duplicate }
 *   GET    /api/packages/:id                 summary + parsed items
 *   GET    /api/packages/:id/file            original .m1pkg
 *   DELETE /api/packages/:id
 *   GET    /api/history?item=NAME[&cell=KEY] value history of one item across packages
 *   GET    /api/resource-names               { 'HARDWARE|signature': name }
 *   PUT    /api/resource-names               body { key, name } (empty name removes)
 *   GET    /api/backup                       JSON backup (same format as the browser export)
 *   POST   /api/backup                       restore a JSON backup → { added }
 *   GET    /api/harnesses                    wiring harness summaries, newest first
 *   POST   /api/harnesses                    body { name, data, note } → { id, revision, saved }
 *   GET    /api/harnesses/:id[?revision=N]   latest (or given) revision with data and revision list
 *   PUT    /api/harnesses/:id                body { name, data, note } → new revision { id, revision, saved }
 *   DELETE /api/harnesses/:id
 *   DELETE /api/harnesses/:id/revisions/:n   delete one revision → { latest } (409 if it is the only one)
 *   GET    /api/harness-systems             [{ id, name, updated, harnesses, manual, rejected }]
 *   POST   /api/harness-systems             body { name, harnesses, manual, rejected } → system
 *   PUT    /api/harness-systems/:id         same body → system
 *   DELETE /api/harness-systems/:id         (the harnesses themselves are kept)
 *   POST   /api/harness-images              body = PNG/JPEG/GIF/WebP bytes (Content-Type image/*) → { id }
 *   GET    /api/harness-images/:id          image bytes (ids are SHA-256 of the content, so cacheable forever)
 */

'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var zlib = require('zlib');
var TuneStore = require('./db.js').TuneStore;

var ROOT = path.resolve(__dirname, '..');
var PORT = parseInt(process.env.PORT || '8080', 10);
var HOST = process.env.HOST || '127.0.0.1';
var DB_FILE = process.env.TUNERCONTROL_DB || path.join(ROOT, 'data', 'tunercontrol.db');
var TOKEN = process.env.TUNERCONTROL_TOKEN || '';

var MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
var MAX_JSON_BYTES = 512 * 1024 * 1024;
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Top-level folders that hold private data or server code and must never be served.
var PRIVATE_DIRS = ['files', 'data', 'server', 'analysis', 'node_modules', 'deploy'];

var MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
};

function HttpError(status, message) { this.status = status; this.message = message; }

// =========================================================================
// Responses
// =========================================================================

function send(req, res, status, body, type) {
    var headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !/^image\//.test(type)) {
        body = zlib.gzipSync(body);
        headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(req, res, status, data) {
    send(req, res, status, Buffer.from(JSON.stringify(data)), 'application/json; charset=utf-8');
}

function readBody(req, limit) {
    return new Promise(function (resolve, reject) {
        var chunks = [], size = 0;
        req.on('data', function (c) {
            size += c.length;
            if (size > limit) { reject(new HttpError(413, 'Upload too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', function () { resolve(Buffer.concat(chunks)); });
        req.on('error', reject);
    });
}

function readJson(req) {
    return readBody(req, MAX_JSON_BYTES).then(function (buf) {
        try { return JSON.parse(buf.toString('utf8')); } catch (e) { throw new HttpError(400, 'Invalid JSON body'); }
    });
}

function authorized(req) {
    if (!TOKEN) return true;
    var m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    var a = Buffer.from(m[1]), b = Buffer.from(TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// =========================================================================
// API
// =========================================================================

function handleApi(req, res, url, store) {
    var parts = url.pathname.split('/').filter(Boolean).slice(1);   // drop 'api'
    var method = req.method;

    if (parts[0] === 'health' && method === 'GET') {
        return sendJson(req, res, 200, { ok: true, auth: !!TOKEN, parserVersion: require('../lib/m1pkg-parser.js').M1PKG_PARSER_VERSION });
    }
    if (!authorized(req)) throw new HttpError(401, 'Missing or invalid access token');

    if (parts[0] === 'packages') {
        if (parts.length === 1 && method === 'GET') return sendJson(req, res, 200, store.listSummaries());
        if (parts.length === 1 && method === 'POST') {
            return readBody(req, MAX_PACKAGE_BYTES).then(function (buf) {
                if (!buf.length) throw new HttpError(400, 'Empty upload');
                var name = decodeURIComponent(req.headers['x-file-name'] || 'package.m1pkg');
                var id = crypto.createHash('sha256').update(buf).digest('hex');
                var result;
                try { result = store.importFile(id, name, new Uint8Array(buf.buffer, buf.byteOffset, buf.length)); }
                catch (err) { throw new HttpError(422, err.message); }
                sendJson(req, res, result.duplicate ? 200 : 201, result);
            });
        }
        var id = parts[1];
        if (parts.length === 2 && method === 'GET') {
            var pkg = store.getPackage(id);
            if (!pkg) throw new HttpError(404, 'Package not found');
            return sendJson(req, res, 200, pkg);
        }
        if (parts.length === 3 && parts[2] === 'file' && method === 'GET') {
            var file = store.getFile(id);
            if (!file) throw new HttpError(404, 'Original file not stored for this package');
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream', 'Content-Length': file.data.length,
                'Content-Disposition': 'attachment; filename="' + String(file.name || id + '.m1pkg').replace(/["\\\r\n]/g, '_') + '"'
            });
            return res.end(Buffer.from(file.data));
        }
        if (parts.length === 2 && method === 'DELETE') {
            if (!store.deletePackage(id)) throw new HttpError(404, 'Package not found');
            res.writeHead(204); return res.end();
        }
    }

    if (parts[0] === 'history' && parts.length === 1 && method === 'GET') {
        var item = url.searchParams.get('item');
        if (!item) throw new HttpError(400, 'item is required');
        return sendJson(req, res, 200, store.history(item, url.searchParams.has('cell') ? url.searchParams.get('cell') : null));
    }

    if (parts[0] === 'resource-names' && parts.length === 1) {
        if (method === 'GET') return sendJson(req, res, 200, store.listResourceNames());
        if (method === 'PUT') {
            return readJson(req).then(function (body) {
                if (!body || typeof body.key !== 'string' || !body.key) throw new HttpError(400, 'key is required');
                store.setResourceName(body.key, typeof body.name === 'string' ? body.name.trim() : '');
                sendJson(req, res, 200, { ok: true });
            });
        }
    }

    if (parts[0] === 'harnesses') {
        if (parts.length === 1 && method === 'GET') return sendJson(req, res, 200, store.listHarnesses());
        var hid = parts[1] || null;
        if ((parts.length === 1 && method === 'POST') || (parts.length === 2 && method === 'PUT')) {
            return readJson(req).then(function (body) {
                if (!body || typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name is required');
                if (!body.data || !Array.isArray(body.data.connectors) || !Array.isArray(body.data.splices)) {
                    throw new HttpError(400, 'data must be a harness model');
                }
                var saved = store.saveHarness(hid, body.name.trim(), body.data, typeof body.note === 'string' ? body.note : '');
                if (!saved) throw new HttpError(404, 'Harness not found');
                sendJson(req, res, hid ? 200 : 201, saved);
            });
        }
        if (parts.length === 2 && method === 'GET') {
            var rev = url.searchParams.has('revision') ? parseInt(url.searchParams.get('revision'), 10) : 0;
            var harness = store.getHarness(hid, rev || 0);
            if (!harness) throw new HttpError(404, 'Harness not found');
            return sendJson(req, res, 200, harness);
        }
        if (parts.length === 2 && method === 'DELETE') {
            if (!store.deleteHarness(hid)) throw new HttpError(404, 'Harness not found');
            res.writeHead(204); return res.end();
        }
        if (parts.length === 4 && parts[2] === 'revisions' && method === 'DELETE') {
            var deleted;
            try { deleted = store.deleteHarnessRevision(hid, parseInt(parts[3], 10)); }
            catch (err) { throw new HttpError(409, err.message); }
            if (!deleted) throw new HttpError(404, 'Revision not found');
            return sendJson(req, res, 200, deleted);
        }
    }

    if (parts[0] === 'harness-systems') {
        if (parts.length === 1 && method === 'GET') return sendJson(req, res, 200, store.listHarnessSystems());
        var sid = parts[1] || null;
        if ((parts.length === 1 && method === 'POST') || (parts.length === 2 && method === 'PUT')) {
            return readJson(req).then(function (body) {
                if (!body || typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name is required');
                if (!Array.isArray(body.harnesses)) throw new HttpError(400, 'harnesses must be a list');
                var system = store.saveHarnessSystem(sid, { name: body.name.trim(), harnesses: body.harnesses,
                    manual: Array.isArray(body.manual) ? body.manual : [], rejected: Array.isArray(body.rejected) ? body.rejected : [] });
                if (!system) throw new HttpError(404, 'System not found');
                sendJson(req, res, sid ? 200 : 201, system);
            });
        }
        if (parts.length === 2 && method === 'DELETE') {
            if (!store.deleteHarnessSystem(sid)) throw new HttpError(404, 'System not found');
            res.writeHead(204); return res.end();
        }
    }

    if (parts[0] === 'harness-images') {
        if (parts.length === 1 && method === 'POST') {
            var mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw new HttpError(415, 'Images must be PNG, JPEG, GIF or WebP');
            return readBody(req, MAX_IMAGE_BYTES).then(function (buf) {
                if (!buf.length) throw new HttpError(400, 'Empty upload');
                var imageId = crypto.createHash('sha256').update(buf).digest('hex');
                store.putHarnessImage(imageId, mime, new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
                sendJson(req, res, 201, { id: imageId });
            });
        }
        if (parts.length === 2 && method === 'GET') {
            var image = /^[0-9a-f]{64}$/.test(parts[1]) ? store.getHarnessImage(parts[1]) : null;
            if (!image) throw new HttpError(404, 'Image not found');
            res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.data.length,
                                 'Cache-Control': 'private, max-age=31536000, immutable' });
            return res.end(Buffer.from(image.data));
        }
    }

    if (parts[0] === 'backup' && parts.length === 1) {
        if (method === 'GET') return sendJson(req, res, 200, store.exportBackup());
        if (method === 'POST') {
            return readJson(req).then(function (body) {
                var added;
                try { added = store.importBackup(body); } catch (err) { throw new HttpError(400, err.message); }
                sendJson(req, res, 200, { added: added });
            });
        }
    }

    throw new HttpError(404, 'Not found');
}

// =========================================================================
// Static files
// =========================================================================

function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    var rel;
    try { rel = decodeURIComponent(url.pathname); } catch (e) { throw new HttpError(400, 'Bad path'); }
    var segments = rel.split('/').filter(Boolean);
    if (segments.some(function (s) { return s[0] === '.'; }) || PRIVATE_DIRS.indexOf(segments[0]) >= 0) {
        throw new HttpError(404, 'Not found');
    }
    var file = path.join(ROOT, segments.join(path.sep));
    if (file !== ROOT && file.indexOf(ROOT + path.sep) !== 0) throw new HttpError(404, 'Not found');
    var stat;
    try { stat = fs.statSync(file); } catch (e) { throw new HttpError(404, 'Not found'); }
    if (stat.isDirectory()) {
        if (!url.pathname.endsWith('/')) {
            res.writeHead(301, { Location: url.pathname + '/' + url.search });
            return res.end();
        }
        file = path.join(file, 'index.html');
        if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
    }
    var type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    var headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };
    var body = fs.readFileSync(file);
    if (/^text\/|javascript|json|svg/.test(type) && body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        body = zlib.gzipSync(body);
        headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
}

// =========================================================================
// Startup
// =========================================================================

function createServer(store) {
    return http.createServer(function (req, res) {
        var url = new URL(req.url, 'http://localhost');
        Promise.resolve().then(function () {
            return url.pathname === '/api' || url.pathname.indexOf('/api/') === 0
                ? handleApi(req, res, url, store)
                : handleStatic(req, res, url);
        }).catch(function (err) {
            var status = err instanceof HttpError ? err.status : 500;
            if (status === 500) console.error(new Date().toISOString(), req.method, url.pathname, err);
            if (res.headersSent) { res.destroy(); return; }
            if (url.pathname.indexOf('/api') === 0) sendJson(req, res, status, { error: err.message || 'Server error' });
            else send(req, res, status, Buffer.from(status === 404 ? 'Not found' : 'Error'), 'text/plain; charset=utf-8');
        });
    });
}

if (require.main === module) {
    var store = new TuneStore(DB_FILE);
    var updated = store.reparseStale();
    if (updated) console.log('Re-parsed ' + updated + ' stored package(s) with the current parser');
    var server = createServer(store);
    server.listen(PORT, HOST, function () {
        console.log('TunerControl listening on http://' + HOST + ':' + PORT + ' (database ' + DB_FILE + ')' +
            (TOKEN ? ', API token required' : ''));
        if (!TOKEN && HOST !== '127.0.0.1' && HOST !== 'localhost') {
            console.warn('Warning: listening beyond localhost without TUNERCONTROL_TOKEN — anyone who can reach this port can read and change tune data.');
        }
    });
    var shutdown = function () { server.close(function () { store.db.close(); process.exit(0); }); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

module.exports = { createServer: createServer };
