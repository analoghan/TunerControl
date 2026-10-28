/**
 * m1-config/tune-source.js — Tunes stored by the M1 Config Viewer, for use in other tools
 * (VE Table Tuning, Transient Fuel). Needs tune-db.js and tune-api.js.
 *
 *   tsInit()            → Promise<'server' | 'browser' | 'none'>   where the stored tunes are
 *   tsList()            → Promise<[summary]>  newest save first (tuneName, modified, serial, …)
 *   tsLoad(id)          → Promise<package>    summary + parsed items, as parseM1Pkg returns
 *   tsLogInfo(file)     → Promise<{ serial, time }>  ECU serial and start time of a log, when known
 *   tsSuggest(list, info) → { tune, reason }  the tune most likely in the ECU when the log was recorded
 */

var tsBackend = 'none';

function tsInit() {
    return detectTuneServer().then(function (server) {
        if (server) return 'server';
        if (typeof indexedDB === 'undefined') return 'none';
        return openTuneDb().then(function () { return 'browser'; }, function () { return 'none'; });
    }).then(function (b) { tsBackend = b; return b; });
}

function tsList() {
    var list = tsBackend === 'server' ? apiListPackages() : tsBackend === 'browser' ? listTunePackages() : Promise.resolve([]);
    return list.then(function (rows) {
        return rows.slice().sort(function (a, b) { return String(b.modified || '').localeCompare(String(a.modified || '')); });
    });
}

function tsLoad(id) {
    return tsBackend === 'server' ? apiLoadPackage(id) : loadTunePackage(id);
}

/** The original .m1pkg bytes of a stored tune (ArrayBuffer), or null when they weren't kept. */
function tsLoadFile(id) {
    if (tsBackend === 'server') {
        return tuneApi('GET', 'packages/' + encodeURIComponent(id) + '/file', { raw: true }).then(function (r) { return r.arrayBuffer(); });
    }
    return loadTuneFile(id).then(function (f) { return f && f.data ? f.data : null; });
}

/** "11/06/2026", "17:32:21" (day first, as MoTeC writes them) → Date in local time, or null. */
function tsParseDate(date, time) {
    var d = String(date || '').match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/), t = String(time || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!d) return null;
    var out = new Date(+d[3], +d[2] - 1, +d[1], t ? +t[1] : 0, t ? +t[2] : 0, t && t[3] ? +t[3] : 0);
    return isNaN(out.getTime()) ? null : out;
}

/** ECU serial and start time from a log: the .ld header, a MoTeC CSV header, or a "…#30924_20260611_173221…" name. */
function tsLogInfo(file) {
    var info = { serial: null, time: null }, name = file && file.name || '';
    var m = name.match(/#(\d+)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (m) {
        info.serial = +m[1];
        info.time = new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]);
    }
    if (!file || !file.slice) return Promise.resolve(info);
    var isLd = /\.ld$/i.test(name);
    return file.slice(0, isLd ? 0x100 : 8192).arrayBuffer().then(function (buf) {
        if (isLd) {
            var view = new DataView(buf), bytes = new Uint8Array(buf);
            function str(o, n) {
                var s = '';
                for (var i = o; i < o + n && i < bytes.length && bytes[i]; i++) s += String.fromCharCode(bytes[i]);
                return s;
            }
            if (bytes.length >= 0x9e) {
                var serial = view.getUint32(0x46, true), time = tsParseDate(str(0x5e, 16), str(0x7e, 16));
                if (serial) info.serial = serial;
                if (time) info.time = time;
            }
        } else {
            var text = new TextDecoder('latin1').decode(buf), lines = text.split(/\r?\n/).slice(0, 30);
            function field(names) {
                for (var i = 0; i < lines.length; i++) {
                    var cells = lines[i].split(',').map(function (c) { return c.replace(/^"|"$/g, '').trim(); });
                    if (names.indexOf(cells[0].toLowerCase()) >= 0) return cells[1];
                }
                return null;
            }
            var t = tsParseDate(field(['log date', 'date']), field(['log time', 'time']));
            if (t) info.time = t;
        }
        return info;
    }).catch(function () { return info; });
}

/**
 * The stored tune most likely loaded when the log was recorded: same ECU serial (when both are known), saved
 * at or before the log started — the latest such save.
 */
function tsSuggest(list, info) {
    if (!list.length) return { tune: null, reason: 'No tunes are stored yet — import one in the M1 Config Viewer.' };
    var same = info.serial ? list.filter(function (t) { return !t.serial || +t.serial === +info.serial; }) : list;
    if (info.serial && !same.length) return { tune: null, reason: 'No stored tune is from ECU #' + info.serial + '.' };
    if (!info.time) return { tune: null, reason: 'The log\'s date is unknown, so no tune is suggested.' };
    var before = same.filter(function (t) { return t.modified && new Date(t.modified) <= info.time; });
    if (!before.length) {
        return { tune: null, reason: 'No stored tune' + (info.serial ? ' from ECU #' + info.serial : '') +
            ' was saved before this log (' + info.time.toLocaleString() + ').' };
    }
    before.sort(function (a, b) { return new Date(b.modified) - new Date(a.modified); });
    return { tune: before[0], reason: 'Suggested: the latest tune' + (info.serial ? ' from ECU #' + info.serial : '') +
        ' saved before this log (' + info.time.toLocaleString() + ').' };
}

/** Option label for a stored tune. */
function tsLabel(t) {
    return (t.tuneName || t.fileName || 'Tune') + (t.modified ? ' — saved ' + new Date(t.modified).toLocaleString() : '');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { tsParseDate: tsParseDate, tsSuggest: tsSuggest, tsLogInfo: tsLogInfo, tsLabel: tsLabel };
}
