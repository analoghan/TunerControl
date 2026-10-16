/**
 * m1-config/app.js — M1 Config Viewer
 * Imports .m1pkg packages (parsed by lib/m1pkg-parser.js), stores them in IndexedDB (tune-db.js),
 * browses their values and shows what changed between two tune versions.
 */

function $(id) { return document.getElementById(id); }

var pkgInput = $('pkg-input');
var importStatus = $('import-status');
var importError = $('import-error');
var historySection = $('history-section');
var historyBody = document.querySelector('#history-table tbody');
var cmpFrom = $('cmp-from');
var cmpTo = $('cmp-to');
var cmpBtn = $('cmp-btn');
var exportBtn = $('export-btn');
var backupInput = $('backup-input');
var searchInput = $('search-input');

var state = {
    backend: 'browser',   // 'server' (TunerControl server API), 'browser' (IndexedDB) or 'memory'
    memory: {},           // id → package (with items) when backend is 'memory'
    packages: [],         // summaries, oldest first
    current: null,        // package being viewed (with items)
    index: [],            // [{ item, cats, lname }] for the current package
    compare: null,        // { a, b, diff, byName }
    tab: 'changes',
    filter: 'all',
    search: '',
    resourceNames: {},    // 'HARDWARE|signature' → user-entered I/O resource name
    pkgCache: {},         // id → loaded package, for value histories from browser storage
    links: null,          // cross-reference index of the current package (links.js), built on first use
    followTrail: []       // entity keys followed in the Follow dialog, newest last
};

/** Cross-reference index of the current package (links.js), using the same resource names as the tables. */
function links() {
    if (!state.links && state.current) {
        var hw = hardwareOf(state.current);
        state.links = m1lBuildIndex(state.current.items, function (ids) {
            var n = m1cResourceName(ids, hw, state.resourceNames);
            return n ? n.name : null;
        });
    }
    return state.links;
}

/**
 * A button that opens the Follow dialog on an entity key, around already-escaped html. `from` (an entity key) starts the
 * trail there, so following a value from the table shows where it came from.
 */
function followLink(key, html, cls, from) {
    return '<button class="link-btn' + (cls ? ' ' + cls : '') + '" data-follow="' + esc(key) + '"' +
        (from ? ' data-follow-from="' + esc(from) + '"' : '') + ' title="Follow ' +
        esc(m1lTitle(links(), key)) + '">' + html + '</button>';
}

/** The entity an axis of a table reads (e.g. a driver switch), or null. */
function axisTarget(item, axis) {
    var refs = links().byItem[item.name] || [];
    for (var i = 0; i < refs.length; i++) if (refs[i].kind === 'axis' && refs[i].text.indexOf(axis + ' axis:') === 0) return refs[i].to;
    return null;
}

function hardwareOf(pkg) {
    return pkg && pkg.meta ? pkg.meta['Summary.Hardware'] || '' : '';
}

function resourceLabel(ids, pkg) {
    return m1cResourceLabel(ids, hardwareOf(pkg), state.resourceNames);
}

function resourcePin(ids, pkg) {
    return m1cResourcePinFor(ids, hardwareOf(pkg), state.resourceNames);
}

/** Assignment with its pin, for places without a Pin column: "AVI2 (0x6201) · M142 pin C15". */
function resourceLabelWithPin(ids, pkg) {
    var pin = resourcePin(ids, pkg);
    return resourceLabel(ids, pkg) + (pin ? ' · ' + pin : '');
}

// =========================================================================
// Helpers
// =========================================================================

function esc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function setStatus(msg) {
    importStatus.textContent = msg || '';
    importStatus.hidden = !msg;
}

function showError(msg) {
    importError.textContent = msg;
    importError.hidden = false;
}

function hideError() { importError.hidden = true; }

function lastNote(pkg) {
    var log = pkg.commentLog || [];
    for (var i = log.length - 1; i >= 0; i--) if (log[i].note) return log[i].note;
    return '';
}

// =========================================================================
// Storage — server API, IndexedDB, or in-memory for this session
// =========================================================================

function storeSave(id, parsed, fileName, buffer) {
    if (state.backend === 'browser') return saveTunePackage(id, parsed, fileName, buffer);
    if (state.memory[id]) return Promise.resolve({ record: state.memory[id], duplicate: true });
    var pkg = tuneDbSummary(id, parsed, fileName, buffer.byteLength);
    pkg.items = parsed.items;
    state.memory[id] = pkg;
    return Promise.resolve({ record: pkg, duplicate: false });
}

function storeList() {
    if (state.backend === 'server') return apiListPackages();
    if (state.backend === 'browser') return listTunePackages();
    return Promise.resolve(sortTunePackages(Object.keys(state.memory).map(function (k) { return state.memory[k]; })));
}

function storeLoad(id) {
    if (state.backend === 'server') return apiLoadPackage(id);
    if (state.backend === 'browser') return loadTunePackage(id);
    return state.memory[id] ? Promise.resolve(state.memory[id]) : Promise.reject(new Error('Package not found'));
}

