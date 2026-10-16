/**
 * history/history.js — Tuning History page: saved analysis runs per tool, and how their results change from run to run.
 * Needs run-store.js, run-builders.js, m1-config/tune-api.js and tune-source.js.
 */

var HI_TOOLS = {
    've': { label: 'VE Table Tuning', page: '../ve-table/index.html' },
    'transient': { label: 'Transient Fuel', page: '../transient-fuel/index.html' },
    'knock': { label: 'Knock', page: '../knock/index.html' },
    'fuel-pressure': { label: 'DI Fuel Pressure', page: '../fuel-pressure/index.html' }
};
var HI_COLORS = ['#ff5a6e', '#4fc3f7', '#ffd54f', '#81c784', '#ce93d8', '#ffb74d', '#90a4ae', '#f48fb1'];

var hiTool = 've', hiRuns = [], hiCell = null;

function hiEsc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hiFmt(v, dp, unit) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (+v).toFixed(dp === undefined ? 1 : dp) + (unit || '');
}

function hiDate(r) {
    var d = new Date(r.logTime || r.created);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Short label for a run on a chart axis: the tune's last " - " part (e.g. V55), else the log date. */
function hiShort(r) {
    var d = new Date(r.logTime || r.created), date = isNaN(d.getTime()) ? '' : (d.getMonth() + 1) + '/' + d.getDate();
    var tune = r.tuneName ? String(r.tuneName).split(' - ').pop().replace(/\.(csv|m1pkg)$/i, '') : '';
    return (date + (tune ? ' ' + tune : '')).trim() || '—';
}

/**
 * Line chart (SVG) of several series over the runs.
 * series: [{ label, values: [number|null per run] }]; labels: [string per run]; unit: axis unit
 */
function hiChart(series, labels, unit, title) {
    var all = [];
    series.forEach(function (s) { s.values.forEach(function (v) { if (v !== null && v !== undefined && isFinite(v)) all.push(v); }); });
    if (!all.length || labels.length < 1) return '<p class="hi-note">No values to chart yet.</p>';
    var W = 760, H = 240, L = 56, R = 14, T = 16, B = 48;
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.08; min -= pad; max += pad;
    var x = function (i) { return L + (labels.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (labels.length - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - min) / (max - min)); };
    var svg = '<svg class="hi-chart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + hiEsc(title || 'Chart') + '">';
    for (var k = 0; k <= 4; k++) {
        var v = min + (max - min) * k / 4, yy = y(v);
        svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="#2c2c2c"/>' +
            '<text x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end" fill="#888" font-size="11">' + hiEsc(+v.toPrecision(3)) + '</text>';
    }
    labels.forEach(function (l, i) {
        var anchor = labels.length > 1 && i === 0 ? 'start' : labels.length > 1 && i === labels.length - 1 ? 'end' : 'middle';
        svg += '<text x="' + x(i) + '" y="' + (H - B + 16) + '" text-anchor="' + anchor + '" fill="#aaa" font-size="11">' + hiEsc(l) + '</text>';
    });
    if (unit) svg += '<text x="' + (L - 6) + '" y="11" text-anchor="end" fill="#888" font-size="11">' + hiEsc(unit) + '</text>';
    series.forEach(function (s, si) {
        var color = s.color || HI_COLORS[si % HI_COLORS.length], pts = [];
        s.values.forEach(function (v, i) {
            if (v === null || v === undefined || !isFinite(v)) { if (pts.length) { svg += hiLine(pts, color); pts = []; } return; }
            pts.push(x(i) + ',' + y(v));
            svg += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="3.5" fill="' + color + '"><title>' + hiEsc(s.label + ' · ' + labels[i] + ': ' +
                (+v).toFixed(2) + (unit ? ' ' + unit : '')) + '</title></circle>';
        });
        if (pts.length) svg += hiLine(pts, color);
    });
    svg += '</svg>';
    var legend = series.length > 1 ? '<div class="hi-legend">' + series.map(function (s, si) {
        return '<span><i style="background:' + (s.color || HI_COLORS[si % HI_COLORS.length]) + '"></i>' + hiEsc(s.label) + '</span>';
    }).join('') + '</div>' : '';
    return (title ? '<h3>' + hiEsc(title) + '</h3>' : '') + svg + legend;
}

function hiLine(pts, color) {
    return pts.length > 1 ? '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2"/>' : '';
}

// --- tool-specific columns and trends ------------------------------------------------------------------------

