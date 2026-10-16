/**
 * log-viewer/log-chart.js — Canvas time-series chart for MoTeC logs: stacked panes sharing one time axis,
 * an overview strip of the whole log, shaded bands (e.g. samples a tool left out), highlights and event markers.
 *
 *   var chart = new LogChart(container, { onRange(t0, t1) })
 *   chart.setTraces(list)     [{ key, name, unit, color, values, freq, time? }]  (time: per-sample times, else index / freq)
 *   chart.setPanes(panes)     [[key, …], …]
 *   chart.setDuration(s)
 *   chart.setBands(bands)     [{ t0, t1, color, label }]   drawn behind the traces in every pane; the label shows at the cursor
 *   chart.setHighlights(list) [{ t0, t1 }]                 bright strip + tint (e.g. samples of one VE cell)
 *   chart.setMarkers(list)    [{ t, t1, label, color }]    event start line, optional shaded span to t1
 *   chart.setRange(t0, t1) / chart.fit()
 *
 * Mouse: drag to zoom into a span, wheel to zoom, shift + wheel or shift + drag to pan, double-click to show all,
 * click or drag in the overview to move. Keys (when focused): ← → pan, + − zoom.
 */

function LogChart(container, opts) {
    this.opts = opts || {};
    this.el = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lv-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Log chart');
    container.appendChild(this.canvas);
    this.traces = {};
    this.panes = [];
    this.bands = [];
    this.highlights = [];
    this.markers = [];
    this.duration = 0;
    this.t0 = 0;
    this.t1 = 1;
    this.cursorX = null;
    this.drag = null;
    this.layout = null;
    this._bind();
    var self = this;
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { self.render(); }).observe(container);
}

LogChart.OVERVIEW_H = 34;
LogChart.AXIS_H = 22;
LogChart.PANE_H = 140;
LogChart.LEFT = 58;
LogChart.RIGHT = 10;

LogChart.prototype.setTraces = function (list) {
    var self = this;
    this.traces = {};
    list.forEach(function (t) { self.traces[t.key] = t; });
    this.render();
};
LogChart.prototype.setPanes = function (panes) { this.panes = panes.filter(function (p) { return p.length; }); this.render(); };
LogChart.prototype.setDuration = function (d) { this.duration = d; this.t0 = 0; this.t1 = d || 1; this.render(); };
LogChart.prototype.setBands = function (b) { this.bands = b || []; this.render(); };
LogChart.prototype.setHighlights = function (h) { this.highlights = h || []; this.render(); };
LogChart.prototype.setMarkers = function (m) { this.markers = m || []; this.render(); };
LogChart.prototype.fit = function () { this.setRange(0, this.duration); };

LogChart.prototype.setRange = function (t0, t1) {
    var d = this.duration || 1, minSpan = 0.05;
    if (t1 - t0 < minSpan) { var c = (t0 + t1) / 2; t0 = c - minSpan / 2; t1 = c + minSpan / 2; }
    if (t1 - t0 > d) { t0 = 0; t1 = d; }
    if (t0 < 0) { t1 -= t0; t0 = 0; }
    if (t1 > d) { t0 -= t1 - d; t1 = d; }
    this.t0 = Math.max(0, t0);
    this.t1 = t1;
    this.render();
    if (this.opts.onRange) this.opts.onRange(this.t0, this.t1);
};

LogChart.prototype.zoom = function (factor, atT) {
    var c = atT === undefined ? (this.t0 + this.t1) / 2 : atT;
    this.setRange(c - (c - this.t0) * factor, c + (this.t1 - c) * factor);
};
LogChart.prototype.pan = function (fraction) {
    var d = (this.t1 - this.t0) * fraction;
    this.setRange(this.t0 + d, this.t1 + d);
};

// --- geometry -----------------------------------------------------------------------------------------------