function storeDelete(id) {
    if (state.backend === 'server') return apiDeletePackage(id);
    if (state.backend === 'browser') return deleteTunePackage(id);
    delete state.memory[id];
    return Promise.resolve();
}

function storeResourceNames() {
    if (state.backend === 'server') return apiListResourceNames();
    if (state.backend === 'browser') return listResourceNames();
    return Promise.resolve(state.resourceNames);
}

function storeSaveResourceName(key, name) {
    if (state.backend === 'server') return apiSaveResourceName(key, name);
    if (state.backend === 'browser') return saveResourceName(key, name);
    return Promise.resolve();
}

function storeExport() {
    return state.backend === 'server' ? apiExportBackup() : exportTuneDb();
}

function storeImportBackup(backup) {
    return state.backend === 'server' ? apiImportBackup(backup) : importTuneDb(backup);
}

/** Upload (server) or parse locally and save. Resolves { record, duplicate }. */
function importOne(file, of) {
    if (state.backend === 'server') {
        setStatus('Uploading ' + file.name + of + '…');
        return apiImportFile(file);
    }
    setStatus('Reading ' + file.name + of + '…');
    return file.arrayBuffer().then(function (buffer) {
        return tuneDbFileId(buffer).then(function (id) {
            setStatus('Parsing ' + file.name + of + '…');
            return parsePackage(buffer).then(function (parsed) { return storeSave(id, parsed, file.name, buffer); });
        });
    });
}

// =========================================================================
// Parsing — Web Worker, falling back to the main thread (e.g. when opened via file://)
// =========================================================================

function parseOnMainThread(buffer) {
    return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
        return parseM1Pkg(buffer);
    });
}

function parsePackage(buffer) {
    var worker;
    try {
        var urls = ['../lib/xz-decoder.js', '../lib/m1pkg-parser.js', 'worker.js'].map(function (u) {
            return JSON.stringify(new URL(u, window.location.href).href);
        });
        var blob = new Blob(['importScripts(' + urls.join(',') + ');'], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
    } catch (e) {
        return parseOnMainThread(buffer);
    }
    return new Promise(function (resolve, reject) {
        worker.onmessage = function (e) {
            worker.terminate();
            if (e.data.type === 'result') resolve(e.data.result);
            else reject(new Error(e.data.message));
        };
        worker.onerror = function (e) {
            // Worker scripts could not load — parse here instead.
            if (e.preventDefault) e.preventDefault();
            worker.terminate();
            parseOnMainThread(buffer).then(resolve, reject);
        };
        worker.postMessage({ buffer: buffer });
    });
}

// =========================================================================
// Import
// =========================================================================

function importFiles(files) {
    hideError();
    var lastId = null, added = 0, duplicates = 0, failed = [];
    return files.reduce(function (chain, file, i) {
        return chain.then(function () {
            var of = files.length > 1 ? ' (' + (i + 1) + ' of ' + files.length + ')' : '';
            return importOne(file, of).then(function (r) {
                lastId = r.record.id;
                if (r.duplicate) duplicates++; else added++;
            }).catch(function (err) {
                failed.push(file.name + ': ' + (err && err.message ? err.message : err));
            });
        });
    }, Promise.resolve()).then(function () {
        var parts = [];
        if (added) parts.push('Imported ' + added + ' package' + (added > 1 ? 's' : '') + '.');
        if (duplicates) parts.push(duplicates + ' already imported.');
        if (state.backend === 'memory' && added) parts.push('Browser storage is unavailable, so imports last only for this session.');
        setStatus(parts.join(' '));
        if (failed.length) showError('Could not import ' + failed.join('; '));
        return refreshHistory().then(function () { if (lastId) return viewPackage(lastId); });
    });
}

/** Re-parse stored packages that were imported with an older parser version. */
function reparseStale() {
    if (state.backend !== 'browser') return Promise.resolve();   // the server re-parses on startup
    var stale = state.packages.filter(function (p) { return (p.parserVersion || 0) < M1PKG_PARSER_VERSION; });
    if (!stale.length) return Promise.resolve();
    return stale.reduce(function (chain, p, i) {
        return chain.then(function () {
            setStatus('Updating stored packages to the latest parser (' + (i + 1) + ' of ' + stale.length + ')…');
            return loadTuneFile(p.id).then(function (file) {
                if (!file || !file.data) return;
                return parsePackage(file.data).then(function (parsed) { return updateTunePackage(p.id, parsed); });
            }).catch(function (err) { console.warn('Re-parse failed for ' + p.fileName, err); });
        });
    }, Promise.resolve()).then(function () {
        setStatus('');
        return refreshHistory();
    });
}

// =========================================================================
// History + compare
// =========================================================================

function refreshHistory() {
    return storeList().then(function (list) {
        state.packages = list;
        renderHistory();
        var has = list.length > 0;
        historySection.hidden = !has;
        $('empty-state').hidden = has;
        if (!has) {
            state.current = null; state.compare = null;
            $('tune-info').hidden = true;
            $('main-content').hidden = true;
        }
    });
}

function renderHistory() {
    var currentId = state.current ? state.current.id : null;
    historyBody.innerHTML = state.packages.slice().reverse().map(function (p) {
        return '<tr' + (p.id === currentId ? ' class="current"' : '') + '>' +
            '<td>' + esc(p.tuneName || p.fileName) + '</td>' +
            '<td>' + esc(fmtDate(p.modified)) + '</td>' +
            '<td>' + esc(p.firmware && p.firmware.version) + '</td>' +
            '<td>' + esc(lastNote(p)) + '</td>' +
            '<td>' + esc(fmtDate(p.importedAt)) + '</td>' +
            '<td class="actions">' +
            '<button class="btn btn-small btn-secondary" data-view="' + esc(p.id) + '">View</button>' +
            '<button class="btn btn-small btn-danger" data-delete="' + esc(p.id) + '" aria-label="Delete ' +
            esc(p.tuneName || p.fileName) + '">Delete</button></td></tr>';
    }).join('');

    var options = state.packages.map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.tuneName || p.fileName) + '</option>';
    }).join('');
    var from = cmpFrom.value, to = cmpTo.value;
    cmpFrom.innerHTML = options;
    cmpTo.innerHTML = options;
    if (from) cmpFrom.value = from;
    if (to) cmpTo.value = to;
    cmpBtn.disabled = state.packages.length < 2;
    exportBtn.disabled = state.backend === 'memory';
}

