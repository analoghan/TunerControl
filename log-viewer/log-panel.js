/**
 * log-viewer/log-panel.js — Log Viewer panel: channel picker, chart (log-chart.js), and the VE / transient analysis
 * overlays. Used by the Log Viewer page and embedded in VE Table Tuning and the Transient Fuel Analyzer.
 *
 *   var panel = new LogPanel(container, { preset: 'fuelling' | 'transient', storageKey })
 *   panel.open(file)                        → Promise   reads the log and shows the preset channels
 *   panel.analyze({ ve, tf, veTable })      → Promise   runs both tools' filters/detection on the log (their settings)
 *   panel.showCell(m, r, label)             → Promise   highlights the samples that count towards VE cell (m, r)
 *   panel.showEvent(time)                               zooms to the transient event starting at `time`
 */

var LV_SCRIPT_BASE = (function () {
    var s = typeof document !== 'undefined' && document.currentScript;
    return s ? new URL('.', s.src).href : '';
})();

var LV_COLORS = ['#ff5a6e', '#4fc3f7', '#ffd54f', '#81c784', '#ce93d8', '#ffb74d', '#90a4ae', '#f48fb1', '#4db6ac', '#e6ee9c'];

/** VE_REASON codes → label and band colour. */
var LV_VE_REASONS = {
    1: ['Run time', 'rgba(150,150,150,0.20)'], 2: ['Coolant', 'rgba(66,165,245,0.20)'], 3: ['Overrun / fuel cut', 'rgba(244,67,54,0.25)'],
    4: ['Decel', 'rgba(255,152,0,0.22)'], 5: ['TPS rate', 'rgba(255,235,59,0.18)'], 6: ['Not steady', 'rgba(171,71,188,0.22)'],
    7: ['Below min MAP', 'rgba(38,166,154,0.20)'], 8: ['Lambda implausible', 'rgba(236,64,122,0.25)'], 9: ['No lambda / outside table', 'rgba(90,90,90,0.25)'],
    10: ['Outlier', 'rgba(141,110,99,0.30)'],
};

var LV_PRESETS = {
    fuelling: [['Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Exhaust Lambda', 'Fuel Mixture Aim'],
        ['Fuel Closed Loop Control Bank 1 Trim', 'Fuel Closed Loop Control Bank 2 Trim'], ['Inlet Manifold Pressure'], ['Engine Speed'],
        ['Throttle Position']],
    transient: [['Exhaust Lambda Bank 1', 'Exhaust Lambda Bank 2', 'Exhaust Lambda', 'Fuel Mixture Aim'], ['Inlet Manifold Pressure'],
        ['Throttle Position'], ['Engine Overrun State'], ['Fuel Output Cut Count']],
};

function lvEsc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function LogPanel(container, opts) {
    this.opts = opts || {};
    this.root = container;
    this.channels = [];
    this.byName = {};
    this.loaded = {};      // channel id → trace
    this.panes = [];       // [[channel id]]
    this.analysis = null;
    this.hiddenReasons = {};
    this.showVe = this.opts.showVe !== false;
    this.showTf = this.opts.showTf !== false;
    this.cell = null;
    this.selEvent = null;
    this._pending = {};
    this._seq = 0;
    this._build();
}