LogChart.prototype._layout = function () {
    var w = Math.max(200, this.el.clientWidth), L = LogChart.LEFT, R = LogChart.RIGHT;
    var top = LogChart.OVERVIEW_H + 8, panes = [];
    for (var i = 0; i < this.panes.length; i++) panes.push({ y: top + i * LogChart.PANE_H, h: LogChart.PANE_H - 6, keys: this.panes[i] });
    var plotBottom = top + this.panes.length * LogChart.PANE_H;
    return { w: w, h: plotBottom + LogChart.AXIS_H, L: L, R: R, pw: w - L - R, panes: panes, plotTop: top, plotBottom: plotBottom };
};
LogChart.prototype._x = function (t) { var g = this.layout; return g.L + (t - this.t0) / (this.t1 - this.t0) * g.pw; };
LogChart.prototype._t = function (x) { var g = this.layout; return this.t0 + (x - g.L) / g.pw * (this.t1 - this.t0); };
LogChart.prototype._ovX = function (t) { var g = this.layout; return g.L + t / (this.duration || 1) * g.pw; };

/** Index range [i0, i1) of a trace's samples inside [t0, t1]. */
function lcIndex(tr, t) {
    if (!tr.time) return Math.round(t * tr.freq);
    var lo = 0, hi = tr.time.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (tr.time[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
}
function lcTime(tr, i) { return tr.time ? tr.time[i] : i / tr.freq; }

LogChart.prototype.valueAt = function (key, t) {
    var tr = this.traces[key];
    if (!tr) return NaN;
    var i = Math.min(Math.max(lcIndex(tr, t), 0), tr.values.length - 1);
    if (i > 0 && Math.abs(lcTime(tr, i - 1) - t) < Math.abs(lcTime(tr, i) - t)) i--;
    return tr.values[i];
};

function lcRange(tr, t0, t1) {
    var i0 = Math.max(0, lcIndex(tr, t0) - 1), i1 = Math.min(tr.values.length, lcIndex(tr, t1) + 2), lo = Infinity, hi = -Infinity;
    for (var i = i0; i < i1; i++) { var v = tr.values[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return lo <= hi ? [lo, hi] : null;
}

function lcNice(lo, hi) {
    if (lo === hi) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.06;
    return [lo - pad, hi + pad];
}

function lcTicks(lo, hi, count) {
    var span = hi - lo, step = Math.pow(10, Math.floor(Math.log10(span / count))), err = span / count / step;
    if (err >= 5) step *= 5; else if (err >= 2) step *= 2;
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(10));
    return out;
}

function lcFmt(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
}

function lcClock(t) {
    var m = Math.floor(t / 60), s = t - m * 60;
    return m ? m + ':' + (s < 10 ? '0' : '') + s.toFixed(s % 1 ? 1 : 0) : s.toFixed(t % 1 ? 2 : 0) + ' s';
}

// --- drawing ------------------------------------------------------------------------------------------------

LogChart.prototype.render = function () {
    if (this._frame) return;
    var self = this;
    var raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : function (f) { return setTimeout(f, 16); };
    this._frame = raf(function () { self._frame = null; self._draw(); });
};

LogChart.prototype._draw = function () {
    var g = this.layout = this._layout(), dpr = window.devicePixelRatio || 1, c = this.canvas;
    c.style.width = g.w + 'px';
    c.style.height = g.h + 'px';
    if (c.width !== Math.round(g.w * dpr) || c.height !== Math.round(g.h * dpr)) { c.width = Math.round(g.w * dpr); c.height = Math.round(g.h * dpr); }
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var css = getComputedStyle(this.el);
    var col = {
        bg: css.getPropertyValue('--lv-bg').trim() || '#111', grid: css.getPropertyValue('--lv-grid').trim() || '#2a2a2a',
        text: css.getPropertyValue('--lv-text').trim() || '#bbb', muted: css.getPropertyValue('--lv-muted').trim() || '#777',
    };
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.font = '11px system-ui, sans-serif';
    if (!this.duration) return;

    this._drawOverview(ctx, g, col);
    var self = this;
    g.panes.forEach(function (p) { self._drawPane(ctx, g, p, col); });
    this._drawAxis(ctx, g, col);
    this._drawMarkersAndCursor(ctx, g, col);
};

LogChart.prototype._drawSpans = function (ctx, g, y, h, overview) {
    var self = this, x = overview ? function (t) { return self._ovX(t); } : function (t) { return self._x(t); };
    var minW = overview ? 0.5 : 1;
    this.bands.forEach(function (b) {
        if (!overview && (b.t1 < self.t0 || b.t0 > self.t1)) return;
        var x0 = Math.max(g.L, x(b.t0)), x1 = Math.min(g.L + g.pw, x(b.t1));
        ctx.fillStyle = b.color;
        ctx.fillRect(x0, y, Math.max(minW, x1 - x0), h);
    });
    this.highlights.forEach(function (b) {
        if (!overview && (b.t1 < self.t0 || b.t0 > self.t1)) return;
        var x0 = Math.max(g.L, x(b.t0)), x1 = Math.min(g.L + g.pw, x(b.t1)), w = Math.max(overview ? 2 : 3, x1 - x0);
        ctx.fillStyle = 'rgba(57, 255, 136, 0.13)';
        ctx.fillRect(x0, y, w, h);
        ctx.fillStyle = '#39ff88';
        ctx.fillRect(x0, y, w, overview ? h : 4);
    });
};

LogChart.prototype._drawOverview = function (ctx, g, col) {
    var y = 2, h = LogChart.OVERVIEW_H - 4;
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(g.L, y, g.pw, h);
    this._drawSpans(ctx, g, y, h, true);
    var key = this.panes.length ? this.panes[0][0] : null, tr = key && this.traces[key];
    if (tr) {
        var r = lcRange(tr, 0, this.duration);
        if (r) this._trace(ctx, tr, 0, this.duration, g.L, g.pw, y + 2, h - 4, lcNice(r[0], r[1]), tr.color, 0.6);
    }
    var x0 = this._ovX(this.t0), x1 = this._ovX(this.t1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x0, y, Math.max(2, x1 - x0), h);
    ctx.strokeStyle = col.text;
    ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(2, x1 - x0) - 1, h - 1);
    ctx.fillStyle = col.muted;
    ctx.textAlign = 'right';
    ctx.fillText('Overview', g.L - 6, y + h / 2 + 4);
};

/** Draws one trace over pixel columns: min/max per column when samples are dense, else a line through the points. */
LogChart.prototype._trace = function (ctx, tr, t0, t1, x, w, y, h, yr, color, alpha) {
    var i0 = Math.max(0, lcIndex(tr, t0) - 1), i1 = Math.min(tr.values.length, lcIndex(tr, t1) + 2);
    if (i1 <= i0) return;
    var sy = function (v) { return y + h - (v - yr[0]) / (yr[1] - yr[0]) * h; };
    var sx = function (t) { return x + (t - t0) / (t1 - t0) * w; };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y - 1, w, h + 2);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha || 1;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    var perPx = (i1 - i0) / w, pen = false;
    if (perPx <= 2) {
        for (var i = i0; i < i1; i++) {
            var v = tr.values[i];
            if (isNaN(v)) { pen = false; continue; }
            var px = sx(lcTime(tr, i)), py = sy(v);
            if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
            pen = true;
        }
    } else {
        var col0 = -1, lo = Infinity, hi = -Infinity, first = NaN, last = NaN;
        var flush = function (cx) {
            if (lo > hi) return;
            var X = x + cx + 0.5;
            if (pen) ctx.lineTo(X, sy(first)); else ctx.moveTo(X, sy(first));
            ctx.lineTo(X, sy(lo)); ctx.lineTo(X, sy(hi)); ctx.lineTo(X, sy(last));
            pen = true;
        };
        for (i = i0; i < i1; i++) {
            var cx = Math.floor((lcTime(tr, i) - t0) / (t1 - t0) * w);
            if (cx !== col0) { flush(col0); col0 = cx; lo = Infinity; hi = -Infinity; first = NaN; }
            var val = tr.values[i];
            if (isNaN(val)) continue;
            if (isNaN(first)) first = val;
            last = val;
            if (val < lo) lo = val;
            if (val > hi) hi = val;
        }
        flush(col0);
    }
    ctx.stroke();
    ctx.restore();
};

LogChart.prototype._drawPane = function (ctx, g, p, col) {
    var self = this, traces = p.keys.map(function (k) { return self.traces[k]; }).filter(Boolean);
    ctx.strokeStyle = col.grid;
    ctx.strokeRect(g.L + 0.5, p.y + 0.5, g.pw - 1, p.h - 1);
    this._drawSpans(ctx, g, p.y, p.h, false);

    // One shared scale when every trace has the same unit (e.g. lambda and its aim); otherwise each trace scales alone.
    var units = traces.map(function (t) { return t.unit; });
    var shared = units.every(function (u) { return u === units[0]; });
    var ranges = traces.map(function (t) { return lcRange(t, self.t0, self.t1); });
    if (shared) {
        var lo = Infinity, hi = -Infinity;
        ranges.forEach(function (r) { if (r) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); } });
        var yr = lo <= hi ? lcNice(lo, hi) : [0, 1];
        ranges = ranges.map(function () { return yr; });
        ctx.fillStyle = col.muted;
        ctx.textAlign = 'right';
        lcTicks(yr[0], yr[1], 4).forEach(function (v) {
            var yy = p.y + p.h - (v - yr[0]) / (yr[1] - yr[0]) * p.h;
            if (yy < p.y + 6 || yy > p.y + p.h - 2) return;
            ctx.fillStyle = col.grid;
            ctx.fillRect(g.L, Math.round(yy) + 0.5, g.pw, 1);
            ctx.fillStyle = col.muted;
            ctx.fillText(lcFmt(v), g.L - 6, yy + 4);
        });
    } else {
        ranges = ranges.map(function (r) { return r ? lcNice(r[0], r[1]) : [0, 1]; });
    }
    traces.forEach(function (t, i) { self._trace(ctx, t, self.t0, self.t1, g.L, g.pw, p.y + 2, p.h - 4, ranges[i], t.color); });

    // Legend: name, value at the cursor (or the range when the scale is per trace), unit.
    var tc = this.cursorX !== null ? this._t(this.cursorX) : null, lx = g.L + 8, ly = p.y + 15;
    ctx.textAlign = 'left';
    traces.forEach(function (t, i) {
        var val = tc !== null ? lcFmt(self.valueAt(t.key, tc)) : '';
        var rng = !shared && tc === null ? ' [' + lcFmt(ranges[i][0]) + ' – ' + lcFmt(ranges[i][1]) + ']' : '';
        var label = t.name + (val ? ': ' + val : '') + (t.unit ? ' ' + t.unit : '') + rng;
        var tw = ctx.measureText(label).width;
        if (lx + tw > g.L + g.pw - 8) { lx = g.L + 8; ly += 14; }
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(lx - 3, ly - 11, tw + 6, 14);
        ctx.fillStyle = t.color;
        ctx.fillText(label, lx, ly);
        lx += tw + 14;
    });
};

