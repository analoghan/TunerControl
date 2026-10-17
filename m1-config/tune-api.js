/**
 * m1-config/tune-api.js — Client for the TunerControl server API (server/server.js).
 * Used instead of browser storage when the page is served by the server.
 */

var TUNE_API_BASE = new URL('../api/', window.location.href).href;
var TUNE_TOKEN_KEY = 'tunercontrol-api-token';

function tuneApiToken() {
    try { return localStorage.getItem(TUNE_TOKEN_KEY) || ''; } catch (e) { return ''; }
}

function tuneApiSetToken(token) {
    try {
        if (token) localStorage.setItem(TUNE_TOKEN_KEY, token);
        else localStorage.removeItem(TUNE_TOKEN_KEY);
    } catch (e) { /* storage blocked — token is asked for again next time */ }
}

/** Resolves true when the page is served by a TunerControl server. */
function detectTuneServer() {
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return Promise.resolve(false);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 3000);
    return fetch(TUNE_API_BASE + 'health', { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return !!(j && j.ok); })
        .catch(function () { return false; })
        .then(function (ok) { clearTimeout(timer); return ok; });
}

/**
 * Call the API. On 401 asks for the access token once and retries.
 * options: { body, headers, raw } — raw returns the Response instead of parsed JSON.
 */
function tuneApi(method, path, options, retried) {
    var opts = options || {}, headers = {};
    for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
    var token = tuneApiToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    var body = opts.body;
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        body = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
    }
    return fetch(TUNE_API_BASE + path, { method: method, headers: headers, body: body, cache: 'no-store' })
        .then(function (r) {
            if (r.status === 401 && !retried) {
                var entered = window.prompt('This TunerControl server needs an access token:', '');
                if (entered === null || !entered.trim()) throw new Error('Access token required');
                tuneApiSetToken(entered.trim());
                return tuneApi(method, path, options, true);
            }
            if (r.status === 401) tuneApiSetToken('');
            if (!r.ok) {
                return r.json().catch(function () { return {}; }).then(function (j) {
                    throw new Error(j.error || ('Server error ' + r.status));
                });
            }
            if (opts.raw) return r;
            return r.status === 204 ? null : r.json();
        });
}

function apiImportFile(file) {
    return tuneApi('POST', 'packages', {
        body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }
    });
}

function apiListPackages() { return tuneApi('GET', 'packages'); }
function apiLoadPackage(id) { return tuneApi('GET', 'packages/' + encodeURIComponent(id)); }
function apiDeletePackage(id) { return tuneApi('DELETE', 'packages/' + encodeURIComponent(id)); }
function apiListResourceNames() { return tuneApi('GET', 'resource-names'); }
function apiSaveResourceName(key, name) { return tuneApi('PUT', 'resource-names', { body: { key: key, name: name } }); }