LogPanel.prototype._build = function () {
    var self = this;
    this.root.classList.add('lv-panel');
    this.root.innerHTML =
        '<div class="lv-toolbar">' +
        '  <select class="lv-preset" aria-label="Channel layout"><option value="fuelling">Fuelling layout</option>' +
        '    <option value="transient">Transient layout</option><option value="saved">My layout</option></select>' +
        '  <input type="text" class="lv-add" list="" placeholder="Add a channel…" aria-label="Add a channel">' +
        '  <select class="lv-to" aria-label="Add to pane"></select>' +
        '  <button type="button" class="lv-btn lv-add-btn">Add</button>' +
        '  <span class="lv-spacer"></span>' +
        '  <button type="button" class="lv-btn lv-zin" title="Zoom in (+)">＋</button>' +
        '  <button type="button" class="lv-btn lv-zout" title="Zoom out (−)">－</button>' +
        '  <button type="button" class="lv-btn lv-fit" title="Show the whole log (0)">Fit</button>' +
        '  <span class="lv-range"></span>' +
        '</div>' +
        '<div class="lv-status" hidden></div>' +
        '<div class="lv-overlays" hidden>' +
        '  <label><input type="checkbox" class="lv-ve-on" checked> VE filters</label><span class="lv-legend lv-ve-legend"></span>' +
        '  <label><input type="checkbox" class="lv-tf-on" checked> Transient events</label><span class="lv-legend lv-tf-legend"></span>' +
        '</div>' +
        '<div class="lv-cell" hidden></div>' +
        '<div class="lv-chart"></div>' +
        '<p class="lv-hint">Drag across the chart to zoom in · wheel to zoom · shift + drag or shift + wheel to pan · double-click to show everything · ' +
        'click or drag the overview strip to move.</p>' +
        '<div class="lv-panes"></div>' +
        '<div class="lv-events" hidden></div>';
    var q = function (c) { return self.root.querySelector(c); };
    this.el = { preset: q('.lv-preset'), add: q('.lv-add'), to: q('.lv-to'), addBtn: q('.lv-add-btn'), range: q('.lv-range'), status: q('.lv-status'),
        overlays: q('.lv-overlays'), veLegend: q('.lv-ve-legend'), tfLegend: q('.lv-tf-legend'), cell: q('.lv-cell'), chart: q('.lv-chart'),
        panes: q('.lv-panes'), events: q('.lv-events'), veOn: q('.lv-ve-on'), tfOn: q('.lv-tf-on') };
    this.listId = 'lv-list-' + Math.random().toString(36).slice(2);
    var dl = document.createElement('datalist');
    dl.id = this.listId;
    this.root.appendChild(dl);
    this.el.add.setAttribute('list', this.listId);
    this.el.preset.value = this.opts.preset || 'fuelling';
    this.el.veOn.checked = this.showVe;
    this.el.tfOn.checked = this.showTf;

    this.chart = new LogChart(this.el.chart, { onRange: function (t0, t1) { self.el.range.textContent = lcClock(t0) + ' – ' + lcClock(t1); } });
    q('.lv-zin').onclick = function () { self.chart.zoom(0.5); };
    q('.lv-zout').onclick = function () { self.chart.zoom(2); };
    q('.lv-fit').onclick = function () { self.chart.fit(); };
    this.el.preset.onchange = function () { self._applyPreset(self.el.preset.value); };
    this.el.addBtn.onclick = function () { self._addTyped(); };
    this.el.add.onkeydown = function (e) { if (e.key === 'Enter') self._addTyped(); };
    this.el.veOn.onchange = function () { self.showVe = self.el.veOn.checked; self._overlays(); };
    this.el.tfOn.onchange = function () { self.showTf = self.el.tfOn.checked; self._overlays(); };
};

// --- worker ---------------------------------------------------------------------------------------------------

LogPanel.prototype._worker = function () {
    if (this.worker) return this.worker;
    var urls = ['../ve-table/worker.js', '../transient-fuel/worker.js', 'log-file.js', 'worker.js'].map(function (u) {
        return JSON.stringify(new URL(u, LV_SCRIPT_BASE).href);
    });
    var blob = new Blob(['importScripts(' + urls.join(',') + ');'], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob), self = this;
    this.worker = new Worker(url);
    URL.revokeObjectURL(url);
    this.worker.onmessage = function (e) {
        var reply = { open: 'opened', analyze: 'analysis', channels: 'channels', cell: 'cell' };
        var msg = e.data, key = msg.type === 'error' ? reply[msg.for] : msg.type, p = self._pending[key];
        if (!p) return;
        delete self._pending[key];
        if (msg.type === 'error') p.reject(new Error(msg.message)); else p.resolve(msg);
    };
    this.worker.onerror = function (e) {
        Object.keys(self._pending).forEach(function (k) { self._pending[k].reject(new Error(e.message || 'Log viewer worker failed')); });
        self._pending = {};
    };
    return this.worker;
};

/** One outstanding request per message type; a newer one replaces (and rejects) the older. */
LogPanel.prototype._ask = function (type, msg, transfer) {
    var self = this;
    return new Promise(function (resolve, reject) {
        if (self._pending[type]) self._pending[type].reject(new Error('superseded'));
        self._pending[type] = { resolve: resolve, reject: reject };
        self._worker().postMessage(Object.assign({ type: type }, msg), transfer || []);
    });
};

