/**
 * transient-fuel/film-correct.js — Fuel Film Primary table: CSV parsing and corrections from tip-in lean spikes.
 * Shared by the page (app.js) and the tests.
 */

function parseFuelFilmTable(csvText) {
    var lines = csvText.split(/\r?\n/);
    // M1 v2 format: header rows then breakpoints row then data row
    // Line 0: M1,v2
    // Line 1: Body,ul
    // Line 2: Cols,kPa,Inlet Man Pres
    // Line 3: ,bp1,bp2,bp3,...  (MAP breakpoints)
    // Line 4: "0",val1,val2,val3,...  (values)

    var breakpoints = [];
    var values = [];

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line === '') continue;
        var fields = line.split(',').map(function(f) { return f.trim().replace(/^"|"$/g, ''); });

        // Breakpoints row: first field is empty, rest are numbers
        if (fields[0] === '' && fields.length > 2 && !isNaN(parseFloat(fields[1]))) {
            for (var f = 1; f < fields.length; f++) {
                var v = parseFloat(fields[f]);
                if (!isNaN(v)) breakpoints.push(v);
            }
        }
        // Data row: first field is "0" or a number, rest are values
        else if (breakpoints.length > 0 && fields.length > 2 && !isNaN(parseFloat(fields[1]))) {
            var isDataRow = !isNaN(parseFloat(fields[0])) || fields[0] === '0';
            if (isDataRow) {
                for (var f = 1; f < fields.length; f++) {
                    var v = parseFloat(fields[f]);
                    if (!isNaN(v)) values.push(v);
                }
            }
        }
    }

    if (breakpoints.length === 0 || values.length === 0) {
        throw new Error('Could not parse Fuel Film Primary table. Expected M1 v2 CSV format.');
    }

    return { breakpoints: breakpoints, values: values };
}

function computeFuelFilmCorrections(result, settings) {
    var ffTable = result.ffTable;
    var scale = (settings.ffScale || 100) / 100;
    var offset = settings.ffOffset || 0;
    var tipIns = result.tipIns;

    var corrected = ffTable.values.slice();
    var corrections = new Array(ffTable.breakpoints.length);
    var eventCounts = new Array(ffTable.breakpoints.length);
    var leanSpikesPerBin = []; // store lean spikes per breakpoint for analysis
    for (var i = 0; i < corrections.length; i++) { corrections[i] = 0; eventCounts[i] = 0; leanSpikesPerBin.push([]); }

    for (var e = 0; e < tipIns.length; e++) {
        var evt = tipIns[e];
        if (evt.leanSpike <= 2) continue;
        if ((evt.richBefore || 0) > 3) continue;   // rich before the lean peak: not a shortage of film (see generateRecommendations)

        var bestIdx = 0;
        var bestDist = Math.abs(evt.mapTo - ffTable.breakpoints[0]);
        for (var b = 1; b < ffTable.breakpoints.length; b++) {
            var dist = Math.abs(evt.mapTo - ffTable.breakpoints[b]);
            if (dist < bestDist) { bestDist = dist; bestIdx = b; }
        }

        // The film actually used is table × scale + offset. Raise it in proportion to the lean spike (capped at
        // 25%; a near-zero film is treated as 5 ul so it can grow), then convert that change back to table units.
        var currentEffective = ffTable.values[bestIdx] * scale + offset;
        var correctionPct = Math.min(evt.leanSpike / 100, 0.25);
        var effectiveIncrease = Math.max(currentEffective, 5) * correctionPct;
        var additionalNeeded = scale > 0 ? effectiveIncrease / scale : effectiveIncrease;

        corrections[bestIdx] += additionalNeeded;
        eventCounts[bestIdx]++;
        leanSpikesPerBin[bestIdx].push(evt.leanSpike);
    }

    // Average corrections and apply with damping
    for (var i = 0; i < corrected.length; i++) {
        if (eventCounts[i] > 0) {
            var avgCorrection = corrections[i] / eventCounts[i];
            corrected[i] = ffTable.values[i] + avgCorrection * 0.75;
            if (corrected[i] < 0) corrected[i] = 0;
            // Never more than +50% of the cell in one step (a zero cell may take the computed step).
            var maxIncrease = ffTable.values[i] * 0.5;
            if (maxIncrease > 0 && (corrected[i] - ffTable.values[i]) > maxIncrease) {
                corrected[i] = ffTable.values[i] + maxIncrease;
            }
            corrected[i] = Math.round(corrected[i] * 10) / 10;
        }
    }

    // --- Scale vs Offset vs Cell analysis ---
    // Determine whether the error pattern suggests changing scale, offset, or individual cells
    var scaleOffsetAdvice = analyzeScaleVsOffset(ffTable, leanSpikesPerBin, eventCounts, scale, offset);

    return {
        breakpoints: ffTable.breakpoints,
        original: ffTable.values,
        corrected: corrected,
        corrections: corrections.map(function(c, i) { return eventCounts[i] > 0 ? Math.round(c / eventCounts[i] * 10) / 10 : 0; }),
        eventCounts: eventCounts,
        scaleOffsetAdvice: scaleOffsetAdvice,
    };
}