function previousPackageId(id) {
    for (var i = 1; i < state.packages.length; i++) if (state.packages[i].id === id) return state.packages[i - 1].id;
    return null;
}

function viewPackage(id) {
    return storeLoad(id).then(function (pkg) {
        state.current = pkg;
        state.links = null;
        state.index = pkg.items.map(function (item) {
            return { item: item, cats: m1cCategories(item), lname: item.name.toLowerCase() };
        });
        renderInfo();
        renderHistory();
        $('main-content').hidden = false;
        var prev = previousPackageId(id);
        cmpTo.value = id;
        if (prev) {
            cmpFrom.value = prev;
            return compare(prev, id);
        }
        state.compare = null;
        renderActiveTab();
    }).catch(function (err) { showError('Could not open package: ' + err.message); });
}

function compare(fromId, toId) {
    return Promise.all([storeLoad(fromId), storeLoad(toId)]).then(function (r) {
        var byName = {};
        r[0].items.forEach(function (i) { byName[i.name] = i; });
        r[1].items.forEach(function (i) { byName[i.name] = i; });
        state.compare = { a: r[0], b: r[1], diff: diffM1Pkg(r[0], r[1]), byName: byName };
        renderActiveTab();
    });
}

function renderInfo() {
    var p = state.current;
    $('ti-firmware').textContent = (p.firmware && p.firmware.name) || '—';
    $('ti-version').textContent = (p.firmware && p.firmware.version) || '—';
    $('ti-tune').textContent = p.tuneName || p.fileName || '—';
    $('ti-modified').textContent = fmtDate(p.modified);
    $('ti-serial').textContent = p.serial !== null && p.serial !== undefined ? p.serial : '—';
    $('ti-count').textContent = p.items.length.toLocaleString();
    $('tune-info').hidden = false;
}

// =========================================================================
// Rendering — panels
// =========================================================================

function matchesFilters(item) {
    if (state.filter !== 'all' && item.kind !== state.filter) return false;
    return !state.search || item.name.toLowerCase().indexOf(state.search) >= 0;
}

function renderActiveTab() {
    if (!state.current) return;
    if (state.tab === 'changes') renderChanges();
    else if (state.tab === 'calibrations') renderCalibrations();
    else renderParams(state.tab);
}

function renderParams(tab) {
    var rows = [], shown = 0;
    for (var i = 0; i < state.index.length; i++) {
        var e = state.index[i];
        if (e.cats.indexOf(tab) < 0) continue;
        if (state.filter !== 'all' && e.item.kind !== state.filter) continue;
        if (state.search && e.lname.indexOf(state.search) < 0) continue;
        rows.push(paramRow(e.item, i));
        shown++;
    }
    $('tbl-' + tab).innerHTML = shown
        ? '<div class="result-count">' + shown.toLocaleString() + ' item' + (shown === 1 ? '' : 's') + '</div>' +
          '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Name</th><th>Value</th>' +
          '<th>Pin</th><th>Unit</th><th>Type</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'
        : '<p class="muted">No matching parameters.</p>';
}