LogPanel.prototype._status = function (text, isError) {
    this.el.status.hidden = !text;
    this.el.status.textContent = text || '';
    this.el.status.classList.toggle('error', !!isError);
};

// --- loading --------------------------------------------------------------------------------------------------

LogPanel.prototype.open = function (file) {
    var self = this, isCsv = /\.csv$/i.test(file.name);
    if (this.worker) { this.worker.terminate(); this.worker = null; this._pending = {}; }
    this.loaded = {};
    this.analysis = null;
    this.cell = null;
    this.selEvent = null;
    this.fileName = file.name;
    this._status('Reading ' + file.name + '…');
    return (isCsv ? file.text() : file.arrayBuffer()).then(function (data) {
        return self._ask('opened', { type: 'open', data: data, name: file.name }, isCsv ? [] : [data]);
    }).then(function (msg) {
        self.channels = msg.channels;
        self.byName = {};
        msg.channels.forEach(function (c) { if (!(c.name.toLowerCase() in self.byName)) self.byName[c.name.toLowerCase()] = c; });
        var dl = document.getElementById(self.listId);
        dl.innerHTML = msg.channels.map(function (c) {
            return '<option value="' + lvEsc(c.name) + '">' + lvEsc((c.unit ? c.unit + ' · ' : '') + c.freq + ' Hz') + '</option>';
        }).join('');
        self.duration = msg.duration;
        self.chart.setDuration(msg.duration);
        self._status(file.name + ' — ' + msg.channels.length + ' channels, ' + lcClock(msg.duration) + ' long.');
        return self._applyPreset(self.el.preset.value);
    }).catch(function (err) {
        if (err.message !== 'superseded') self._status('Could not read the log: ' + err.message, true);
        throw err;
    });
};

LogPanel.prototype._layoutNames = function (preset) {
    if (preset === 'saved') {
        try {
            var saved = JSON.parse(localStorage.getItem(this._storageKey()) || 'null');
            if (Array.isArray(saved) && saved.length) return saved;
        } catch (e) { /* storage unavailable */ }
        preset = 'fuelling';
    }
    return LV_PRESETS[preset] || LV_PRESETS.fuelling;
};

LogPanel.prototype._storageKey = function () { return 'tunercontrol.logviewer.layout.' + (this.opts.storageKey || 'default'); };

LogPanel.prototype._saveLayout = function () {
    var self = this;
    try {
        localStorage.setItem(this._storageKey(), JSON.stringify(this.panes.map(function (p) {
            return p.map(function (id) { return self.channels[id].name; });
        })));
    } catch (e) { /* storage unavailable: the layout just isn't remembered */ }
};

LogPanel.prototype._applyPreset = function (preset) {
    var self = this, names = this._layoutNames(preset);
    var hasBank = !!(this.byName['exhaust lambda bank 1'] || this.byName['exhaust lambda bank 2']);
    this.panes = names.map(function (pane) {
        return pane.filter(function (n) { return !(hasBank && n === 'Exhaust Lambda'); })
            .map(function (n) { var c = self.byName[n.toLowerCase()]; return c ? c.id : -1; })
            .filter(function (id) { return id >= 0; });
    }).filter(function (p) { return p.length; });
    return this._sync();
};

/** Loads any channel in the panes not loaded yet, then redraws. */
LogPanel.prototype._sync = function () {
    var self = this, need = [];
    this.panes.forEach(function (p) { p.forEach(function (id) { if (!self.loaded[id] && need.indexOf(id) < 0) need.push(id); }); });
    var load = need.length ? this._ask('channels', { ids: need }) : Promise.resolve({ list: [] });
    return load.then(function (msg) {
        msg.list.forEach(function (it) {
            var c = self.channels[it.id];
            self.loaded[it.id] = { key: it.id, name: c.name, unit: c.unit, freq: it.freq, values: it.values, time: it.time };
        });
        self._draw();
    }).catch(function (err) { if (err.message !== 'superseded') self._status(err.message, true); });
};

