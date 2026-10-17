/**
 * harness/app.js — Harness Builder page: open/import/save harnesses, edit connectors and splices,
 * show consistency checks and the comparison with an M1 tune.
 */

var state = {
    id: null,             // stored harness id (null until first save)
    name: '',
    model: null,
    revision: 0, latest: 0, revisions: [],
    dirty: false,
    checks: [], issuesByRow: {}, issuesByBlock: {},
    tab: 'connectors',
    selConnector: null, selSplice: null,
    tunes: [], tunePkg: null, tuneId: '', resourceNames: {}, show: 'problems',
    openIssues: {},       // 'kind|block|index' → true for rows whose problem details are shown
    diagram: '',          // '' = overview, 'system', 'trace:<key>', or a connector/splice id
    systems: [],          // all harness systems
    system: null,         // the system this harness belongs to (or null)
    sysMembers: [],       // other harnesses of that system: [{ id, name, model, revision }]
    tuneScope: 'system'
};

function $(id) { return document.getElementById(id); }

function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(text) { $('status').textContent = text || ''; $('status').hidden = !text; }
function showError(text) { $('error').textContent = text || ''; $('error').hidden = !text; }

var STORAGE_HINTS = {
    server: 'Harnesses are stored on the TunerControl server, with every saved revision.',
    browser: 'Harnesses are stored in this browser only, with every saved revision. Export .xlsx to keep a copy elsewhere.',
    memory: 'Browser storage is unavailable here — harnesses are kept only until the page is closed. Export .xlsx to keep your work.'
};

// =========================================================================
// Harness list, open, import, save
// =========================================================================

function refreshHarnessList(selectId) {
    return hsList().then(function (list) {
        var sel = $('harness-select');
        sel.innerHTML = list.length ? list.map(function (h) {
            return '<option value="' + esc(h.id) + '">' + esc(h.name) + ' — rev ' + h.revision + ', ' +
                esc(new Date(h.updated).toLocaleString()) + '</option>';
        }).join('') : '<option value="">No saved harnesses</option>';
        if (selectId) sel.value = selectId;
        $('open-btn').disabled = !list.length;
    });
}

function confirmDiscard() {
    return !state.dirty || window.confirm('Discard unsaved changes to "' + state.name + '"?');
}

function openHarness(id, revision) {
    showError('');
    return hsLoad(id, revision).then(function (h) {
        state.id = h.id; state.name = h.name; state.model = h.data;
        state.revision = h.revision; state.latest = h.latest; state.revisions = h.revisions;
        state.selConnector = state.model.connectors[0] ? state.model.connectors[0].id : null;
        state.selSplice = state.model.splices[0] ? state.model.splices[0].id : null;
        setDirty(false);
        showEditor();
        return loadSystemContext();
    }).catch(function (err) { showError('Could not open the harness: ' + err.message); });
}

function newHarness() {
    state.id = null; state.name = 'New harness'; state.revision = 0; state.latest = 0; state.revisions = [];
    state.model = { name: 'New harness', sheets: [{ name: 'Connectors', kind: 'connectors' }, { name: 'Splices', kind: 'splices' }],
                    connectors: [], splices: [] };
    state.selConnector = null; state.selSplice = null;
    state.system = null; state.sysMembers = [];
    setDirty(true);
    showEditor();
    renderSystemSelect();
}

function importXlsx(file) {
    showError('');
    setStatus('Reading ' + file.name + '…');
    var name = file.name.replace(/\.xlsx$/i, ''), parts;
    file.arrayBuffer().then(readXlsx).then(function (wb) {
        var model = harnessFromWorkbook(wb, name);
        parts = [{ name: name, model: model }];
        // Sheets that are their own (sub-)harness: a connector name shared with another sheet = a mating pair.
        harnessSplitCandidates(model).forEach(function (c) {
            if (!window.confirm('The sheet "' + c.sheet + '" has its own ' + c.shared.join(', ') + ' connector, which mates with ' +
                    c.shared.join(', ') + ' on another sheet. Import "' + c.sheet + '" as a separate harness, joined to the main one?')) return;
            var split = harnessSplitSheet(parts[0].model, c.sheet, name + ' - ' + c.sheet);
            parts[0].model = split.main;
            parts.push({ name: split.sub.name, model: split.sub });
        });
        return parts.reduce(function (p, part) {
            return p.then(function () {
                return hsStoreModelImages(part.model, function (done, total) {
                    setStatus('Storing images for ' + part.name + ': ' + done + ' of ' + total + '…');
                }).then(function (n) {
                    part.images = n;
                    setStatus('Saving ' + part.name + '…');
                    return hsSave(null, part.name, part.model, 'Imported from ' + file.name);
                }).then(function (saved) { part.id = saved.id; });
            });
        }, Promise.resolve());
    }).then(function () {
        return joinImportedToSystem(parts);
    }).then(function () {
        var main = parts[0], c = main.model.connectors.length, sp = main.model.splices.length;
        setStatus('Imported ' + file.name + ': ' + c + ' connector' + (c === 1 ? '' : 's') + ', ' + sp + ' splice' + (sp === 1 ? '' : 's') +
            (main.images ? ', ' + main.images + ' image' + (main.images === 1 ? '' : 's') : '') +
            (parts.length > 1 ? ' — plus ' + parts.slice(1).map(function (p) { return '"' + p.name + '"'; }).join(', ') + ' as separate harness' +
                (parts.length > 2 ? 'es' : '') : '') + '.');
        return refreshHarnessList(main.id).then(function () { return openHarness(main.id); });
    }).catch(function (err) {
        setStatus('');
        showError('Could not import ' + file.name + ': ' + err.message);
    }).then(function () { $('xlsx-input').value = ''; });
}

/**
 * After an import: put split-off sub-harnesses in a system with the main harness, and offer to join a
 * system with saved harnesses whose connectors mate with the new ones.
 */
function joinImportedToSystem(parts) {
    var newIds = parts.map(function (p) { return p.id; });
    return Promise.all([hsListSystems(), hsList()]).then(function (r) {
        var systems = r[0], others = r[1].filter(function (h) { return newIds.indexOf(h.id) < 0; });
        return Promise.all(others.map(function (h) {
            return hsLoad(h.id).then(function (x) { return { id: x.id, name: x.name, model: x.data }; }, function () { return null; });
        })).then(function (loaded) {
            var partners = [];
            loaded.filter(Boolean).forEach(function (o) {
                var joins = harnessMates(parts.map(function (p) { return { id: p.id, name: p.name, model: p.model }; }).concat([o]), {}).mates
                    .filter(function (l) { return l.a.harness === o.id || l.b.harness === o.id; });
                if (joins.length) partners.push({ harness: o, connectors: joins.map(function (l) { return l.a.connector; }) });
            });
            var target = null, ask = null;
            partners.some(function (p) {
                var sys = systems.filter(function (s) { return s.harnesses.indexOf(p.harness.id) >= 0; })[0];
                if (sys) { target = sys; ask = p; return true; }
                return false;
            });
            if (!target && partners.length) ask = partners[0];
            var join = null;
            if (ask) {
                var q = '"' + parts[0].name + '" plugs into "' + ask.harness.name + '" (' + ask.connectors.join(', ') + ' mate). ' +
                    (target ? 'Add it to the system "' + target.name + '"?' : 'Create a system with both?');
                if (window.confirm(q)) join = { system: target, partner: ask.harness };
            }
            if (!join && parts.length < 2) return null;
            var sys = join && join.system ? join.system : null, ids = newIds.slice();
            if (join && !sys) ids.push(join.partner.id);
            if (!sys) {
                var name = window.prompt('Name for the system that joins these harnesses (e.g. the car):', parts[0].name + ' system');
                if (name === null || !name.trim()) return null;
                return hsSaveSystem(null, { name: name.trim(), harnesses: ids });
            }
            ids.forEach(function (id) { if (sys.harnesses.indexOf(id) < 0) sys.harnesses.push(id); });
            return hsSaveSystem(sys.id, sys);
        });
    });
}

function saveHarness() {
    var name = $('name-input').value.trim() || 'Harness';
    var older = state.id && state.revision !== state.latest;
    var note = window.prompt(older ? 'Note for this revision (restores revision ' + state.revision + '):'
                                   : 'Note for this revision (optional):', older ? 'Restored revision ' + state.revision : '');
    if (note === null) return;
    state.model.name = name;
    hsSave(state.id, name, state.model, note).then(function (saved) {
        setStatus('Saved revision ' + saved.revision + '.');
        return refreshHarnessList(saved.id).then(function () { return openHarness(saved.id); });
    }).catch(function (err) { showError('Could not save: ' + err.message); });
}

function exportXlsx() {
    var ids = {};
    state.model.connectors.concat(state.model.splices).forEach(function (b) {
        (b.images || []).forEach(function (im) { if (im.id) ids[im.id] = true; });
    });
    setStatus(Object.keys(ids).length ? 'Collecting images…' : '');
    var data = {};
    Promise.all(Object.keys(ids).map(function (id) {
        return hsImageBytes(id).then(function (b) { data[id] = b; }, function () { /* missing image: left out */ });
    })).then(function () {
        downloadXlsx(writeXlsx(harnessToWorkbook(state.model, data)));
        var missing = Object.keys(ids).length - Object.keys(data).length;
        setStatus(missing ? missing + ' image' + (missing === 1 ? ' was' : 's were') + ' not found and left out of the export.' : '');
    }).catch(function (err) { showError('Could not export: ' + err.message); });
}