function paramRow(item, idx) {
    var value, pin = '';
    if (item.axes) {
        value = esc(m1cTableSize(item)) + ' <button class="btn btn-small btn-secondary" data-grid="' + idx +
            '" aria-expanded="false">Show</button>';
    } else if (item.type === 'io_resource') {
        value = esc(resourceLabel(item.value, state.current));
        if (m1lValueTarget(links(), item)) value = followLink(m1lValueTarget(links(), item), value, '', 'g:' + m1lGroupOf(item.name));
        pin = esc(resourcePin(item.value, state.current) || '');
        if (m1cResourceAssigned(item.value)) {
            value += ' <button class="btn btn-small btn-secondary" data-name-res="' + idx + '" aria-label="Name resource for ' +
                esc(item.name) + '">Name</button>';
        }
    } else {
        value = esc(m1cFormatValue(item, item.value, item.label));
        if (m1lValueTarget(links(), item)) value = followLink(m1lValueTarget(links(), item), value, '', 'g:' + m1lGroupOf(item.name));
    }
    if (!item.axes && state.packages.length > 1) {
        value += ' <button class="btn btn-small btn-secondary" data-history="' + idx + '" aria-label="History of ' + esc(item.name) + '">History</button>';
    }
    return '<tr><td class="param-name">' + followLink('g:' + m1lGroupOf(item.name), esc(item.name), 'follow-name') + '</td><td class="num">' + value + '</td>' +
        '<td class="param-pin">' + pin + '</td><td>' + esc(m1cUnit(item)) + '</td><td class="param-kind">' + esc(item.kind) + '</td></tr>';
}

function gridHtml(item, idx) {
    var g = m1cTableGrid(item), axes = {};
    item.axes.forEach(function (a) { axes[a.axis] = a; });
    function axisLabel(a) {
        if (!a) return '';
        var u = m1cUnit(a), text = esc((a.input || a.axis) + (u ? ' (' + u + ')' : ''));
        var to = axisTarget(item, a.axis);
        return to ? followLink(to, text) : text;
    }
    function num(v, src) { return esc(m1cFormatNumber(v, m1cConvert(0, src).dps)); }
    var hist = state.packages.length > 1;
    var html = '<div class="grid-caption">Values' + (m1cUnit(item) ? ' (' + esc(m1cUnit(item)) + ')' : '') +
        ' · X: ' + axisLabel(axes.X) + (axes.Y ? ' · Y: ' + axisLabel(axes.Y) : '') +
        (hist ? ' · click a cell for its history' : '') + '</div>';
    function cellKey(ix, iy, iz) {
        return 'V[' + [ix, iy, iz].slice(0, item.axes.length).join(',') + ']';
    }
    g.slices.forEach(function (s, iz) {
        if (axes.Z) html += '<div class="grid-caption">Z = ' + num(s.zValue, axes.Z) + ' · ' + axisLabel(axes.Z) + '</div>';
        html += '<div class="grid-wrap"><table class="grid-table"><thead><tr><th>' + (axes.Y ? 'Y \\ X' : 'X') + '</th>' +
            g.x.map(function (x) { return '<th scope="col">' + num(x, axes.X) + '</th>'; }).join('') + '</tr></thead><tbody>';
        s.rows.forEach(function (row, iy) {
            html += '<tr><th scope="row">' + (axes.Y ? num(g.y[iy], axes.Y) : 'Value') + '</th>' +
                row.map(function (v, ix) {
                    return hist ? '<td class="hcell" data-hkey="' + cellKey(ix, iy, iz) + '">' + num(v, item) + '</td>' : '<td>' + num(v, item) + '</td>';
                }).join('') + '</tr>';
        });
        html += '</tbody></table></div>';
    });
    return '<div data-hist-item="' + idx + '">' + html + '</div>';
}

function toggleGrid(btn) {
    var tr = btn.closest('tr'), next = tr.nextElementSibling;
    if (next && next.classList.contains('grid-row')) {
        next.remove();
        btn.textContent = 'Show';
        btn.setAttribute('aria-expanded', 'false');
        return;
    }
    var item = state.index[parseInt(btn.getAttribute('data-grid'), 10)].item;
    var row = document.createElement('tr');
    row.className = 'grid-row';
    row.innerHTML = '<td colspan="5">' + gridHtml(item, parseInt(btn.getAttribute('data-grid'), 10)) + '</td>';
    tr.parentNode.insertBefore(row, tr.nextSibling);
    btn.textContent = 'Hide';
    btn.setAttribute('aria-expanded', 'true');
}