LogPanel.prototype._draw = function () {
    var self = this, colorOf = {}, n = 0, traces = [];
    this.panes.forEach(function (p) { p.forEach(function (id) { if (!(id in colorOf)) colorOf[id] = LV_COLORS[n++ % LV_COLORS.length]; }); });
    Object.keys(colorOf).forEach(function (id) {
        var t = self.loaded[id];
        if (t) traces.push(Object.assign({}, t, { color: colorOf[id] }));
    });
    this.chart.setTraces(traces);
    this.chart.setPanes(this.panes.map(function (p) { return p.filter(function (id) { return self.loaded[id]; }); }));

    this.el.to.innerHTML = this.panes.map(function (p, i) { return '<option value="' + i + '">to pane ' + (i + 1) + '</option>'; }).join('') +
        '<option value="new">to a new pane</option>';
    this.el.panes.innerHTML = this.panes.map(function (p, i) {
        return '<div><span>Pane ' + (i + 1) + ':</span>' + p.map(function (id) {
            var c = self.channels[id];
            return '<span class="lv-chip"><span class="sw" style="background:' + colorOf[id] + '"></span>' + lvEsc(c.name) +
                (c.unit ? ' <span style="color:#777">' + lvEsc(c.unit) + '</span>' : '') +
                ' <span style="color:#666">' + c.freq + ' Hz</span>' +
                '<button type="button" data-pane="' + i + '" data-id="' + id + '" aria-label="Remove ' + lvEsc(c.name) + '">×</button></span>';
        }).join('') + '</div>';
    }).join('');
    this.el.panes.querySelectorAll('button[data-id]').forEach(function (b) {
        b.onclick = function () {
            var p = self.panes[+b.dataset.pane];
            p.splice(p.indexOf(+b.dataset.id), 1);
            self.panes = self.panes.filter(function (x) { return x.length; });
            self._saveLayout();
            self.el.preset.value = 'saved';
            self._draw();
        };
    });
};

LogPanel.prototype._addTyped = function () {
    var c = this.byName[this.el.add.value.trim().toLowerCase()];
    if (!c) { this._status('No channel named "' + this.el.add.value + '" in this log.', true); return; }
    var to = this.el.to.value;
    if (to === 'new' || !this.panes.length) this.panes.push([c.id]);
    else if (this.panes[+to].indexOf(c.id) < 0) this.panes[+to].push(c.id);
    this.el.add.value = '';
    this._status('');
    this._saveLayout();
    this.el.preset.value = 'saved';
    this._sync();
};

// --- analysis overlays ----------------------------------------------------------------------------------------

/**
 * Runs the VE Table Tuning filters and the Transient Fuel event detection on the log.
 * settings: { ve: VE tool settings, tf: transient settings, veTable: { mapBreakpoints, rpmBreakpoints, values } (optional) }
 */
LogPanel.prototype.analyze = function (settings) {
    var self = this;
    settings = settings || {};
    this._status('Running the analysis filters…');
    return this._ask('analysis', { type: 'analyze', ve: settings.ve || {}, tf: settings.tf || {}, veTable: settings.veTable || null })
        .then(function (msg) {
            self.analysis = msg;
            self._status(self.fileName + ' — ' + self.channels.length + ' channels, ' + lcClock(self.duration) + ' long.');
            self._overlays();
            return msg;
        }).catch(function (err) { if (err.message !== 'superseded') self._status('Analysis failed: ' + err.message, true); throw err; });
};

