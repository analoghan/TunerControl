/**
 * backup/backup-page.js — Backup & Restore page: what is stored, download a full backup, restore one (lib/backup.js).
 */

(function () {
    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function status(t) { $('bk-status').textContent = t || ''; }
    function error(t) { $('bk-error').textContent = t || ''; $('bk-error').hidden = !t; }
    function table(rows) {
        return '<table class="bk-table"><tbody>' + rows.map(function (r) {
            return '<tr><th>' + esc(r[0]) + '</th><td class="num">' + esc(r[1]) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    var pending = null;   // backup chosen for restore

    /** Counts from the lightweight lists (no need to fetch every tune and picture). */
    function renderNow() {
        return Promise.all([hsTunes(), hsResourceNames(), rsList(null, false), hsList(), hsListSystems()]).then(function (r) {
            var names = Object.keys(r[1]), labels = names.filter(function (k) { return k.indexOf('label|') === 0; }).length, revs = 0, nets = 0;
            r[3].forEach(function (h) { revs += h.latest || h.revision || 0; });
            r[4].forEach(function (s) { nets += (s.canNetworks || []).length; });
            $('bk-now').innerHTML = table([['Tunes', r[0].length], ['Resource names', names.length - labels], ['Labels', labels],
                ['Tuning history runs', r[2].length], ['Harnesses', r[3].length], ['Harness systems', r[4].length], ['CAN networks', nets]]);
        }).catch(function (err) { $('bk-now').innerHTML = '<p class="bk-error">Could not read what is stored: ' + esc(err.message) + '</p>'; });
    }

    bkBackend().then(function (b) {
        $('bk-storage').textContent = b === 'server' ? 'Stored on the TunerControl server — the backup holds everything in its database.'
            : b === 'browser' ? 'Stored in this browser only (no TunerControl server). The backup holds everything this browser has stored.'
            : 'No storage is available here (private window?).';
        $('bk-export').disabled = b === 'none';
        if (b !== 'none') renderNow();
        else $('bk-now').innerHTML = '<p>Nothing is stored.</p>';
    });

    $('bk-export').addEventListener('click', function () {
        error('');
        status('Building the backup…');
        $('bk-export').disabled = true;
        bkExport().then(function (backup) {
            var blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'tunercontrol-backup-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
            var c = bkContents(backup).filter(function (x) { return x[1]; }).map(function (x) { return x[0] + ' ' + x[1]; });
            status('Backup saved (' + (blob.size / 1048576).toFixed(1) + ' MB) — ' + c.join(', ') + '.');
        }).catch(function (err) { status(''); error('Could not build the backup: ' + err.message); })
          .then(function () { $('bk-export').disabled = false; });
    });

    $('bk-file').addEventListener('change', function () {
        var file = this.files[0];
        this.value = '';
        if (!file) return;
        error(''); status('Reading ' + file.name + '…');
        file.text().then(function (text) {
            var backup = JSON.parse(text);
            bkCheck(backup);
            pending = backup;
            status('');
            $('bk-preview').hidden = false;
            $('bk-preview').innerHTML = '<p><strong>' + esc(file.name) + '</strong>' + (backup.exportedAt ? ' — made ' + esc(new Date(backup.exportedAt).toLocaleString()) : '') +
                (backup.source ? ' from ' + (backup.source === 'server' ? 'a server' : 'browser storage') : '') + '</p>' +
                table(bkContents(backup).filter(function (x) { return x[1]; })) +
                '<button id="bk-restore" class="bk-btn">Restore</button> <button id="bk-cancel" class="bk-btn secondary">Cancel</button>';
        }).catch(function (err) { status(''); error('Could not read ' + file.name + ': ' + (err instanceof SyntaxError ? 'not a JSON file' : err.message)); });
    });

    $('bk-preview').addEventListener('click', function (e) {
        if (e.target.id === 'bk-cancel') { pending = null; $('bk-preview').hidden = true; return; }
        if (e.target.id !== 'bk-restore' || !pending) return;
        e.target.disabled = true;
        error(''); status('Restoring…');
        bkImport(pending).then(function (n) {
            pending = null;
            $('bk-preview').hidden = true;
            var parts = [['tune', 'tunes', n.packages], ['resource name or label', 'resource names and labels', n.resourceNames],
                ['tuning history run', 'tuning history runs', n.runs], ['harness', 'harnesses', n.harnesses],
                ['harness revision', 'harness revisions', n.revisions], ['system', 'systems', n.systems], ['picture', 'pictures', n.images],
                ['page setting', 'page settings', n.settings]]
                .filter(function (p) { return p[2]; }).map(function (p) { return p[2] + ' ' + (p[2] === 1 ? p[0] : p[1]); });
            status(parts.length ? 'Restored ' + parts.join(', ') + '.' : 'Nothing to restore — everything in the backup is already here.');
            return renderNow();
        }).catch(function (err) { status(''); error('Could not restore: ' + err.message); e.target.disabled = false; });
    });
})();