/**
 * Analyzes whether lean spikes correlate with table values (scale issue),
 * are constant across zones (offset issue), or are localized (cell issue).
 */
function analyzeScaleVsOffset(ffTable, leanSpikesPerBin, eventCounts, scale, offset) {
    // Get average lean spike per bin (only bins with data)
    var binsWithData = [];
    for (var i = 0; i < ffTable.breakpoints.length; i++) {
        if (eventCounts[i] > 2 && leanSpikesPerBin[i].length > 0) {
            var avgSpike = leanSpikesPerBin[i].reduce(function(a, b) { return a + b; }, 0) / leanSpikesPerBin[i].length;
            var effectiveValue = ffTable.values[i] * scale + offset;
            binsWithData.push({ idx: i, map: ffTable.breakpoints[i], avgSpike: avgSpike, value: effectiveValue });
        }
    }

    if (binsWithData.length < 2) {
        return { type: 'cells', message: 'Not enough data across multiple MAP zones to determine scale vs offset. Adjust individual cells based on the corrected table above.' };
    }

    // Check if lean spikes are proportional to table values (= scale issue)
    // Compute correlation between effective_value and lean_spike
    var n = binsWithData.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (var i = 0; i < n; i++) {
        var x = binsWithData[i].value;
        var y = binsWithData[i].avgSpike;
        sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x; sumY2 += y * y;
    }
    var correlation = (n * sumXY - sumX * sumY) / (Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)) || 1);

    // Check if lean spikes are roughly constant (= offset issue)
    var avgSpike = sumY / n;
    var spikeVariance = 0;
    for (var i = 0; i < n; i++) {
        var diff = binsWithData[i].avgSpike - avgSpike;
        spikeVariance += diff * diff;
    }
    var spikeStdDev = Math.sqrt(spikeVariance / n);
    var coeffOfVariation = avgSpike > 0 ? spikeStdDev / avgSpike : 999;

    // Decision logic
    if (correlation > 0.7 && n >= 3) {
        // Lean spikes correlate with table values → scale issue
        // Compute suggested scale: avgSpike% tells us how much more compensation is needed
        var avgPctError = avgSpike / 100; // e.g., 10% → 0.10
        var suggestedScale = Math.round((scale * (1 + avgPctError)) * 100);
        return {
            type: 'scale',
            message: 'Lean spikes are proportional to current table values (correlation ' + correlation.toFixed(2) + '). This suggests the table shape is correct but the overall magnitude is too low. Consider increasing the Fuel Film Scale from ' + Math.round(scale * 100) + '% to approximately ' + suggestedScale + '% — this adjusts all cells proportionally without changing the table shape.',
            suggestedScale: suggestedScale
        };
    } else if (coeffOfVariation < 0.4 && n >= 3) {
        // Lean spikes are roughly constant across zones → offset issue
        // Compute suggested offset increase
        // Average lean spike of X% on an average effective value means we need ~X% more volume
        var avgEffective = sumX / n;
        var additionalOffset = Math.round(avgEffective * (avgSpike / 100));
        var suggestedOffset = offset + additionalOffset;
        return {
            type: 'offset',
            message: 'Lean spikes are roughly constant across MAP zones (avg ' + avgSpike.toFixed(1) + '% ± ' + spikeStdDev.toFixed(1) + '%). This suggests a flat fuel deficit regardless of load — consistent with an offset issue. Consider increasing the Fuel Film Offset from ' + offset + ' ul to approximately ' + suggestedOffset + ' ul. This adds a fixed amount of compensation at every MAP point without changing the table values.',
            suggestedOffset: suggestedOffset
        };
    } else {
        // Localized — different zones have different issues
        var worstZone = binsWithData.sort(function(a, b) { return b.avgSpike - a.avgSpike; })[0];
        return {
            type: 'cells',
            message: 'Lean spikes vary by MAP zone (not proportional, not constant). The errors are localized to specific operating regions. Adjust individual table cells using the corrected values above. The worst zone is around ' + worstZone.map + ' kPa with ' + worstZone.avgSpike.toFixed(1) + '% avg lean spike.'
        };
    }
}

