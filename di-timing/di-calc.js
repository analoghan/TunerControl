/**
 * di-timing/di-calc.js — Direct injection timing calculations (no DOM; shared by the page and the tests).
 *
 * Angles are in M1's scale: degrees before the firing (compression) TDC — "dBTDC", as M1 Tune shows Fuel Timing
 * Primary Main and its limits. On it: 720/0 = firing TDC, 540 = BDC after the power stroke, 360 = TDC between
 * exhaust and intake (overlap TDC), 180 = BDC after the intake stroke. A larger value is earlier in the cycle.
 * (The MoTeC training spreadsheet's "720° reference", counted from firing TDC, is 720 − dBTDC.)
 *
 * Valve events follow the GM Gen V calculator (SOI sheet): seat-to-seat (0.006") duration ≈ 0.050" duration + 52°,
 * exhaust centreline = 2 × LSA − ICL, and the optimal start of injection is halfway between intake valve opening and
 * the intake centreline (0.006" events), but at least 20° after overlap TDC.
 */

var DI_SEAT_EXTRA = 52;          // 0.006" duration ≈ 0.050" duration + this
var DI_MIN_SOI_ATDC = 20;        // the spreadsheet never starts injection earlier than 20° after overlap TDC
var DI_EVC_BUFFER = 5;           // start at least this long after the exhaust valve seats
var DI_SPARK_CLEARANCE = 10;     // end injection at least this long before the spark (GM's EOI spark offset is 5°; 10° is the safer minimum)
var DI_LATE_SOI = 230;           // a start later than this (dBTDC) is close to BDC, where the slow intake air mixes the fuel poorly
var DI_BDC = 180;                // intake BDC in dBTDC: injection after it is on the compression stroke

/** Crank degrees one injection lasts: PW (ms) × rpm × 0.006 (= 360° × rpm / 60 / 1000). */
function diCrankDeg(pwMs, rpm) { return pwMs * rpm * 0.006; }

/**
 * Valve events for one lift basis.
 * cam: { intakeDur, exhaustDur, lsa, icl, phaser (°, advance), phaserMovesExhaust (cam-in-block, e.g. GM Gen V) }
 * Returns crank-referenced events (as on a cam card) and their dBTDC positions.
 */
function diEvents(intakeDur, exhaustDur, lsa, icl, phaser, phaserMovesExhaust) {
    var adv = phaser || 0;
    var iclEff = icl - adv;                                    // intake centreline, ° after overlap TDC
    var ecl = 2 * lsa - icl + (phaserMovesExhaust ? adv : 0);  // exhaust centreline, ° before overlap TDC
    var ivo = intakeDur / 2 - iclEff;                          // ° BTDC (overlap)
    var ivc = intakeDur - ivo - 180;                           // ° ABDC (intake)
    var evc = exhaustDur / 2 - ecl;                            // ° ATDC (overlap)
    var evo = exhaustDur - evc - 180;                          // ° BBDC (power)
    return {
        icl: iclEff, ecl: ecl, ivoBTDC: ivo, ivcABDC: ivc, evoBBDC: evo, evcATDC: evc,
        overlap: (intakeDur + exhaustDur) / 2 - 2 * lsa + (phaserMovesExhaust ? 0 : adv),
        dBTDC: { ivo: 360 + ivo, ivc: 180 - ivc, evo: 540 + evo, evc: 360 - evc }
    };
}

/** Events at 0.050" and seat-to-seat (0.006"). cam.basis = '050' (default) or '006' says which the durations are. */
function diValveEvents(cam) {
    var extra = cam.seatExtra === undefined ? DI_SEAT_EXTRA : cam.seatExtra;
    var i050 = cam.basis === '006' ? cam.intakeDur - extra : cam.intakeDur;
    var e050 = cam.basis === '006' ? cam.exhaustDur - extra : cam.exhaustDur;
    return {
        at050: diEvents(i050, e050, cam.lsa, cam.icl, cam.phaser, cam.phaserMovesExhaust),
        at006: diEvents(i050 + extra, e050 + extra, cam.lsa, cam.icl, cam.phaser, cam.phaserMovesExhaust)
    };
}

