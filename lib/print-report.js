/**
 * lib/print-report.js — Print a report on its own, so the browser's print dialog can save it as a PDF.
 *
 * prPrint({ title, subtitle, meta: [[label, value], …], sections: [{ title, html, newPage }], fileName, landscape })
 *   Builds #print-report at the end of <body> (light theme from lib/print-report.css; the page itself is hidden while
 *   printing), waits for its pictures, opens the print dialog and removes the report afterwards. `fileName` becomes the
 *   document title while printing, which browsers use as the suggested PDF name. Section html is trusted (already escaped).
 * prEsc(s) — HTML-escape text.
 * prTable(headers, rows) — a plain table; cells are already-escaped html.
 * prSnapshot(el) — html of an already-rendered part of a page, for pages whose renderers write the DOM: a copy without controls,
 *   hidden parts or the embedded Log Viewer; charts (canvas) become pictures; translucent cell colours are kept.
 * prBlocks(root) — sections [{ title, html }] from each visible .report-block in root (not .pr-skip), titled by its h2.
 */

function prEsc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function prTable(headers, rows, cls) {
    return '<table class="pr-table' + (cls ? ' ' + cls : '') + '"><thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' + rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + (c === null || c === undefined || c === '' ? '—' : c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table>';
}

var PR_SNAPSHOT_DROP = 'button, input, textarea, script, .rs-save, .log-panel, #log-panel, .pr-skip';

function prSnapshot(el) {
    var src = [el].concat(Array.prototype.slice.call(el.querySelectorAll('*')));
    var copy = el.cloneNode(true), dst = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll('*')));
    var drop = [];
    src.forEach(function (s, i) {
        var d = dst[i];
        if (i > 0 && (s.hidden || getComputedStyle(s).display === 'none' || s.matches(PR_SNAPSHOT_DROP))) { drop.push(d); return; }
        if (s.tagName === 'SELECT') {   // a choice on the page (e.g. which cylinder a grid shows) prints as its chosen text
            var chosen = document.createElement('b');
            chosen.textContent = s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : '';
            d.parentNode.replaceChild(chosen, d);
            return;
        }
        var cs = getComputedStyle(s);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { d.style.overflow = 'visible'; d.style.maxHeight = 'none'; }   // scroll boxes clip on paper
        if (s.tagName === 'TABLE' && s.rows.length && s.rows[0].cells.length > 12) d.classList.add('pr-wide');
        if (s.tagName === 'CANVAS') {
            // Charts are drawn for the dark page: keep its background so their light text stays readable
            var img = document.createElement('img');
            try {
                var c = document.createElement('canvas');
                c.width = s.width; c.height = s.height;
                var g = c.getContext('2d');
                g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, c.width, c.height); g.drawImage(s, 0, 0);
                img.src = c.toDataURL('image/png');
            } catch (e) { drop.push(d); return; }
            var fig = document.createElement('figure');
            fig.className = 'pr-figure';
            fig.appendChild(img);
            d.parentNode.replaceChild(fig, d);
            return;
        }
        // Translucent cell colours (heat maps) read as light tints on white; opaque dark ones are the page's own background
        var bg = cs.backgroundColor;
        var m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(bg);
        if (m && +m[4] > 0.04 && +m[4] < 0.6 && /^(TD|TH|SPAN|DIV)$/.test(s.tagName)) {
            d.classList.add('pr-shade');
            d.style.setProperty('--pr-bg', 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + Math.min(0.45, +m[4] * 1.5) + ')');
        }
    });
    drop.forEach(function (d) { if (d.parentNode) d.parentNode.removeChild(d); });
    return copy.innerHTML;
}

function prBlocks(root) {
    return Array.prototype.slice.call(root.querySelectorAll('.report-block')).filter(function (b) {
        return !b.hidden && getComputedStyle(b).display !== 'none' && !b.matches('.pr-skip') && b.textContent.trim();
    }).map(function (b) {
        var h = b.querySelector('h2'), html = prSnapshot(b);
        if (h) html = html.replace(h.outerHTML, '');
        return { title: h ? h.textContent.trim() : '', html: html };
    }).filter(function (s) { return s.html.replace(/<[^>]*>/g, '').trim(); });
}

function prCleanup() {
    var old = document.getElementById('print-report');
    if (old) old.remove();
    var page = document.getElementById('print-report-page');
    if (page) page.remove();
    document.documentElement.classList.remove('pr-printing');
    if (prCleanup.title !== undefined) { document.title = prCleanup.title; prCleanup.title = undefined; }
}

/** Resolves once every picture in el (HTML <img> and SVG <image>) has loaded or failed. */
function prImagesReady(el) {
    var srcs = [];
    el.querySelectorAll('img').forEach(function (img) { if (img.src) srcs.push(img.src); });
    el.querySelectorAll('image').forEach(function (img) {
        var href = img.getAttribute('href') || img.getAttribute('xlink:href');
        if (href) srcs.push(href);
    });
    return Promise.all(srcs.map(function (src) {
        return new Promise(function (resolve) {
            var im = new Image();
            im.onload = im.onerror = function () { resolve(); };
            im.src = src;
        });
    }));
}

function prPrint(report) {
    prCleanup();
    var el = document.createElement('div');
    el.id = 'print-report';
    var html = '<header class="pr-head"><h1>' + prEsc(report.title) + '</h1>' +
        (report.subtitle ? '<p class="pr-subtitle">' + prEsc(report.subtitle) + '</p>' : '');
    if (report.meta && report.meta.length) {
        html += '<dl class="pr-meta">' + report.meta.map(function (m) {
            return '<div><dt>' + prEsc(m[0]) + '</dt><dd>' + prEsc(m[1] === null || m[1] === undefined || m[1] === '' ? '—' : m[1]) + '</dd></div>';
        }).join('') + '</dl>';
    }
    html += '<p class="pr-generated">TunerControl · ' + prEsc(new Date().toLocaleString()) + '</p></header>';
    (report.sections || []).forEach(function (s) {
        html += '<section class="pr-section' + (s.newPage ? ' pr-new-page' : '') + '">' + (s.title ? '<h2>' + prEsc(s.title) + '</h2>' : '') +
            s.html + '</section>';
    });
    el.innerHTML = html;
    document.body.appendChild(el);
    if (report.landscape) {
        el.classList.add('pr-landscape');
        var page = document.createElement('style');
        page.id = 'print-report-page';
        page.textContent = '@page { size: landscape; }';
        document.head.appendChild(page);
    }
    document.documentElement.classList.add('pr-printing');
    prCleanup.title = document.title;
    if (report.fileName) document.title = report.fileName.replace(/[\\/:*?"<>|]+/g, '_');
    return prImagesReady(el).then(function () {
        return new Promise(function (resolve) {
            // Clean up on afterprint: print() does not block in every browser. A report left behind is hidden on screen and
            // removed by the next prPrint.
            function finish() { window.removeEventListener('afterprint', finish); prCleanup(); resolve(); }
            window.addEventListener('afterprint', finish);
            setTimeout(function () { window.print(); }, 50);
        });
    });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { prEsc: prEsc, prTable: prTable, prSnapshot: prSnapshot, prBlocks: prBlocks };