function renderCalibrations() {
    var sel = state.current.selections || [];
    $('tbl-calibrations').innerHTML = sel.length
        ? '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Slot</th><th>Calibration</th>' +
          '<th>Version</th></tr></thead><tbody>' + sel.map(function (s) {
              return '<tr><td class="param-name">' + esc(s.slot) + '</td><td>' + esc(s.name) + '</td><td>' +
                  esc(s.version || '') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="muted">This package has no library calibration selections.</p>';
}

function renderChanges() {
    var el = $('tbl-changes'), c = state.compare;
    if (!c) {
        el.innerHTML = '<p class="muted">' + (state.packages.length < 2
            ? 'Import another version of this tune to see what changed.'
            : 'Choose two tunes above and press Compare.') + '</p>';
        return;
    }
    var d = c.diff;
    var items = d.items.filter(function (i) {
        var def = c.byName[i.name];
        return matchesFilters(def || { name: i.name, kind: i.kind });
    });
    var cellCount = d.items.reduce(function (n, i) { return n + i.cells.length; }, 0);

    var html = '<p><strong>' + esc(c.a.tuneName || c.a.fileName) + '</strong> &rarr; <strong>' +
        esc(c.b.tuneName || c.b.fileName) + '</strong></p>';
    html += '<div class="summary-grid change-summary">' +
        stat(d.items.length, 'Items changed') + stat(cellCount, 'Values changed') +
        stat(d.selections.length, 'Calibration changes') +
        stat(d.firmwareChanged ? 'Yes' : 'No', 'Firmware changed') + '</div>';

    if (d.firmwareChanged) {
        html += '<div class="rec-item rec-warning">These tunes use different firmware. Items that only exist in one of them are listed as added or removed.</div>';
    }

    var notes = (c.b.commentLog || []).filter(function (e) { return e.time && (!c.a.modified || e.time > c.a.modified) && (e.title || e.note); });
    if (notes.length) {
        html += '<div class="report-block"><h2>Save notes</h2>' + notes.map(function (n) {
            return '<div class="change-note"><strong>' + esc(n.title || '') + '</strong> · ' + esc(fmtDate(n.time)) +
                (n.note ? '<br>' + esc(n.note) : '') + '</div>';
        }).join('') + '</div>';
    }

    if (d.selections.length) {
        html += '<div class="report-block"><h2>Calibration selections</h2><div class="table-scroll"><table class="event-table data-table">' +
            '<thead><tr><th>Slot</th><th>From</th><th>To</th></tr></thead><tbody>' +
            d.selections.map(function (s) {
                return '<tr><td class="param-name">' + esc(s.slot) + '</td><td class="change-from">' + esc(s.from || '—') +
                    '</td><td class="change-to">' + esc(s.to || '—') + '</td></tr>';
            }).join('') + '</tbody></table></div></div>';
    }

    if (!d.items.length && !d.selections.length) {
        html += '<p class="muted">No calibration differences between these tunes.</p>';
    } else if (!items.length && d.items.length) {
        html += '<p class="muted">No changed items match the current search/filter.</p>';
    }
    html += items.map(function (ch) { return changeHtml(ch, c.byName[ch.name]); }).join('');
    el.innerHTML = html;
}

function stat(value, label) {
    return '<div class="summary-stat"><span class="stat-value">' + esc(value) + '</span><span class="stat-label">' +
        esc(label) + '</span></div>';
}

var MAX_CELLS_SHOWN = 40;

function changeHtml(ch, item) {
    var cls = ch.change === 'added' ? ' change-added' : ch.change === 'removed' ? ' change-removed' : '';
    var html = '<div class="change-item' + cls + '"><h3><span class="param-name">' +
        (links().groups[m1lGroupOf(ch.name)] ? followLink('g:' + m1lGroupOf(ch.name), esc(ch.name), 'follow-name') : esc(ch.name)) + '</span>' +
        '<span class="param-kind">' + esc(ch.change === 'changed' ? (item ? item.kind : '') : ch.change) + '</span></h3>';
    if (ch.change !== 'changed') return html + '</div>';
    var unit = item ? m1cUnit(item) : '';
    if (item.type === 'io_resource') {
        var r0 = ch.cells[0];
        return html + '<div><span class="change-from">' + esc(resourceLabelWithPin(r0.from, state.compare.a)) +
            '</span> &rarr; <span class="change-to">' + esc(resourceLabelWithPin(r0.to, state.compare.b)) + '</span>' +
            ' <button class="link-btn" data-hist-name="' + esc(ch.name) + '" data-hist-key="">history</button></div></div>';
    }
    if (!item.axes) {
        var c0 = ch.cells[0];
        return html + '<div><span class="change-from">' + esc(m1cFormatCell(item, '', c0.from, c0.fromLabel)) +
            '</span> &rarr; <span class="change-to">' + esc(m1cFormatCell(item, '', c0.to, c0.toLabel)) + '</span>' +
            (unit ? ' ' + esc(unit) : '') + ' <button class="link-btn" data-hist-name="' + esc(ch.name) + '" data-hist-key="">history</button></div></div>';
    }
    html += '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Cell</th><th>From</th><th>To</th></tr></thead><tbody>';
    ch.cells.slice(0, MAX_CELLS_SHOWN).forEach(function (cell) {
        html += '<tr><td><button class="link-btn" data-hist-name="' + esc(ch.name) + '" data-hist-key="' + esc(cell.key) +
            '" title="History of this cell">' + esc(m1cCellLabel(item, cell.key)) + '</button></td><td class="num change-from">' +
            esc(m1cFormatCell(item, cell.key, cell.from)) + '</td><td class="num change-to">' +
            esc(m1cFormatCell(item, cell.key, cell.to)) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    if (ch.cells.length > MAX_CELLS_SHOWN) html += '<div class="more">… and ' + (ch.cells.length - MAX_CELLS_SHOWN) + ' more cells</div>';
    if (unit) html += '<div class="more">Values in ' + esc(unit) + '</div>';
    return html + '</div>';
}

// =========================================================================
// Events
// =========================================================================

pkgInput.addEventListener('change', function () {
    var files = Array.prototype.slice.call(pkgInput.files);
    pkgInput.value = '';
    if (files.length) importFiles(files);
});

cmpBtn.addEventListener('click', function () {
    if (!cmpFrom.value || !cmpTo.value) return;
    hideError();
    compare(cmpFrom.value, cmpTo.value).then(function () { selectTab('changes'); })
        .catch(function (err) { showError('Could not compare: ' + err.message); });
});

historyBody.addEventListener('click', function (e) {
    var view = e.target.closest('[data-view]'), del = e.target.closest('[data-delete]');
    if (view) viewPackage(view.getAttribute('data-view'));
    if (del) {
        var id = del.getAttribute('data-delete');
        var p = state.packages.filter(function (x) { return x.id === id; })[0];
        if (!window.confirm('Delete "' + (p ? p.tuneName || p.fileName : id) + '" from the tune history?')) return;
        storeDelete(id).then(refreshHistory).then(function () {
            if (state.current && state.current.id === id) {
                state.current = null;
                if (state.packages.length) return viewPackage(state.packages[state.packages.length - 1].id);
            } else if (state.compare && (state.compare.a.id === id || state.compare.b.id === id)) {
                state.compare = null;
                renderActiveTab();
            }
        }).catch(function (err) { showError('Could not delete: ' + err.message); });
    }
});

exportBtn.addEventListener('click', function () {
    storeExport().then(function (backup) {
        var blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'tunercontrol-m1-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }).catch(function (err) { showError('Could not export: ' + err.message); });
});

backupInput.addEventListener('change', function () {
    var file = backupInput.files[0];
    backupInput.value = '';
    if (!file) return;
    hideError();
    if (state.backend === 'memory') { showError('Browser storage is unavailable, so backups cannot be restored here.'); return; }
    setStatus('Restoring ' + file.name + '…');
    file.text().then(function (text) { return storeImportBackup(JSON.parse(text)); })
        .then(function (added) {
            setStatus('Restored ' + added + ' package' + (added === 1 ? '' : 's') + ' from backup.');
            return storeResourceNames().then(function (names) { state.resourceNames = names; }).then(refreshHistory);
        }).then(function () {
            if (!state.current && state.packages.length) return viewPackage(state.packages[state.packages.length - 1].id);
        }).catch(function (err) { showError('Could not restore backup: ' + err.message); });
});

function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach(function (t) {
        var on = t.getAttribute('data-tab') === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.id !== 'panel-' + tab; });
    renderActiveTab();
}

document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { selectTab(t.getAttribute('data-tab')); });
});

document.querySelectorAll('.filter-btn').forEach(function (b) {
    b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-filter');
        document.querySelectorAll('.filter-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderActiveTab();
    });
});

var searchTimer = null;
searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
        state.search = searchInput.value.trim().toLowerCase();
        renderActiveTab();
    }, 150);
});

