/**
 * harness/harness-tune.js — Compare a harness with the I/O assignments in an M1 tune.
 *
 * Uses the pin tables in m1-config/resource-names.js: each assigned I/O resource in the tune gives a
 * connector pin ("M142 pin C15"), which is matched to harness connector "M142.C" cavity "15".
 *
 * harnessTuneCompare(model, pkg, hardware, userNames) →
 *   { rows: [{ pin, connectorId, cavity, resource, tune: [names], harness: pin|null, status, note }],
 *     unnamed: [{ ids, tune: [names] }]  — tune assignments whose pin is not known (not named yet),
 *     labelIssues: [{ where, label, expected }], summary: { ok, check, missing, 'not-in-tune', 'no-connector' } }
 * status: 'ok' | 'check' (functions look different) | 'missing' (tune uses the pin, harness has no wire)
 *       | 'not-in-tune' (harness wires an ECU input/output that no named tune assignment uses — the tune may
 *         still use it through an assignment listed in `unnamed`)
 *       | 'no-connector' (the pin's connector is not in this harness, e.g. an E888 not drawn here)
 */

/** Words that say what kind of signal something is rather than what it measures. */
var HT_GENERIC = ['sensor', 'signal', 'resource', 'value', 'input', 'output', 'primary', 'main', 'control', 'sens',
    'temperature', 'pressure', 'position', 'speed', 'switch', 'engine', 'the', 'and', 'to', 'from', 'of', 'a', 'b',
    'power', 'ground', 'reference', 'bank', 'cylinder'];
var HT_SYNONYMS = {
    temp: ['temperature'], press: ['pressure'], pres: ['pressure'], iat: ['inlet', 'air'], map: ['inlet', 'manifold'],
    injector: ['fuel'], inj: ['fuel'], coil: ['ignition'], ign: ['ignition'], trans: ['transmission'],
    hpfp: ['fuel', 'direct'], lpfp: ['fuel'], cmp: ['camshaft'], cam: ['camshaft'], ckp: ['crankshaft'],
    crank: ['crankshaft'], app: ['pedal'], tps: ['throttle'], dbw: ['throttle'], ect: ['coolant'],
    eot: ['oil'], eop: ['oil'], pan: ['crankcase'], vss: ['wheel'], ac: ['air', 'conditioner'],
    knk: ['knock'], baro: ['ambient'], o2: ['lambda'], afr: ['lambda'], wss: ['wheel'],
    flex: ['fuel', 'composition'], ethanol: ['fuel', 'composition']
};
/** Harness functions that are not signals the tune assigns (power, grounds, buses, spares). */
var HT_NOT_SIGNAL = /^(spare|unused|n\/a|empty|battery|sensor (5|0|6)|5v|0v|ground|can |lin|rs232|ethernet|ecu power)/i;

function htWords(text) {
    var out = [];
    String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').forEach(function (w) {
        if (!w) return;
        (HT_SYNONYMS[w] || [w]).forEach(function (s) { out.push(s); });
    });
    return out;
}

/** Do a tune item name and a harness function plausibly describe the same thing? */
function htSameFunction(tuneNames, harnessText) {
    var h = htWords(harnessText), hNums = h.filter(function (w) { return /^\d+$/.test(w); });
    return tuneNames.some(function (name) {
        var t = htWords(name), tNums = t.filter(function (w) { return /^\d+$/.test(w); });
        if (tNums.length && hNums.length && !tNums.some(function (n) { return hNums.indexOf(n) >= 0; })) return false;
        var subject = t.filter(function (w) { return HT_GENERIC.indexOf(w) < 0 && !/^\d+$/.test(w); });
        if (!subject.length) subject = t;
        return subject.some(function (w) { return h.indexOf(w) >= 0; });
    });
}

/**
 * "M142 pin A06 (+ A07)" → { unit: 'M142', connector: 'A', cavity: '6', second: { connector: 'A', cavity: '7', kind: '+' } }.
 * A second pin is the '+' side of a direct injector or the other half bridge of a bridge output ("C18 / C01").
 */
function htParsePin(text) {
    var m = String(text || '').match(/^(\S+) pin ([A-Z])(\d+)(?: \(\+ ([A-Z])(\d+)\)| \/ ([A-Z])(\d+))?/);
    if (!m) return null;
    var p = { unit: m[1], connector: m[2], cavity: String(parseInt(m[3], 10)), second: null };
    if (m[4]) p.second = { connector: m[4], cavity: String(parseInt(m[5], 10)), kind: '+' };
    if (m[6]) p.second = { connector: m[6], cavity: String(parseInt(m[7], 10)), kind: '/' };
    return p;
}

/** Short tune item name for display: drop trailing ".Resource.Value" style suffixes. */
function htItemName(name) {
    return name.replace(/(\.Resource)?(\.Value)?$/, '').replace(/[ .](Input |Output |Sensor )?Resource$/, '');
}

/** Datasheet designation key for every cavity of a unit: { 'A.6': 'di1a-', 'A.7': 'di1a+', 'C.15': 'av2' }. */
function htCavityKeys(unit) {
    var pins = (typeof M1C_PINOUTS !== 'undefined' ? M1C_PINOUTS : {})[unit] || {}, out = {};
    Object.keys(pins).forEach(function (key) {
        if (/^bridge/.test(key)) return;   // bridge outputs reuse the half-bridge pins (hbN)
        var m = pins[key].match(/^([A-Z])(\d+)(?: \(([+-]|TX|LO) ([A-Z])(\d+)\))?/);
        if (!m) return;
        var di = /^di\d/.test(key);
        out[m[1] + '.' + parseInt(m[2], 10)] = di ? key + '-' : key;
        if (m[3] && di) out[m[4] + '.' + parseInt(m[5], 10)] = key + '+';
    });
    return out;
}