LogPanel.prototype._overlays = function () {
    var self = this, a = this.analysis;
    this.el.overlays.hidden = !a;
    if (!a) return;
    var rate = this.channels.length ? Math.max.apply(null, this.channels.map(function (c) { return c.freq; })) : 100;

    // VE filters
    var bands = [];
    if (a.ve.error) {
        this.el.veLegend.innerHTML = '<span style="color:#888">' + lvEsc(a.ve.error) + '</span>';
    } else {
        var total = Object.keys(a.ve.counts).reduce(function (s, k) { return s + a.ve.counts[k]; }, 0);
        this.el.veLegend.innerHTML = '<span class="lv-chip" title="Samples the VE analysis uses"><span class="sw" style="background:transparent;border:1px solid #666"></span>Used ' +
            (a.ve.used || 0).toLocaleString() + ' (' + Math.round(100 * (a.ve.used || 0) / Math.max(total, 1)) + '%)</span>' +
            Object.keys(LV_VE_REASONS).filter(function (k) { return a.ve.counts[k]; }).map(function (k) {
                var r = LV_VE_REASONS[k];
                return '<span class="lv-chip' + (self.hiddenReasons[k] ? ' off' : '') + '" role="button" tabindex="0" data-reason="' + k + '" title="' +
                    lvEsc(r[0]) + ': ' + a.ve.counts[k].toLocaleString() + ' samples (' + lcClock(a.ve.counts[k] / rate) + ') — click to show/hide">' +
                    '<span class="sw" style="background:' + r[1].replace(/[\d.]+\)$/, '0.9)') + '"></span>' + lvEsc(r[0]) + ' ' +
                    a.ve.counts[k].toLocaleString() + '</span>';
            }).join('');
        this.el.veLegend.querySelectorAll('[data-reason]').forEach(function (chip) {
            var toggle = function () { self.hiddenReasons[chip.dataset.reason] = !self.hiddenReasons[chip.dataset.reason]; self._overlays(); };
            chip.onclick = toggle;
            chip.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
        });
        if (this.showVe) {
            a.ve.segments.forEach(function (s) {
                if (!self.hiddenReasons[s[2]] && LV_VE_REASONS[s[2]]) bands.push({ t0: s[0], t1: s[1], color: LV_VE_REASONS[s[2]][1], label: 'VE: ' + LV_VE_REASONS[s[2]][0] });
            });
        }
    }
    this.chart.setBands(bands);

    // Transient events
    var markers = [];
    if (a.tf.error) {
        this.el.tfLegend.innerHTML = '<span style="color:#888">' + lvEsc(a.tf.error) + '</span>';
    } else {
        var ins = a.tf.events.filter(function (e) { return e.type === 'tip-in'; }).length;
        this.el.tfLegend.innerHTML =
            '<span class="lv-chip"><span class="sw" style="background:#4dd0e1"></span>Tip-in ' + ins + '</span>' +
            '<span class="lv-chip"><span class="sw" style="background:#ffb74d"></span>Tip-out ' + (a.tf.events.length - ins) + '</span>' +
            '<span class="lv-chip" title="Overlapping overrun or a fuel cut — not measured"><span class="sw" style="background:#777"></span>Skipped ' +
            a.tf.skipped.length + '</span>';
        if (this.showTf) {
            a.tf.events.forEach(function (e) {
                var tipIn = e.type === 'tip-in';
                markers.push({ t: e.time, t1: e.windowEnd, color: tipIn ? '#4dd0e1' : '#ffb74d',
                    fill: e === self.selEvent ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)',
                    label: (tipIn ? 'tip-in ' + e.leanSpike + '% lean' : 'tip-out ' + e.richOvershoot + '% rich') });
            });
            a.tf.skipped.forEach(function (e) { markers.push({ t: e.time, t1: e.endTime, color: '#777', fill: 'rgba(120,120,120,0.08)', label: 'skipped' }); });
        }
    }
    this.chart.setMarkers(markers);
    this._eventTable();
};

LogPanel.prototype._eventTable = function () {
    var self = this, a = this.analysis;
    if (!a || a.tf.error || !this.showTf) { this.el.events.hidden = true; return; }
    var rows = a.tf.events.map(function (e) { return { e: e, skipped: false }; })
        .concat(a.tf.skipped.map(function (e) { return { e: e, skipped: true }; }))
        .sort(function (x, y) { return x.e.time - y.e.time; });
    this.el.events.hidden = !rows.length;
    this.el.events.innerHTML = '<table><thead><tr><th>Time</th><th>Event</th><th>MAP</th><th>Lean</th><th>Rich</th><th>Recovery</th></tr></thead><tbody>' +
        rows.map(function (row, i) {
            var e = row.e;
            if (row.skipped) {
                return '<tr class="skipped" data-i="' + i + '"><td>' + lcClock(e.time) + '</td><td>' + e.type + ' — skipped (overrun / fuel cut)</td>' +
                    '<td></td><td></td><td></td><td></td></tr>';
            }
            return '<tr data-i="' + i + '"' + (e === self.selEvent ? ' class="sel"' : '') + '><td>' + lcClock(e.time) + '</td><td>' + e.type + '</td><td>' +
                e.mapFrom + '→' + e.mapTo + ' kPa</td><td>' + (e.type === 'tip-in' ? e.leanSpike.toFixed(1) + '%' : '') + '</td><td>' +
                e.richOvershoot.toFixed(1) + '%</td><td>' + (e.settled === false ? '&gt; ' : '') + e.recoveryTime + ' ms</td></tr>';
        }).join('') + '</tbody></table>';
    this.el.events.querySelectorAll('tbody tr').forEach(function (tr) {
        tr.onclick = function () {
            var row = rows[+tr.dataset.i];
            if (row.skipped) self.chart.setRange(row.e.time - 2, row.e.endTime + 2);
            else self.showEvent(row.e.time);
        };
    });
};