/**
 * Recommended start of injection: the spreadsheet's point (halfway from IVO to the intake centreline, ≥ 20° ATDC),
 * moved later if needed so it is at least DI_EVC_BUFFER after the exhaust valve seats.
 * Returns { atdc (° after overlap TDC), dBTDC, spreadsheetAtdc, limitedByEvc }.
 */
function diRecommendSoi(ev006, buffer) {
    var b = buffer === undefined ? DI_EVC_BUFFER : buffer;
    var sheet = Math.max((ev006.icl - ev006.ivoBTDC) / 2, DI_MIN_SOI_ATDC);
    var afterEvc = ev006.evcATDC + b;
    var atdc = Math.max(sheet, afterEvc);
    return { atdc: atdc, dBTDC: 360 - atdc, spreadsheetAtdc: sheet, limitedByEvc: afterEvc > sheet };
}

/**
 * Where one injection ends and what it runs into.
 * ctx: { evc (dBTDC, seat-to-seat), spark (° BTDC), primaryLimit (dBTDC) }
 */
function diCheckInjection(soi, pwMs, rpm, ctx) {
    var crank = diCrankDeg(pwMs, rpm), eoi = soi - crank;
    return {
        soi: soi, eoi: eoi, crank: crank,
        beforeEvc: ctx.evc !== undefined && soi > ctx.evc,
        intoCompression: eoi < DI_BDC,
        truncated: ctx.primaryLimit !== undefined && eoi < ctx.primaryLimit,
        nearSpark: ctx.spark !== undefined && eoi - ctx.spark < DI_SPARK_CLEARANCE
    };
}

/** Longest pulse (ms) that fits between soi and an end angle at rpm. */
function diMaxPw(soi, endAngle, rpm) { return rpm > 0 ? (soi - endAngle) / (rpm * 0.006) : Infinity; }

/**
 * Start of injection by engine speed for a design pulse width: the recommended SOI, moved earlier (towards the
 * exhaust valve closing, never before it) only where the pulse would otherwise run into the compression stroke.
 * opts: { soi, earliest (dBTDC, the latest-allowed early bound: EVC − buffer), pwMs, spark, primaryLimit, evc }
 */
function diSoiTable(rpms, opts) {
    return rpms.map(function (rpm) {
        var crank = diCrankDeg(opts.pwMs, rpm), soi = opts.soi;
        if (soi - crank < DI_BDC) soi = Math.min(opts.earliest, DI_BDC + crank);
        soi = Math.round(soi);
        var c = diCheckInjection(soi, opts.pwMs, rpm, opts);
        c.rpm = rpm;
        c.maxPwToBdc = diMaxPw(soi, DI_BDC, rpm);
        c.maxPwToLimit = opts.primaryLimit !== undefined ? diMaxPw(soi, opts.primaryLimit, rpm) : null;
        return c;
    });
}

/**
 * Advice on the M1 limits. limits: { startLimit, primaryLimit } (dBTDC), ev006, spark (max ° BTDC), soiMax (largest
 * value in the tune's table, if known). Returns [{ severity, text }].
 */
