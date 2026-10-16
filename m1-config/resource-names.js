/**
 * m1-config/resource-names.js — Names for M1 I/O resource assignments.
 *
 * A package stores each I/O assignment as 5 x u32 resource IDs (one slot per IO method); the pin
 * names M1 Tune shows come from its hardware definitions, which are not in the package. Names here
 * are either confirmed against M1 Tune or entered by the user, and are keyed by hardware (Summary.Hardware)
 * plus the full 5-slot signature, because the same pin can carry different IDs in different slots.
 */

/**
 * Exact signatures confirmed against M1 Tune.
 * E888 (CAN expander) inputs stay exact: AVI1/3/5/7 = 0x6540/44/48/4c suggest two IDs per input, but
 * AVI8 = 0x6550 breaks that pattern.
 */
var M1C_KNOWN_RESOURCES = {
    M142: {
        '0x0000,0x0000,0x6540,0x0000,0x0000': 'E888 AVI1',
        '0x0000,0x0000,0x6544,0x0000,0x0000': 'E888 AVI3',
        '0x0000,0x0000,0x6548,0x0000,0x0000': 'E888 AVI5',
        '0x0000,0x0000,0x654c,0x0000,0x0000': 'E888 AVI7',
        '0x0000,0x0000,0x6550,0x0000,0x0000': 'E888 AVI8'
    }
};

/** Numbering rules for M1 Tune resource names (slot = position of the ID in the 5-slot record). */
var M1C_RESOURCE_RULES = {
    M142: [
        // Direct injector drives 1A-, 1B-, 2A- ... 4B- (all 8 confirmed).
        { slot: 2, from: 0x6110, to: 0x6117, name: function (id) {
            var k = id - 0x6110;
            return 'Direct Injector ' + (Math.floor(k / 2) + 1) + (k % 2 ? 'B' : 'A') + '-';
        } },
        // Low side ignition outputs. LS Ignition 1 = 0x611c confirmed; 2-8 inferred from the
        // contiguous block used by cylinders 2-8.
        { slot: 2, from: 0x611c, to: 0x6123, name: function (id) { return 'Low Side Ignition ' + (id - 0x611c + 1); } },
        // Local analogue voltage inputs AVI1-17 (AVI2 = 0x6201 and AVI17 = 0x6210 confirmed).
        { slot: 2, from: 0x6200, to: 0x6210, name: function (id) { return 'AVI' + (id - 0x6200 + 1); } },
        // Analogue temperature inputs follow AVI17. AT1 = 0x6211 confirmed; AT2-6 inferred from the
        // contiguous block of temperature sensors at 0x6212-0x6216.
        { slot: 2, from: 0x6211, to: 0x6216, name: function (id) { return 'AT' + (id - 0x6211 + 1); } },
        // Universal digital inputs UDIG1-12: frequency inputs use [0x6400+n-1, 0, 0x6462+n, 0, 0x6440+n-1]
        // (UDIG2/3/4/7 confirmed: cam, throttle decode, rear wheel speed, fuel composition); switch inputs
        // use slot 2 only (UDIG12 = 0x646e confirmed: Driver Switch 1).
        { slot: 0, from: 0x6400, to: 0x640b, name: function (id) { return 'UDIG' + (id - 0x6400 + 1); } },
        { slot: 2, from: 0x6463, to: 0x646e, name: function (id) { return 'UDIG' + (id - 0x6462); } },
        // Knock inputs 1-4 (1 and 2 confirmed: odd / even cylinders).
        { slot: 2, from: 0x6100, to: 0x6103, name: function (id) { return 'Knock Input ' + (id - 0x6100 + 1); } },
        // Low side injector outputs 1-6 (2 and 3 confirmed: Auxiliary Outputs 2 and 3).
        { slot: 1, from: 0x6430, to: 0x6435, name: function (id) { return 'Low Side Injector ' + (id - 0x6430 + 1); } },
        // Bridge outputs (Bridge Output 1 = 0x645b confirmed: throttle servo motor; 2-5 inferred — the DI pump
        // at 0x645c is wired to HB3/HB4 = Bridge Output 2 in the Aston harness).
        { slot: 1, from: 0x645b, to: 0x645f, name: function (id) { return 'Bridge Output ' + (id - 0x645b + 1); } },
        // PDM (CAN power distribution) outputs: 8 IDs per byte, Mask 01 at the top of each block and
        // masks 02-80 counting downward (Byte 0/1/2 Mask 01 = 0x6567/0x656f/0x6577 and
        // Byte 0 Mask 02 = 0x6566 confirmed).
        { slot: 1, from: 0x6560, to: 0x6577, name: function (id) {
            var k = id - 0x6560, mask = 1 << (7 - k % 8);
            return 'PDM Byte ' + Math.floor(k / 8) + ', Mask ' + ('0' + mask.toString(16).toUpperCase()).slice(-2);
        } },
        // E888 (CAN expander) outputs 1-8 (2-6 and 8 confirmed).
        { slot: 1, from: 0x6578, to: 0x657f, name: function (id) { return 'E888 Output ' + (id - 0x6578 + 1); } },
        // FIRMWARE0-31 (0, 4 and 10 checked; M1 Tune lists 32).
        { slot: 2, from: 0x6520, to: 0x653f, name: function (id) { return 'FIRMWARE' + (id - 0x6520); } }
    ]
};