$('main-content').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-grid]');
    if (btn) toggleGrid(btn);
    var hb = e.target.closest('[data-history]');
    if (hb) showHistory(state.index[parseInt(hb.getAttribute('data-history'), 10)].item, '');
    var hc = e.target.closest('[data-hkey]');
    if (hc) showHistory(state.index[parseInt(hc.closest('[data-hist-item]').getAttribute('data-hist-item'), 10)].item, hc.getAttribute('data-hkey'));
    var hn = e.target.closest('[data-hist-name]');
    if (hn && state.compare) showHistory(state.compare.byName[hn.getAttribute('data-hist-name')], hn.getAttribute('data-hist-key'));
    var nameBtn = e.target.closest('[data-name-res]');
    if (nameBtn) nameResource(state.index[parseInt(nameBtn.getAttribute('data-name-res'), 10)].item);
});

// =========================================================================
// Follow: what a setting group or I/O resource uses and what references it
// =========================================================================

/** Open the Follow dialog on an entity; push (default) adds it to the trail, 'new' starts a new trail (at `from` if given). */
function openFollow(key, mode, from) {
    if (mode === 'new' || !$('follow-dialog').open) state.followTrail = from && from !== key ? [from] : [];
    if (state.followTrail[state.followTrail.length - 1] !== key) state.followTrail.push(key);
    renderFollow();
    if (!$('follow-dialog').open) $('follow-dialog').showModal();
    $('follow-body').scrollTop = 0;
}

/** Display value of an item in the Follow dialog, linked when it points at another entity. */
function followValue(item) {
    if (item.axes) return esc(m1cTableSize(item)) + ' table';
    var text = item.type === 'io_resource' ? resourceLabelWithPin(item.value, state.current) : m1cFormatValue(item, item.value, item.label);
    var to = m1lValueTarget(links(), item);
    return to ? followLink(to, esc(text)) : esc(text);
}

/** How a reference reads: "= Driver Switch 8", "assigned FIRMWARE5", "Z axis: …". */
function refHow(r) {
    return r.kind === 'value' ? '= ' + r.text : r.kind === 'resource' ? 'assigned ' + r.text : r.text;
}