function diLimitAdvice(limits, ev006, spark, soiMax) {
    var out = [], evc = ev006.dBTDC.evc, r5 = function (v) { return Math.floor(v / 5) * 5; };
    var recStart = r5(evc - DI_EVC_BUFFER);
    if (limits.startLimit !== null && limits.startLimit !== undefined) {
        if (limits.startLimit > evc) {
            var tableEarly = soiMax !== null && soiMax !== undefined && soiMax > evc;
            out.push({ severity: tableEarly || limits.startLimit - evc > 10 ? 'warning' : 'info', text: 'Injection Start Limit ' + limits.startLimit +
                ' dBTDC lets injection start up to ' + Math.round(limits.startLimit - evc) + '° before the exhaust valve seats (' + Math.round(evc) +
                ' dBTDC at 0.006"); fuel injected then partly leaves through the exhaust. Ideally injection always starts after the exhaust ' +
                'valve closes — a limit of about ' + recStart + ' dBTDC. On a supercharged or turbocharged engine an earlier start can be ' +
                'deliberate where the pulse would otherwise run into the compression stroke; then allow only as much as those cells need.' +
                (tableEarly ? ' The timing table asks for up to ' + Math.round(soiMax) + ' dBTDC, earlier than the exhaust valve closes.' : '') });
        } else if (soiMax !== null && soiMax !== undefined && soiMax > limits.startLimit) {
            out.push({ severity: 'info', text: 'Some timing table cells (up to ' + Math.round(soiMax) + ' dBTDC) are earlier than the Injection ' +
                'Start Limit (' + limits.startLimit + '); M1 starts those injections at the limit instead.' });
        } else {
            out.push({ severity: 'good', text: 'Injection Start Limit ' + limits.startLimit + ' dBTDC is after the exhaust valve seats (' +
                Math.round(evc) + ' dBTDC).' });
        }
    }
    if (limits.primaryLimit !== null && limits.primaryLimit !== undefined) {
        var minLimit = (spark || 0) + DI_SPARK_CLEARANCE;
        if (limits.primaryLimit < minLimit) {
            out.push({ severity: 'warning', text: 'Primary Limit ' + limits.primaryLimit + ' dBTDC lets injection run to within ' +
                Math.round(limits.primaryLimit - (spark || 0)) + '° of the spark (max ' + spark + '° BTDC): fuel sprayed that late can douse the ' +
                'spark and misfire. Keep it at least ' + DI_SPARK_CLEARANCE + '° before the spark (GM allows 5°; 10° is safer) — about ' +
                Math.ceil(minLimit / 5) * 5 + ' dBTDC or more.' });
        } else {
            out.push({ severity: 'good', text: 'Primary Limit ' + limits.primaryLimit + ' dBTDC ends injection ' +
                Math.round(limits.primaryLimit - (spark || 0)) + '° before the most advanced spark (' + spark + '° BTDC)' +
                (limits.primaryLimit < DI_BDC ? ', allowing up to ' + Math.round(DI_BDC - limits.primaryLimit) + '° into the compression stroke ' +
                    'before the pulse is cut short.' : ' and before the compression stroke.') });
        }
    }
    return out;
}

/** Check each cell of the tune's timing table (SOI, dBTDC): earlier than the seat-to-seat EVC, or late near BDC. */
function diTableCheck(table, ev006) {
    var evc = ev006.dBTDC.evc, early = [], late = [];
    table.values.forEach(function (row, m) {
        row.forEach(function (v, r) {
            if (v > evc) early.push({ rpm: table.rpm[r], map: table.map[m], soi: v, by: v - evc });
            if (v < DI_LATE_SOI) late.push({ rpm: table.rpm[r], map: table.map[m], soi: v });
        });
    });
    return { early: early, late: late, max: Math.max.apply(null, table.values.map(function (row) { return Math.max.apply(null, row); })) };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { diValveEvents: diValveEvents, diEvents: diEvents, diRecommendSoi: diRecommendSoi, diCheckInjection: diCheckInjection,
        diSoiTable: diSoiTable, diLimitAdvice: diLimitAdvice, diTableCheck: diTableCheck, diCrankDeg: diCrankDeg, diMaxPw: diMaxPw,
        DI_SEAT_EXTRA: DI_SEAT_EXTRA, DI_BDC: DI_BDC, DI_SPARK_CLEARANCE: DI_SPARK_CLEARANCE, DI_LATE_SOI: DI_LATE_SOI };
}