var HI_COLUMNS = {
    've': [['Cells', function (s) { return s.cells; }], ['Mean |correction|', function (s) { return hiFmt(s.meanAbsCorrection, 2, '%'); }],
           ['Cells > 2%', function (s) { return s.cellsOver2; }], ['Largest', function (s) { return hiFmt(s.worstCorrection, 1, '%'); }]],
    'transient': [['Tip-ins', function (s) { return s.tipIns; }], ['Avg lean', function (s) { return hiFmt(s.avgLean, 1, '%'); }],
                  ['Avg rich', function (s) { return hiFmt(s.avgRich, 1, '%'); }], ['Rich first', function (s) { return s.richFirst; }]],
    'knock': [['Events', function (s) { return s.events; }], ['Sensor check', function (s) { return s.weak && s.weak.length ? s.weak.join('; ') : 'OK'; }],
              ['Max retard', function (s) { return s.retardSource === 'knockTrim' ? hiFmt(s.maxRetard, 1, '°') : '—'; }]],
    'fuel-pressure': [['Within ±2 bar', function (s) { return hiFmt(s.pctWithin, 1, '%'); }],
                      ['Overshoot on rise', function (s) { return hiFmt(s.riseOverShare, 0, '%'); }],
                      ['Max over / under', function (s) { return hiFmt(s.maxOver, 0) + ' / ' + hiFmt(s.maxUnder, 0) + ' bar'; }],
                      ['P / I gain', function (s) { return s.pGain === null ? '—' : s.pGain + ' / ' + s.iGain; }]]
};

function hiTrends(runs) {
    var labels = runs.map(hiShort), S = function (f) { return runs.map(function (r) { return f(r.summary || {}); }); };
    if (hiTool === 've') {
        return hiChart([{ label: 'Mean |correction|', values: S(function (s) { return s.meanAbsCorrection; }) }], labels, '%', 'Mean VE correction needed') +
            hiChart([{ label: 'Cells > 2%', values: S(function (s) { return s.cellsOver2; }) }], labels, 'cells', 'Cells needing more than 2%') +
            hiVeCells(runs, labels);
    }
    if (hiTool === 'transient') {
        return hiChart([{ label: 'Avg lean spike', values: S(function (s) { return s.avgLean; }) },
                        { label: 'Avg rich overshoot', values: S(function (s) { return s.avgRich; }) }], labels, '%', 'Tip-in excursions') +
            hiChart([{ label: 'Tip-ins rich, then lean', values: S(function (s) { return s.richFirst; }) }], labels, 'tip-ins', 'Tip-ins that go rich first');
    }
    if (hiTool === 'knock') {
        var cyl = [];
        for (var c = 1; c <= 8; c++) {
            cyl.push({ label: 'Cyl ' + c, values: runs.map(function (r) {
                var h = r.data && r.data.health ? r.data.health.filter(function (p) { return p.cyl === c; })[0] : null;
                return h ? h.median : null;
            }) });
        }
        return hiChart(cyl, labels, '%', 'Typical knock level per cylinder (sensor check)') +
            '<p class="hi-note">A healthy sensor always hears some engine noise. Cylinders reading far below the others (for example all of one knock ' +
            'input) point at that sensor or its wiring; after a fix their line should rise to the others.</p>' +
            hiChart([{ label: 'Knock events', values: S(function (s) { return s.events; }) }], labels, 'events', 'Knock events above the threshold');
    }
    return hiChart([{ label: 'Within ±2 bar', values: S(function (s) { return s.pctWithin; }) }], labels, '%', 'Rail pressure on aim') +
        hiChart([{ label: 'Overshoot while the aim rises', values: S(function (s) { return s.riseOverShare; }) },
                 { label: 'Lag behind a rising aim', values: S(function (s) { return s.riseLagShare; }) }], labels, '% of rising time',
                'Response to a rising aim (needs a tune on the run)');
}

/** VE: the latest run's grid; click a cell to chart its correction across runs (matched by breakpoint values). */
function hiVeCells(runs, labels) {
    var latest = runs.filter(function (r) { return r.data && r.data.cells; }).pop();
    if (!latest) return '';
    var d = latest.data, html = '<h3>Correction by cell</h3><p class="hi-note">Latest run (' + hiEsc(hiShort(latest)) + '). Click a cell to see its ' +
        'correction in every run.</p><div class="hi-scroll"><table class="hi-grid"><thead><tr><th>kPa \\ rpm</th>' +
        d.rpmBreakpoints.map(function (r) { return '<th>' + Math.round(r) + '</th>'; }).join('') + '</tr></thead><tbody>';
    d.mapBreakpoints.forEach(function (m, mi) {
        html += '<tr><th>' + Math.round(m) + '</th>';
        d.cells[mi].forEach(function (c, ri) {
            var v = c.c, cls = v === null ? 'na' : Math.abs(v) <= 2 ? 'ok' : v > 0 ? 'pos' : 'neg';
            var sel = hiCell && hiCell.map === m && hiCell.rpm === d.rpmBreakpoints[ri] ? ' sel' : '';
            html += '<td class="' + cls + sel + '" data-map="' + m + '" data-rpm="' + d.rpmBreakpoints[ri] + '" tabindex="0">' +
                (v === null ? '' : (v > 0 ? '+' : '') + v.toFixed(1)) + '</td>';
        });
        html += '</tr>';
    });
    html += '</tbody></table></div><div id="hi-cell-trend"></div>';
    return html;
}

