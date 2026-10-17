/**
 * lib/print-report.js — Print a report on its own, so the browser's print dialog can save it as a PDF.
 *
 * prPrint({ title, subtitle, meta: [[label, value], …], sections: [{ title, html, newPage }], fileName, landscape })
 *   Builds #print-report at the end of <body> (light theme from lib/print-report.css; the page itself is hidden while
 *   printing), waits for its pictures, opens the print dialog and removes the report afterwards. `fileName` becomes the
 *   document title while printing, which browsers use as the suggested PDF name. Section html is trusted (already escaped).
 * prEsc(s) — HTML-escape text.
 * prTable(headers, rows) — a plain table; cells are already-escaped html.
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

if (typeof module !== 'undefined' && module.exports) module.exports = { prEsc: prEsc, prTable: prTable };