/**
 * Connector pins from the hardware documentation, keyed by the canonical form from m1cPinKey.
 * M142: datasheet part 13142, connectors A-D. Direct injectors list the '-' pin M1 Tune assigns,
 * then the '+' pin. E888: user manual Appendix G (its own A/B connectors), used for "E888 …" names
 * on any ECU; thermocouples list the '+' pin, then the '-' pin.
 */
var M1C_PINOUTS = {
    M142: {
        av1: 'C14', av2: 'C15', av3: 'C16', av4: 'C17', av5: 'C25', av6: 'D20', av7: 'D21', av8: 'D22',
        av9: 'B10', av10: 'B11', av11: 'B12', av12: 'B16', av13: 'B17', av14: 'B18', av15: 'A03', av16: 'A04',
        av17: 'A05',
        at1: 'D03', at2: 'D04', at3: 'D05', at4: 'D06', at5: 'A01', at6: 'A02',
        di1a: 'A06 (+ A07)', di1b: 'A09 (+ A08)', di2a: 'B22 (+ B23)', di2b: 'B25 (+ B24)',
        di3a: 'C27 (+ C19)', di3b: 'C28 (+ C20)', di4a: 'C29 (+ C21)', di4b: 'C30 (+ C22)',
        ign1: 'C03', ign2: 'C04', ign3: 'C05', ign4: 'C06', ign5: 'C07', ign6: 'C08', ign7: 'C12', ign8: 'C13',
        inj1: 'C23', inj2: 'C24', inj3: 'B09', inj4: 'B15', inj5: 'B08', inj6: 'B14',
        hb1: 'C18', hb2: 'C01', hb3: 'C31', hb4: 'C32', hb5: 'C33', hb6: 'C34', hb7: 'B20', hb8: 'B21',
        hb9: 'B01', hb10: 'B02',
        udig1: 'D01', udig2: 'D02', udig3: 'D08', udig4: 'D09', udig5: 'D10', udig6: 'D11', udig7: 'D14',
        udig8: 'B03', udig9: 'B04', udig10: 'B05', udig11: 'B06', udig12: 'B07',
        dig1: 'A23', dig2: 'A15', dig3: 'A16', dig4: 'A17',
        knock1: 'D07', knock2: 'D13', knock3: 'A13', knock4: 'A14',
        lambda1: 'A11', lambda2: 'A12',
        rs232: 'A21 (TX A22)', lin: 'A20',
        can1: 'D17 (LO D18)', can2: 'A30 (LO A31)', can3: 'A28 (LO A29)',
        // Bridge outputs pair two half bridges: Bridge Output 1 = HB1 + HB2 (confirmed); 2-5 follow the same
        // pairing (HB3+HB4 …).
        bridge1: 'C18 / C01', bridge2: 'C31 / C32', bridge3: 'C33 / C34', bridge4: 'B20 / B21', bridge5: 'B01 / B02'
    },
    E888: {
        av1: 'A22', av2: 'A23', av3: 'A24', av4: 'A25', av5: 'A30', av6: 'A31', av7: 'A32', av8: 'A33',
        out1: 'B1', out2: 'B2', out3: 'B3', out4: 'B4', out5: 'B5', out6: 'B6', out7: 'B7', out8: 'B13',
        tc1: 'A1 (- A2)', tc2: 'A3 (- A4)', tc3: 'A14 (- A5)', tc4: 'A12 (- A13)',
        tc5: 'A18 (- A19)', tc6: 'A20 (- A21)', tc7: 'A26 (- A27)', tc8: 'A28 (- A29)',
        cjc1: 'A6', cjc2: 'A7',
        dig1: 'B11', dig2: 'B10', dig3: 'B19', dig4: 'B18', dig5: 'B12', dig6: 'B25',
        can1: 'B23 (LO B24)'
    }
};

/** Expander modules whose resources M1 Tune prefixes with the device name, e.g. "E888 AVI7". */
var M1C_PIN_DEVICES = /^(e888)\s+(.*)$/;