function renderFollow() {
    var ix = links(), key = state.followTrail[state.followTrail.length - 1], e = m1lEntity(ix, key);
    $('follow-back').disabled = state.followTrail.length < 2;
    $('follow-title').textContent = (key.indexOf('r:') === 0 ? 'I/O resource ' : '') + m1lTitle(ix, key);
    $('follow-trail').innerHTML = state.followTrail.length > 1 ? 'Followed: ' + state.followTrail.map(function (k, i) {
        var t = esc(m1lTitle(ix, k));
        return i === state.followTrail.length - 1 ? '<strong>' + t + '</strong>' : '<button class="link-btn" data-trail="' + i + '">' + t + '</button>';
    }).join(' → ') : '';
    if (!e) {
        $('follow-crumbs').innerHTML = '';
        $('follow-body').innerHTML = '<p class="muted">Not in this tune.</p>';
        return;
    }
    $('follow-crumbs').innerHTML = e.parents.length ? 'In ' + e.parents.map(function (p) {
        return followLink(p.key, esc(p.title.split('.').pop()));
    }).join(' › ') : '';

    var html = '';
    function section(title, n, body, empty) {
        html += '<h3 class="follow-h">' + esc(title) + ' <span class="muted">(' + n + ')</span></h3>' + (n ? body : '<p class="muted">' + esc(empty) + '</p>');
    }
    function table(head, rows) {
        return '<div class="table-scroll"><table class="event-table data-table follow-table"><thead><tr>' +
            head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    }
    function findBtn(name) {
        return '<button class="btn btn-small btn-secondary" data-find="' + esc(name) + '" title="Show ' + esc(name) + ' in the table">Find</button>';
    }

    section(e.kind === 'resource' ? 'Assigned or selected by' : 'Referenced by', e.usedBy.length, table(['Setting', 'How', ''], e.usedBy.map(function (r) {
        return '<tr><td class="param-name">' + followLink('g:' + m1lGroupOf(r.from), esc(r.from)) + '</td><td>' + esc(refHow(r)) +
            '</td><td class="num">' + findBtn(r.from) + '</td></tr>';
    })), e.kind === 'resource' ? 'Nothing in this tune uses it.' : 'Nothing else in this tune points at ' + e.title + '.');

    if (e.kind === 'group') {
        section('Uses', e.uses.length, table(['Setting', 'Points at'], e.uses.map(function (r) {
            return '<tr><td class="param-name">' + esc(r.from.slice(e.title.length + 1)) + '</td><td>' +
                followLink(r.to, esc(m1lTitle(ix, r.to))) + (r.kind === 'axis' ? ' <span class="muted">(' + esc(r.text.split(':')[0]) + ')</span>' : '') + '</td></tr>';
        })), 'Its settings do not point at other groups or resources.');

        section('Settings', e.memberCount, table(['Name', 'Value', 'Unit', ''], e.members.map(function (it) {
            return '<tr><td class="param-name">' + esc(it.name.slice(e.title.length + 1)) + '</td><td class="num">' + followValue(it) +
                '</td><td>' + esc(m1cUnit(it)) + '</td><td class="num">' + findBtn(it.name) + '</td></tr>';
        })) + (e.memberCount > e.members.length ? '<div class="more">… and ' + (e.memberCount - e.members.length) + ' more</div>' : ''),
            'No settings directly in this group.');

        if (e.subgroups.length) {
            html += '<h3 class="follow-h">Groups inside <span class="muted">(' + e.subgroups.length + ')</span></h3><div class="follow-chips">' +
                e.subgroups.map(function (g) { return followLink(g.key, esc(g.title) + ' <span class="muted">' + g.count + '</span>', 'follow-chip'); }).join('') + '</div>';
        }
    }
    $('follow-body').innerHTML = html;
}

/** Show one item in the All tab: search for its exact name. */
function findInTable(name) {
    $('follow-dialog').close();
    searchInput.value = name;
    state.search = name.toLowerCase();
    selectTab('all');
}

document.addEventListener('click', function (e) {
    var f = e.target.closest('[data-follow]');
    if (f && state.current) {
        e.preventDefault();
        openFollow(f.getAttribute('data-follow'), e.target.closest('#follow-dialog') ? 'push' : 'new', f.getAttribute('data-follow-from'));
        return;
    }
    var t = e.target.closest('[data-trail]');
    if (t) { state.followTrail = state.followTrail.slice(0, parseInt(t.getAttribute('data-trail'), 10) + 1); renderFollow(); return; }
    var fd = e.target.closest('[data-find]');
    if (fd) findInTable(fd.getAttribute('data-find'));
});
$('follow-back').addEventListener('click', function () {
    if (state.followTrail.length > 1) { state.followTrail.pop(); renderFollow(); }
});

// =========================================================================
// Value history across tune versions
// =========================================================================

function loadPackageCached(id) {
    if (state.pkgCache[id]) return Promise.resolve(state.pkgCache[id]);
    return storeLoad(id).then(function (p) { state.pkgCache[id] = p; return p; });
}

