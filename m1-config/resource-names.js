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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        m1cResourceKey: m1cResourceKey, m1cResourceName: m1cResourceName,
        m1cResourceLabel: m1cResourceLabel, m1cResourceAssigned: m1cResourceAssigned
    };
}
