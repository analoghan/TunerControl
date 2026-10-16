/**
 * knock/knock-freq.js — Bore-based knock frequencies (MoTeC M1 training method).
 *
 * MoTeC's knock setup training (M1 Training 51) works an 87.5 mm bore to a first order frequency of about 6,500 Hz
 * and takes the second order as exactly double. The frequency scales inversely with bore, so first order ≈
 * KNOCK_FREQ_HZ_MM / bore. (The same as Draper's first circumferential mode, 1.841·c / (π·B), with c ≈ 970 m/s.)
 * The A–D sweep follows the training's example: first order, a midpoint, second order and one above it.
 */

/** Hz·mm: 6,500 Hz × 87.5 mm, the worked example in MoTeC's knock training. */
var KNOCK_FREQ_HZ_MM = 6500 * 87.5;

function knockRound(v, step) { return Math.round(v / step) * step; }

/**
 * Bore (mm) → { first, second, sweep: [A, B, C, D] } in Hz, or null for an unusable bore.
 * Sweep: A = first order, B = midway, C = second order, D = second order + 15 % (the training used
 * 6,500 / 10,000 / 13,000 / 15,000 for 87.5 mm).
 */
function knockFrequencies(boreMm) {
    if (!(boreMm > 30 && boreMm < 250)) return null;
    var first = knockRound(KNOCK_FREQ_HZ_MM / boreMm, 10), second = first * 2;
    return {
        first: first,
        second: second,
        sweep: [knockRound(first, 100), knockRound((first + second) / 2, 100), knockRound(second, 100), knockRound(second * 1.15, 100)]
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { knockFrequencies: knockFrequencies, KNOCK_FREQ_HZ_MM: KNOCK_FREQ_HZ_MM };
}