/** Name spellings (M1 Tune, datasheet designation and full name) → canonical pinout key prefix. */
var M1C_PIN_PATTERNS = [
    [/^(?:avi?|analog(?:ue)? voltage(?: input)?) ?(\d+)$/, 'av'],
    [/^(?:at|analog(?:ue)? temp(?:erature)?(?: input)?) ?(\d+)$/, 'at'],
    [/^(?:direct injector|inj_?d) ?(\d[ab])(?: ?[-+]|_neg|_pos)?$/, 'di'],
    [/^(?:low side ignition|ign_?ls) ?(\d+)$/, 'ign'],
    [/^(?:low side injector|inj_?ls) ?(\d+)$/, 'inj'],
    [/^(?:half bridge(?: output)?|out_?hb|hb) ?(\d+)$/, 'hb'],
    [/^(?:h-?bridge|bridge)(?: output)? ?(\d+)$/, 'bridge'],
    [/^(?:universal digital(?: input)?|udig) ?(\d+)$/, 'udig'],
    [/^(?:digital input|dig) ?(\d+)$/, 'dig'],
    [/^knock(?: input)? ?(\d+)$/, 'knock'],
    [/^(?:lambda narrow(?: input)?|la_?nb) ?(\d+)$/, 'lambda'],
    [/^(?:can(?: bus)?) ?(\d)$/, 'can'],
    [/^(?:output|pwm|aux(?:iliary)?(?: output)?|exaux) ?(\d+)$/, 'out'],
    [/^(?:tc|thermocouple(?: input)?|extc) ?(\d+)$/, 'tc'],
    [/^cjc ?(\d)$/, 'cjc'],
    [/^(rs232|lin)(?: bus| receive)?$/, '']
];

/** Canonical pinout key for a resource name, e.g. "Analogue Voltage Input 2" / "AVI2" → "av2". */
function m1cPinKey(name) {
    var n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    for (var i = 0; i < M1C_PIN_PATTERNS.length; i++) {
        var m = n.match(M1C_PIN_PATTERNS[i][0]);
        if (m) return M1C_PIN_PATTERNS[i][1] + m[1];
    }
    return null;
}

/**
 * Connector pin for a resource name, labelled with the unit it is on: "M142 pin C15" on the ECU,
 * "E888 pin A32" on an E888 expander, or null when unknown (PDM, FIRMWARE, other hardware).
 */
function m1cResourcePin(name, hardware) {
    var device = String(name || '').trim().toLowerCase().match(M1C_PIN_DEVICES);
    var unit = device ? device[1].toUpperCase() : hardware || '';
    var pins = M1C_PINOUTS[unit], key = m1cPinKey(device ? device[2] : name);
    if (!pins || !key || !pins[key]) return null;
    return unit + ' pin ' + pins[key];
}

function m1cResourceKey(ids) {
    return (ids || []).join(',');
}

function m1cResourceAssigned(ids) {
    return (ids || []).some(function (id) { return id !== '0x0000'; });
}

/**
 * Resolve a resource name. `userNames` maps 'HARDWARE|signature' → name (user entries win).
 * Returns { name, source: 'user' | 'known' | 'rule' } or null when unknown.
 */
function m1cResourceName(ids, hardware, userNames) {
    if (!m1cResourceAssigned(ids)) return null;
    var key = m1cResourceKey(ids), hw = hardware || '';
    if (userNames && userNames[hw + '|' + key]) return { name: userNames[hw + '|' + key], source: 'user' };
    var known = M1C_KNOWN_RESOURCES[hw];
    if (known && known[key]) return { name: known[key], source: 'known' };
    var rules = M1C_RESOURCE_RULES[hw] || [];
    for (var i = 0; i < rules.length; i++) {
        var r = rules[i], id = parseInt(ids[r.slot], 16);
        if (id >= r.from && id <= r.to) return { name: r.name(id), source: 'rule' };
    }
    return null;
}

/** Display text: "FIRMWARE4 (0x6524)", raw IDs when unnamed, or "Not assigned". */
function m1cResourceLabel(ids, hardware, userNames) {
    if (!m1cResourceAssigned(ids)) return 'Not assigned';
    var raw = ids.filter(function (id) { return id !== '0x0000'; }).join(', ');
    var n = m1cResourceName(ids, hardware, userNames);
    return n ? n.name + ' (' + raw + ')' : raw;
}

/** Connector pin of an assignment ("M142 pin C15", "E888 pin A32"), or null when unnamed or unknown. */
function m1cResourcePinFor(ids, hardware, userNames) {
    var n = m1cResourceName(ids, hardware, userNames);
    return n ? m1cResourcePin(n.name, hardware) : null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        m1cResourceKey: m1cResourceKey, m1cResourceName: m1cResourceName,
        m1cResourceLabel: m1cResourceLabel, m1cResourceAssigned: m1cResourceAssigned,
        m1cResourcePin: m1cResourcePin, m1cResourcePinFor: m1cResourcePinFor, m1cPinKey: m1cPinKey
    };
}