/** Zooms to the transient event starting at `time` (seconds) and selects it. */
LogPanel.prototype.showEvent = function (time) {
    var a = this.analysis;
    if (!a || a.tf.error) return false;
    var best = null;
    a.tf.events.forEach(function (e) { if (!best || Math.abs(e.time - time) < Math.abs(best.time - time)) best = e; });
    if (!best || Math.abs(best.time - time) > 0.05) return false;
    this.selEvent = best;
    if (!this.showTf) { this.showTf = true; this.el.tfOn.checked = true; }
    this._overlays();
    this.chart.setRange(best.time - 1.5, best.windowEnd + 1);
    var sel = this.el.events.querySelector('tr.sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    return true;
};

/** Highlights the used samples that count towards VE cell (m, r) and steps through them. */
LogPanel.prototype.showCell = function (m, r, label) {
    var self = this;
    return this._ask('cell', { type: 'cell', m: m, r: r }).then(function (msg) {
        self.cell = { m: m, r: r, label: label, segments: msg.segments, weight: msg.weight, mean: msg.mean, at: -1 };
        self.chart.setHighlights(msg.segments.map(function (s) { return { t0: s[0], t1: s[1] }; }));
        self._cellBar();
        if (msg.segments.length) self._cellStep(1);
        return msg;
    }).catch(function (err) { if (err.message !== 'superseded') self._status(err.message, true); });
};

LogPanel.prototype._cellBar = function () {
    var self = this, c = this.cell;
    this.el.cell.hidden = !c;
    if (!c) return;
    var n = c.segments.length;
    this.el.cell.innerHTML = '<strong>VE cell ' + lvEsc(c.label || '') + '</strong>' +
        '<span>' + (n ? n + ' stretch' + (n === 1 ? '' : 'es') + ' of samples, weight ' + Math.round(c.weight).toLocaleString() +
            (c.mean !== null ? ', mean correction ' + (c.mean > 0 ? '+' : '') + c.mean.toFixed(2) + '%' : '') : 'no samples used in this cell') + '</span>' +
        (n ? '<button type="button" class="lv-btn" data-step="-1">◀ Previous</button><span class="lv-at">' + (c.at + 1) + ' / ' + n + '</span>' +
            '<button type="button" class="lv-btn" data-step="1">Next ▶</button>' : '') +
        '<button type="button" class="lv-btn" data-clear="1">Clear</button>';
    this.el.cell.querySelectorAll('[data-step]').forEach(function (b) { b.onclick = function () { self._cellStep(+b.dataset.step); }; });
    this.el.cell.querySelector('[data-clear]').onclick = function () { self.cell = null; self.chart.setHighlights([]); self._cellBar(); };
};

LogPanel.prototype._cellStep = function (dir) {
    var c = this.cell, n = c.segments.length;
    if (!n) return;
    c.at = ((c.at + dir) % n + n) % n;
    var s = c.segments[c.at], span = Math.max(4, (s[1] - s[0]) * 1.6);
    var mid = (s[0] + s[1]) / 2;
    this.chart.setRange(mid - span / 2, mid + span / 2);
    var at = this.el.cell.querySelector('.lv-at');
    if (at) at.textContent = (c.at + 1) + ' / ' + n;
};

if (typeof module !== 'undefined' && module.exports) module.exports = { LogPanel: LogPanel, LV_VE_REASONS: LV_VE_REASONS };