LogChart.prototype._drawAxis = function (ctx, g, col) {
    var y = g.plotBottom;
    ctx.fillStyle = col.muted;
    ctx.textAlign = 'center';
    var self = this;
    lcTicks(this.t0, this.t1, Math.max(2, Math.floor(g.pw / 110))).forEach(function (t) {
        var x = self._x(t);
        ctx.fillStyle = col.grid;
        ctx.fillRect(Math.round(x) + 0.5, g.plotTop, 1, g.plotBottom - g.plotTop);
        ctx.fillStyle = col.muted;
        ctx.fillText(lcClock(t), x, y + 14);
    });
};

LogChart.prototype._drawMarkersAndCursor = function (ctx, g, col) {
    var self = this;
    this.markers.forEach(function (m) {
        if ((m.t1 || m.t) < self.t0 || m.t > self.t1) return;
        var x = self._x(m.t);
        if (m.t1) {
            ctx.fillStyle = m.fill || 'rgba(255,255,255,0.06)';
            ctx.fillRect(Math.max(g.L, x), g.plotTop, Math.max(1, Math.min(g.L + g.pw, self._x(m.t1)) - Math.max(g.L, x)), g.plotBottom - g.plotTop);
        }
        ctx.strokeStyle = m.color || '#fff';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, g.plotTop);
        ctx.lineTo(Math.round(x) + 0.5, g.plotBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        if (m.label && (self.t1 - self.t0) < 600) {
            ctx.fillStyle = m.color || '#fff';
            ctx.textAlign = 'left';
            ctx.fillText(m.label, x + 3, g.plotTop - 1);
        }
    });
    if (this.drag && this.drag.mode === 'zoom') {
        var a = Math.min(this.drag.x0, this.drag.x), b = Math.max(this.drag.x0, this.drag.x);
        ctx.fillStyle = 'rgba(227, 24, 55, 0.18)';
        ctx.fillRect(a, g.plotTop, b - a, g.plotBottom - g.plotTop);
    }
    if (this.cursorX !== null) {
        ctx.fillStyle = col.text;
        ctx.fillRect(Math.round(this.cursorX), g.plotTop, 1, g.plotBottom - g.plotTop);
        var tc = this._t(this.cursorX), names = [];
        this.bands.forEach(function (b) { if (b.label && tc >= b.t0 && tc < b.t1 && names.indexOf(b.label) < 0) names.push(b.label); });
        var label = lcClock(tc) + (names.length ? ' — ' + names.join(', ') : ''), tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = col.bg;
        ctx.fillRect(this.cursorX - tw / 2, g.plotBottom + 2, tw, 16);
        ctx.fillStyle = col.text;
        ctx.textAlign = 'center';
        ctx.fillText(label, this.cursorX, g.plotBottom + 14);
    }
};

