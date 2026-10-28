/**
 * history/run-builders.js — Turns each tool's result into the summary and detail stored in the tuning history.
 * Pure functions (no DOM), shared by the tool pages, the history page and the tests.
 *
 *   rbVe(msg)           VE Table Tuning worker result
 *   rbTransient(result) Transient Fuel Analyzer result
 *   rbKnock(analysis)   Knock Analyzer worker analysis
 *   rbFuelPressure(analysis)  DI Fuel Pressure worker analysis
 *   rbLogHealth(result) Log Health lhAnalyze result
 *   rbIgnition(result)  Ignition Review igAnalyze result
 *   rbClPeriod(result)  Closed-Loop Period clAnalyze result
 *   rbPulls(result)     Pull Report puAnalyze result
 * Each returns { summary, data }. Values are rounded so a run stays small.
 */

function rbRound(v, dp) {
    if (v === null || v === undefined || isNaN(v)) return null;
    var f = Math.pow(10, dp === undefined ? 2 : dp);
    return Math.round(v * f) / f;
}

function rbVe(msg) {
    var g = msg.correctionGrid, sumAbs = 0, n = 0, over2 = 0, worst = null;
    var cells = g.cells.map(function (row) {
        return row.map(function (c) {
            if (c.correction !== null && c.correction !== undefined) {
                n++; sumAbs += Math.abs(c.correction);
                if (Math.abs(c.correction) > 2) over2++;
                if (worst === null || Math.abs(c.correction) > Math.abs(worst)) worst = c.correction;
            }
            return { c: rbRound(c.correction, 2), n: c.count || 0, le: rbRound(c.lambdaError, 2), cl: rbRound(c.clTrimAvg, 2) };
        });
    });
    return {
        summary: { samples: msg.totalSamples, cells: msg.cellsAboveThreshold, meanAbsCorrection: n ? rbRound(sumAbs / n, 2) : null,
                   cellsOver2: over2, worstCorrection: rbRound(worst, 2) },
        data: { mapBreakpoints: g.mapBreakpoints.slice(), rpmBreakpoints: g.rpmBreakpoints.slice(), cells: cells,
                filtered: { time: msg.filteredByTime, coolant: msg.filteredByCoolant, fuelCut: msg.filteredByFuelCut, steady: msg.filteredBySteady,
                            decel: msg.filteredByDecel, lambda: msg.filteredByLambda } }
    };
}

function rbTransient(r) {
    var zones = {};
    (r.tipIns || []).forEach(function (e) {
        var z = Math.floor(e.mapTo / 20) * 20, zz = zones[z] || (zones[z] = { n: 0, lean: 0, rich: 0, richFirst: 0 });
        zz.n++; zz.lean += e.leanSpike; zz.rich += e.richOvershoot; zz.richFirst += e.richBefore || 0;
    });
    var zoneList = Object.keys(zones).map(Number).sort(function (a, b) { return a - b; }).map(function (z) {
        var zz = zones[z];
        return { from: z, to: z + 20, n: zz.n, lean: rbRound(zz.lean / zz.n, 1), rich: rbRound(zz.rich / zz.n, 1), richFirst: rbRound(zz.richFirst / zz.n, 1) };
    });
    return {
        summary: { tipIns: r.tipInCount, tipOuts: r.tipOutCount, skipped: r.skippedFuelCut || 0, avgLean: rbRound(r.avgLeanSpike, 1),
                   avgRich: rbRound(r.avgRichOvershoot, 1), richFirst: r.richFirstTipIns || 0, avgRecovery: Math.round(r.avgRecoveryTime || 0),
                   unsettled: r.unsettledTipIns || 0 },
        data: { zones: zoneList, recommendations: (r.recommendations || []).map(function (x) { return { severity: x.severity, text: x.text }; }) }
    };
}

