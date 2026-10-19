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
    tuneScope: 'system',
    canPinsOpen: {},      // CAN device/feed id → true while its pin links are shown
    compare: null,        // Revisions tab: { from: revision, to: revision | 'open', diff, fromLabel, toLabel }
    revCache: {}          // 'harnessId|revision' → stored model, for comparing revisions
};

function $(id) { return document.getElementById(id); }

function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(text) { $('status').textContent = text || ''; $('status').hidden = !text; }
function showError(text) { $('error').textContent = text || ''; $('error').hidden = !text; }

var STORAGE_HINTS = {
    server: 'Harnesses are stored on the TunerControl server, with every saved revision. Backup & Restore saves them all with everything else.',
    browser: 'Harnesses are stored in this browser only, with every saved revision. Backup & Restore saves them all with everything else.',
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
        state.id = h.id; state.name = h.name; state.model = harnessUpgrade(h.data);
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
            return hsLoad(h.id).then(function (x) { return { id: x.id, name: x.name, model: harnessUpgrade(x.data) }; }, function () { return null; });
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
    downloadFile(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx');
}

/** Save bytes or text as "<harness name> rev N<suffix>". */
function downloadFile(data, type, suffix) {
    var blob = new Blob([data], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ($('name-input').value.trim() || 'harness').replace(/[\\/:*?"<>|]+/g, '_') +
        (state.revision ? ' rev ' + state.revision : '') + suffix;
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
    state.compare = null;
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
    ['connectors', 'splices', 'cables', 'diagram', 'system', 'can', 'checks', 'build', 'revisions', 'tune'].forEach(function (p) { $('panel-' + p).hidden = p !== tab; });
    if (tab === 'system') renderSystem();
    if (tab === 'connectors' && state.model) renderConnectorEditor();   // CAN pin tags may have changed
    if (tab === 'can') renderCan();
    if (tab === 'checks') renderChecks();
    if (tab === 'cables') renderCables();
    if (tab === 'build') renderBuild();
    if (tab === 'revisions') renderRevisions();
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
    if (state.tab === 'cables') renderCables();
    if (state.tab === 'tune') renderTune();
    if (state.tab === 'diagram') renderDiagram();
    if (state.tab === 'system') renderSystem();
    if (state.tab === 'can') renderCan();
    if (state.tab === 'build') renderBuild();
}

// =========================================================================
// Checks
// =========================================================================

var checkTimer = null;

function runChecks() {
    state.checks = harnessCheck(state.model).concat(cableIssues());
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
    $('count-cables').textContent = state.cables.cables.length || '';
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

// =========================================================================
// Cables (harness-cable.js): twisted pairs and other multi-conductor cables
// =========================================================================

/** Cable problems as check issues, on the row of the cable's first wire; the notes (info) stay on the Cables tab. Sets state.cables. */
function cableIssues() {
    state.cables = harnessCables(state.model);
    var out = [];
    state.cables.cables.forEach(function (c) {
        var w = c.wires[0], end = w.from.kind === 'pin' ? w.from : w.to.kind === 'pin' ? w.to : null, ref = null;
        var conn = end ? findConnector(end.block) : null;
        if (conn) {
            var cavity = end.label.slice(end.block.length + 1);
            for (var i = 0; i < conn.pins.length; i++) if (conn.pins[i].cavity === cavity) { ref = { kind: 'pin', block: conn.id, index: i }; break; }
        }
        c.problems.forEach(function (p) {
            if (p.severity === 'info') return;
            out.push({ severity: p.severity, where: end ? end.label : c.name, message: 'Cable ' + c.name + ': ' + p.message, target: null, ref: ref, fix: null });
        });
    });
    return out;
}

/** The editor's pin fields for a connector: with the Cable column when one of its wires is in a cable. */
function connectorFields(c) {
    var withCable = !!state.cables && c.pins.some(function (p) { return state.cables.byEndpoint[harnessEndpointName(c.id, p.cavity)]; });
    return harnessPinFields(c, withCable);
}

function cableEndHtml(e) {
    if (e.kind === 'pin' || e.kind === 'splice') return '<button class="link-btn" data-cable-goto="' + esc(e.label) + '">' + esc(e.label) + '</button>';
    return esc(e.label || '—');
}

function renderCables() {
    var el = $('cables'), r = state.cables;
    if (!state.model || !r) { el.innerHTML = ''; return; }
    var named = r.cables.filter(function (c) { return c.explicit; }).length, detected = r.cables.length - named;
    var html = '<div class="build-bar"><span class="hint">' + r.cables.length + ' cable' + (r.cables.length === 1 ? '' : 's') +
        (r.cables.length ? ' — ' + named + ' named in the Cable column, ' + detected + ' detected' : '') + '</span><span class="spacer"></span>' +
        (detected ? '<button class="btn btn-small btn-secondary" id="cables-name" title="Write the detected names into the Cable column of their wires, so ' +
            'they stay as they are">Name the detected cables</button>' : '') + '</div>';
    if (r.untyped.length) {
        html += '<p class="hint">' + r.untyped.map(function (u) { return '<strong>' + esc(u.pn) + '</strong> (' + u.count + ' wire' + (u.count === 1 ? '' : 's') + ')'; })
            .join(', ') + ' look' + (r.untyped.length === 1 ? 's' : '') + ' like a cable but ' + (r.untyped.length === 1 ? 'is' : 'are') +
            ' not a known cable type — add ' + (r.untyped.length === 1 ? 'it' : 'them') + ' to the list below.</p>';
    }
    if (r.cables.length) {
        html += '<div class="table-scroll"><table class="event-table data-table"><thead><tr><th>Cable</th><th>Type</th><th>Part number</th>' +
            '<th>Conductors</th><th>Shield / drain</th><th>Notes</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
            r.cables.map(function (c, n) {
                var name = c.explicit ? '<input type="text" class="text-input cable-name" data-cable="' + n + '" value="' + esc(c.name) +
                    '" aria-label="Name of cable ' + esc(c.name) + '" title="Renames the cable in every cavity that names it; empty leaves it to detection">'
                    : esc(c.name) + ' <span class="hint">detected</span>';
                var wires = function (list) {
                    return list.map(function (w) { return cableEndHtml(w.from) + ' → ' + cableEndHtml(w.to) + ' <span class="hint">' + esc(w.wire) + '</span>'; }).join('<br>');
                };
                return '<tr><td>' + name + '</td><td>' + esc(c.type ? c.type.label : 'Cable') + '</td><td class="param-name">' + esc(c.pn) + '</td><td>' +
                    wires(c.conductors) + '</td><td>' + (c.shields.length ? wires(c.shields) : '<span class="hint">' + (c.type && c.type.shielded ? 'none here' : '—') + '</span>') +
                    '</td><td>' + c.problems.map(function (p) {
                        return (p.severity === 'info' ? '' : markerHtml([p]) + ' ') + '<span' + (p.severity === 'info' ? ' class="hint"' : '') + '>' + esc(p.message) + '</span>';
                    }).join('<br>') + '</td><td class="actions">' + (c.anchor.block ? '<button class="btn btn-small btn-secondary" data-cable-diagram="' +
                        esc(c.anchor.block) + '">Diagram</button>' : '') + '</td></tr>';
            }).join('') + '</tbody></table></div>';
    } else {
        html += '<p class="muted">No cables found: no conductor part number or description says a wire is part of a multi-conductor cable.</p>';
    }
    var types = state.model.cableTypes || [];
    html += '<h3>Cable part numbers</h3><p class="hint">M27500 part numbers need no entry: M27500-22TG2T14 is 22 AWG, 2 conductors, shield T ' +
        '(U = no shield). List other cable part numbers here (e.g. an Ethernet cable as unshielded pairs). A description such as "(3 Wire Shielded)" ' +
        'also works, and every row with the same part number counts as that cable.</p>' +
        '<table class="event-table data-table cable-types"><thead><tr><th>Part number</th><th>Conductors</th><th>Shielded</th><th></th></tr></thead><tbody>' +
        types.map(function (t, i) {
            return '<tr><td><input type="text" class="text-input" data-ctype="' + i + '" data-field="pn" value="' + esc(t.pn) + '" aria-label="Part number"></td>' +
                '<td><input type="number" class="text-input" min="2" max="12" data-ctype="' + i + '" data-field="conductors" value="' + esc(t.conductors) +
                '" aria-label="Conductors" style="width:70px"></td><td><input type="checkbox" data-ctype="' + i + '" data-field="shielded"' +
                (t.shielded ? ' checked' : '') + ' aria-label="Shielded"></td><td class="actions"><button class="btn btn-small btn-danger" data-ctype-remove="' + i +
                '" aria-label="Remove ' + esc(t.pn) + '">&times;</button></td></tr>';
        }).join('') + '</tbody></table><button class="btn btn-small btn-secondary" id="ctype-add">Add a cable part number</button>';
    el.innerHTML = html;
}

function cablesChanged() {
    setDirty(true);
    runChecks();
    renderAll();
}

$('cables').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'cables-name') {
        harnessNameCables(state.model, state.cables.cables);
        cablesChanged();
    } else if (b.id === 'ctype-add') {
        var untyped = state.cables.untyped[0];
        (state.model.cableTypes = state.model.cableTypes || []).push({ pn: untyped ? untyped.pn : '', conductors: 2, shielded: false });
        cablesChanged();
    } else if (b.hasAttribute('data-ctype-remove')) {
        state.model.cableTypes.splice(+b.getAttribute('data-ctype-remove'), 1);
        cablesChanged();
    } else if (b.hasAttribute('data-cable-goto')) {
        gotoEndpoint(b.getAttribute('data-cable-goto'));
    } else if (b.hasAttribute('data-cable-diagram')) {
        state.diagram = b.getAttribute('data-cable-diagram');
        selectTab('diagram');
    }
});
$('cables').addEventListener('change', function (e) {
    var t = e.target;
    if (t.classList.contains('cable-name')) {
        var cable = state.cables.cables[+t.getAttribute('data-cable')];
        if (cable) harnessRenameCable(state.model, cable.name, t.value);
        cablesChanged();
    } else if (t.hasAttribute('data-ctype')) {
        var type = state.model.cableTypes[+t.getAttribute('data-ctype')], f = t.getAttribute('data-field');
        if (!type) return;
        type[f] = f === 'shielded' ? t.checked : f === 'conductors' ? Math.max(2, parseInt(t.value, 10) || 2) : t.value.trim();
        cablesChanged();
    }
});

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
/** Alphabetical by name, numbers in order (X106 before X160, CAN2 before CAN10), ignoring case. */
function byName(a, b) {
    return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
}

function renderBlockList(listId, kind, selected, filter, countOf, attr) {
    var f = filter.trim().toLowerCase(), html = '';
    harnessSheetGroups(state.model).forEach(function (sheet) {
        var items = sheet[kind].filter(function (b) {
            return !f || (b.id + ' ' + (b.title || '') + ' ' + (b.connector || b.type || '') + ' ' + (b.notes || '')).toLowerCase().indexOf(f) >= 0;
        }).sort(byName);
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
    var remoteField = kind === 'pin' ? 'remote' : 'end', canUses = kind === 'pin' && state.system ? canPinUses(canNetworks(), currentKey()) : {};
    records.forEach(function (rec, i) {
        var open = !!state.openIssues[issueKey(kind, block.id, i)];
        html += '<tr data-row="' + i + '"><td class="mark-col" data-marker="' + kind + '|' + esc(block.id) + '|' + i + '">' +
            markerHtml(rowIssues(kind, block.id, i), i, open) + '</td>';
        fields.forEach(function (f) {
            var detected = f === 'cable' && !harnessText(rec.cable) && state.cables ? state.cables.byEndpoint[harnessEndpointName(block.id, rec.cavity)] : null;
            var input = '<input type="text" class="cell-input cell-' + f + '" data-row="' + i + '" data-field="' + f + '" value="' +
                esc(rec[f]) + '" aria-label="' + esc(f + ' row ' + (i + 1)) + '"' +
                (detected ? ' placeholder="' + esc(detected.name) + '" title="Detected cable: ' + esc(detected.name) + ' — type a name to fix it, or - to leave it out"' : '') + '>';
            if (f === remoteField) {
                input = '<div class="remote-cell">' + input + '<button class="link-btn" data-goto="' + i + '" title="Go to the other end" ' +
                    'aria-label="Go to the other end of row ' + (i + 1) + '">&rarr;</button></div>';
            }
            var uses = f === 'function' ? canUses[block.id + '|' + String(rec.cavity).trim().toLowerCase()] : null;
            if (uses) {
                input = '<div class="remote-cell">' + input + uses.map(function (u) {
                    return '<button class="can-pin-tag" data-can-goto="' + esc(u.item.id) + '" title="' + esc(u.net.name + ' · ' + u.item.name + ' · ' +
                        CAN_PIN_LABELS[u.role] + ' — show in the CAN tab') + '">' + esc(CAN_PIN_LABELS[u.role]) + '</button>';
                }).join('') + '</div>';
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
        fieldsHtml(c, CONNECTOR_FIELDS) +
        '<label class="check-label chassis-toggle" title="A free-text column for what each wire connects to outside this harness">' +
        '<input type="checkbox" id="chassis-toggle"' + (c.chassisFunction ? ' checked' : '') + '> Chassis Function column</label>' +
        imagesHtml(c) + rowsHtml('pin', c, c.pins, connectorFields(c), harnessPinColumns(c, connectorFields(c))) +
        '<button class="btn btn-secondary btn-small" id="add-row">Add cavity</button>';
    loadThumbnails(el);
}

function editorHeadHtml(block, what) {
    return '<div class="editor-head"><h2>' + esc(block.id) + '</h2>' +
        '<button class="btn btn-small btn-secondary" id="show-diagram">Wiring diagram</button>' +
        (what === 'connector' ? '<button class="btn btn-small btn-secondary" id="print-pinout" title="A printable pinout sheet of this connector (save it as PDF)">Pinout sheet</button>' : '') +
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
    if (isConnector) harnessRenameLengths(state.model, oldId, newId);
    if (isConnector && state.system && canRenameConnector(canNetworks(), currentKey(), oldId, newId)) canSave();
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
        if (block && t.id === 'chassis-toggle') {
            block.chassisFunction = t.checked;
            setDirty(true);
            renderConnectorEditor();
        }
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
        if (t.hasAttribute('data-can-goto')) { canShowItem(t.getAttribute('data-can-goto')); return; }
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
        if (t.id === 'print-pinout') { printPinouts([block]).catch(function (err) { showError('Could not build the pinout sheet: ' + err.message); }); return; }
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
            (isConnector ? HARNESS_PIN_FIELDS.concat('chassis', 'cable') : HARNESS_WIRE_FIELDS).forEach(function (f) { blank[f] = ''; });
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
            columns: HARNESS_PIN_COLUMNS.slice(),
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
        return '<optgroup label="' + esc(label) + '">' + blocks.slice().sort(byName).map(function (b) {
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
    var nets = canNetworks();
    if (nets.length) {
        extra += '<optgroup label="CAN networks">' + nets.map(function (n) {
            return '<option value="can:' + esc(n.id) + '">' + esc(n.name || 'CAN network') + '</option>';
        }).join('') + '</optgroup>';
    }
    sel.innerHTML = opts + extra + group('Connectors', state.model.connectors) + group('Splices', state.model.splices);
    if (state.diagram === 'system' && !state.system) state.diagram = '';
    if (/^can:/.test(state.diagram) && !canFindNet(state.diagram.slice(4))) state.diagram = '';
    if (state.diagram && state.diagram !== 'system' && !/^(trace|can):/.test(state.diagram) &&
        !findConnector(state.diagram) && !findSplice(state.diagram)) state.diagram = '';
    sel.value = state.diagram;
    if (state.diagram === 'system' || /^trace:/.test(state.diagram)) { renderSystemDiagram(); return; }
    if (/^can:/.test(state.diagram)) {
        renderDiagram.seq = (renderDiagram.seq || 0) + 1;
        $('diagram-hint').textContent = 'Each connection is a twisted pair (CAN-H / CAN-L), with +12 V and ground beside it where it carries power. Click a device, feed or hub to edit it.';
        $('diagram').innerHTML = canNetworkDiagram(canFindNet(state.diagram.slice(4)), canNetworks()).svg;
        return;
    }
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
        var d = focus ? harnessBlockDiagram(state.model, focus.id, { imageUrls: urls, cables: state.cables ? state.cables.byEndpoint : null })
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
            return hsLoad(id).then(function (h) { return { id: h.id, name: h.name, model: harnessUpgrade(h.data), revision: h.revision }; },
                function () { return null; });
        }));
    }).then(function (members) {
        state.sysMembers = members.filter(Boolean);
        renderSystemSelect();
        if (state.tab === 'connectors' && state.model) renderConnectorEditor();
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
    $('count-can').textContent = canCountText();
    if (state.tab === 'can') renderCan();
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
            '</td>' + (useSystem ? '<td>' + esc(x.harnessName || '—') + '</td>' : '') + '<td class="param-name">' + esc(x.tune.join(', ') || '—') +
            x.labels.map(function (l) { return ' <span class="user-label" title="Your label in the M1 Config Viewer">' + esc(l) + '</span>'; }).join('') + '</td><td>' + esc(x.resource || '—') + '</td><td>' +
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
    ['can', 'CAN networks (tables and diagrams)'], ['cutlist', 'Cut list'], ['bom', 'Bill of materials'], ['tune', 'Tune comparison (all pins)'],
    ['pinouts', 'Pinout sheets (a page per connector, then the splices)'], ['changes', 'Revision changes (as compared on the Revisions tab)']];

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
    if (id === 'can' && !canNetworks().length) return state.system ? 'no CAN networks in the system' : 'this harness is not in a system';
    if (id === 'pinouts' && !state.model.connectors.length) return 'no connectors';
    if (id === 'changes' && !(state.compare && state.compare.diff)) return 'compare two revisions on the Revisions tab first';
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

/** One CAN network: devices, hubs and terminators, its checks, then its diagram. */
function pdfCanHtml(net) {
    function hubName(id) { var h = id ? net.hubs.filter(function (x) { return x.id === id; })[0] : null; return h ? esc(h.name) : 'Not connected'; }
    var speed = canBitrate(net.bitrate), checks = canNetworkChecks(net, systemMembers(), canNetworks());
    var html = '<div class="pr-block"><h3>' + esc(net.name) + '</h3><p class="pr-note"><strong>Speed:</strong> ' + esc(speed ? canBitrateText(speed) : 'not set') +
        ' · <strong>Terminations:</strong> ' + canTerminations(net) + (net.notes ? ' · ' + esc(net.notes) : '') + '</p>';
    function pins(item, isFeed) {
        return canPinRoles(item, isFeed).map(function (r) {
            var ref = (item.pins || {})[r];
            return ref && ref.cavity ? esc(CAN_PIN_LABELS[r] + ' ' + (memberName(ref.harness) ? memberName(ref.harness) + ' · ' : '') + canPinText(ref)) : '';
        }).filter(Boolean).join('<br>');
    }
    html += prTable(['Device', 'Hub', 'Termination', 'Power', 'Speed', 'Pins', 'Notes'], net.devices.map(function (d) {
        var own = canBitrate(d.bitrate);
        return [esc(d.name), hubName(d.hub), d.termination ? '120 Ω on' : 'off', d.power ? 'From CAN' : '',
            esc(own ? canBitrateText(own) : speed ? canBitrateText(speed) + ' (network)' : ''), pins(d, false), esc(d.notes)];
    }));
    if (canFeeds(net).length) {
        html += prTable(['Power feed', 'Power comes from', 'Feeds into', 'Pins', 'Notes'], canFeeds(net).map(function (f) {
            var to = canFeedTarget(net, f);
            return [esc(f.name), esc(f.source), to ? esc(to.hub ? 'Hub ' + to.hub.name : to.device.name) : 'Not connected', pins(f, true), esc(f.notes)];
        }));
    }
    if (net.hubs.length) {
        html += prTable(['Hub', 'Connects to hubs', 'Power shared with other networks', 'Notes'], net.hubs.map(function (h) {
            var links = net.hubs.filter(function (o) { return o !== h && canHubLink(net, h.id, o.id); }).map(function (o) {
                var data = canHubLinked(net, h.id, o.id), power = canHubPowerLinked(net, h.id, o.id);
                return esc(o.name) + (data && power ? '' : data ? ' (CAN only)' : ' (power only)');
            });
            return [esc(h.name), links.join(', '), canPowerLinks(net).filter(function (l) { return l.hub === h.id; }).map(canPowerLinkName).map(esc).join(', '), esc(h.notes)];
        }));
    }
    if (net.terminators.length) html += prTable(['Terminator (120 Ω)', 'Plugged into hub'], net.terminators.map(function (t) { return [esc(t.name), hubName(t.hub)]; }));
    if (checks.length) {
        html += '<p class="pr-note">' + checks.map(function (c) {
            return '<span class="status-' + (c.severity === 'error' ? 'error' : 'warning') + '">' + esc(c.where + ' — ' + c.message) + '</span>';
        }).join('<br>') + '</p>';
    }
    return html + '</div>' + pdfFigure(canNetworkDiagram(net, canNetworks()).svg, net.name + ' — twisted-pair wiring');
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
    var keys = isConnector ? connectorFields(block) : HARNESS_WIRE_FIELDS;
    var problems = recs.some(function (r, i) { return rowIssues(kind, block.id, i).length; });
    var headers = (isConnector ? harnessPinColumns(block, keys) : keys.map(function (k, i) { return (block.columns || [])[i] || HARNESS_WIRE_COLUMNS[i] || k; }))
        .map(esc);
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
    var wantImages = (opts.pictures && (opts.connectors || opts.connectorDiagrams || opts.splices || opts.spliceDiagrams)) || opts.pinouts;
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
        if (opts.can) {
            canNetworks().forEach(function (net, i) {
                sections.push({ title: i === 0 ? 'CAN networks' : '', html: pdfCanHtml(net), newPage: sections.length > 0 });
            });
        }
        if (opts.cutlist || opts.bom) {
            var wires = buildWires();
            if (opts.cutlist) sections.push({ title: 'Cut list', html: buildCutListHtml(wires, true), newPage: sections.length > 0 });
            if (opts.bom) sections.push({ title: 'Bill of materials', html: buildBomHtml(harnessBom(state.model, wires)), newPage: sections.length > 0 });
        }
        if (opts.pinouts) {
            pinoutSections(state.model.connectors, urls, true).forEach(function (sec) { sec.newPage = sections.length > 0; sections.push(sec); });
        }
        if (opts.changes) {
            sections.push({ title: 'Changes — ' + state.compare.fromLabel + ' → ' + state.compare.toLabel, html: revisionsDiffHtml(true),
                            newPage: sections.length > 0 });
        }
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

// =========================================================================
// Cut list & BOM (harness-build.js). Wire lengths are optional, saved in the model as wireLengths / lengthUnit.
// =========================================================================

/** The cut list in "from" order (natural sort, so M142.A.2 comes before M142.A.10). */
function buildWires() {
    var wires = harnessCutList(state.model).sort(function (a, b) {
        return a.from.label.localeCompare(b.from.label, undefined, { numeric: true, sensitivity: 'base' });
    });
    harnessCables(state.model, wires);   // sets wire.cableName
    return wires;
}

function buildEndHtml(end, forPdf) {
    if (!end.label) return '<span class="muted">—</span>';
    var text = esc(end.label), note = end.kind === 'outside' ? ' <span class="hint">(outside this harness)</span>' : '';
    if (forPdf || (end.kind !== 'pin' && end.kind !== 'splice')) return text + note;
    return '<button class="link-btn param-name" data-build-goto="' + esc(end.label) + '">' + text + '</button>' + note;
}

function buildCutListHtml(wires, forPdf) {
    var unit = state.model.lengthUnit || 'mm';
    return '<div class="table-scroll"><table class="event-table data-table build-table"><thead><tr><th>#</th><th>From</th><th>Terminal</th><th>To</th>' +
        '<th>Terminal</th><th>Wire part number</th><th>Wire</th><th>Cable</th><th>Length (' + esc(unit) + ')</th><th>Function</th><th>Note</th></tr></thead><tbody>' +
        wires.map(function (w, i) {
            var len = forPdf ? (w.length === null ? '' : esc(w.length)) : '<input type="number" class="text-input build-length" min="0" step="any" data-key="' +
                esc(w.key) + '" value="' + (w.length === null ? '' : esc(w.length)) + '" aria-label="Length of wire ' + (i + 1) + '" placeholder="—">';
            return '<tr' + (w.problem ? ' class="build-problem"' : '') + '><td>' + (i + 1) + '</td><td>' + buildEndHtml(w.from, forPdf) + '</td><td>' + esc(w.from.terminal) +
                '</td><td>' + buildEndHtml(w.to, forPdf) + '</td><td>' + esc(w.to.kind === 'terminal' ? '' : w.to.terminal) + '</td><td class="param-name">' +
                esc(w.wirePn) + '</td><td>' + esc(w.wire) + '</td><td>' + esc(w.cableName || '') + '</td><td class="num">' + len + '</td><td>' + esc(w.function) + '</td><td>' +
                (w.problem ? markerHtml([{ severity: 'warning', message: w.problem }]) + ' ' + esc(w.problem) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
}

function buildBomHtml(bom) {
    var unit = bom.lengthUnit;
    function table(title, list, withLength) {
        if (!list.length) return '';
        return '<h3>' + esc(title) + '</h3><div class="table-scroll"><table class="event-table data-table build-bom"><thead><tr><th>Part</th><th class="num">Quantity</th>' +
            (withLength ? '<th class="num">Total length</th>' : '') + '<th>Used in</th></tr></thead><tbody>' + list.map(function (x) {
                var used = x.used.slice(0, 12).join(', ') + (x.used.length > 12 ? ' and ' + (x.used.length - 12) + ' more' : '');
                return '<tr><td class="param-name">' + esc(x.part) + '</td><td class="num">' + x.count + '</td>' + (withLength ? '<td class="num">' +
                    (x.length ? esc(+x.length.toFixed(3) + ' ' + unit) + (x.missingLengths ? ' <span class="hint">+ ' + x.missingLengths + ' without a length</span>' : '')
                        : '<span class="hint">—</span>') + '</td>' : '') + '<td class="hint">' + esc(used) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
    }
    var notes = [];
    if (bom.unnamed.connectors) notes.push(bom.unnamed.connectors + ' connector' + (bom.unnamed.connectors === 1 ? ' has' : 's have') + ' no part number');
    if (bom.unnamed.terminals) notes.push(bom.unnamed.terminals + ' wired cavit' + (bom.unnamed.terminals === 1 ? 'y has' : 'ies have') + ' no terminal part number');
    return table('Connectors', bom.connectors) + table('Boots', bom.boots) + table('Splices', bom.splices) + table('Terminals', bom.terminals) +
        table('Cavity plugs', bom.plugs) + table('Wire ends', bom.ends) + table('Wire', bom.wire, true) +
        (notes.length ? '<p class="hint">Not counted: ' + esc(notes.join('; ')) + '.</p>' : '');
}

function buildSummaryText(wires) {
    var withLen = wires.filter(function (w) { return w.length !== null; }).length, problems = wires.filter(function (w) { return w.problem; }).length;
    return wires.length + ' wires · ' + (withLen ? withLen + ' with a length' : 'no lengths entered (optional)') +
        (problems ? ' · ' + problems + ' to check' : '');
}

function renderBuild() {
    var el = $('build');
    if (!state.model) { el.innerHTML = ''; return; }
    var wires = buildWires(), unit = state.model.lengthUnit || 'mm';
    el.innerHTML = '<div class="build-bar"><span id="build-summary" class="hint">' + esc(buildSummaryText(wires)) + '</span><span class="spacer"></span>' +
        '<label class="hint">Length unit <select id="build-unit" aria-label="Length unit">' + HB_LENGTH_UNITS.map(function (u) {
            return '<option' + (u === unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select></label>' +
        '<button class="btn btn-small btn-secondary" id="build-cut-csv">Download cut list (.csv)</button>' +
        '<button class="btn btn-small btn-secondary" id="build-bom-csv">Download BOM (.csv)</button></div>' +
        '<h3>Cut list</h3>' + (wires.length ? buildCutListHtml(wires, false) : '<p class="muted">No wires yet.</p>') +
        '<h3 class="build-bom-head">Bill of materials</h3><div id="build-bom">' + buildBomHtml(harnessBom(state.model, wires)) + '</div>';
}

$('build').addEventListener('input', function (e) {
    var t = e.target;
    if (!t.classList.contains('build-length')) return;
    harnessSetLength(state.model, t.getAttribute('data-key'), t.value);
    setDirty(true);
    var wires = buildWires();
    $('build-summary').textContent = buildSummaryText(wires);
    $('build-bom').innerHTML = buildBomHtml(harnessBom(state.model, wires));
});
$('build').addEventListener('change', function (e) {
    if (e.target.id !== 'build-unit') return;
    harnessSetLengthUnit(state.model, e.target.value);
    setDirty(true);
    renderBuild();
});
$('build').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'build-cut-csv') downloadFile(harnessCutListCsv(state.model, buildWires()), 'text/csv', ' cut list.csv');
    else if (b.id === 'build-bom-csv') downloadFile(harnessBomCsv(state.model, harnessBom(state.model, buildWires())), 'text/csv', ' BOM.csv');
    else if (b.hasAttribute('data-build-goto')) gotoEndpoint(b.getAttribute('data-build-goto'));
});
$('pdf-dialog').addEventListener('close', function () {
    if ($('pdf-dialog').returnValue !== 'print') return;
    exportPdf().catch(function (err) { showError('Could not build the PDF: ' + err.message); });
});

// =========================================================================
// Pinout sheets (harness-pinout.js): one page per connector for the bench and for fault-finding
// =========================================================================

/** "Engine · revision 7" (+ unsaved), printed on every sheet so a sheet on the bench says which harness it belongs to. */
function pinoutSource() {
    var name = $('name-input').value.trim() || state.name || 'Harness';
    return name + (state.revision ? ' · revision ' + state.revision : ' · not saved') + (state.dirty ? ' (with unsaved changes)' : '');
}

/** A wire colour swatch (SVG, so it prints: the report theme clears backgrounds). */
function pinoutSwatch(look) {
    if (!look || !look.label) return '';
    return '<svg class="pinout-swatch" width="26" height="10" viewBox="0 0 26 10" aria-hidden="true"><rect x="0.5" y="0.5" width="25" height="9" rx="2" fill="' +
        esc(look.color) + '" stroke="#333"/>' + (look.stripe ? '<rect x="0.5" y="3.5" width="25" height="3" fill="' + esc(look.stripe) + '"/>' : '') + '</svg> ';
}

function pinoutToHtml(row) {
    if (row.empty) return '';
    if (!row.to.length) return '<span class="status-warning">no other end</span>';
    return row.to.map(function (e) {
        var text = esc(e.label) + (e.kind === 'outside' ? ' <span class="muted">(outside this harness)</span>' :
            e.kind === 'missing' ? ' <span class="status-warning">(not in this harness)</span>' : '');
        if (e.kind === 'splice' && e.others.length) text += '<br><span class="muted">joins ' + esc(e.others.join(', ')) + '</span>';
        return text;
    }).join('<br>');
}

/** One connector's sheet: header fields, pictures, then a row per cavity. */
function pinoutSheetHtml(block, rows, urls) {
    var fields = CONNECTOR_FIELDS.filter(function (f) { return f[0] !== 'id' && f[0] !== 'title' && f[0] !== 'sheet' && harnessText(block[f[0]]); });
    var noteHead = harnessPinColumns(block, HARNESS_PIN_FIELDS)[5];
    var withNote = rows.some(function (r) { return r.note; }), withChassis = rows.some(function (r) { return r.chassis; });
    function cableOf(r) { var c = state.cables && state.cables.byEndpoint[harnessEndpointName(block.id, r.cavity)]; return c ? c.name : ''; }
    var withCable = rows.some(cableOf);
    var wired = rows.filter(function (r) { return !r.empty; }).length;
    var html = '<p class="pr-note pinout-source">' + esc(pinoutSource()) + '</p>' +
        (block.title && block.title !== block.id ? '<p class="pinout-title">' + esc(block.title) + '</p>' : '') +
        (fields.length ? '<p class="pr-note">' + fields.map(function (f) { return '<strong>' + esc(f[1]) + ':</strong> ' + esc(block[f[0]]); }).join(' · ') + '</p>' : '');
    var pics = (block.images || []).filter(function (im) { return urls && urls[im.id]; });
    if (pics.length) {
        html += '<div class="pinout-pics">' + pics.map(function (im) {
            return '<figure><img src="' + esc(urls[im.id]) + '" alt="">' + (im.caption ? '<figcaption>' + esc(im.caption) + '</figcaption>' : '') + '</figure>';
        }).join('') + '</div>';
    }
    var headers = ['Cavity', 'Function'].concat(withNote ? [esc(noteHead)] : [], ['Wire', 'Wire part number', 'Terminal', 'Goes to'], withChassis ? [esc(HARNESS_CHASSIS_COLUMN)] : [],
        withCable ? [esc(HARNESS_CABLE_COLUMN)] : []);
    html += prTable(headers, rows.map(function (r) {
        var cells = ['<strong>' + esc(r.cavity) + '</strong>', r.empty ? '<span class="muted">' + esc(r.function || 'Empty') + '</span>' : esc(r.function)];
        if (withNote) cells.push(esc(r.note));
        cells.push(r.empty ? '<span class="muted">' + esc(r.wire || r.wirePn || 'no wire') + '</span>' : pinoutSwatch(r.look) + esc(r.wire),
                   r.empty ? '' : '<span class="pinout-part">' + esc(r.wirePn) + '</span>', '<span class="pinout-part">' + esc(r.terminal) + '</span>', pinoutToHtml(r));
        if (withChassis) cells.push(esc(r.chassis));
        if (withCable) cells.push(esc(cableOf(r)));
        return cells;
    }), 'pinout-table');
    return html + '<p class="pr-note">' + rows.length + ' cavit' + (rows.length === 1 ? 'y' : 'ies') + ', ' + wired + ' wired.</p>';
}

/** The splices on one sheet: each splice and the ends it joins, a row per end (the splice's cells span its rows). */
function pinoutSplicesHtml(splices) {
    return '<p class="pr-note pinout-source">' + esc(pinoutSource()) + '</p><table class="pr-table pinout-table pinout-splices"><thead><tr><th>Splice</th>' +
        '<th>Type</th><th>Joins</th><th>Wire</th><th>Function</th></tr></thead>' + splices.map(function (s) {
        var ends = s.ends.length ? s.ends : [{ label: '', wire: '', function: '' }];
        return '<tbody>' + ends.map(function (e, i) {
            var head = i ? '' : '<td rowspan="' + ends.length + '"><strong>' + esc(s.id) + '</strong>' + (s.notes ? '<br><span class="muted">' + esc(s.notes) + '</span>' : '') +
                '</td><td rowspan="' + ends.length + '">' + esc(s.type) + (s.boot ? '<br><span class="muted">Boot ' + esc(s.boot) + '</span>' : '') + '</td>';
            return '<tr>' + head + '<td>' + (esc(e.label) || '<span class="status-warning">no ends</span>') + '</td><td>' + esc(e.wire) + '</td><td>' +
                esc(e.function) + '</td></tr>';
        }).join('') + '</tbody>';
    }).join('') + '</table>';
}

/** Report sections: a sheet per connector (each on its own page) and, when withSplices, a splice sheet. urls: { blockId: { imageId: url } }. */
function pinoutSections(connectors, urls, withSplices) {
    var wires = harnessCutList(state.model), pins = harnessPinouts(state.model, wires);
    var out = connectors.map(function (c) {
        return { title: 'Pinout — ' + c.id, html: pinoutSheetHtml(c, pins[c.id] || [], urls[c.id]), newPage: true };
    });
    if (withSplices && state.model.splices.length) out.push({ title: 'Splices', html: pinoutSplicesHtml(harnessSpliceSheet(state.model, wires)), newPage: true });
    return out;
}

/** Print pinout sheets of some connectors on their own (the connector editor's Pinout sheet button). */
function printPinouts(connectors) {
    return Promise.all(connectors.map(pdfImageUrls)).then(function (list) {
        var urls = {};
        connectors.forEach(function (c, i) { urls[c.id] = list[i]; });
        var sections = pinoutSections(connectors, urls, false);
        sections[0].newPage = false;
        if (connectors.length === 1) sections[0].title = '';   // the report title already names it
        var name = $('name-input').value.trim() || state.name || 'Harness';
        return prPrint({ title: connectors.length === 1 ? 'Pinout — ' + connectors[0].id : 'Pinout sheets — ' + name,
                         meta: [['Harness', name], ['Revision', state.revision ? state.revision + (state.dirty ? ' + unsaved changes' : '') : 'not saved']],
                         sections: sections, fileName: name + ' ' + (connectors.length === 1 ? connectors[0].id : '') + ' pinout' });
    });
}

// =========================================================================
// Revisions: compare two saved revisions, or one with what is open now (harness-diff.js)
// =========================================================================

function revisionLabel(rev) {
    if (rev === 'open') return state.revision ? 'what’s open now (revision ' + state.revision + (state.dirty ? ' + unsaved changes' : '') + ')' : 'what’s open now';
    var r = state.revisions.filter(function (x) { return x.revision === rev; })[0];
    return 'revision ' + rev + (r ? ' (' + new Date(r.saved).toLocaleString() + (r.note ? ' — ' + r.note : '') + ')' : '');
}

function revisionModel(rev) {
    if (rev === 'open') return Promise.resolve(state.model);
    var key = state.id + '|' + rev;
    if (state.revCache[key]) return Promise.resolve(state.revCache[key]);
    return hsLoad(state.id, rev).then(function (h) { return (state.revCache[key] = harnessUpgrade(h.data)); });
}

/** The default pair: unsaved changes against their revision, else the viewed revision against the one before it. */
function revisionDefaults() {
    var older = state.revisions.map(function (r) { return r.revision; }).filter(function (n) { return n < state.revision; });
    if (state.dirty || !older.length) return { from: state.revision, to: 'open' };
    return { from: Math.max.apply(null, older), to: 'open' };
}

function renderRevisions() {
    var el = $('revisions');
    if (!state.model) { el.innerHTML = ''; return; }
    if (!state.id || !state.revisions.length) {
        el.innerHTML = '<p class="muted">This harness isn’t saved yet. Every save is a revision; once there is one, you can compare it with later ones or with your unsaved changes.</p>';
        return;
    }
    var cur = state.compare || revisionDefaults();
    var opts = function (list, sel) {
        return list.map(function (v) { return '<option value="' + v + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(revisionLabel(v)) + '</option>'; }).join('');
    };
    var revs = state.revisions.map(function (r) { return r.revision; });
    el.innerHTML = '<div class="compare-row"><label for="rev-from">Compare</label><select id="rev-from" aria-label="Compare from">' + opts(revs, cur.from) +
        '</select><label for="rev-to">with</label><select id="rev-to" aria-label="Compare with">' + opts(['open'].concat(revs), cur.to) + '</select></div>' +
        '<div id="rev-result"><p class="muted">Comparing…</p></div>';
    compareRevisions(cur.from, cur.to);
}

function compareRevisions(from, to) {
    state.compare = { from: from, to: to, diff: null, fromLabel: revisionLabel(from), toLabel: revisionLabel(to) };
    var want = state.compare;
    Promise.all([revisionModel(from), revisionModel(to)]).then(function (models) {
        if (state.compare !== want) return;
        want.diff = harnessDiff(models[0], models[1]);
        if ($('rev-result')) $('rev-result').innerHTML = revisionsDiffHtml(false);
    }).catch(function (err) {
        if ($('rev-result')) $('rev-result').innerHTML = '<p class="status-error">Could not load the revision: ' + esc(err.message) + '</p>';
    });
}

function revValue(v) { return v === '' ? '<span class="muted">(blank)</span>' : esc(v); }

function revChangesHtml(changes) {
    return changes.map(function (c) {
        return '<strong>' + esc(c.label) + ':</strong> <span class="change-from">' + revValue(c.before) + '</span> → <span class="change-to">' + revValue(c.after) + '</span>';
    }).join('<br>');
}

/** A cavity or splice wire as one line: function · wire → where it goes. */
function revRecordText(rec, isConnector) {
    var parts = [harnessText(rec.function), harnessText(rec.wire)].filter(Boolean).join(' · ');
    var dest = harnessText(isConnector ? rec.remote : '');
    return esc(parts || '(no wire)') + (dest && !HARNESS_NO_REMOTE.test(dest) ? ' → ' + esc(dest) : '');
}

function revBlockHtml(e, isConnector, forPdf) {
    var kind = isConnector ? 'connectors' : 'splices', recs = isConnector ? e.after.pins : e.after.wires;
    var live = !forPdf && state.compare.to === 'open';
    var name = live ? '<button class="link-btn" data-rev-goto="' + kind + '|' + esc(e.id) + '|">' + esc(e.id) + '</button>' : esc(e.id);
    var html = '<div class="change-item"><h3>' + name + (e.renamedFrom ? ' <span class="param-kind">renamed from ' + esc(e.renamedFrom) + '</span>' : '') + '</h3>';
    if (e.fields.length) html += '<p class="change-note">' + revChangesHtml(e.fields) + '</p>';
    var pics = [e.images.added && e.images.added + ' picture' + (e.images.added === 1 ? '' : 's') + ' added',
                e.images.removed && e.images.removed + ' picture' + (e.images.removed === 1 ? '' : 's') + ' removed'].filter(Boolean);
    if (pics.length) html += '<p class="change-note">' + esc(pics.join(', ')) + '</p>';
    if (e.rows.length) {
        var order = { removed: 0, changed: 1, added: 2 };
        var rows = e.rows.slice().sort(function (a, b) {
            return a.key.localeCompare(b.key, undefined, { numeric: true }) || order[a.kind] - order[b.kind];
        });
        html += prTable([isConnector ? 'Cavity' : 'End', 'Change', 'Details'], rows.map(function (r) {
            var key = esc(r.key), idx = r.after ? recs.indexOf(r.after) : -1;
            if (live && idx >= 0) key = '<button class="link-btn" data-rev-goto="' + kind + '|' + esc(e.id) + '|' + idx + '">' + key + '</button>';
            var what = r.kind === 'added' ? '<span class="change-to">Added</span>' : r.kind === 'removed' ? '<span class="change-from">Removed</span>'
                : r.rewired ? '<span class="status-warning">Rewired</span>' : 'Changed';
            var details = r.kind === 'changed' ? revChangesHtml(r.fields) : revRecordText(r.after || r.before, isConnector);
            return [key, what, details];
        }), 'rev-table');
    }
    return html + '</div>';
}

function revAddedRemovedHtml(list, isConnector, added) {
    return list.map(function (b) {
        var n = isConnector ? b.pins.filter(harnessHasWire).length : b.wires.length;
        var detail = [isConnector ? harnessText(b.title) !== b.id ? harnessText(b.title) : '' : harnessText(b.type),
            isConnector ? harnessText(b.connector) : '', n + (isConnector ? ' wired cavit' + (n === 1 ? 'y' : 'ies') : ' wire' + (n === 1 ? '' : 's'))].filter(Boolean);
        return '<div class="change-item ' + (added ? 'change-added' : 'change-removed') + '"><h3>' + esc(b.id) + ' <span class="param-kind">' +
            (added ? 'added' : 'removed') + '</span></h3><p class="change-note">' + esc(detail.join(' · ')) + '</p></div>';
    }).join('');
}

function revisionsDiffHtml(forPdf) {
    var d = state.compare.diff;
    var html = '<p class="change-summary">' + (forPdf ? '' : '<strong>' + esc(state.compare.fromLabel) + '</strong> → <strong>' + esc(state.compare.toLabel) + '</strong>: ') +
        esc(harnessDiffSummary(d)) + '</p>';
    if (d.same) return html;
    var follow = d.counts.followRename;
    if (follow) html += '<p class="hint">' + follow + ' connection' + (follow === 1 ? '' : 's') + ' only changed to follow a rename; they aren’t listed.</p>';
    [[true, 'Connectors', d.connectors], [false, 'Splices', d.splices]].forEach(function (g) {
        var x = g[2];
        if (!x.added.length && !x.removed.length && !x.changed.length) return;
        html += '<h3>' + g[1] + '</h3>' + revAddedRemovedHtml(x.removed, g[0], false) + revAddedRemovedHtml(x.added, g[0], true) +
            x.changed.map(function (e) { return revBlockHtml(e, g[0], forPdf); }).join('');
    });
    if (d.lengths.length) {
        var unit = state.model.lengthUnit || 'mm';
        var shown = function (mm) { return mm === null ? '<span class="muted">none</span>' : esc(Math.round(mm / HB_UNIT_MM[unit] * 1000) / 1000 + ' ' + unit); };
        html += '<h3>Wire lengths</h3>' + prTable(['Wire', 'Before', 'After'], d.lengths.map(function (l) {
            return [esc(l.key.split('||').filter(function (p) { return p.charAt(0) !== '~'; }).map(function (p) { return p.replace(/#\d+$/, ''); }).join(' — ')), shown(l.before), shown(l.after)];
        }), 'rev-table');
    }
    return html;
}

$('revisions').addEventListener('change', function (e) {
    if (e.target.id !== 'rev-from' && e.target.id !== 'rev-to') return;
    var from = parseInt($('rev-from').value, 10), to = $('rev-to').value === 'open' ? 'open' : parseInt($('rev-to').value, 10);
    $('rev-result').innerHTML = '<p class="muted">Comparing…</p>';
    compareRevisions(from, to);
});
$('revisions').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rev-goto]');
    if (!b) return;
    var p = b.getAttribute('data-rev-goto').split('|');
    gotoRow(p[0], p[1], p[2] === '' ? null : parseInt(p[2], 10));
});

// =========================================================================
// CAN networks of the system (harness-can.js), saved with the system
// =========================================================================

function canNetworks() {
    if (!state.system) return [];
    if (!state.system.canNetworks) state.system.canNetworks = [];
    return state.system.canNetworks;
}

function canFindNet(id) { return canNetworks().filter(function (n) { return n.id === id; })[0] || null; }

function canList(net, kind) {
    return kind === 'hub' ? net.hubs : kind === 'device' ? net.devices : kind === 'feed' ? canFeeds(net) : net.terminators;
}

var canSaveTimer = null;

/** Save the system soon (typing) or now. */
function canSave(soon) {
    clearTimeout(canSaveTimer);
    var sys = state.system;
    if (!sys) return;
    canSaveTimer = setTimeout(function () {
        hsSaveSystem(sys.id, sys).catch(function (err) { showError('Could not save the CAN networks: ' + err.message); });
    }, soon ? 600 : 0);
}

function canCountText() {
    var n = canNetworks().length;
    return n ? String(n) : '';
}

function canChecksHtml(net) {
    var checks = canNetworkChecks(net, systemMembers(), canNetworks());
    return checks.length ? '<ul class="can-checks">' + checks.map(function (c) {
        return '<li>' + markerHtml([c]) + ' <strong>' + esc(c.where) + '</strong> — ' + esc(c.message) + '</li>';
    }).join('') + '</ul>' : '<p class="ok-banner">Two terminations, one speed, everything connected.</p>';
}

function canInput(net, kind, item, field, attrs) {
    return '<input type="text" class="text-input can-input can-' + field + '" data-net="' + esc(net.id) + '" data-kind="' + kind + '"' +
        (item ? ' data-id="' + esc(item.id) + '"' : '') + ' data-field="' + field + '" value="' + esc((item || net)[field]) + '"' + (attrs || '') + '>';
}

function canHubSelect(net, kind, item) {
    return '<select class="can-input" data-net="' + esc(net.id) + '" data-kind="' + kind + '" data-id="' + esc(item.id) + '" data-field="hub" ' +
        'aria-label="Hub for ' + esc(item.name) + '"><option value="">Not connected</option>' + net.hubs.map(function (h) {
            return '<option value="' + esc(h.id) + '"' + (h.id === item.hub ? ' selected' : '') + '>' + esc(h.name || '(no name)') + '</option>';
        }).join('') + '</select>';
}

/** Where a power feed goes in: a hub or a device. */
function canFeedSelect(net, feed) {
    function opt(value, label) { return '<option value="' + esc(value) + '"' + (feed.to === value ? ' selected' : '') + '>' + esc(label || '(no name)') + '</option>'; }
    return '<select class="can-input" data-net="' + esc(net.id) + '" data-kind="feed" data-id="' + esc(feed.id) + '" data-field="to" ' +
        'aria-label="Where ' + esc(feed.name) + ' feeds in"><option value="">Not connected</option>' +
        (net.hubs.length ? '<optgroup label="Hubs">' + net.hubs.map(function (h) { return opt('hub:' + h.id, h.name); }).join('') + '</optgroup>' : '') +
        (net.devices.length ? '<optgroup label="Devices">' + net.devices.map(function (d) { return opt('device:' + d.id, d.name); }).join('') + '</optgroup>' : '') +
        '</select>';
}

function canCheckbox(net, kind, item, field, label) {
    return '<label class="check-label"><input type="checkbox" class="can-input" data-net="' + esc(net.id) + '" data-kind="' + kind + '" data-id="' +
        esc(item.id) + '" data-field="' + field + '"' + (item[field] ? ' checked' : '') + '> ' + label + '</label>';
}

function canRemoveBtn(net, kind, item) {
    return '<button class="btn btn-small btn-danger" data-can-action="remove" data-net="' + esc(net.id) + '" data-kind="' + kind + '" data-id="' +
        esc(item.id) + '" aria-label="Remove ' + esc(item.name) + '">&times;</button>';
}

/** "CAN 2 · Rear hub" for a power link to another network. */
function canPowerLinkName(l) {
    var o = canFindNet(l.net), h = o ? canHub(o, l.to) : null;
    return h ? (o.name || 'CAN') + ' · ' + (h.name || '(no name)') : '(removed)';
}

/** The Pins cell: what is linked, and a button to show the pin pickers. */
function canPinsButton(net, kind, item) {
    var linked = canPinRoles(item, kind === 'feed').map(function (r) {
        var ref = (item.pins || {})[r];
        return ref && ref.cavity ? CAN_PIN_SHORT[r] + ' ' + canPinText(ref) : '';
    }).filter(Boolean);
    return '<button class="btn btn-small btn-secondary can-pins-btn" data-can-action="pins" data-net="' + esc(net.id) + '" data-id="' + esc(item.id) + '"' +
        ' aria-expanded="' + (state.canPinsOpen[item.id] ? 'true' : 'false') + '" title="' + esc(linked.length ? linked.join(', ') : 'Link this connection to harness pins') + '">' +
        esc(linked.length ? linked.join(' · ') : 'Link pins') + '</button>';
}

/** Connectors of every harness in the system, by harness, as select options (value = JSON [harnessId, connectorId]). */
function canConnectorOptions(ref) {
    var value = ref ? JSON.stringify([ref.harness, ref.connector]) : '', found = false;
    var html = systemMembers().slice().sort(byName).map(function (m) {
        return '<optgroup label="' + esc(m.name) + '">' + m.model.connectors.slice().sort(byName).map(function (c) {
            var v = JSON.stringify([m.id, c.id]);
            if (v === value) found = true;
            return '<option value="' + esc(v) + '"' + (v === value ? ' selected' : '') + '>' + esc(c.id + (c.title && c.title !== c.id ? ' — ' + c.title : '')) + '</option>';
        }).join('') + '</optgroup>';
    }).join('');
    // A link to a connector that is gone stays visible until it is changed.
    if (ref && !found) html = '<option value="' + esc(value) + '" selected>' + esc(canPinText({ connector: ref.connector }) + ' (not found)') + '</option>' + html;
    return '<option value="">Not linked</option>' + html;
}

/** The pin pickers under a device or feed row: one line per wire. */
function canPinsHtml(net, kind, item, colspan) {
    var members = systemMembers();
    function attrs(role, part) {
        return ' class="can-pin-input" data-net="' + esc(net.id) + '" data-kind="' + kind + '" data-id="' + esc(item.id) + '" data-role="' + role +
            '" data-part="' + part + '"';
    }
    var rows = canPinRoles(item, kind === 'feed').map(function (role) {
        var ref = (item.pins || {})[role], f = ref ? canFindPin(members, ref) : null, pins = f && f.connector ? f.connector.pins : [];
        var cav = ref ? String(ref.cavity || '').trim().toLowerCase() : '';
        var pinSel = '<select' + attrs(role, 'cavity') + (f && f.connector ? '' : ' disabled') + ' aria-label="' + esc(CAN_PIN_LABELS[role] + ' pin') + '">' +
            '<option value="">' + (f && f.connector ? 'Pick a pin' : '—') + '</option>' + pins.map(function (p) {
                var fn = harnessText(p.function);
                return '<option value="' + esc(p.cavity) + '"' + (String(p.cavity).trim().toLowerCase() === cav ? ' selected' : '') + '>' +
                    esc(p.cavity + (fn ? ' — ' + hdClip(fn, 34) : '')) + '</option>';
            }).join('') + (ref && ref.cavity && !(f && f.pin) ? '<option value="' + esc(ref.cavity) + '" selected>' + esc(ref.cavity + ' (not found)') + '</option>' : '') + '</select>';
        var pin = f && f.pin;
        return '<tr><td><span class="can-swatch can-swatch-' + role + '"></span>' + esc(CAN_PIN_LABELS[role]) + '</td>' +
            '<td><select' + attrs(role, 'connector') + ' aria-label="' + esc(CAN_PIN_LABELS[role] + ' connector') + '">' + canConnectorOptions(ref) + '</select></td>' +
            '<td>' + pinSel + '</td><td class="hint">' + esc(pin ? harnessText(pin.function) : '') + '</td><td class="hint">' + esc(pin ? harnessText(pin.wire) : '') + '</td>' +
            '<td class="actions">' + (pin ? '<button class="link-btn" data-can-action="goto-pin" data-net="' + esc(net.id) + '" data-key="' +
                esc(ref.harness + '|' + harnessEndpointName(ref.connector, pin.cavity)) + '" title="Go to this pin" aria-label="Go to ' +
                esc(canPinText(ref)) + '">&rarr;</button>' : '') + '</td></tr>';
    }).join('');
    return '<tr class="can-pins-row"><td colspan="' + colspan + '"><table class="can-pin-table"><thead><tr><th>Wire</th><th>Connector</th><th>Pin</th>' +
        '<th>Function</th><th>Wire</th><th><span class="sr-only">Go</span></th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="hint">Pick the connector and the pins are filled in from their functions ("CAN 1 High", "CAN 1 Low", …) where that is clear.</p></td></tr>';
}

/** Show a device or feed in the CAN tab with its pin links open. */
function canShowItem(id) {
    state.canPinsOpen[id] = true;
    selectTab('can');
    canFocus(id);
}

function canNetworkHtml(net) {
    var html = '<section class="system-section can-network" data-net-section="' + esc(net.id) + '"><div class="can-head">' +
        '<label>Network ' + canInput(net, 'net', null, 'name', ' aria-label="Network name"') + '</label>' +
        '<label>Speed ' + canInput(net, 'net', null, 'bitrate', ' list="can-bitrates" placeholder="kbit/s" aria-label="Network speed (kbit/s)"') + ' kbit/s</label>' +
        '<label class="can-notes">Notes ' + canInput(net, 'net', null, 'notes', ' aria-label="Network notes"') + '</label>' +
        '<button class="btn btn-small btn-secondary" data-can-action="diagram" data-net="' + esc(net.id) + '">Diagram</button>' +
        '<button class="btn btn-small btn-danger" data-can-action="delete-network" data-net="' + esc(net.id) + '">Delete network</button></div>' +
        '<div class="can-checks-wrap" id="can-checks-' + esc(net.id) + '">' + canChecksHtml(net) + '</div>';

    html += '<h4>Devices</h4>' + (net.devices.length ? '<div class="table-scroll"><table class="event-table data-table can-table"><thead><tr>' +
        '<th>Device</th><th>Hub</th><th>Termination</th><th title="Powered through its CAN connection (+12 V and ground in the CAN cable)">Power</th>' +
        '<th>Speed (kbit/s)</th><th>Pins</th><th>Notes</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        net.devices.map(function (d) {
            return '<tr><td>' + canInput(net, 'device', d, 'name', ' aria-label="Device name"') + '</td><td>' + canHubSelect(net, 'device', d) + '</td>' +
                '<td>' + canCheckbox(net, 'device', d, 'termination', '120 Ω on') + '</td>' +
                '<td>' + canCheckbox(net, 'device', d, 'power', 'From CAN') + '</td>' +
                '<td>' + canInput(net, 'device', d, 'bitrate', ' list="can-bitrates" placeholder="' + esc(net.bitrate ? 'network' : 'kbit/s') +
                    '" aria-label="Device speed (kbit/s)"') + '</td><td>' + canPinsButton(net, 'device', d) + '</td>' +
                '<td>' + canInput(net, 'device', d, 'notes', ' aria-label="Device notes"') + '</td><td class="actions">' + canRemoveBtn(net, 'device', d) + '</td></tr>' +
                (state.canPinsOpen[d.id] ? canPinsHtml(net, 'device', d, 8) : '');
        }).join('') + '</tbody></table></div>' : '<p class="muted">No devices yet.</p>') +
        '<button class="btn btn-small btn-secondary" data-can-action="add-device" data-net="' + esc(net.id) + '">Add device</button>';

    html += '<h4>Hubs</h4>' + (net.hubs.length ? '<div class="table-scroll"><table class="event-table data-table can-table"><thead><tr>' +
        '<th>Hub</th><th title="CAN: CAN-H/CAN-L between the hubs. Power: +12 V and ground between them.">Connects to hubs</th>' +
        '<th title="Power hubs that split the data buses: power shared with a hub of another network, with no CAN between them">Power shared with other networks</th>' +
        '<th>Notes</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        net.hubs.map(function (h) {
            var others = net.hubs.filter(function (o) { return o !== h; });
            function tick(o, field, on, label) {
                return '<label class="check-label"><input type="checkbox" class="can-input" data-net="' + esc(net.id) + '" data-kind="hub" data-id="' +
                    esc(h.id) + '" data-field="' + field + '" data-other="' + esc(o.id) + '"' + (on ? ' checked' : '') + '> ' + label + '</label>';
            }
            var away = [];
            canNetworks().forEach(function (n) {
                if (n === net) return;
                n.hubs.forEach(function (oh) {
                    away.push('<label class="check-label can-link"><input type="checkbox" class="can-input" data-net="' + esc(net.id) + '" data-kind="hub" data-id="' +
                        esc(h.id) + '" data-field="xpower" data-other-net="' + esc(n.id) + '" data-other="' + esc(oh.id) + '"' +
                        (canPowerLinked(net, h.id, n, oh.id) ? ' checked' : '') + '> ' + esc((n.name || 'CAN') + ' · ' + (oh.name || '(no name)')) + '</label>');
                });
            });
            return '<tr><td>' + canInput(net, 'hub', h, 'name', ' aria-label="Hub name"') + '</td><td>' + (others.length ? others.map(function (o) {
                return '<span class="can-link"><span data-hub-name="' + esc(o.id) + '">' + esc(o.name || '(no name)') + '</span>: ' +
                    tick(o, 'link', canHubLinked(net, h.id, o.id), 'CAN') + ' ' + tick(o, 'linkpower', canHubPowerLinked(net, h.id, o.id), 'Power') + '</span>';
            }).join('') : '<span class="muted">No other hubs</span>') + '</td>' +
                '<td>' + (away.length ? away.join('') : '<span class="muted">No hubs in other networks</span>') + '</td>' +
                '<td>' + canInput(net, 'hub', h, 'notes', ' aria-label="Hub notes"') + '</td><td class="actions">' + canRemoveBtn(net, 'hub', h) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">No hubs yet.</p>') +
        '<button class="btn btn-small btn-secondary" data-can-action="add-hub" data-net="' + esc(net.id) + '">Add hub</button>';

    html += '<h4>Terminators</h4>' + (net.terminators.length ? '<div class="table-scroll"><table class="event-table data-table can-table"><thead><tr>' +
        '<th>Terminator (120 Ω)</th><th>Plugged into hub</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        net.terminators.map(function (t) {
            return '<tr><td>' + canInput(net, 'term', t, 'name', ' aria-label="Terminator name"') + '</td><td>' + canHubSelect(net, 'term', t) + '</td>' +
                '<td class="actions">' + canRemoveBtn(net, 'term', t) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">No standalone terminators.</p>') +
        '<button class="btn btn-small btn-secondary" data-can-action="add-term" data-net="' + esc(net.id) + '">Add terminator</button>';

    var feeds = canFeeds(net), names = net.devices.map(function (d) { return d.name; }).filter(Boolean);
    html += '<h4>Power feeds</h4>' + (feeds.length ? '<div class="table-scroll"><table class="event-table data-table can-table"><thead><tr>' +
        '<th>Feed</th><th>Power comes from</th><th>Feeds into</th><th>Pins</th><th>Notes</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        feeds.map(function (f) {
            return '<tr><td>' + canInput(net, 'feed', f, 'name', ' aria-label="Feed name"') + '</td>' +
                '<td>' + canInput(net, 'feed', f, 'source', ' list="can-sources-' + esc(net.id) + '" placeholder="e.g. PDM30 OUT 5" aria-label="Where the power comes from"') + '</td>' +
                '<td>' + canFeedSelect(net, f) + '</td><td>' + canPinsButton(net, 'feed', f) + '</td>' +
                '<td>' + canInput(net, 'feed', f, 'notes', ' aria-label="Feed notes"') + '</td>' +
                '<td class="actions">' + canRemoveBtn(net, 'feed', f) + '</td></tr>' + (state.canPinsOpen[f.id] ? canPinsHtml(net, 'feed', f, 6) : '');
        }).join('') + '</tbody></table></div>' : '<p class="muted">No power feeds.</p>') +
        '<datalist id="can-sources-' + esc(net.id) + '">' + names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>' +
        '<button class="btn btn-small btn-secondary" data-can-action="add-feed" data-net="' + esc(net.id) + '">Add power feed</button>';
    return html + '</section>';
}

function renderCan() {
    var el = $('can');
    $('count-can').textContent = canCountText();
    if (!state.system) {
        el.innerHTML = '<p class="muted">CAN networks belong to a harness system. Choose a system in the <strong>System</strong> list above ' +
            '(or <strong>New system…</strong>) to add networks to it.</p>' + (state.id ? '' : '<p class="muted">Save the harness first.</p>');
        return;
    }
    el.innerHTML = '<datalist id="can-bitrates">' + CAN_BITRATES.map(function (b) { return '<option value="' + b + '">'; }).join('') + '</datalist>' +
        canNetworks().map(canNetworkHtml).join('') +
        '<button class="btn btn-secondary" data-can-action="add-network">Add CAN network</button>';
}

/** Show a newly added row's name field. */
function canFocus(id) {
    var input = $('can').querySelector('input[data-id="' + id + '"][data-field="name"]');
    if (input) { input.focus(); input.select(); }
}

$('can').addEventListener('click', function (e) {
    var b = e.target.closest('[data-can-action]');
    if (!b || !state.system) return;
    var action = b.getAttribute('data-can-action'), net = canFindNet(b.getAttribute('data-net')), item, focus = null;
    if (action === 'add-network') {
        var n = canNewNetwork('CAN ' + (canNetworks().length + 1));
        canNetworks().push(n);
        focus = n.id;
        renderCan(); canSave();
        var input = $('can').querySelector('input[data-net="' + n.id + '"][data-kind="net"][data-field="name"]');
        if (input) { input.focus(); input.select(); }
        return;
    }
    if (!net) return;
    if (action === 'delete-network') {
        if (!window.confirm('Delete the CAN network "' + net.name + '" with its ' + net.devices.length + ' devices and ' + net.hubs.length + ' hubs?')) return;
        state.system.canNetworks = canNetworks().filter(function (x) { return x !== net; });
        canForgetPowerLinks(canNetworks(), net.id);
    } else if (action === 'pins') {
        var pid = b.getAttribute('data-id');
        if (state.canPinsOpen[pid]) delete state.canPinsOpen[pid]; else state.canPinsOpen[pid] = true;
        renderCan();
        return;
    } else if (action === 'goto-pin') {
        gotoSystemEndpoint(b.getAttribute('data-key'));
        return;
    } else if (action === 'diagram') {
        state.diagram = 'can:' + net.id;
        selectTab('diagram');
        return;
    } else if (action === 'add-device') {
        item = { id: canId(), name: 'Device ' + (net.devices.length + 1), hub: net.hubs.length === 1 ? net.hubs[0].id : '', termination: false, bitrate: '', notes: '' };
        net.devices.push(item);
    } else if (action === 'add-hub') {
        item = { id: canId(), name: 'Hub ' + (net.hubs.length + 1), notes: '' };
        if (net.hubs.length) canSetHubLink(net, net.hubs[net.hubs.length - 1].id, item.id, true);   // usually chained to the last one
        net.hubs.push(item);
    } else if (action === 'add-feed') {
        item = { id: canId(), name: 'Power feed ' + (canFeeds(net).length + 1), source: '', to: net.hubs.length === 1 ? 'hub:' + net.hubs[0].id : '', notes: '' };
        canFeeds(net).push(item);
    } else if (action === 'add-term') {
        item = { id: canId(), name: 'Terminator ' + (net.terminators.length + 1), hub: net.hubs.length === 1 ? net.hubs[0].id : '' };
        net.terminators.push(item);
    } else if (action === 'remove') {
        var kind = b.getAttribute('data-kind'), id = b.getAttribute('data-id');
        if (kind === 'hub') canRemoveHub(net, id, canNetworks());
        else if (kind === 'device') canRemoveDevice(net, id);
        else if (kind === 'feed') net.feeds = canFeeds(net).filter(function (x) { return x.id !== id; });
        else net.terminators = net.terminators.filter(function (x) { return x.id !== id; });
    }
    if (item) focus = item.id;
    renderCan(); canSave();
    if (focus) canFocus(focus);
});

// Typing: update and save, refresh the checks and hub names in place (re-rendering would lose the focus).
$('can').addEventListener('input', function (e) {
    var t = e.target;
    if (!t.classList.contains('can-input') || t.type === 'checkbox' || t.tagName === 'SELECT') return;
    var net = canFindNet(t.getAttribute('data-net'));
    if (!net) return;
    var kind = t.getAttribute('data-kind'), field = t.getAttribute('data-field');
    var target = kind === 'net' ? net : canList(net, kind).filter(function (x) { return x.id === t.getAttribute('data-id'); })[0];
    if (!target) return;
    target[field] = field === 'bitrate' ? t.value.trim() : t.value;
    if (kind === 'hub' && field === 'name') {
        $('can').querySelectorAll('option[value="' + target.id + '"], option[value="hub:' + target.id + '"], [data-hub-name="' + target.id + '"]').forEach(function (o) {
            o.textContent = target.name || '(no name)';
        });
    }
    if (kind === 'device' && field === 'name') {
        $('can').querySelectorAll('option[value="device:' + target.id + '"]').forEach(function (o) { o.textContent = target.name || '(no name)'; });
    }
    if (kind === 'net' && field === 'bitrate') {
        $('can').querySelectorAll('input[data-net="' + net.id + '"][data-kind="device"][data-field="bitrate"]').forEach(function (i) {
            i.placeholder = net.bitrate ? 'network' : 'kbit/s';
        });
    }
    var checks = document.getElementById('can-checks-' + net.id);
    if (checks) checks.innerHTML = canChecksHtml(net);
    canSave(true);
});

$('can').addEventListener('change', function (e) {
    var t = e.target;
    if (t.classList.contains('can-pin-input')) { canPinChange(t); return; }
    if (!t.classList.contains('can-input') || (t.type !== 'checkbox' && t.tagName !== 'SELECT')) return;
    var net = canFindNet(t.getAttribute('data-net'));
    if (!net) return;
    var kind = t.getAttribute('data-kind'), field = t.getAttribute('data-field');
    var target = canList(net, kind).filter(function (x) { return x.id === t.getAttribute('data-id'); })[0];
    if (!target) return;
    if (field === 'link') canSetHubLink(net, target.id, t.getAttribute('data-other'), t.checked, canHubLink(net, target.id, t.getAttribute('data-other')) ? 'data' : undefined);
    else if (field === 'linkpower') canSetHubLink(net, target.id, t.getAttribute('data-other'), t.checked, 'power');
    else if (field === 'xpower') canSetPowerLink(net, target.id, canFindNet(t.getAttribute('data-other-net')), t.getAttribute('data-other'), t.checked);
    else if (field === 'termination' || field === 'power') target[field] = t.checked;
    else if (field === 'hub' || field === 'to') target[field] = t.value;
    renderCan(); canSave();
});

/** A connector or pin picked for one of a device's or feed's wires. Picking a connector fills the wires it can tell from the functions. */
function canPinChange(t) {
    var net = canFindNet(t.getAttribute('data-net'));
    if (!net) return;
    var kind = t.getAttribute('data-kind'), role = t.getAttribute('data-role');
    var item = canList(net, kind).filter(function (x) { return x.id === t.getAttribute('data-id'); })[0];
    if (!item) return;
    var pins = item.pins = item.pins || {};
    if (t.getAttribute('data-part') === 'cavity') {
        if (pins[role]) pins[role].cavity = t.value;
    } else if (!t.value) {
        delete pins[role];
    } else {
        var hc = JSON.parse(t.value), s = canSuggestPins(net, item, kind === 'feed', systemMembers(), hc[0], hc[1]);
        pins[role] = { harness: hc[0], connector: hc[1], cavity: s[role] || '' };
        canPinRoles(item, kind === 'feed').forEach(function (r) {
            if (r !== role && !pins[r] && s[r]) pins[r] = { harness: hc[0], connector: hc[1], cavity: s[r] };
        });
    }
    renderCan(); canSave();
}

// =========================================================================
// Add from .xlsx — copy blocks from another workbook into the open harness
// =========================================================================

var addState = null;   // { file, incoming }

/** Same contents, ignoring the sheet and pictures. */
function sameBlock(a, b) {
    function key(x) {
        return JSON.stringify([x.title, x.connector, x.mateConn, x.matePin, x.type, x.boot, x.notes,
            (x.pins || x.wires || []).map(function (r) { return (x.pins ? HARNESS_PIN_FIELDS.concat('chassis', 'cable') : HARNESS_WIRE_FIELDS).map(function (f) { return harnessText(r[f]); }); })]);
    }
    return !!a.pins === !!b.pins && key(a) === key(b);
}

function openAddDialog(file) {
    showError('');
    setStatus('Reading ' + file.name + '…');
    file.arrayBuffer().then(readXlsx).then(function (wb) {
        var incoming = harnessFromWorkbook(wb, file.name);
        addState = { file: file, incoming: incoming };
        setStatus('');
        $('add-title').textContent = 'Add from ' + file.name;
        $('add-list').innerHTML = harnessSheetGroups(incoming).map(function (sheet, si) {
            var blocks = sheet.connectors.slice().sort(byName).concat(sheet.splices.slice().sort(byName));
            if (!blocks.length) return '';
            return '<fieldset class="pdf-options"><legend><label><input type="checkbox" data-add-sheet="' + si + '"> ' + esc(sheet.name) +
                ' <span class="count">' + blocks.length + '</span></label></legend>' + blocks.map(function (b) {
                    var mine = harnessFindBlock(state.model, b.id), n = b.pins ? b.pins.length : b.wires.length;
                    var meta = (b.pins ? 'connector · ' + n + ' cavit' + (n === 1 ? 'y' : 'ies') : 'splice · ' + n + ' wire' + (n === 1 ? '' : 's')) +
                        ((b.images || []).length ? ' · ' + b.images.length + ' picture' + (b.images.length === 1 ? '' : 's') : '');
                    var html = '<div class="add-row" data-add-sheet-of="' + si + '"><label><input type="checkbox" data-add-id="' + esc(b.id) + '"' +
                        (mine ? '' : ' checked') + '> <span class="block-id">' + esc(b.id) + '</span> <span class="count">' + esc(meta) + '</span></label>';
                    if (mine) {
                        var kindClash = !!mine.pins !== !!b.pins;
                        html += '<span class="add-clash">' + (kindClash ? 'Name used by a ' + (mine.pins ? 'connector' : 'splice') + ' here'
                            : sameBlock(mine, b) ? 'Already here, identical' : 'Already here, different') + '</span>' +
                            '<select data-add-action aria-label="What to do with ' + esc(b.id) + '">' +
                            (kindClash ? '' : '<option value="replace">Replace yours</option>') + '<option value="rename">Add as</option></select>' +
                            '<input type="text" class="text-input" data-add-newid aria-label="New name for ' + esc(b.id) + '" value="' +
                            esc(harnessFreeId([state.model, incoming], b.id)) + '"' + (kindClash ? '' : ' hidden') + '>';
                    }
                    return html + '</div>';
                }).join('') + '</fieldset>';
        }).join('') || '<p class="muted">No connectors or splices in this spreadsheet.</p>';
        $('add-error').hidden = true;
        addUpdate();
        $('add-dialog').returnValue = '';
        $('add-dialog').showModal();
    }).catch(function (err) {
        setStatus('');
        showError('Could not read ' + file.name + ': ' + err.message);
    }).then(function () { $('add-input').value = ''; });
}

/** Sheet checkboxes follow their rows; the summary counts what will be added. */
function addUpdate() {
    var list = $('add-list'), picks = addPicks();
    list.querySelectorAll('[data-add-sheet]').forEach(function (box) {
        var rows = list.querySelectorAll('[data-add-sheet-of="' + box.getAttribute('data-add-sheet') + '"] [data-add-id]');
        var on = [].filter.call(rows, function (r) { return r.checked; }).length;
        box.checked = on === rows.length && on > 0;
        box.indeterminate = on > 0 && on < rows.length;
    });
    var n = { add: 0, replace: 0, rename: 0 };
    picks.forEach(function (p) { n[p.action]++; });
    $('add-summary').textContent = picks.length ? 'Adds ' + (n.add + n.rename) + (n.rename ? ' (' + n.rename + ' renamed)' : '') +
        (n.replace ? ', replaces ' + n.replace : '') + '.' : 'Nothing picked.';
    $('add-ok').disabled = !picks.length;
}

function addPicks() {
    var picks = [];
    $('add-list').querySelectorAll('.add-row').forEach(function (row) {
        var box = row.querySelector('[data-add-id]'), sel = row.querySelector('[data-add-action]');
        if (!box.checked) return;
        picks.push({ id: box.getAttribute('data-add-id'), action: sel ? sel.value : 'add',
                     newId: sel ? row.querySelector('[data-add-newid]').value.trim() : '' });
    });
    return picks;
}

/** A problem with the picked names, or ''. */
function addProblem(picks) {
    var taken = {};
    state.model.connectors.concat(state.model.splices).forEach(function (b) { taken[b.id.toLowerCase()] = true; });
    picks.forEach(function (p) { if (p.action === 'replace') delete taken[p.id.toLowerCase()]; });
    for (var i = 0; i < picks.length; i++) {
        var p = picks[i], name = p.action === 'rename' ? p.newId : p.id;
        if (p.action === 'replace') { taken[name.toLowerCase()] = true; continue; }
        if (!name) return 'Give ' + p.id + ' a new name.';
        if (p.action === 'rename' && /\s/.test(name)) return '"' + name + '": names cannot contain spaces.';
        if (taken[name.toLowerCase()]) return '"' + name + '" is already used' + (p.action === 'rename' ? ' — pick another name for ' + p.id : '') + '.';
        taken[name.toLowerCase()] = true;
    }
    return '';
}

function addPicked() {
    var picks = addPicks(), file = addState.file, incoming = addState.incoming, result;
    try { result = harnessMergeBlocks(state.model, incoming, picks); } catch (err) { showError(err.message); return; }
    addState = null;
    setStatus('Storing pictures…');
    hsStoreModelImages(state.model).then(function () {
        var names = result.added.concat(result.renamed.map(function (r) { return r[1]; }), result.replaced);
        var first = names.map(function (id) { return findConnector(id); }).filter(Boolean)[0];
        if (first) state.selConnector = first.id;
        else if (names.length) state.selSplice = names[0];
        setDirty(true);
        runChecks();
        renderAll();
        if (!first && names.length) selectTab('splices'); else if (first) selectTab('connectors');
        var a = result.added.length + result.renamed.length;
        setStatus('From ' + file.name + ': added ' + a + (result.renamed.length ? ' (' + result.renamed.map(function (r) { return r[0] + ' as ' + r[1]; }).join(', ') + ')' : '') +
            (result.replaced.length ? ', replaced ' + result.replaced.join(', ') : '') + '. Not saved yet — press Save to keep them.');
    }).catch(function (err) { setStatus(''); showError('Could not store the pictures: ' + err.message); });
}

$('add-btn').addEventListener('click', function () { if (state.model) $('add-input').click(); });
$('add-input').addEventListener('change', function () { if (this.files[0]) openAddDialog(this.files[0]); });
$('add-list').addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-add-sheet')) {
        $('add-list').querySelectorAll('[data-add-sheet-of="' + t.getAttribute('data-add-sheet') + '"] [data-add-id]').forEach(function (b) { b.checked = t.checked; });
    }
    if (t.hasAttribute('data-add-action')) t.parentNode.querySelector('[data-add-newid]').hidden = t.value !== 'rename';
    $('add-error').hidden = true;
    addUpdate();
});
$('add-list').addEventListener('input', function () { $('add-error').hidden = true; addUpdate(); });
$('add-ok').addEventListener('click', function (e) {
    var problem = addProblem(addPicks());
    if (!problem) return;
    e.preventDefault();
    $('add-error').textContent = problem;
    $('add-error').hidden = false;
});
$('add-dialog').addEventListener('close', function () {
    if ($('add-dialog').returnValue === 'add' && addState) addPicked();
    addState = null;
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
    var canItem = e.target.closest('[data-can-item]');
    if (canItem) {
        selectTab('can');
        canFocus(canItem.getAttribute('data-can-item'));
        return;
    }
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
