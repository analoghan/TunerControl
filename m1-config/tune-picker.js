/**
 * m1-config/tune-picker.js — The "Tune (.m1pkg, optional) / Or a stored tune" controls of an analysis page.
 * Needs tune-source.js (stored tunes), and lib/m1pkg-parser.js with lib/xz-decoder.js (a .m1pkg file).
 *
 * tsPicker({ pkgInput, select, row, hint, status, extract, describe, none, onError }) → { suggest(logFile), current() }
 *   extract(pkg) → settings (e.g. m1pkgInjector); describe(settings) → status text; none: status text without a tune.
 *   suggest(logFile) picks the stored tune most likely in the ECU when the log was recorded (tsSuggest), unless the user chose one.
 */

function tsPicker(o) {
    var settings = null, picked = false, stored = [];
    function set(s, label) {
        settings = s;
        o.status.textContent = s ? label + ': ' + (s.tuneName || 'tune') + '. ' + o.describe(s) : o.none;
    }
    function fail(what, err) {
        set(null);
        if (o.onError) o.onError('Could not read ' + what + ': ' + err.message);
    }
    function useStored(id, hint, suggested) {
        if (!id) { set(null); o.hint.textContent = ''; return Promise.resolve(); }
        o.select.value = id;
        o.hint.textContent = 'Loading…';
        return tsLoad(id).then(function (pkg) {
            if (o.select.value !== id) return;
            o.pkgInput.value = '';
            set(o.extract(pkg), 'Stored tune');
            o.hint.textContent = hint || '';
            o.hint.classList.toggle('suggested', !!suggested);
        }).catch(function (err) { o.hint.textContent = ''; fail('the stored tune', err); });
    }
    o.pkgInput.addEventListener('change', function () {
        var file = o.pkgInput.files[0];
        if (!file) return;
        picked = true;
        o.select.value = '';
        o.hint.textContent = '';
        file.arrayBuffer().then(function (buf) { set(o.extract(parseM1Pkg(buf)), 'Tune file ' + file.name); })
            .catch(function (err) { fail(file.name, err); });
    });
    o.select.addEventListener('change', function () {
        picked = !!o.select.value;
        useStored(o.select.value, '', false);
    });
    var pendingLog = null;
    function suggest(file) {
        pendingLog = file;
        if (!stored.length || picked || !file) return;
        tsLogInfo(file).then(function (info) {
            var sug = tsSuggest(stored, info);
            if (sug.tune) return useStored(sug.tune.id, sug.reason, true);
            o.hint.textContent = sug.reason;
            o.hint.classList.remove('suggested');
        });
    }
    if (typeof tsInit !== 'undefined') {
        tsInit().then(tsList).then(function (list) {
            stored = list;
            if (!list.length) return;
            list.forEach(function (t) {
                var opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = tsLabel(t);
                o.select.appendChild(opt);
            });
            o.row.hidden = false;
            if (pendingLog) suggest(pendingLog);
        }).catch(function () { /* no stored tunes: the file input still works */ });
    }
    set(null);
    return { suggest: suggest, current: function () { return settings; } };
}