function hiCellTrend(runs) {
    var el = document.getElementById('hi-cell-trend');
    if (!el || !hiCell) return;
    var vals = runs.map(function (r) {
        var d = r.data;
        if (!d || !d.cells) return null;
        var mi = d.mapBreakpoints.findIndex(function (m) { return Math.abs(m - hiCell.map) < 0.5; });
        var ri = d.rpmBreakpoints.findIndex(function (x) { return Math.abs(x - hiCell.rpm) < 0.5; });
        return mi >= 0 && ri >= 0 ? d.cells[mi][ri] : null;
    });
    el.innerHTML = hiChart([{ label: 'Correction', values: vals.map(function (c) { return c ? c.c : null; }) }], runs.map(hiShort), '%',
        'Cell ' + Math.round(hiCell.map) + ' kPa × ' + Math.round(hiCell.rpm) + ' rpm') +
        '<p class="hi-note">Samples per run: ' + vals.map(function (c, i) { return hiEsc(hiShort(runs[i])) + ' ' + (c ? c.n : '—'); }).join(' · ') +
        '. A cell converging on 0 means the corrections are landing; one swinging back and forth may need more data or smoothing.</p>';
}

// --- rendering ---------------------------------------------------------------------------------------------

function hiRender() {
    document.querySelectorAll('.hi-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === hiTool); b.setAttribute('aria-selected', b.dataset.tool === hiTool); });
    var runs = hiRuns, list = document.getElementById('hi-list'), trends = document.getElementById('hi-trends');
    var cols = HI_COLUMNS[hiTool];
    if (!runs.length) {
        list.innerHTML = '<p class="hi-note">No ' + hiEsc(HI_TOOLS[hiTool].label) + ' runs saved yet. Run an analysis on the <a href="' +
            HI_TOOLS[hiTool].page + '">' + hiEsc(HI_TOOLS[hiTool].label) + '</a> page and click <strong>Save to tuning history</strong>.</p>';
        trends.innerHTML = '';
        return;
    }
    var html = '<div class="hi-scroll"><table class="hi-table"><thead><tr><th>Log</th><th>Tune</th>' + cols.map(function (c) { return '<th>' + c[0] + '</th>'; }).join('') +
        '<th>Note</th><th></th></tr></thead><tbody>';
    runs.slice().reverse().forEach(function (r) {
        var s = r.summary || {};
        html += '<tr data-id="' + hiEsc(r.id) + '"><td><div>' + hiEsc(hiDate(r)) + '</div><small>' + hiEsc(r.logName || '') + '</small></td><td>' +
            hiEsc(r.tuneName || '—') + '</td>' + cols.map(function (c) { return '<td>' + hiEsc(c[1](s)) + '</td>'; }).join('') +
            '<td class="hi-note-cell">' + hiEsc(r.note || '') + '</td><td class="hi-actions"><button type="button" data-act="view">Details</button> ' +
            '<button type="button" data-act="note">Note</button> <button type="button" data-act="delete">Delete</button></td></tr>' +
            '<tr class="hi-detail" data-detail="' + hiEsc(r.id) + '" hidden><td colspan="' + (cols.length + 4) + '"></td></tr>';
    });
    list.innerHTML = html + '</tbody></table></div>';
    trends.innerHTML = runs.length > 1 ? hiTrends(runs) : '<p class="hi-note">Save a second run to see how the results change.</p>' + hiTrends(runs);
    hiCellTrend(runs);
}

function hiDetail(run) {
    var d = run.data || {}, parts = [];
    if (run.settings) parts.push('<p><strong>Settings:</strong> ' + hiEsc(Object.keys(run.settings).filter(function (k) {
        return run.settings[k] !== null && run.settings[k] !== undefined && typeof run.settings[k] !== 'object';
    }).map(function (k) { return k + ' ' + run.settings[k]; }).join(', ')) + '</p>');
    var advice = d.recommendations || d.advice;
    if (Array.isArray(advice) && advice.length && advice[0].text) {
        parts.push('<ul>' + advice.map(function (a) { return '<li class="sev-' + hiEsc(a.severity) + '">' + hiEsc(a.text) + '</li>'; }).join('') + '</ul>');
    }
    if (d.health) {
        parts.push('<p><strong>Typical knock level:</strong> ' + d.health.map(function (h) {
            return 'Cyl ' + h.cyl + ' ' + h.median + '%' + (h.input ? ' (' + hiEsc(h.input) + ')' : '');
        }).join(', ') + '</p>');
    }
    if (d.recommendations && d.recommendations.length && d.recommendations[0].cyl) {
        parts.push('<p><strong>Timing advice:</strong> ' + d.recommendations.map(function (x) {
            return 'Cyl ' + x.cyl + ': ' + x.events + ' events, worst ' + x.maxRatio + '×, ' + (x.reductionDeg ? '−' + x.reductionDeg + '°' : 'no change');
        }).join('; ') + '</p>');
    }
    if (d.zones) {
        parts.push('<p><strong>Tip-ins by destination MAP:</strong> ' + d.zones.map(function (z) {
            return z.from + '–' + z.to + ' kPa: ' + z.n + ', lean ' + z.lean + '%, rich ' + z.rich + '%';
        }).join('; ') + '</p>');
    }
    if (d.classes && d.classes.length) {
        parts.push('<p><strong>Kinds of error:</strong> ' + d.classes.filter(function (c) { return c.seconds; }).map(function (c) {
            return hiEsc(c.label) + ' ' + c.seconds + ' s (' + c.share + '%)';
        }).join('; ') + '</p>');
    }
    parts.push('<p class="hi-note">Saved ' + hiEsc(new Date(run.created).toLocaleString()) + (run.serial ? ' · ECU #' + run.serial : '') + '.</p>');
    return parts.join('');
}

function hiLoad() {
    hiCell = null;
    return rsList(hiTool, true).then(function (runs) { hiRuns = runs; hiRender(); })
        .catch(function (err) { document.getElementById('hi-list').innerHTML = '<p class="hi-error">Could not load the history: ' + hiEsc(err.message) + '</p>'; });
}

function hiInit() {
    document.getElementById('hi-tabs').innerHTML = Object.keys(HI_TOOLS).map(function (k) {
        return '<button type="button" class="hi-tab" role="tab" data-tool="' + k + '">' + hiEsc(HI_TOOLS[k].label) + '</button>';
    }).join('');
    document.getElementById('hi-tabs').addEventListener('click', function (e) {
        var b = e.target.closest('.hi-tab');
        if (!b) return;
        hiTool = b.dataset.tool;
        try { localStorage.setItem('tunercontrol.history.tool', hiTool); } catch (err) { /* not remembered */ }
        hiLoad();
    });
    document.getElementById('hi-list').addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-act]');
        if (!btn) return;
        var id = btn.closest('tr').dataset.id, run = hiRuns.filter(function (r) { return r.id === id; })[0];
        if (!run) return;
        if (btn.dataset.act === 'view') {
            var row = document.querySelector('tr[data-detail="' + CSS.escape(id) + '"]');
            row.hidden = !row.hidden;
            if (!row.hidden) row.firstChild.innerHTML = hiDetail(run);
        } else if (btn.dataset.act === 'note') {
            var note = window.prompt('Note for this run:', run.note || '');
            if (note === null) return;
            rsSetNote(id, note.trim()).then(hiLoad).catch(function (err) { window.alert('Could not save the note: ' + err.message); });
        } else if (btn.dataset.act === 'delete') {
            if (!window.confirm('Delete this run (' + (run.logName || 'log') + ', ' + hiDate(run) + ') from the history?')) return;
            rsDelete(id).then(hiLoad).catch(function (err) { window.alert('Could not delete: ' + err.message); });
        }
    });
    document.getElementById('hi-trends').addEventListener('click', function (e) {
        var td = e.target.closest('td[data-map]');
        if (!td) return;
        hiCell = { map: +td.dataset.map, rpm: +td.dataset.rpm };
        document.querySelectorAll('.hi-grid td.sel').forEach(function (x) { x.classList.remove('sel'); });
        td.classList.add('sel');
        hiCellTrend(hiRuns);
    });
    document.getElementById('hi-trends').addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('td[data-map]')) { e.preventDefault(); e.target.click(); }
    });
    try { var saved = localStorage.getItem('tunercontrol.history.tool'); if (HI_TOOLS[saved]) hiTool = saved; } catch (err) { /* default */ }
    rsInit().then(function (b) {
        document.getElementById('hi-storage').textContent = b === 'server' ? 'Stored on the TunerControl server.' :
            b === 'browser' ? 'Stored in this browser only — open the pages from a TunerControl server to share the history between browsers.' :
            'Storage is not available in this browser (private window?), so runs cannot be saved.';
        return hiLoad();
    });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', hiInit);
if (typeof module !== 'undefined' && module.exports) module.exports = { hiChart: hiChart, hiShort: hiShort };