/** Designation key for a harness label such as "AT5", "Injector 1A +", "DI 2B-", "IGN_LS1". */
function htLabelKey(label) {
    var t = String(label || '').trim();
    var di = t.match(/^(?:m142\s+)?(?:direct injector|injector|inj_?d|di)\s*(\d[ab])\s*([+-])$/i);
    if (di) return 'di' + di[1].toLowerCase() + di[2];
    return typeof m1cPinKey === 'function' ? m1cPinKey(t.replace(/^m1\d\d\s+/i, '')) : null;
}

function harnessTuneCompare(model, pkg, hardware, userNames) {
    var index = harnessIndex(model), rows = [], byPin = {}, labelIssues = [], unnamed = {};
    var connectorsById = {};
    model.connectors.forEach(function (c) { connectorsById[c.id] = c; });

    (pkg.items || []).forEach(function (item) {
        if (item.type !== 'io_resource' || !m1cResourceAssigned(item.value)) return;
        var n = m1cResourceName(item.value, hardware, userNames);
        var pinText = n ? m1cResourcePin(n.name, hardware) : null, p = htParsePin(pinText);
        if (!n) {
            var ids = item.value.filter(function (id) { return id !== '0x0000'; }).join(', ');
            (unnamed[ids] = unnamed[ids] || { ids: ids, tune: [] }).tune.push(htItemName(item.name));
        }
        if (!p) return;
        function add(connector, cavity, resource, partnerNote) {
            var key = p.unit + '.' + connector + '.' + cavity;
            if (!byPin[key]) {
                byPin[key] = { pin: p.unit + ' ' + connector + String(cavity).padStart(2, '0'), connectorId: p.unit + '.' + connector,
                               cavity: cavity, resource: resource, tune: [], partnerNote: partnerNote || '' };
            }
            byPin[key].tune.push(htItemName(item.name));
        }
        add(p.connector, p.cavity, n.name);
        if (p.second) {
            var main = p.unit + ' ' + p.connector + String(p.cavity).padStart(2, '0');
            add(p.second.connector, p.second.cavity, p.second.kind === '+' ? n.name.replace(/-$/, '+') : n.name + ' (2nd pin)',
                (p.second.kind === '+' ? 'Supply side of ' : 'Other half of ') + n.name + ' (' + main + ').');
        }
    });

    Object.keys(byPin).forEach(function (key) {
        var r = byPin[key], entry = index.connectors[r.connectorId];
        r.harness = entry ? entry.pins[r.cavity] || null : null;
        if (!entry) { r.status = 'no-connector'; r.note = r.connectorId + ' is not in this harness.'; }
        else if (!r.harness || !harnessHasWire(r.harness)) {
            r.status = 'missing'; r.note = 'The tune uses this pin but the harness has no wire on it.';
        } else if (/^(spare|unused)$/i.test(harnessText(r.harness.function))) {
            r.status = 'missing';
            r.note = 'The tune uses this pin but the harness marks it as ' + harnessText(r.harness.function).toLowerCase() +
                (harnessText(r.harness.remote) && !/^n\/a$/i.test(harnessText(r.harness.remote)) ? ' (wired to ' + harnessText(r.harness.remote) + ')' : '') + '.';
        } else if (htSameFunction(r.tune, r.harness.function)) r.status = 'ok';
        else { r.status = 'check'; r.note = 'The harness function does not look like the tune assignment.'; }
        if (r.tune.length > 1) r.note = (r.note ? r.note + ' ' : '') + 'The tune assigns ' + r.tune.length + ' items to this pin.';
        if (r.partnerNote) r.note = r.partnerNote + (r.note ? ' ' + r.note : '');
        delete r.partnerNote;
        rows.push(r);
    });

    // ECU cavities (connectors named after the tune hardware) and harness labels.
    var keys = htCavityKeys(hardware);
    model.connectors.forEach(function (c) {
        var m = c.id.match(/^(\S+)\.([A-Z])$/);
        if (!m || m[1] !== hardware) return;
        c.pins.forEach(function (p) {
            var cav = String(parseInt(p.cavity, 10));
            if (cav === 'NaN') return;
            var expected = keys[m[2] + '.' + cav], labelKey = htLabelKey(p.note);
            if (labelKey && expected && labelKey !== expected) {
                labelIssues.push({ where: c.id + '.' + p.cavity, label: p.note, expected: expected });
            }
            if (byPin[hardware + '.' + m[2] + '.' + cav] || !harnessHasWire(p)) return;
            if (HT_NOT_SIGNAL.test(harnessText(p.function)) || !expected || /^(can|rs232|lin)/.test(expected)) return;
            rows.push({ pin: hardware + ' ' + m[2] + cav.padStart(2, '0'), connectorId: c.id, cavity: cav, resource: null,
                        tune: [], harness: p, status: 'not-in-tune',
                        note: 'Wired in the harness, but no named tune assignment uses this pin.' });
        });
    });

    rows.sort(function (a, b) {
        return a.pin.localeCompare(b.pin, undefined, { numeric: true });
    });
    var summary = { ok: 0, check: 0, missing: 0, 'not-in-tune': 0, 'no-connector': 0 };
    rows.forEach(function (r) { summary[r.status]++; });
    return { rows: rows, labelIssues: labelIssues, summary: summary,
             unnamed: Object.keys(unnamed).map(function (k) { return unnamed[k]; }) };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { harnessTuneCompare: harnessTuneCompare, htSameFunction: htSameFunction, htLabelKey: htLabelKey,
                       htCavityKeys: htCavityKeys };
}