function downloadXlsx(bytes) {
    var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ($('name-input').value.trim() || 'harness').replace(/[\\/:*?"<>|]+/g, '_') +
        (state.revision ? ' rev ' + state.revision : '') + '.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

/** Delete the revision being viewed, then show the newest remaining one. */
function deleteRevision() {
    if (!state.id || state.revisions.length < 2) return;
    var r = state.revisions.filter(function (x) { return x.revision === state.revision; })[0] || {};
    var msg = 'Delete revision ' + state.revision + (r.saved ? ' (' + new Date(r.saved).toLocaleString() + (r.note ? ' — ' + r.note : '') + ')' : '') +
        '? ' + (state.revisions.length === 2 ? 'The other revision is kept.' : 'The other ' + (state.revisions.length - 1) + ' revisions are kept.') +
        (state.dirty ? '\n\nYour unsaved changes will be discarded.' : '');
    if (!window.confirm(msg)) return;
    var deleted = state.revision;
    hsDeleteRevision(state.id, deleted).then(function (res) {
        setDirty(false);
        setStatus('Deleted revision ' + deleted + '.');
        return refreshHarnessList(state.id).then(function () { return openHarness(state.id, res.latest); });
    }).catch(function (err) { showError('Could not delete the revision: ' + err.message); });
}

function deleteHarness() {
    if (!state.id) { state.model = null; setDirty(false); hideEditor(); return; }
    if (!window.confirm('Delete "' + state.name + '" and all of its revisions?')) return;
    hsDelete(state.id).then(function () {
        state.id = null; state.model = null; setDirty(false);
        hideEditor();
        setStatus('Harness deleted.');
        return refreshHarnessList();
    }).catch(function (err) { showError('Could not delete: ' + err.message); });
}

function setDirty(d) {
    state.dirty = d;
    $('dirty-flag').hidden = !d;
}

// =========================================================================
// Editor shell
// =========================================================================

function showEditor() {
    $('editor').hidden = false;
    $('empty-state').hidden = true;
    $('name-input').value = state.name;
    var rs = $('revision-select');
    rs.innerHTML = state.revisions.length ? state.revisions.map(function (r) {
        return '<option value="' + r.revision + '">' + r.revision + ' — ' + esc(new Date(r.saved).toLocaleString()) +
            (r.note ? ' — ' + esc(r.note) : '') + '</option>';
    }).join('') : '<option value="">Not saved</option>';
    if (state.revision) rs.value = String(state.revision);
    rs.disabled = !state.revisions.length;
    $('delete-revision-btn').disabled = state.revisions.length < 2;
    $('delete-revision-btn').title = state.revisions.length < 2 ? 'Only one revision — use Delete to remove the harness' : '';
    var older = state.id && state.revision !== state.latest;
    $('revision-hint').hidden = !older;
    $('revision-hint').textContent = older ? 'Viewing revision ' + state.revision + ' of ' + state.latest +
        '. Saving makes it the newest revision; Export saves a copy without changing anything.' : '';
    $('delete-btn').textContent = state.id ? 'Delete' : 'Close';
    runChecks();
    renderAll();
}

function hideEditor() {
    $('editor').hidden = true;
    $('empty-state').hidden = false;
}

function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach(function (t) {
        var on = t.getAttribute('data-tab') === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    ['connectors', 'splices', 'diagram', 'system', 'checks', 'tune'].forEach(function (p) { $('panel-' + p).hidden = p !== tab; });
    if (tab === 'system') renderSystem();
    if (tab === 'checks') renderChecks();
    if (tab === 'diagram') renderDiagram();
    if (tab === 'tune') loadTunes();
}

function renderAll() {
    $('count-connectors').textContent = state.model.connectors.length;
    $('count-splices').textContent = state.model.splices.length;
    renderConnectorList();
    renderSpliceList();
    renderConnectorEditor();
    renderSpliceEditor();
    if (state.tab === 'checks') renderChecks();
    if (state.tab === 'tune') renderTune();
    if (state.tab === 'diagram') renderDiagram();
    if (state.tab === 'system') renderSystem();
}

// =========================================================================
// Checks
// =========================================================================

var checkTimer = null;

function runChecks() {
    state.checks = harnessCheck(state.model);
    state.issuesByRow = {}; state.issuesByBlock = {};
    state.checks.forEach(function (i) {
        if (i.ref) {
            var key = i.ref.kind + '|' + i.ref.block + '|' + i.ref.index;
            (state.issuesByRow[key] = state.issuesByRow[key] || []).push(i);
        }
        var block = i.ref ? i.ref.block : i.where;
        var b = state.issuesByBlock[block] = state.issuesByBlock[block] || { error: 0, warning: 0 };
        b[i.severity]++;
    });
    var errors = state.checks.filter(function (i) { return i.severity === 'error'; }).length;
    $('count-checks').textContent = errors ? errors + ' errors' : state.checks.length ? state.checks.length + ' warnings' : '✓';
}

/** Re-run checks shortly after an edit and refresh markers without rebuilding the inputs being typed in. */
function scheduleChecks() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(function () {
        runChecks();
        renderConnectorList();
        renderSpliceList();
        refreshRowMarkers();
        if (state.tab === 'checks') renderChecks();
        if (state.tab === 'tune') renderTune();
    }, 350);
}

function rowIssues(kind, block, index) {
    return state.issuesByRow[kind + '|' + block + '|' + index] || [];
}

/**
 * Error (!) / warning (?) marker. Hovering shows the problems; with `row` (an editor row index) it is a button
 * that opens the problem details under the row.
 */
function markerHtml(issues, row, open) {
    if (!issues.length) return '';
    var error = issues.some(function (i) { return i.severity === 'error'; });
    var text = issues.map(function (i) { return i.message; }).join('\n');
    var cls = 'marker ' + (error ? 'marker-error' : 'marker-warning'), label = (error ? 'Error: ' : 'Warning: ') + text;
    if (row === undefined) {
        return '<span class="' + cls + '" title="' + esc(text) + '" role="img" aria-label="' + esc(label) + '">' + (error ? '!' : '?') + '</span>';
    }
    return '<button class="' + cls + '" data-show-issues="' + row + '" title="' + esc(text) + '" aria-expanded="' + (open ? 'true' : 'false') +
        '" aria-label="' + esc(label + ' (show details)') + '">' + (error ? '!' : '?') + '</button>';
}

function issueKey(kind, block, index) { return kind + '|' + block + '|' + index; }

/** Problem details for one editor row: each message, with "Use …" (suggested fix) and "Go to …" buttons. */
function issueDetailHtml(kind, blockId, index, colspan) {
    var issues = rowIssues(kind, blockId, index);
    if (!issues.length) return '';
    return '<tr class="issue-row" data-issues-for="' + index + '"><td colspan="' + colspan + '"><ul>' + issues.map(function (i, n) {
        var actions = '';
        if (i.fix) actions += ' <button class="btn btn-small" data-row-fix="' + index + '|' + n + '">Use ' + esc(i.fix) + '</button>';
        if (i.target && i.target !== i.fix) {
            actions += ' <button class="btn btn-small btn-secondary" data-goto-target="' + esc(i.target) + '">Go to ' + esc(i.target) + '</button>';
        }
        return '<li class="issue-' + i.severity + '"><span class="issue-text">' + esc(i.message) + '</span>' + actions + '</li>';
    }).join('') + '</ul></td></tr>';
}

/** After checks re-run: update markers and open detail rows without rebuilding the inputs being typed in. */
function refreshRowMarkers() {
    document.querySelectorAll('[data-marker]').forEach(function (cell) {
        var parts = cell.getAttribute('data-marker').split('|'), index = parseInt(parts[2], 10);
        var key = issueKey(parts[0], parts[1], index), issues = rowIssues(parts[0], parts[1], index);
        if (!issues.length) delete state.openIssues[key];
        cell.innerHTML = markerHtml(issues, index, !!state.openIssues[key]);
        var tr = cell.parentNode, next = tr.nextElementSibling;
        if (next && next.classList.contains('issue-row')) next.remove();
        if (state.openIssues[key]) tr.insertAdjacentHTML('afterend', issueDetailHtml(parts[0], parts[1], index, tr.children.length));
    });
}

function renderChecks() {
    var list = state.checks;
    if (!list.length) {
        $('checks').innerHTML = '<p class="ok-banner">No problems found: every connection matches at both ends.</p>';
        return;
    }
    var errors = list.filter(function (i) { return i.severity === 'error'; }).length;
    var html = '<p class="result-count">' + errors + ' error' + (errors === 1 ? '' : 's') + ', ' + (list.length - errors) +
        ' warning' + (list.length - errors === 1 ? '' : 's') + '</p>' +
        '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th></th><th>Where</th><th>Problem</th>' +
        '<th><span class="sr-only">Actions</span></th></tr></thead><tbody>';
    list.forEach(function (i, n) {
        html += '<tr><td>' + markerHtml([i]) + '</td><td class="param-name"><button class="link-btn" data-goto-issue="' + n + '">' +
            esc(i.where) + '</button></td><td>' + esc(i.message) + '</td><td class="actions">' +
            (i.fix ? '<button class="btn btn-small" data-fix="' + n + '">Use ' + esc(i.fix) + '</button>' : '') + '</td></tr>';
    });
    $('checks').innerHTML = html + '</tbody></table></div>';
}

function applyFix(issue) {
    var rec = rowRecord(issue.ref);
    if (!rec) return;
    if (issue.ref.kind === 'pin') rec.remote = issue.fix; else rec.end = issue.fix;
    showError('');
    setDirty(true);
    runChecks();
    renderAll();
}

function rowRecord(ref) {
    if (!ref) return null;
    var block = ref.kind === 'pin' ? findConnector(ref.block) : findSplice(ref.block);
    return block ? (ref.kind === 'pin' ? block.pins : block.wires)[ref.index] : null;
}

function gotoIssue(issue) {
    if (issue.ref) { gotoRow(issue.ref.kind === 'pin' ? 'connectors' : 'splices', issue.ref.block, issue.ref.index); return; }
    gotoEndpoint(issue.where);
}

// =========================================================================
// Navigation
// =========================================================================

function findConnector(id) {
    return state.model.connectors.filter(function (c) { return c.id === id; })[0] || null;
}

function findSplice(id) {
    return state.model.splices.filter(function (s) { return s.id === id; })[0] || null;
}

function gotoRow(tab, blockId, index) {
    if (tab === 'connectors') state.selConnector = blockId; else state.selSplice = blockId;
    selectTab(tab);
    if (tab === 'connectors') { renderConnectorList(); renderConnectorEditor(); } else { renderSpliceList(); renderSpliceEditor(); }
    if (index === null || index === undefined) return;
    var row = document.querySelector('#' + (tab === 'connectors' ? 'connector' : 'splice') + '-editor tr[data-row="' + index + '"]');
    if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('flash');
        setTimeout(function () { row.classList.remove('flash'); }, 1600);
    }
}

/** Jump to whatever a remote reference points at. */
/** Jump to whatever a reference points at. Returns false when it points at nothing in this harness. */
function gotoEndpoint(text) {
    var r = harnessResolve(harnessIndex(state.model), text);
    if (r.kind === 'pin' && r.pin) gotoRow('connectors', r.connector.id, r.connector.pins.indexOf(r.pin));
    else if (r.kind === 'splice') gotoRow('splices', r.splice.id, null);
    else if (findConnector(text)) gotoRow('connectors', text, null);
    else if (findSplice(text)) gotoRow('splices', text, null);
    else return false;
    return true;
}

/** Show (or toggle) the problem details under an editor row. */
function showRowIssues(kind, blockId, index, toggle) {
    var key = issueKey(kind, blockId, index);
    if (toggle && state.openIssues[key]) delete state.openIssues[key]; else state.openIssues[key] = true;
    refreshRowMarkers();
    document.querySelectorAll('[data-marker]').forEach(function (cell) {
        if (cell.getAttribute('data-marker') !== key) return;
        var marker = cell.querySelector('.marker');
        if (marker) marker.focus();
        cell.parentNode.scrollIntoView({ block: 'nearest' });
    });
}

// =========================================================================
// Connector and splice lists
// =========================================================================

function badgeHtml(id) {
    var b = state.issuesByBlock[id];
    if (!b) return '';
    return b.error ? '<span class="badge badge-error">' + b.error + '</span>' : b.warning ? '<span class="badge badge-warning">' + b.warning + '</span>' : '';
}

/** One heading per sheet, however the blocks are ordered (`kind` = 'connectors' | 'splices' of harnessSheetGroups). */
function renderBlockList(listId, kind, selected, filter, countOf, attr) {
    var f = filter.trim().toLowerCase(), html = '';
    harnessSheetGroups(state.model).forEach(function (sheet) {
        var items = sheet[kind].filter(function (b) {
            return !f || (b.id + ' ' + (b.title || '') + ' ' + (b.connector || b.type || '') + ' ' + (b.notes || '')).toLowerCase().indexOf(f) >= 0;
        });
        if (!items.length) return;
        html += '<li class="sheet-name">' + esc(sheet.name) + '</li>';
        items.forEach(function (b) {
            html += '<li><button class="block-btn' + (b.id === selected ? ' selected' : '') + '" ' + attr + '="' + esc(b.id) + '">' +
                '<span class="block-id">' + esc(b.id) + '</span><span class="block-meta">' + countOf(b) + '</span>' + badgeHtml(b.id) + '</button></li>';
        });
    });
    $(listId).innerHTML = html || '<li class="muted">None</li>';
}

function renderConnectorList() {
    renderBlockList('connector-list', 'connectors', state.selConnector, $('connector-filter').value,
        function (c) { return c.pins.length; }, 'data-connector');
}

function renderSpliceList() {
    renderBlockList('splice-list', 'splices', state.selSplice, $('splice-filter').value,
        function (s) { return s.wires.length; }, 'data-splice');
}

// =========================================================================
// Block editors
// =========================================================================

var CONNECTOR_FIELDS = [['id', 'Name (used in connections)'], ['title', 'Title'], ['sheet', 'Sheet'], ['connector', 'Connector'],
    ['boot', 'Boot'], ['mateConn', 'Mate connector'], ['matePin', 'Mate pin'], ['notes', 'Notes']];
var SPLICE_FIELDS = [['id', 'Name (used in connections)'], ['sheet', 'Sheet'], ['type', 'Splice type'], ['boot', 'Boot'], ['notes', 'Notes']];

function fieldsHtml(block, fields) {
    var listId = block.pins ? 'connector-sheets' : 'splice-sheets';   // existing sheet names to pick from
    return '<div class="field-grid">' + fields.map(function (f) {
        return '<label><span>' + esc(f[1]) + '</span><input type="text" class="text-input" data-block-field="' + f[0] + '" value="' +
            esc(block[f[0]]) + '"' + (f[0] === 'sheet' ? ' list="' + listId + '"' : '') + '></label>';
    }).join('') + '</div><datalist id="' + listId + '">' + harnessSheetGroups(state.model).map(function (s) {
        return '<option value="' + esc(s.name) + '">';
    }).join('') + '</datalist>';
}

function rowsHtml(kind, block, records, fields, columns) {
    var html = '<div class="table-scroll"><table class="event-table data-table edit-table"><thead><tr><th class="mark-col"></th>' +
        fields.map(function (f, i) { return '<th>' + esc(columns[i] || f) + '</th>'; }).join('') +
        '<th><span class="sr-only">Actions</span></th></tr></thead><tbody>';
    var remoteField = kind === 'pin' ? 'remote' : 'end';
    records.forEach(function (rec, i) {
        var open = !!state.openIssues[issueKey(kind, block.id, i)];
        html += '<tr data-row="' + i + '"><td class="mark-col" data-marker="' + kind + '|' + esc(block.id) + '|' + i + '">' +
            markerHtml(rowIssues(kind, block.id, i), i, open) + '</td>';
        fields.forEach(function (f) {
            var input = '<input type="text" class="cell-input cell-' + f + '" data-row="' + i + '" data-field="' + f + '" value="' +
                esc(rec[f]) + '" aria-label="' + esc(f + ' row ' + (i + 1)) + '">';
            if (f === remoteField) {
                input = '<div class="remote-cell">' + input + '<button class="link-btn" data-goto="' + i + '" title="Go to the other end" ' +
                    'aria-label="Go to the other end of row ' + (i + 1) + '">&rarr;</button></div>';
            }
            html += '<td>' + input + '</td>';
        });
        html += '<td class="actions"><button class="btn btn-small btn-secondary" data-trace-row="' + i + '" title="Trace this circuit" ' +
            'aria-label="Trace the circuit of row ' + (i + 1) + '">&#x2933;</button> ' +
            '<button class="btn btn-small btn-danger" data-remove-row="' + i + '" aria-label="Remove row ' + (i + 1) +
            '">&times;</button></td></tr>';
        if (open) html += issueDetailHtml(kind, block.id, i, fields.length + 2);
    });
    return html + '</tbody></table></div>';
}

function renderConnectorEditor() {
    var c = findConnector(state.selConnector), el = $('connector-editor');
    if (!c) {
        el.innerHTML = '<p class="muted">' + (state.model.connectors.length ? 'Select a connector.' : 'No connectors yet — add one.') + '</p>';
        return;
    }
    el.innerHTML = editorHeadHtml(c, 'connector') +
        fieldsHtml(c, CONNECTOR_FIELDS) + imagesHtml(c) + rowsHtml('pin', c, c.pins, HARNESS_PIN_FIELDS, c.columns || []) +
        '<button class="btn btn-secondary btn-small" id="add-row">Add cavity</button>';
    loadThumbnails(el);
}

function editorHeadHtml(block, what) {
    return '<div class="editor-head"><h2>' + esc(block.id) + '</h2>' +
        '<button class="btn btn-small btn-secondary" id="show-diagram">Wiring diagram</button>' +
        '<button class="btn btn-small btn-danger" id="remove-block">Delete ' + what + '</button></div>';
}

/** Pictures of a connector/splice: thumbnails (click for full size), captions, add and remove. */
function imagesHtml(block) {
    var images = block.images || [];
    return '<section class="images-section" aria-label="Images"><div class="images-head"><h3>Images</h3>' +
        '<label class="btn btn-secondary btn-small">Add image<input type="file" class="add-image" accept="image/png,image/jpeg,image/gif" hidden multiple></label>' +
        '</div><div class="image-strip">' + (images.length ? images.map(function (im, i) {
            return '<div class="image-card"><button class="thumb" data-view-image="' + i + '" aria-label="View image ' + (i + 1) +
                ' full size"><img data-image-id="' + esc(im.id) + '" alt="' + esc(im.caption || block.id + ' image ' + (i + 1)) + '"></button>' +
                '<input type="text" data-image-caption="' + i + '" value="' + esc(im.caption) + '" placeholder="Caption" aria-label="Caption for image ' + (i + 1) + '">' +
                '<button class="btn btn-small btn-danger remove-image" data-remove-image="' + i + '" aria-label="Remove image ' + (i + 1) + '">&times;</button></div>';
        }).join('') : '<p class="muted">No images. Add a connector face or pinout drawing.</p>') + '</div></section>';
}

function loadThumbnails(root) {
    root.querySelectorAll('img[data-image-id]').forEach(function (img) {
        hsImageUrl(img.getAttribute('data-image-id')).then(function (url) { img.src = url; },
            function () { img.alt = 'Image not found'; });
    });
}

function viewImage(im, fallbackCaption) {
    hsImageUrl(im.id).then(function (url) {
        $('image-viewer-img').src = url;
        $('image-viewer-img').alt = im.caption || fallbackCaption;
        $('image-viewer-caption').textContent = im.caption || fallbackCaption;
        $('image-viewer').showModal();
    }).catch(function (err) { showError('Could not show the image: ' + err.message); });
}

/** Store picked files as images of a block. */
function addImages(block, files) {
    var list = Array.prototype.slice.call(files || []);
    return list.reduce(function (p, file) {
        return p.then(function () {
            if (!/^image\/(png|jpeg|gif)$/.test(file.type)) throw new Error(file.name + ' is not a PNG, JPEG or GIF image.');
            return Promise.all([hsPutImage(file, file.type), imageSize(file)]).then(function (r) {
                (block.images = block.images || []).push({ id: r[0], mime: file.type, w: r[1].w, h: r[1].h, caption: '' });
            });
        });
    }, Promise.resolve()).then(function () {
        setDirty(true);
        renderAll();
    }).catch(function (err) { showError('Could not add the image: ' + err.message); renderAll(); });
}

function imageSize(file) {
    return new Promise(function (resolve) {
        var img = new Image(), url = URL.createObjectURL(file);
        img.onload = function () { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
        img.onerror = function () { resolve({ w: 300, h: 300 }); URL.revokeObjectURL(url); };
        img.src = url;
    });
}

function renderSpliceEditor() {
    var s = findSplice(state.selSplice), el = $('splice-editor');
    if (!s) {
        el.innerHTML = '<p class="muted">' + (state.model.splices.length ? 'Select a splice.' : 'No splices yet — add one.') + '</p>';
        return;
    }
    el.innerHTML = editorHeadHtml(s, 'splice') +
        fieldsHtml(s, SPLICE_FIELDS) + imagesHtml(s) + rowsHtml('wire', s, s.wires, HARNESS_WIRE_FIELDS, s.columns || []) +
        '<button class="btn btn-secondary btn-small" id="add-row">Add wire</button>';
    loadThumbnails(el);
}

/** References to a connector ("ID.cavity") or splice ("ID") across the harness. */
function forEachReference(fn) {
    state.model.connectors.forEach(function (c) { c.pins.forEach(function (p) { fn(p, 'remote'); }); });
    state.model.splices.forEach(function (s) { s.wires.forEach(function (w) { fn(w, 'end'); }); });
}

function renameBlock(block, isConnector, newId, input) {
    var oldId = block.id;
    newId = newId.trim();
    if (newId === oldId) return;
    var clash = state.model.connectors.concat(state.model.splices).some(function (b) {
        return b !== block && b.id.toLowerCase() === newId.toLowerCase();
    });
    if (!newId || clash) {
        showError(newId ? '"' + newId + '" is already used by another connector or splice.' : 'The name cannot be empty.');
        input.value = oldId;
        return;
    }
    var refs = [];
    forEachReference(function (rec, f) {
        var v = String(rec[f] || '').trim();
        if (isConnector ? v.indexOf(oldId + '.') === 0 : v === oldId) refs.push([rec, f, v]);
    });
    if (refs.length && window.confirm('Update ' + refs.length + ' connection' + (refs.length === 1 ? '' : 's') + ' that refer to ' +
            oldId + ' so they use ' + newId + '?')) {
        refs.forEach(function (r) { r[0][r[1]] = isConnector ? newId + r[2].slice(oldId.length) : newId; });
    }
    block.id = newId;
    if (isConnector) state.selConnector = newId; else state.selSplice = newId;
    showError('');
    setDirty(true);
    runChecks();
    renderAll();
}

function wireEditor(containerId, isConnector) {
    var el = $(containerId);
    function current() { return isConnector ? findConnector(state.selConnector) : findSplice(state.selSplice); }
    el.addEventListener('input', function (e) {
        var t = e.target, block = current();
        if (!block) return;
        if (t.hasAttribute('data-field')) {
            var recs = isConnector ? block.pins : block.wires;
            recs[parseInt(t.getAttribute('data-row'), 10)][t.getAttribute('data-field')] = t.value;
            setDirty(true);
            scheduleChecks();
        } else if (t.hasAttribute('data-image-caption')) {
            block.images[parseInt(t.getAttribute('data-image-caption'), 10)].caption = t.value;
            setDirty(true);
        } else if (t.hasAttribute('data-block-field') && t.getAttribute('data-block-field') !== 'id') {
            block[t.getAttribute('data-block-field')] = t.value;
            setDirty(true);
            if (t.getAttribute('data-block-field') === 'sheet' || t.getAttribute('data-block-field') === 'title') {
                isConnector ? renderConnectorList() : renderSpliceList();
            }
        }
    });
    el.addEventListener('change', function (e) {
        var t = e.target, block = current();
        if (block && t.getAttribute('data-block-field') === 'id') renameBlock(block, isConnector, t.value, t);
        if (block && t.getAttribute('data-block-field') === 'sheet') {
            // Spell the sheet like the existing sheet it matches (case, spaces), so it joins that sheet.
            var others = Object.assign({}, state.model, { connectors: state.model.connectors.filter(function (b) { return b !== block; }),
                splices: state.model.splices.filter(function (b) { return b !== block; }) });
            var name = harnessText(t.value).replace(/\s+/g, ' ');
            var same = harnessSheetGroups(others).filter(function (s) { return s.name.toLowerCase() === name.toLowerCase(); })[0];
            block.sheet = t.value = same ? same.name : name;
            isConnector ? renderConnectorList() : renderSpliceList();
        }
        if (block && t.classList.contains('add-image')) addImages(block, t.files);
    });
    el.addEventListener('click', function (e) {
        var block = current(), t = e.target.closest('button');
        if (!block || !t) return;
        var recs = isConnector ? block.pins : block.wires;
        var kind = isConnector ? 'pin' : 'wire';
        if (t.hasAttribute('data-view-image')) {
            viewImage(block.images[parseInt(t.getAttribute('data-view-image'), 10)], block.id);
            return;
        }
        if (t.hasAttribute('data-remove-image')) {
            var ii = parseInt(t.getAttribute('data-remove-image'), 10);
            if (!window.confirm('Remove image ' + (ii + 1) + ' from ' + block.id + '?')) return;
            block.images.splice(ii, 1);
            setDirty(true); renderAll();
            return;
        }
        if (t.id === 'show-diagram') { showDiagram(block.id); return; }
        if (t.hasAttribute('data-trace-row')) {
            var tr = recs[parseInt(t.getAttribute('data-trace-row'), 10)];
            showDiagram('trace:' + currentKey() + '|' + (isConnector ? block.id + '.' + tr.cavity : block.id));
            return;
        }
        if (t.hasAttribute('data-goto')) {
            var gi = parseInt(t.getAttribute('data-goto'), 10), rec = recs[gi], where = isConnector ? rec.remote : rec.end;
            if (gotoEndpoint(where)) return;
            // Nothing to jump to: explain why on the row itself.
            if (rowIssues(kind, block.id, gi).length) showRowIssues(kind, block.id, gi, false);
            else showError(String(where || '').trim() ? '"' + where + '" is not a connector pin or splice in this harness.'
                                                      : 'This row has no ' + (isConnector ? 'remote connection' : 'location') + '.');
        } else if (t.hasAttribute('data-show-issues')) {
            showRowIssues(kind, block.id, parseInt(t.getAttribute('data-show-issues'), 10), true);
        } else if (t.hasAttribute('data-row-fix')) {
            var fp = t.getAttribute('data-row-fix').split('|');
            applyFix(rowIssues(kind, block.id, parseInt(fp[0], 10))[parseInt(fp[1], 10)]);
        } else if (t.hasAttribute('data-goto-target')) {
            gotoEndpoint(t.getAttribute('data-goto-target'));
        } else if (t.hasAttribute('data-remove-row')) {
            var ri = parseInt(t.getAttribute('data-remove-row'), 10), r = recs[ri];
            var what = isConnector
                ? 'cavity ' + (r.cavity || '(no location)') + (r.function ? ' (' + r.function + ')' : '') + ' from ' + block.id
                : 'wire ' + (r.end || '(no location)') + (r.function ? ' (' + r.function + ')' : '') + ' from splice ' + block.id;
            if (!window.confirm('Remove ' + what + '?')) return;
            recs.splice(ri, 1);
            state.openIssues = {};
            setDirty(true); runChecks(); renderAll();
        } else if (t.id === 'add-row') {
            var blank = {};
            (isConnector ? HARNESS_PIN_FIELDS : HARNESS_WIRE_FIELDS).forEach(function (f) { blank[f] = ''; });
            if (isConnector) {
                var nums = recs.map(function (p) { return parseInt(p.cavity, 10); }).filter(function (n) { return !isNaN(n); });
                if (nums.length === recs.length && nums.length) blank.cavity = String(Math.max.apply(null, nums) + 1);
            }
            recs.push(blank);
            setDirty(true); runChecks(); renderAll();
            var inputs = el.querySelectorAll('tr[data-row="' + (recs.length - 1) + '"] input');
            if (inputs.length) inputs[isConnector && blank.cavity ? 1 : 0].focus();
        } else if (t.id === 'remove-block') {
            if (!window.confirm('Delete ' + block.id + ' and its ' + recs.length + ' row' + (recs.length === 1 ? '' : 's') + '?')) return;
            var list = isConnector ? state.model.connectors : state.model.splices, i = list.indexOf(block);
            list.splice(i, 1);
            var next = list[Math.min(i, list.length - 1)];
            if (isConnector) state.selConnector = next ? next.id : null; else state.selSplice = next ? next.id : null;
            setDirty(true); runChecks(); renderAll();
        }
    });
}

function addBlock(isConnector) {
    var id = window.prompt(isConnector ? 'Connector name, as used in connections (e.g. ECPT, X160, M142.A):'
                                       : 'Splice name, as used in connections (e.g. M142.SPL.5VA):', '');
    if (id === null) return;
    id = id.trim();
    if (!id) return;
    if (state.model.connectors.concat(state.model.splices).some(function (b) { return b.id.toLowerCase() === id.toLowerCase(); })) {
        showError('"' + id + '" is already used by another connector or splice.');
        return;
    }
    var kind = isConnector ? 'connectors' : 'splices';
    var sheetDef = state.model.sheets.filter(function (s) { return s.kind === kind; })[0];
    var near = isConnector ? findConnector(state.selConnector) : findSplice(state.selSplice);
    var sheet = near ? near.sheet : sheetDef ? sheetDef.name : isConnector ? 'Connectors' : 'Splices';
    if (!state.model.sheets.some(function (s) { return s.name === sheet; })) state.model.sheets.push({ name: sheet, kind: kind });
    if (isConnector) {
        state.model.connectors.push({ id: id, title: id, sheet: sheet, connector: '', boot: '', mateConn: '', matePin: '', notes: '',
            columns: ['Location', 'Pin', 'Conductor Part Number', 'Conductor Description', 'Engine Function', 'Notes', 'Remote Connection', 'Status'],
            pins: [] });
        state.selConnector = id;
    } else {
        state.model.splices.push({ id: id, sheet: sheet, type: '', boot: '', notes: '',
            columns: ['Location', 'Conductor Part Number', 'Conductor Description', 'Function'], wires: [] });
        state.selSplice = id;
    }
    showError('');
    setDirty(true); runChecks(); renderAll();
}

// =========================================================================
// Diagram
// =========================================================================

function showDiagram(id) {
    state.diagram = id || '';
    selectTab('diagram');
}

function renderDiagram() {
    var sel = $('diagram-select'), opts = '<option value="">Overview — all connectors and splices</option>';
    function group(label, blocks) {
        if (!blocks.length) return '';
        return '<optgroup label="' + esc(label) + '">' + blocks.map(function (b) {
            return '<option value="' + esc(b.id) + '">' + esc(b.id) + '</option>';
        }).join('') + '</optgroup>';
    }
    var extra = '';
    if (state.system) extra += '<option value="system">System overview — ' + esc(state.system.name) + '</option>';
    if (/^trace:/.test(state.diagram)) {
        var tp = state.diagram.slice(6).split('|');
        extra += '<option value="' + esc(state.diagram) + '">Circuit from ' + esc((memberName(tp[0]) ? memberName(tp[0]) + ' · ' : '') +
            tp.slice(1).join('|')) + '</option>';
    }
    sel.innerHTML = opts + extra + group('Connectors', state.model.connectors) + group('Splices', state.model.splices);
    if (state.diagram === 'system' && !state.system) state.diagram = '';
    if (state.diagram && state.diagram !== 'system' && !/^trace:/.test(state.diagram) &&
        !findConnector(state.diagram) && !findSplice(state.diagram)) state.diagram = '';
    sel.value = state.diagram;
    if (state.diagram === 'system' || /^trace:/.test(state.diagram)) { renderSystemDiagram(); return; }
    var focus = state.diagram ? findConnector(state.diagram) || findSplice(state.diagram) : null;
    $('diagram-hint').textContent = focus
        ? 'Click a pin to edit it, or a connector or splice header to show its diagram.'
        : 'Hover a box to highlight its wires; click it to show its wiring diagram.';
    var images = focus ? (focus.images || []) : [], seq = (renderDiagram.seq = (renderDiagram.seq || 0) + 1);
    Promise.all(images.map(function (im) {
        return hsImageUrl(im.id).then(function (url) { return [im.id, url]; }, function () { return null; });
    })).then(function (pairs) {
        if (seq !== renderDiagram.seq) return;   // a newer diagram was requested while images loaded
        var urls = {};
        pairs.forEach(function (p) { if (p) urls[p[0]] = p[1]; });
        var hardware = state.tunePkg && state.tunePkg.meta ? state.tunePkg.meta['Summary.Hardware'] : '';
        var d = focus ? harnessBlockDiagram(state.model, focus.id, { imageUrls: urls })
                      : harnessOverviewDiagram(state.model, { hardware: hardware || undefined });
        $('diagram').innerHTML = d.svg;
    });
}

/** System overview or circuit trace in the Diagram tab. */
function renderSystemDiagram() {
    var members = systemMembers(), d;
    renderDiagram.seq = (renderDiagram.seq || 0) + 1;
    if (state.diagram === 'system') {
        $('diagram-hint').textContent = 'Each box is a harness with its mated connectors. Click a harness to open it.';
        d = harnessSystemDiagram(members, systemMates().mates);
    } else {
        var trace = harnessTrace(harnessSystemGraph(members, systemMates().mates), state.diagram.slice(6));
        if (!trace) { $('diagram').innerHTML = '<p style="padding:12px;color:#444">That endpoint no longer exists.</p>'; return; }
        var harnesses = {};
        trace.nodes.forEach(function (n) { harnesses[n.harness] = true; });
        var hn = Object.keys(harnesses).length;
        $('diagram-hint').textContent = trace.nodes.length + ' endpoints in ' + hn + ' harness' + (hn === 1 ? '' : 'es') +
            '. Click an endpoint to edit it.';
        d = harnessTraceDiagram(trace);
    }
    $('diagram').innerHTML = d.svg;
}

/** Download the diagram as a standalone SVG, with pictures embedded. */
function downloadDiagram() {
    var svg = $('diagram').querySelector('svg');
    if (!svg) return;
    var copy = svg.cloneNode(true);
    copy.classList.remove('dimmed');
    copy.querySelectorAll('.hl').forEach(function (e) { e.classList.remove('hl'); });
    var images = Array.prototype.slice.call(copy.querySelectorAll('image'));
    Promise.all(images.map(function (img) {
        var href = img.getAttribute('href');
        return fetch(href).then(function (r) { return r.blob(); }).then(function (blob) {
            return new Promise(function (resolve) {
                var fr = new FileReader();
                fr.onload = function () { img.setAttribute('href', fr.result); img.setAttribute('xlink:href', fr.result); resolve(); };
                fr.onerror = function () { resolve(); };
                fr.readAsDataURL(blob);
            });
        }, function () { /* leave the link */ });
    })).then(function () {
        var blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (($('name-input').value.trim() || 'harness') + ' - ' + (state.diagram || 'overview')).replace(/[\\/:*?"<>|]+/g, '_') + '.svg';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
}

/** Overview: highlight the hovered box and its bundles. */
function highlightNode(id) {
    var svg = $('diagram').querySelector('svg');
    if (!svg || state.diagram) return;
    svg.classList.toggle('dimmed', !!id);
    svg.querySelectorAll('.hl').forEach(function (e) { e.classList.remove('hl'); });
    if (!id) return;
    svg.querySelectorAll('.node').forEach(function (n) { if (n.getAttribute('data-node') === id) n.classList.add('hl'); });
    svg.querySelectorAll('.edge').forEach(function (e) {
        var a = e.getAttribute('data-a'), b = e.getAttribute('data-b');
        if (a !== id && b !== id) return;
        e.classList.add('hl');
        var other = a === id ? b : a;
        svg.querySelectorAll('.node').forEach(function (n) { if (n.getAttribute('data-node') === other) n.classList.add('hl'); });
    });
}

// =========================================================================
// Systems
// =========================================================================

/** Key of the open harness inside system graphs. */
function currentKey() { return state.id || 'unsaved'; }

function memberName(id) {
    if (id === currentKey()) return $('name-input').value.trim() || state.name;
    var m = state.sysMembers.filter(function (x) { return x.id === id; })[0];
    return m ? m.name : '';
}

/** Harnesses of the system, with the open one's live (possibly unsaved) model; just this harness otherwise. */
function systemMembers() {
    var me = { id: currentKey(), name: $('name-input').value.trim() || state.name, model: state.model };
    if (!state.system) return [me];
    return state.system.harnesses.map(function (id) {
        if (id === state.id) return me;
        return state.sysMembers.filter(function (m) { return m.id === id; })[0] || null;
    }).filter(Boolean);
}

function systemMates() {
    return harnessMates(systemMembers(), state.system || {});
}

/** Find this harness's system and load the other members' latest revisions. */
function loadSystemContext() {
    return hsListSystems().then(function (list) {
        state.systems = list;
        state.system = state.id ? list.filter(function (s) { return s.harnesses.indexOf(state.id) >= 0; })[0] || null : null;
        var others = state.system ? state.system.harnesses.filter(function (id) { return id !== state.id; }) : [];
        return Promise.all(others.map(function (id) {
            return hsLoad(id).then(function (h) { return { id: h.id, name: h.name, model: h.data, revision: h.revision }; },
                function () { return null; });
        }));
    }).then(function (members) {
        state.sysMembers = members.filter(Boolean);
        renderSystemSelect();
        if (state.tab === 'system') renderSystem();
        if (state.tab === 'diagram') renderDiagram();
        if (state.tab === 'tune') renderTune();
    }).catch(function (err) { showError('Could not load harness systems: ' + err.message); });
}

function renderSystemSelect() {
    var sel = $('system-select');
    sel.innerHTML = '<option value="">None</option>' + state.systems.map(function (s) {
        return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
    }).join('') + '<option value="__new">New system…</option>';
    sel.value = state.system ? state.system.id : '';
    $('tune-scope').hidden = !state.system;
    var joins = state.system ? systemMates().mates.length : 0;
    $('count-system').textContent = state.system ? state.system.harnesses.length + ' harnesses' + (joins ? ', ' + joins + ' joins' : '') : '';
}

function saveSystem(system) {
    return hsSaveSystem(system.id || null, system).then(function (saved) {
        return loadSystemContext().then(function () { return saved; });
    }).catch(function (err) { showError('Could not save the system: ' + err.message); });
}

/** Move the open harness into another system (or none). */
function changeSystem(value) {
    if (!state.id) {
        showError('Save the harness before adding it to a system.');
        renderSystemSelect();
        return;
    }
    var current = state.system, chain = Promise.resolve();
    if (value === '__new') {
        var name = window.prompt('Name for the new system (e.g. the car):', state.name + ' system');
        if (name === null || !name.trim()) { renderSystemSelect(); return; }
        chain = hsSaveSystem(null, { name: name.trim(), harnesses: [] }).then(function (s) { value = s.id; state.systems.push(s); });
    }
    chain.then(function () {
        if (current && current.id === value) return null;
        var steps = [];
        if (current) {
            current.harnesses = current.harnesses.filter(function (h) { return h !== state.id; });
            steps.push(hsSaveSystem(current.id, current));
        }
        var target = state.systems.filter(function (s) { return s.id === value; })[0];
        if (target && target.harnesses.indexOf(state.id) < 0) {
            target.harnesses.push(state.id);
            steps.push(hsSaveSystem(target.id, target));
        }
        return Promise.all(steps);
    }).then(loadSystemContext).catch(function (err) { showError('Could not change the system: ' + err.message); });
}

function endHtml(end) {
    var mem = systemMembers().filter(function (m) { return m.id === end.harness; })[0];
    var conn = mem ? mem.model.connectors.filter(function (k) { return k.id === end.connector; })[0] : null;
    return '<td>' + esc(memberName(end.harness)) + '</td><td class="param-name">' + esc(end.connector) + '</td><td class="hint">' +
        esc(conn ? conn.connector || '' : '') + '</td>';
}

function renderSystem() {
    var el = $('system');
    if (!state.system) {
        el.innerHTML = '<p class="muted">This harness is not part of a system. Choose one in the <strong>System</strong> list above ' +
            '(or <strong>New system…</strong>) to join it to the harnesses it plugs into.</p>' +
            (state.id ? '' : '<p class="muted">Save the harness first.</p>');
        return;
    }
    var members = systemMembers(), m = systemMates(), checks = harnessSystemChecks(members, m.mates);
    var html = '<section class="system-section"><h3>Harnesses in ' + esc(state.system.name) + '</h3>' +
        '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Harness</th><th>Connectors</th><th>Splices</th>' +
        '<th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        members.map(function (x) {
            var me = x.id === currentKey();
            return '<tr' + (me ? ' class="current-harness"' : '') + '><td>' + esc(x.name) + (me ? ' (open)' : '') + '</td><td>' +
                x.model.connectors.length + '</td><td>' + x.model.splices.length + '</td><td class="actions">' +
                (me ? '' : '<button class="btn btn-small btn-secondary" data-open-harness="' + esc(x.id) + '">Open</button> ') +
                '<button class="btn btn-small btn-danger" data-remove-member="' + esc(x.id) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div><div class="system-actions"><select id="add-member-select" aria-label="Harness to add"></select>' +
        '<button class="btn btn-small btn-secondary" id="add-member-btn">Add to system</button><span class="spacer"></span>' +
        '<button class="btn btn-small btn-secondary" id="rename-system-btn">Rename system</button>' +
        '<button class="btn btn-small btn-danger" id="delete-system-btn">Delete system</button></div></section>';

    html += '<section class="system-section"><h3>Mated connectors</h3>' + (m.mates.length
        ? '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Harness</th><th>Connector</th><th>Part</th><th></th>' +
          '<th>Harness</th><th>Connector</th><th>Part</th><th>Joined</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
          m.mates.map(function (l, i) {
              var tag = l.parts === 'conflict' ? '<span class="tag tag-bad">parts don\'t mate</span>' :
                  l.source === 'manual' ? '<span class="tag tag-manual">manual</span>' : '<span class="tag tag-auto">automatic</span>';
              return '<tr>' + endHtml(l.a) + '<td class="mate-sign">⇄</td>' + endHtml(l.b) + '<td>' + tag + '</td>' +
                  '<td class="actions"><button class="btn btn-small btn-danger" data-unlink="' + i + '">Unlink</button></td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="muted">No connectors are joined yet. Connectors join automatically when they have the same name and mating part numbers, or link them below.</p>');
    if (m.suggestions.length) {
        html += '<p class="hint">Same name, not joined:</p><ul class="plain-list">' + m.suggestions.map(function (l, i) {
            return '<li>' + esc(memberName(l.a.harness) + ' ' + l.a.connector + ' ⇄ ' + memberName(l.b.harness) + ' ' + l.b.connector) +
                ' — ' + (l.source === 'rejected' ? 'unlinked by you' : 'part numbers don\'t mate') +
                ' <button class="btn btn-small btn-secondary" data-relink="' + i + '">Link</button></li>';
        }).join('') + '</ul>';
    }
    var options = [];
    members.forEach(function (x) {
        x.model.connectors.forEach(function (c) {
            options.push('<option value="' + esc(JSON.stringify([x.id, c.id])) + '">' + esc(x.name + ' — ' + c.id) + '</option>');
        });
    });
    html += '<div class="system-actions"><span class="hint">Link manually:</span><select id="link-a" aria-label="First connector">' + options.join('') +
        '</select><span class="mate-sign">⇄</span><select id="link-b" aria-label="Second connector">' + options.join('') +
        '</select><button class="btn btn-small btn-secondary" id="link-btn">Link</button></div></section>';

    html += '<section class="system-section"><h3>Checks across joins</h3>' + (checks.length
        ? '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th></th><th>Where</th><th>Problem</th></tr></thead><tbody>' +
          checks.map(function (c) {
              return '<tr><td>' + markerHtml([c]) + '</td><td class="param-name"><button class="link-btn" data-goto-sys="' +
                  esc(c.harness + '|' + c.where) + '">' + esc(memberName(c.harness) + ' · ' + c.where) + '</button></td><td>' + esc(c.message) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : (m.mates.length ? '<p class="ok-banner">Every joined cavity matches on both sides.</p>' : '')) + '</section>';
    el.innerHTML = html;

    hsList().then(function (list) {
        var sel = $('add-member-select');
        if (!sel || !state.system) return;
        var avail = list.filter(function (h) { return state.system.harnesses.indexOf(h.id) < 0; });
        sel.innerHTML = avail.length ? avail.map(function (h) { return '<option value="' + esc(h.id) + '">' + esc(h.name) + '</option>'; }).join('')
            : '<option value="">No other saved harnesses</option>';
        $('add-member-btn').disabled = !avail.length;
    });
}

/** Go to an endpoint anywhere in the system ("harnessId|ENDPOINT"), opening that harness if needed. */
function gotoSystemEndpoint(key) {
    var i = key.indexOf('|'), hid = key.slice(0, i), ep = key.slice(i + 1);
    if (ep.charAt(0) === '?') return;
    function go() { if (findSplice(ep)) gotoRow('splices', ep, null); else gotoEndpoint(ep); }
    if (hid === currentKey()) { go(); return; }
    if (!confirmDiscard()) return;
    openHarness(hid).then(go);
}

$('system').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || !state.system) return;
    var sys = state.system, m = systemMates();
    if (b.hasAttribute('data-open-harness')) {
        if (confirmDiscard()) openHarness(b.getAttribute('data-open-harness'));
    } else if (b.hasAttribute('data-remove-member')) {
        var rid = b.getAttribute('data-remove-member');
        if (!window.confirm('Remove ' + memberName(rid) + ' from ' + sys.name + '? The harness itself is kept.')) return;
        sys.harnesses = sys.harnesses.filter(function (h) { return h !== rid; });
        saveSystem(sys);
    } else if (b.id === 'add-member-btn') {
        var aid = $('add-member-select').value;
        if (aid) { sys.harnesses.push(aid); saveSystem(sys); }
    } else if (b.id === 'rename-system-btn') {
        var name = window.prompt('System name:', sys.name);
        if (name && name.trim()) { sys.name = name.trim(); saveSystem(sys); }
    } else if (b.id === 'delete-system-btn') {
        if (!window.confirm('Delete the system "' + sys.name + '"? Its harnesses are kept.')) return;
        hsDeleteSystem(sys.id).then(loadSystemContext);
    } else if (b.hasAttribute('data-unlink')) {
        var l = m.mates[parseInt(b.getAttribute('data-unlink'), 10)], key = hsysLinkKey(l);
        sys.manual = (sys.manual || []).filter(function (x) { return hsysLinkKey(x) !== key; });
        if (l.source === 'auto') (sys.rejected = sys.rejected || []).push({ a: l.a, b: l.b });
        saveSystem(sys);
    } else if (b.hasAttribute('data-relink')) {
        var sg = m.suggestions[parseInt(b.getAttribute('data-relink'), 10)], k2 = hsysLinkKey(sg);
        sys.rejected = (sys.rejected || []).filter(function (x) { return hsysLinkKey(x) !== k2; });
        if (sg.parts === 'conflict') (sys.manual = sys.manual || []).push({ a: sg.a, b: sg.b });
        saveSystem(sys);
    } else if (b.id === 'link-btn') {
        var a = JSON.parse($('link-a').value), c = JSON.parse($('link-b').value);
        if (a[0] === c[0]) { showError('Pick connectors in two different harnesses.'); return; }
        var link = { a: { harness: a[0], connector: a[1] }, b: { harness: c[0], connector: c[1] } };
        sys.rejected = (sys.rejected || []).filter(function (x) { return hsysLinkKey(x) !== hsysLinkKey(link); });
        (sys.manual = sys.manual || []).push(link);
        showError('');
        saveSystem(sys);
    } else if (b.hasAttribute('data-goto-sys')) {
        gotoSystemEndpoint(b.getAttribute('data-goto-sys'));
    }
});

$('system-select').addEventListener('change', function () { changeSystem(this.value); });
$('tune-scope').addEventListener('change', function () { state.tuneScope = this.value; renderTune(); });

// =========================================================================
// Tune comparison
// =========================================================================

var STATUS_LABELS = { ok: 'OK', check: 'Check', missing: 'No wire', 'not-in-tune': 'Not matched', 'no-connector': 'Not in harness' };
/** Problems view order: things to fix first, then pins that could not be matched. */
var STATUS_ORDER = { missing: 0, check: 1, 'not-in-tune': 2, 'no-connector': 3, ok: 4 };

function loadTunes() {
    return Promise.all([hsTunes(), hsResourceNames()]).then(function (r) {
        state.tunes = r[0].slice().sort(function (a, b) { return (b.modified || '').localeCompare(a.modified || ''); });
        state.resourceNames = r[1] || {};
        var sel = $('tune-select');
        sel.innerHTML = state.tunes.length ? state.tunes.map(function (t) {
            return '<option value="' + esc(t.id) + '">' + esc(t.tuneName || t.fileName) + '</option>';
        }).join('') : '<option value="">No tunes — import one in the M1 Config Viewer</option>';
        if (state.tuneId && state.tunes.some(function (t) { return t.id === state.tuneId; })) sel.value = state.tuneId;
        else state.tuneId = state.tunes.length ? state.tunes[0].id : '';
        sel.disabled = !state.tunes.length;
        return loadTune(state.tuneId);
    }).catch(function (err) { showError('Could not load tunes: ' + err.message); });
}

function loadTune(id) {
    state.tuneId = id;
    if (!id) { state.tunePkg = null; renderTune(); return Promise.resolve(); }
    if (state.tunePkg && state.tunePkg.id === id) { renderTune(); return Promise.resolve(); }
    $('tune-result').innerHTML = '<p class="muted">Loading tune…</p>';
    return hsTune(id).then(function (pkg) { state.tunePkg = pkg; renderTune(); })
        .catch(function (err) { showError('Could not load the tune: ' + err.message); });
}

function renderTune() { $('tune-result').innerHTML = tuneCompareHtml(state.show); }

/** The tune comparison of state.tunePkg; show = 'problems' or 'all'. */
function tuneCompareHtml(show) {
    var pkg = state.tunePkg;
    if (!pkg) {
        return '<p class="muted">Import a tune (.m1pkg) in the <a href="../m1-config/index.html">M1 Config Viewer</a> to compare it with this harness.</p>';
    }
    var hardware = (pkg.meta && pkg.meta['Summary.Hardware']) || '';
    if (!M1C_PINOUTS[hardware]) {
        return '<p class="muted">No pinout is known for ' + esc(hardware || 'this ECU') + ', so its pins cannot be compared.</p>';
    }
    var useSystem = !!state.system && state.tuneScope === 'system';
    var r = harnessTuneCompare(useSystem ? systemMembers() : state.model, pkg, hardware, state.resourceNames), s = r.summary;
    var html = '<div class="summary-grid tune-summary">' +
        [['ok', 'Match'], ['check', 'Check'], ['missing', 'No wire'], ['not-in-tune', 'Not matched'], ['no-connector', 'Not in harness']]
            .map(function (k) {
                return '<div class="summary-stat status-' + k[0] + '"><span class="stat-value">' + s[k[0]] + '</span><span class="stat-label">' +
                    k[1] + '</span></div>';
            }).join('') + '</div>';
    var rows = r.rows.filter(function (x) { return show === 'all' || x.status !== 'ok'; });
    if (show !== 'all') {
        rows.sort(function (a, b) { return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]; });   // stable: pin order within a status
    }
    html += '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Pin</th>' + (useSystem ? '<th>Harness</th>' : '') +
        '<th>Tune uses it for</th>' +
        '<th>Resource</th><th>Harness function</th><th>Harness label</th><th>Status</th></tr></thead><tbody>';
    rows.forEach(function (x) {
        var hasConn = !!findConnector(x.connectorId);
        html += '<tr class="status-row-' + x.status + '"><td class="param-pin">' +
            (hasConn ? '<button class="link-btn" data-goto-pin="' + esc(x.connectorId + '.' + x.cavity) + '">' + esc(x.pin) + '</button>' : esc(x.pin)) +
            '</td>' + (useSystem ? '<td>' + esc(x.harnessName || '—') + '</td>' : '') + '<td class="param-name">' + esc(x.tune.join(', ') || '—') + '</td><td>' + esc(x.resource || '—') + '</td><td>' +
            esc(x.harness ? x.harness.function : '—') + '</td><td>' + esc(x.harness ? x.harness.note : '') + '</td>' +
            '<td class="status-cell status-' + x.status + '" title="' + esc(x.note || '') + '">' + esc(STATUS_LABELS[x.status]) +
            (x.note ? '<span class="status-note">' + esc(x.note) + '</span>' : '') + '</td></tr>';
    });
    html += '</tbody></table></div>';
    if (!rows.length) html = html.replace(/<div class="table-scroll">[\s\S]*$/, '<p class="ok-banner">Every pin the tune uses matches the harness.</p>');

    if (r.labelIssues.length) {
        html += '<h3 class="sub-head">Harness labels that don\'t match the ' + esc(hardware) + ' pinout</h3><ul class="plain-list">' +
            r.labelIssues.map(function (l) {
                return '<li><button class="link-btn" data-goto-pin="' + esc(l.where) + '">' + esc(l.where) + '</button> is labelled "' +
                    esc(l.label) + '"</li>';
            }).join('') + '</ul>';
    }
    if (r.unnamed.length) {
        html += '<h3 class="sub-head">Tune assignments without a known pin (' + r.unnamed.length + ')</h3>' +
            '<p class="panel-desc">These I/O resources are not named yet, so their pins can\'t be placed. Name them with the ' +
            '<strong>Name</strong> button in the <a href="../m1-config/index.html">M1 Config Viewer</a> (as M1 Tune shows them, e.g. ' +
            '"UDIG2") and they will be compared here. Many of the "Not matched" pins above are probably these.</p>' +
            '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Resource IDs</th><th>Used for</th></tr></thead><tbody>' +
            r.unnamed.map(function (u) {
                return '<tr><td class="param-pin">' + esc(u.ids) + '</td><td class="param-name">' + esc(u.tune.join(', ')) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
    }
    return html;
}

// =========================================================================
// Export PDF: a printable report of the harness (lib/print-report.js)
// =========================================================================

var PDF_OPTIONS_KEY = 'harnessPdfOptions';
var PDF_PARTS = [['overview', 'Overview diagram'], ['system', 'System overview diagram'], ['checks', 'Checks'],
    ['connectors', 'Connector pin tables'], ['connectorDiagrams', 'A wiring diagram for each connector'],
    ['splices', 'Splice tables'], ['spliceDiagrams', 'A wiring diagram for each splice'], ['pictures', 'Pictures'],
    ['tune', 'Tune comparison (all pins)']];

function pdfSavedOptions() {
    try { return JSON.parse(localStorage.getItem(PDF_OPTIONS_KEY) || 'null'); } catch (e) { return null; }
}

/** Why a report part can't be included, or '' when it can. */
function pdfPartUnavailable(id) {
    if (id === 'system' && !state.system) return 'this harness is not in a system';
    if ((id === 'connectors' || id === 'connectorDiagrams') && !state.model.connectors.length) return 'no connectors';
    if ((id === 'splices' || id === 'spliceDiagrams') && !state.model.splices.length) return 'no splices';
    if (id === 'pictures' && !state.model.connectors.concat(state.model.splices).some(function (b) { return (b.images || []).length; })) return 'no pictures';
    if (id === 'tune' && !state.tunePkg) return 'choose a tune on the Tune comparison tab first';
    return '';
}

function openPdfDialog() {
    var saved = pdfSavedOptions() || { parts: ['overview', 'checks', 'connectors', 'splices'] };
    $('pdf-parts').innerHTML = PDF_PARTS.map(function (p) {
        var why = pdfPartUnavailable(p[0]);
        return '<label' + (why ? ' class="disabled"' : '') + '><input type="checkbox" value="' + p[0] + '"' +
            (!why && saved.parts.indexOf(p[0]) >= 0 ? ' checked' : '') + (why ? ' disabled' : '') + '> ' + esc(p[1]) +
            (why ? ' <span class="count">' + esc(why) + '</span>' : '') + '</label>';
    }).join('');
    $('pdf-landscape').checked = !!saved.landscape;
    $('pdf-dialog').returnValue = '';   // Escape keeps the last returnValue
    $('pdf-dialog').showModal();
}

function pdfFigure(svg, caption) {
    return '<figure class="pr-figure">' + svg + (caption ? '<figcaption>' + esc(caption) + '</figcaption>' : '') + '</figure>';
}

/** Object URLs of a block's pictures: { id: url }. */
function pdfImageUrls(block) {
    return Promise.all((block.images || []).map(function (im) {
        return hsImageUrl(im.id).then(function (url) { return [im.id, url]; }, function () { return null; });
    })).then(function (pairs) {
        var urls = {};
        pairs.forEach(function (p) { if (p) urls[p[0]] = p[1]; });
        return urls;
    });
}

/** One connector or splice: its header fields, its rows (with any problems), then its diagram or pictures. */
function pdfBlockHtml(block, isConnector, opts, urls) {
    var fields = (isConnector ? CONNECTOR_FIELDS : SPLICE_FIELDS).filter(function (f) { return f[0] !== 'id' && block[f[0]]; });
    var html = '<div class="pr-block"><h3>' + esc(block.id) + (block.title && block.title !== block.id ? ' — ' + esc(block.title) : '') + '</h3>';
    if (fields.length) {
        html += '<p class="pr-note">' + fields.map(function (f) { return '<strong>' + esc(f[1]) + ':</strong> ' + esc(block[f[0]]); }).join(' · ') + '</p>';
    }
    var kind = isConnector ? 'pin' : 'wire', recs = isConnector ? block.pins : block.wires;
    var keys = isConnector ? HARNESS_PIN_FIELDS : HARNESS_WIRE_FIELDS, cols = isConnector ? HARNESS_PIN_COLUMNS : HARNESS_WIRE_COLUMNS;
    var problems = recs.some(function (r, i) { return rowIssues(kind, block.id, i).length; });
    var headers = keys.map(function (k, i) { return esc((block.columns || [])[i] || cols[i] || k); });
    if (problems) headers.push('Problem');
    html += prTable(headers, recs.map(function (r, i) {
        var row = keys.map(function (k) { return esc(r[k]); });
        if (problems) {
            row.push(rowIssues(kind, block.id, i).map(function (x) {
                return '<span class="status-' + (x.severity === 'error' ? 'error' : 'warning') + '">' + esc(x.message) + '</span>';
            }).join('<br>'));
        }
        return row;
    })) + '</div>';
    if (opts[isConnector ? 'connectorDiagrams' : 'spliceDiagrams']) {
        html += pdfFigure(harnessBlockDiagram(state.model, block.id, { imageUrls: opts.pictures ? urls : {} }).svg, block.id + ' wiring diagram');
    } else if (opts.pictures) {
        html += (block.images || []).map(function (im) {
            return urls[im.id] ? '<figure class="pr-figure"><img src="' + esc(urls[im.id]) + '" alt="">' +
                (im.caption ? '<figcaption>' + esc(im.caption) + '</figcaption>' : '') + '</figure>' : '';
        }).join('');
    }
    return html;
}

function pdfChecksHtml() {
    var list = state.checks;
    if (!list.length) return '<p>No problems found: every connection matches at both ends.</p>';
    var errors = list.filter(function (i) { return i.severity === 'error'; }).length;
    return '<p>' + errors + ' error' + (errors === 1 ? '' : 's') + ', ' + (list.length - errors) + ' warning' + (list.length - errors === 1 ? '' : 's') + '</p>' +
        prTable(['', 'Where', 'Problem'], list.map(function (i) {
            return ['<span class="status-' + (i.severity === 'error' ? 'error">Error' : 'warning">Warning') + '</span>', esc(i.where), esc(i.message)];
        }));
}

function exportPdf() {
    var opts = { parts: [], landscape: $('pdf-landscape').checked };
    $('pdf-parts').querySelectorAll('input:checked:not(:disabled)').forEach(function (cb) { opts.parts.push(cb.value); opts[cb.value] = true; });
    try { localStorage.setItem(PDF_OPTIONS_KEY, JSON.stringify({ parts: opts.parts, landscape: opts.landscape })); } catch (e) { /* this visit only */ }
    var name = $('name-input').value.trim() || state.name || 'Harness';
    var blocks = state.model.connectors.concat(state.model.splices);
    var wantImages = opts.pictures && (opts.connectors || opts.connectorDiagrams || opts.splices || opts.spliceDiagrams);
    return Promise.all(blocks.map(function (b) { return wantImages ? pdfImageUrls(b) : Promise.resolve({}); })).then(function (urlList) {
        var urls = {};
        blocks.forEach(function (b, i) { urls[b.id] = urlList[i]; });
        var sections = [];
        if (opts.overview) {
            var hardware = state.tunePkg && state.tunePkg.meta ? state.tunePkg.meta['Summary.Hardware'] : '';
            sections.push({ title: 'Overview', html: pdfFigure(harnessOverviewDiagram(state.model, { hardware: hardware || undefined }).svg) });
        }
        if (opts.system) {
            sections.push({ title: 'System — ' + state.system.name, html: pdfFigure(harnessSystemDiagram(systemMembers(), systemMates().mates).svg),
                            newPage: sections.length > 0 });
        }
        if (opts.checks) sections.push({ title: 'Checks', html: pdfChecksHtml(), newPage: sections.length > 0 });
        [[true, 'connectors', 'connectorDiagrams', 'Connectors', state.model.connectors],
         [false, 'splices', 'spliceDiagrams', 'Splices', state.model.splices]].forEach(function (k) {
            if (!opts[k[1]] && !opts[k[2]]) return;
            var tableOpts = opts[k[1]] ? opts : null;
            k[4].forEach(function (b, i) {
                var html = tableOpts ? pdfBlockHtml(b, k[0], opts, urls[b.id])
                    : pdfFigure(harnessBlockDiagram(state.model, b.id, { imageUrls: opts.pictures ? urls[b.id] : {} }).svg, b.id + ' wiring diagram');
                // Each block with a diagram starts a page; tables alone run on.
                sections.push({ title: i === 0 ? k[3] : '', html: html, newPage: sections.length > 0 && (i === 0 || !!opts[k[2]]) });
            });
        });
        if (opts.tune) {
            sections.push({ title: 'Tune comparison — ' + (state.tunePkg.tuneName || state.tunePkg.fileName || ''), html: tuneCompareHtml('all'),
                            newPage: sections.length > 0 });
        }
        var errors = state.checks.filter(function (i) { return i.severity === 'error'; }).length;
        var meta = [['Harness', name], ['Revision', state.revision ? state.revision + (state.latest && state.revision !== state.latest ? ' of ' + state.latest : '') : 'not saved'],
            ['System', state.system ? state.system.name : ''], ['Connectors', state.model.connectors.length], ['Splices', state.model.splices.length],
            ['Checks', state.checks.length ? errors + ' errors, ' + (state.checks.length - errors) + ' warnings' : 'no problems']];
        if (state.dirty) meta.push(['Note', 'Includes changes not saved yet']);
        return prPrint({ title: 'Harness — ' + name, meta: meta, sections: sections, landscape: opts.landscape,
                         fileName: name + (state.revision ? ' r' + state.revision : '') });
    });
}

$('pdf-btn').addEventListener('click', function () { if (state.model) openPdfDialog(); });
$('pdf-dialog').addEventListener('close', function () {
    if ($('pdf-dialog').returnValue !== 'print') return;
    exportPdf().catch(function (err) { showError('Could not build the PDF: ' + err.message); });
});

// =========================================================================
// Events and startup
// =========================================================================

$('xlsx-input').addEventListener('change', function () {
    var f = this.files[0];
    if (f && confirmDiscard()) importXlsx(f); else this.value = '';
});
$('open-btn').addEventListener('click', function () {
    var id = $('harness-select').value;
    if (id && confirmDiscard()) openHarness(id);
});
$('new-btn').addEventListener('click', function () { if (confirmDiscard()) newHarness(); });
$('save-btn').addEventListener('click', saveHarness);
$('export-btn').addEventListener('click', exportXlsx);
$('delete-btn').addEventListener('click', deleteHarness);
$('delete-revision-btn').addEventListener('click', deleteRevision);
$('name-input').addEventListener('input', function () { setDirty(true); });
$('revision-select').addEventListener('change', function () {
    var rev = parseInt(this.value, 10);
    if (!state.id || !rev) return;
    if (!confirmDiscard()) { this.value = String(state.revision); return; }
    openHarness(state.id, rev);
});
document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { selectTab(t.getAttribute('data-tab')); });
});
$('connector-filter').addEventListener('input', renderConnectorList);
$('splice-filter').addEventListener('input', renderSpliceList);
$('connector-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-connector]');
    if (b) { state.selConnector = b.getAttribute('data-connector'); renderConnectorList(); renderConnectorEditor(); }
});
$('splice-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-splice]');
    if (b) { state.selSplice = b.getAttribute('data-splice'); renderSpliceList(); renderSpliceEditor(); }
});
$('add-connector-btn').addEventListener('click', function () { addBlock(true); });
$('add-splice-btn').addEventListener('click', function () { addBlock(false); });
wireEditor('connector-editor', true);
wireEditor('splice-editor', false);
$('checks').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-fix')) applyFix(state.checks[parseInt(b.getAttribute('data-fix'), 10)]);
    else if (b.hasAttribute('data-goto-issue')) gotoIssue(state.checks[parseInt(b.getAttribute('data-goto-issue'), 10)]);
});
$('tune-select').addEventListener('change', function () { loadTune(this.value); });
$('diagram-select').addEventListener('change', function () { state.diagram = this.value; renderDiagram(); });
$('diagram-download').addEventListener('click', downloadDiagram);
$('diagram').addEventListener('click', function (e) {
    var row = e.target.closest('[data-endpoint]'), node = e.target.closest('[data-node]');
    var traced = e.target.closest('[data-trace]'), harnessBox = e.target.closest('[data-harness]');
    if (traced) { gotoSystemEndpoint(traced.getAttribute('data-trace')); return; }
    if (harnessBox) {
        var hid = harnessBox.getAttribute('data-harness');
        if (hid !== currentKey() && confirmDiscard()) openHarness(hid);
        return;
    }
    if (row) {
        var ep = row.getAttribute('data-endpoint');
        if (findSplice(ep)) gotoRow('splices', ep, null); else gotoEndpoint(ep);
    } else if (node) {
        state.diagram = node.getAttribute('data-node');
        renderDiagram();
        $('diagram').scrollTop = 0;
    }
});
$('diagram').addEventListener('mouseover', function (e) {
    var node = e.target.closest('[data-node]');
    highlightNode(node ? node.getAttribute('data-node') : null);
});
$('diagram').addEventListener('mouseleave', function () { highlightNode(null); });
document.querySelectorAll('[data-show]').forEach(function (b) {
    b.addEventListener('click', function () {
        state.show = b.getAttribute('data-show');
        document.querySelectorAll('[data-show]').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderTune();
    });
});
$('tune-result').addEventListener('click', function (e) {
    var b = e.target.closest('[data-goto-pin]');
    if (b) gotoEndpoint(b.getAttribute('data-goto-pin'));
});
window.addEventListener('beforeunload', function (e) {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

hsChooseBackend().then(function (backend) {
    $('storage-hint').textContent = STORAGE_HINTS[backend];
    return refreshHarnessList();
}).catch(function (err) { showError('Could not open harness storage: ' + err.message); });