// --- interaction --------------------------------------------------------------------------------------------

LogChart.prototype._bind = function () {
    var self = this, c = this.canvas;
    function pos(e) { var r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function inPlot(p) { var g = self.layout; return g && p.x >= g.L && p.x <= g.L + g.pw && p.y >= g.plotTop && p.y <= g.plotBottom; }
    function inOverview(p) { var g = self.layout; return g && p.x >= g.L && p.x <= g.L + g.pw && p.y < LogChart.OVERVIEW_H; }
    function moveOverview(p) {
        var t = (p.x - self.layout.L) / self.layout.pw * self.duration, span = self.t1 - self.t0;
        self.setRange(t - span / 2, t + span / 2);
    }

    c.addEventListener('pointerdown', function (e) {
        if (!self.duration || e.button !== 0) return;
        var p = pos(e);
        if (inOverview(p)) { self.drag = { mode: 'overview' }; moveOverview(p); }
        else if (inPlot(p)) self.drag = e.shiftKey ? { mode: 'pan', x: p.x, t0: self.t0, t1: self.t1 } : { mode: 'zoom', x0: p.x, x: p.x };
        else return;
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    c.addEventListener('pointermove', function (e) {
        var p = pos(e), g = self.layout;
        if (self.drag && self.drag.mode === 'overview') moveOverview(p);
        else if (self.drag && self.drag.mode === 'pan') {
            var dt = (p.x - self.drag.x) / g.pw * (self.drag.t1 - self.drag.t0);
            self.setRange(self.drag.t0 - dt, self.drag.t1 - dt);
        } else if (self.drag && self.drag.mode === 'zoom') self.drag.x = Math.min(Math.max(p.x, g.L), g.L + g.pw);
        self.cursorX = inPlot(p) ? p.x : null;
        self.render();
    });
    c.addEventListener('pointerup', function () {
        var d = self.drag;
        self.drag = null;
        if (d && d.mode === 'zoom' && Math.abs(d.x - d.x0) > 4) self.setRange(self._t(Math.min(d.x0, d.x)), self._t(Math.max(d.x0, d.x)));
        else self.render();
    });
    c.addEventListener('pointerleave', function () { if (!self.drag) { self.cursorX = null; self.render(); } });
    c.addEventListener('dblclick', function () { self.fit(); });
    c.addEventListener('wheel', function (e) {
        var p = pos(e);
        if (!self.duration || !(inPlot(p) || inOverview(p))) return;
        e.preventDefault();
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) self.pan((e.shiftKey ? e.deltaY : e.deltaX) / 500);
        else self.zoom(Math.exp(e.deltaY / 300), inPlot(p) ? self._t(p.x) : undefined);
    }, { passive: false });
    c.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') self.pan(-0.2);
        else if (e.key === 'ArrowRight') self.pan(0.2);
        else if (e.key === '+' || e.key === '=') self.zoom(0.5);
        else if (e.key === '-') self.zoom(2);
        else if (e.key === '0') self.fit();
        else return;
        e.preventDefault();
    });
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LogChart: LogChart, lcTicks: lcTicks, lcFmt: lcFmt, lcClock: lcClock };
}