/** Rows [{ tuneName, modified, value, label }] oldest first for one item/cell, from the server or stored tunes. */
function historyRows(item, key) {
    if (state.backend === 'server') {
        return tuneApi('GET', 'history?item=' + encodeURIComponent(item.name) + '&cell=' + encodeURIComponent(key)).then(function (rows) {
            return rows.map(function (r) {
                var value = item.type === 'io_resource' ? (r.text_value ? r.text_value.split(',') : null)
                    : r.value !== null ? r.value : r.text_value;
                return { tuneName: r.tune_name, modified: r.modified, value: value, label: r.text_value };
            });
        });
    }
    return Promise.all(state.packages.map(function (p) {
        return loadPackageCached(p.id).then(function (pkg) {
            var it = pkg.items.filter(function (x) { return x.name === item.name; })[0];
            var cell = it ? m1pkgCells(it).filter(function (c) { return c.key === key; })[0] : null;
            return { tuneName: p.tuneName || p.fileName, modified: p.modified, value: cell ? cell.value : null, label: cell ? cell.label : null };
        });
    }));
}

function showHistory(item, key) {
    if (!item) return;
    var where = key ? m1cCellLabel(item, key) : '';
    $('hist-title').textContent = item.name + (where ? ' — ' + where : '');
    $('hist-sub').textContent = 'Loading…';
    $('hist-chart').innerHTML = '';
    $('hist-table').innerHTML = '';
    if (!$('hist-dialog').open) $('hist-dialog').showModal();
    historyRows(item, key).then(function (rows) {
        var unit = m1cUnit(key && /^[XYZ]\[/.test(key) ? item.axes.filter(function (a) { return a.axis === key[0]; })[0] : item);
        var pts = m1hPoints(rows, item, key, function (ids) { return resourceLabel(ids, state.current); });
        var changes = 0;
        pts.forEach(function (p, i) { if (i && p.text !== pts[i - 1].text) changes++; });
        $('hist-sub').textContent = pts.length + ' tune version' + (pts.length === 1 ? '' : 's') + ', ' +
            (changes ? 'changed ' + changes + ' time' + (changes === 1 ? '' : 's') : 'never changed') + (unit ? ' · values in ' + unit : '') + '.';
        $('hist-chart').innerHTML = m1hChartSvg(pts, unit);
        $('hist-table').innerHTML = '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Tune</th><th>Saved</th>' +
            '<th>Value</th><th>Change</th></tr></thead><tbody>' + pts.slice().reverse().map(function (p, i, arr) {
                var prev = arr[i + 1], change = '';
                if (prev && p.num !== null && prev.num !== null && p.num !== prev.num) {
                    var d = p.num - prev.num;
                    change = '<span class="' + (d > 0 ? 'hist-up' : 'hist-down') + '">' + (d > 0 ? '+' : '') + esc(+d.toPrecision(4)) + '</span>';
                } else if (prev && p.text !== prev.text) change = 'changed';
                return '<tr><td title="' + esc(p.tuneName) + '">' + esc(p.tuneName) + '</td><td>' +
                    esc(p.modified ? new Date(p.modified).toLocaleString() : '') + '</td><td class="num">' + esc(p.text) + '</td><td class="num">' +
                    change + '</td></tr>';
            }).join('') + '</tbody></table></div>';
    }).catch(function (err) { $('hist-sub').textContent = 'Could not load the history: ' + err.message; });
}

/** Ask for the M1 Tune name of an I/O resource and remember it for this hardware. */
function nameResource(item) {
    var hw = hardwareOf(state.current);
    var key = hw + '|' + m1cResourceKey(item.value);
    var current = m1cResourceName(item.value, hw, state.resourceNames);
    var name = window.prompt('Resource name shown in M1 Tune for ' + item.name +
        ' (' + item.value.filter(function (v) { return v !== '0x0000'; }).join(', ') + ').\n' +
        'Applies to every item and tune using this assignment on ' + (hw || 'this hardware') + '. Leave empty to clear.\n' +
        'ECU inputs/outputs named as in M1 Tune or the datasheet (e.g. UDIG2, Half Bridge Output 4) get their connector pin.',
        current ? current.name : '');
    if (name === null) return;
    name = name.trim();
    storeSaveResourceName(key, name).then(function () {
        if (name) state.resourceNames[key] = name; else delete state.resourceNames[key];
        state.links = null;
        renderActiveTab();
    }).catch(function (err) { showError('Could not save the resource name: ' + err.message); });
}

// =========================================================================
// Startup
// =========================================================================

var STORAGE_HINTS = {
    server: 'Packages are stored on the TunerControl server and shared by every browser that uses it.',
    browser: 'Packages are stored in this browser only. Import each saved version (e.g. V54, V55) to build up the tune history.',
    memory: 'Browser storage is unavailable here — imported packages are kept only until the page is closed.'
};

/** Use the server when this page is served by one; otherwise IndexedDB, or memory as a last resort. */
function chooseBackend() {
    return detectTuneServer().then(function (server) {
        if (server) return 'server';
        return openTuneDb().then(function () { return 'browser'; }, function () { return 'memory'; });
    }).then(function (backend) {
        state.backend = backend;
        $('storage-hint').textContent = STORAGE_HINTS[backend];
    });
}

chooseBackend().then(function () {
    return storeResourceNames().then(function (names) { state.resourceNames = names; });
}).then(refreshHistory).then(reparseStale).then(function () {
    if (state.packages.length) return viewPackage(state.packages[state.packages.length - 1].id);
}).catch(function (err) { showError(err.message || String(err)); });
