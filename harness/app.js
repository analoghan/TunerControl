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
    openIssues: {}        // 'kind|block|index' → true for rows whose problem details are shown
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
    }).catch(function (err) { showError('Could not open the harness: ' + err.message); });
}

function newHarness() {
    state.id = null; state.name = 'New harness'; state.revision = 0; state.latest = 0; state.revisions = [];
    state.model = { name: 'New harness', sheets: [{ name: 'Connectors', kind: 'connectors' }, { name: 'Splices', kind: 'splices' }],
                    connectors: [], splices: [] };
    state.selConnector = null; state.selSplice = null;
    setDirty(true);
    showEditor();
}

function importXlsx(file) {
    showError('');
    setStatus('Reading ' + file.name + '…');
    file.arrayBuffer().then(readXlsx).then(function (wb) {
        var name = file.name.replace(/\.xlsx$/i, '');
        var model = harnessFromWorkbook(wb, name);
        setStatus('Saving ' + name + '…');
        return hsSave(null, name, model, 'Imported from ' + file.name).then(function (saved) {
            var c = model.connectors.length, s = model.splices.length;
            setStatus('Imported ' + file.name + ': ' + c + ' connector' + (c === 1 ? '' : 's') + ', ' + s + ' splice' +
                (s === 1 ? '' : 's') + '.');
            return refreshHarnessList(saved.id).then(function () { return openHarness(saved.id); });
        });
    }).catch(function (err) {
        setStatus('');
        showError('Could not import ' + file.name + ': ' + err.message);
    }).then(function () { $('xlsx-input').value = ''; });
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
    var bytes = writeXlsx(harnessToWorkbook(state.model));
    var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ($('name-input').value.trim() || 'harness').replace(/[\\/:*?"<>|]+/g, '_') +
        (state.revision ? ' rev ' + state.revision : '') + '.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
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
    ['connectors', 'splices', 'checks', 'tune'].forEach(function (p) { $('panel-' + p).hidden = p !== tab; });
    if (tab === 'checks') renderChecks();
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

function renderBlockList(listId, blocks, selected, filter, countOf, attr) {
    var f = filter.trim().toLowerCase(), lastSheet = null, html = '';
    blocks.forEach(function (b) {
        if (f && (b.id + ' ' + (b.title || '') + ' ' + (b.connector || b.type || '') + ' ' + (b.notes || '')).toLowerCase().indexOf(f) < 0) return;
        if (b.sheet !== lastSheet) { html += '<li class="sheet-name">' + esc(b.sheet || '') + '</li>'; lastSheet = b.sheet; }
        html += '<li><button class="block-btn' + (b.id === selected ? ' selected' : '') + '" ' + attr + '="' + esc(b.id) + '">' +
            '<span class="block-id">' + esc(b.id) + '</span><span class="block-meta">' + countOf(b) + '</span>' + badgeHtml(b.id) + '</button></li>';
    });
    $(listId).innerHTML = html || '<li class="muted">None</li>';
}

function renderConnectorList() {
    renderBlockList('connector-list', state.model.connectors, state.selConnector, $('connector-filter').value,
        function (c) { return c.pins.length; }, 'data-connector');
}

function renderSpliceList() {
    renderBlockList('splice-list', state.model.splices, state.selSplice, $('splice-filter').value,
        function (s) { return s.wires.length; }, 'data-splice');
}

// =========================================================================
// Block editors
// =========================================================================

var CONNECTOR_FIELDS = [['id', 'Name (used in connections)'], ['title', 'Title'], ['sheet', 'Sheet'], ['connector', 'Connector'],
    ['boot', 'Boot'], ['mateConn', 'Mate connector'], ['matePin', 'Mate pin'], ['notes', 'Notes']];
var SPLICE_FIELDS = [['id', 'Name (used in connections)'], ['sheet', 'Sheet'], ['type', 'Splice type'], ['boot', 'Boot'], ['notes', 'Notes']];

function fieldsHtml(block, fields) {
    return '<div class="field-grid">' + fields.map(function (f) {
        return '<label><span>' + esc(f[1]) + '</span><input type="text" class="text-input" data-block-field="' + f[0] + '" value="' +
            esc(block[f[0]]) + '"></label>';
    }).join('') + '</div>';
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
        html += '<td class="actions"><button class="btn btn-small btn-danger" data-remove-row="' + i + '" aria-label="Remove row ' + (i + 1) +
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
    el.innerHTML = '<div class="editor-head"><h2>' + esc(c.id) + '</h2><button class="btn btn-small btn-danger" id="remove-block">Delete connector</button></div>' +
        fieldsHtml(c, CONNECTOR_FIELDS) + rowsHtml('pin', c, c.pins, HARNESS_PIN_FIELDS, c.columns || []) +
        '<button class="btn btn-secondary btn-small" id="add-row">Add cavity</button>';
}

function renderSpliceEditor() {
    var s = findSplice(state.selSplice), el = $('splice-editor');
    if (!s) {
        el.innerHTML = '<p class="muted">' + (state.model.splices.length ? 'Select a splice.' : 'No splices yet — add one.') + '</p>';
        return;
    }
    el.innerHTML = '<div class="editor-head"><h2>' + esc(s.id) + '</h2><button class="btn btn-small btn-danger" id="remove-block">Delete splice</button></div>' +
        fieldsHtml(s, SPLICE_FIELDS) + rowsHtml('wire', s, s.wires, HARNESS_WIRE_FIELDS, s.columns || []) +
        '<button class="btn btn-secondary btn-small" id="add-row">Add wire</button>';
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
    });
    el.addEventListener('click', function (e) {
        var block = current(), t = e.target.closest('button');
        if (!block || !t) return;
        var recs = isConnector ? block.pins : block.wires;
        var kind = isConnector ? 'pin' : 'wire';
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

function renderTune() {
    var el = $('tune-result'), pkg = state.tunePkg;
    if (!pkg) {
        el.innerHTML = '<p class="muted">Import a tune (.m1pkg) in the <a href="../m1-config/index.html">M1 Config Viewer</a> to compare it with this harness.</p>';
        return;
    }
    var hardware = (pkg.meta && pkg.meta['Summary.Hardware']) || '';
    if (!M1C_PINOUTS[hardware]) {
        el.innerHTML = '<p class="muted">No pinout is known for ' + esc(hardware || 'this ECU') + ', so its pins cannot be compared.</p>';
        return;
    }
    var r = harnessTuneCompare(state.model, pkg, hardware, state.resourceNames), s = r.summary;
    var html = '<div class="summary-grid tune-summary">' +
        [['ok', 'Match'], ['check', 'Check'], ['missing', 'No wire'], ['not-in-tune', 'Not matched'], ['no-connector', 'Not in harness']]
            .map(function (k) {
                return '<div class="summary-stat status-' + k[0] + '"><span class="stat-value">' + s[k[0]] + '</span><span class="stat-label">' +
                    k[1] + '</span></div>';
            }).join('') + '</div>';
    var rows = r.rows.filter(function (x) { return state.show === 'all' || x.status !== 'ok'; });
    if (state.show !== 'all') {
        rows.sort(function (a, b) { return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]; });   // stable: pin order within a status
    }
    html += '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Pin</th><th>Tune uses it for</th>' +
        '<th>Resource</th><th>Harness function</th><th>Harness label</th><th>Status</th></tr></thead><tbody>';
    rows.forEach(function (x) {
        var hasConn = !!findConnector(x.connectorId);
        html += '<tr class="status-row-' + x.status + '"><td class="param-pin">' +
            (hasConn ? '<button class="link-btn" data-goto-pin="' + esc(x.connectorId + '.' + x.cavity) + '">' + esc(x.pin) + '</button>' : esc(x.pin)) +
            '</td><td class="param-name">' + esc(x.tune.join(', ') || '—') + '</td><td>' + esc(x.resource || '—') + '</td><td>' +
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
    el.innerHTML = html;
}

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