function rbKnock(a) {
    var dist = a.cylinderDistribution || { counts: [], total: 0 }, health = a.sensorHealth || { perCylinder: [], weak: [] };
    return {
        summary: { events: a.totalEvents !== undefined ? a.totalEvents : dist.total, perCylinder: dist.counts.slice(),
                   weak: health.weak.map(function (w) { return w.label; }), threshold: a.thresholdLabel || null,
                   maxRetard: a.retardStats ? rbRound(a.retardStats.maxRetard, 1) : null, retardSource: a.retardStats ? a.retardStats.source : null },
        data: {
            health: health.perCylinder.map(function (p) { return { cyl: p.cylinderIndex, median: rbRound(p.median, 2), p99: rbRound(p.p99, 2), input: p.input }; }),
            recommendations: (a.timingRecommendations || []).map(function (x) {
                return { cyl: x.cylinderIndex, events: x.events, maxRatio: x.maxRatio, reductionDeg: x.reductionDeg };
            })
        }
    };
}

function rbFuelPressure(a, rail) {
    var rc = a.railControl || null, cls = rc ? rc.classes : {};
    function share(k) { return cls[k] ? cls[k].share : null; }
    return {
        summary: { pctWithin: rbRound(a.pctWithinTolerance, 1), pctOver: rbRound(a.pctOvershoot, 1), pctUnder: rbRound(a.pctUndershoot, 1),
                   maxOver: rbRound(a.maxOvershoot, 1), maxUnder: rbRound(a.maxUndershoot, 1), aimSteps: (a.transientEvents || []).length,
                   riseOverShare: share('riseOver'), riseLagShare: share('riseLag'), bleedSeconds: cls.bleed ? cls.bleed.seconds : null,
                   pGain: rc && rc.gains ? rc.gains.p : null, iGain: rc && rc.gains ? rc.gains.i : null,
                   pumpMax: a.pump ? a.pump.maxControl : null },
        data: {
            classes: rc ? Object.keys(cls).map(function (k) { return { kind: k, label: cls[k].label, seconds: cls[k].seconds, episodes: cls[k].episodes, share: cls[k].share }; }) : [],
            advice: rc ? rc.advice.map(function (x) { return { severity: x.severity, text: x.text }; }) : [],
            cells: rc && rc.cells ? rc.cells : null,
            aim: rail && rail.aim ? { rpm: rail.aim.rpm, volume: rail.aim.volume, values: rail.aim.values } : null
        }
    };
}

/** Findings that need a look (not ok), compact. */
function rbFindings(findings) {
    return (findings || []).filter(function (f) { return f.severity !== 'ok'; }).map(function (f) {
        return { severity: f.severity, group: f.group, text: f.title };
    });
}

function rbLogHealth(r) {
    var c = r.counts || {};
    var top = (r.findings || []).filter(function (f) { return f.severity === 'fail' || f.severity === 'warn'; })[0];
    return {
        summary: { fail: c.fail || 0, warn: c.warn || 0, info: c.info || 0, runningS: Math.round(r.runningS || 0), top: top ? top.title : null },
        data: { findings: rbFindings(r.findings) }
    };
}

function rbIgnition(r) {
    var knock = (r.cells || []).filter(function (x) { return x.knockPct !== null && x.knockPct !== undefined; });
    var dep = r.departures || {}, cyl = r.cylinders || [];
    return {
        summary: { fitMedian: r.fit ? rbRound(r.fit.median, 2) : null, fitP90: r.fit ? rbRound(r.fit.p90, 2) : null, normalS: Math.round(r.normalS || 0),
                   belowS: dep.below ? rbRound(dep.below.seconds, 1) : 0, aboveS: dep.above ? rbRound(dep.above.seconds, 1) : 0,
                   maxKnockPct: knock.length ? Math.round(Math.max.apply(null, knock.map(function (x) { return x.knockPct; }))) : null,
                   composition: rbRound(r.composition, 1), trimmedCyls: cyl.filter(function (x) { return x.retard < 0; }).map(function (x) { return x.cylinder; }) },
        data: {
            findings: rbFindings(r.findings),
            cylinders: cyl.map(function (x) { return { cyl: x.cylinder, input: x.input, retard: rbRound(x.retard, 1), knockMedian: rbRound(x.knockMedian, 2) }; }),
            cells: (r.cells || []).map(function (x) {
                return { rpm: x.rpm, kpa: x.kpa, s: rbRound(x.seconds, 1), timing: rbRound(x.timing, 1), knockPct: rbRound(x.knockPct, 0) };
            })
        }
    };
}

function rbClPeriod(r) {
    var sites = r.sites || [], ev = r.events || [];
    return {
        summary: { steps: ev.filter(function (e) { return e.source === 'aim'; }).length, cuts: ev.filter(function (e) { return e.source !== 'aim'; }).length,
                   changes: sites.filter(function (s) { return s.suggested !== null; }).length,
                   sites: sites.filter(function (s) { return s.medianMs !== null; }).map(function (s) {
                       return { flow: s.flow, table: Math.round(s.tableMs), measured: Math.round(s.medianMs), suggested: s.suggested };
                   }) },
        data: {
            findings: rbFindings(r.findings),
            sites: sites.map(function (s) {
                return { flow: s.flow, table: Math.round(s.tableMs), n: s.n, measured: s.medianMs !== null ? Math.round(s.medianMs) : null,
                         suggested: s.suggested, action: s.action };
            })
        }
    };
}

function rbPulls(r) {
    var pulls = r.pulls || [], worst = { lean: null, knockPct: null, railUnder: null, lowMin: null };
    function hi(k, v) { if (v !== null && v !== undefined && isFinite(v) && (worst[k] === null || v > worst[k])) worst[k] = v; }
    var rows = pulls.map(function (p) {
        var m = p.metrics || {}, lean = null, kn = null;
        (m.lambda || []).forEach(function (b) { if (b && b.lean !== null && (lean === null || b.lean > lean)) lean = b.lean; });
        (m.knock || []).forEach(function (x) { if (x.pctOfThreshold !== null && (kn === null || x.pctOfThreshold > kn)) kn = x.pctOfThreshold; });
        var under = m.rail && m.rail.worstUnder !== null ? -m.rail.worstUnder : null, low = m.low ? m.low.min : null;
        hi('lean', lean); hi('knockPct', kn); hi('railUnder', under);
        if (low !== null && low !== undefined && (worst.lowMin === null || low < worst.lowMin)) worst.lowMin = low;
        return { rpm: p.rpm, rpmMax: p.rpmMax, mapMax: rbRound(p.mapMax, 0), seconds: rbRound(p.seconds, 1), full: !!p.full, lean: rbRound(lean, 3),
                 knockPct: rbRound(kn, 0), railUnder: rbRound(under, 0), lowMin: rbRound(low, 0),
                 flags: (p.flags || []).filter(function (f) { return f.severity !== 'info'; }).map(function (f) { return { severity: f.severity, text: f.text }; }) };
    });
    return {
        summary: { pulls: pulls.length, full: pulls.filter(function (p) { return p.full; }).length,
                   flagged: rows.filter(function (x) { return x.flags.length; }).length,
                   rpmMax: pulls.length ? Math.max.apply(null, pulls.map(function (p) { return p.rpmMax; })) : null,
                   mapMax: pulls.length ? rbRound(Math.max.apply(null, pulls.map(function (p) { return p.mapMax || 0; })), 0) : null,
                   worstLean: rbRound(worst.lean, 3), worstKnockPct: rbRound(worst.knockPct, 0), worstRailUnder: rbRound(worst.railUnder, 0),
                   lowMin: rbRound(worst.lowMin, 0) },
        data: { findings: rbFindings(r.findings), pulls: rows }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { rbVe: rbVe, rbTransient: rbTransient, rbKnock: rbKnock, rbFuelPressure: rbFuelPressure, rbLogHealth: rbLogHealth,
        rbIgnition: rbIgnition, rbClPeriod: rbClPeriod, rbPulls: rbPulls, rbRound: rbRound };
}
