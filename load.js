import { LOAD } from './thresholds.js';

// Exponentially weighted training load. Standard impulse-response model.
export function computeLoad(rides, asOf = new Date()) {
  const byDay = new Map();
  for (const r of rides) {
    const key = r.date.slice(0, 10);
    byDay.set(key, (byDay.get(key) || 0) + (r.tss || 0));
  }
  const start = new Date(asOf);
  start.setDate(start.getDate() - 180);

  let ctl = 0;
  let atl = 0;
  const series = [];
  const ctlK = 1 - Math.exp(-1 / LOAD.ctlDays);
  const atlK = 1 - Math.exp(-1 / LOAD.atlDays);

  for (let d = new Date(start); d <= asOf; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const tss = byDay.get(key) || 0;
    ctl += (tss - ctl) * ctlK;
    atl += (tss - atl) * atlK;
    series.push({
      date: key,
      tss,
      ctl: Number(ctl.toFixed(1)),
      atl: Number(atl.toFixed(1)),
      tsb: Number((ctl - atl).toFixed(1)),
    });
  }

  const latest = series[series.length - 1];
  let state = 'productive';
  if (latest.tsb > LOAD.tsbFreshAbove) state = 'fresh';
  else if (latest.tsb < LOAD.tsbDeepHoleBelow) state = 'deep_hole';
  else if (latest.tsb < LOAD.tsbFatiguedBelow) state = 'fatigued';

  const last7 = series.slice(-7).reduce((s, d) => s + d.tss, 0);
  const prev7 = series.slice(-14, -7).reduce((s, d) => s + d.tss, 0);
  const rampPct = prev7 > 0 ? Number((((last7 - prev7) / prev7) * 100).toFixed(1)) : null;

  return {
    series,
    ctl: latest.ctl,
    atl: latest.atl,
    tsb: latest.tsb,
    state,
    last7dTss: Math.round(last7),
    rampPct,
    rampWarning: rampPct != null && rampPct > LOAD.maxWeeklyRampPct,
  };
}

// Phenotype from the shape of the power-duration curve, not a dropdown.
// Ratios are relative to 20-minute power, which anchors the aerobic end.
export function computePhenotype(bestPowers) {
  const p5s = bestPowers['5s'];
  const p1m = bestPowers['1m'];
  const p5m = bestPowers['5m'];
  const p20m = bestPowers['20m'];
  if (!p5s || !p5m || !p20m) {
    return { label: 'unknown', confidence: 'insufficient', ratios: {} };
  }

  const sprintRatio = p5s / p20m;
  const vo2Ratio = p5m / p20m;
  const anaerobicRatio = p1m ? p1m / p20m : null;

  let label;
  if (sprintRatio >= 2.6) label = 'sprinter';
  else if (anaerobicRatio && anaerobicRatio >= 1.45 && sprintRatio >= 2.0) label = 'puncheur';
  else if (vo2Ratio <= 1.12) label = 'time_trial_diesel';
  else label = 'all_rounder';

  return {
    label,
    confidence: p1m ? 'moderate' : 'low',
    ratios: {
      sprint_5s_over_20m: Number(sprintRatio.toFixed(2)),
      anaerobic_1m_over_20m: anaerobicRatio ? Number(anaerobicRatio.toFixed(2)) : null,
      vo2_5m_over_20m: Number(vo2Ratio.toFixed(2)),
    },
    // What this phenotype most needs work on, given a road-racing goal
    trainingBias:
      label === 'time_trial_diesel'
        ? 'add neuromuscular and VO2 work; the aerobic end is already strong'
        : label === 'sprinter' || label === 'puncheur'
        ? 'extend time-to-exhaustion at threshold; the top end is not the limiter'
        : 'balanced development, lean into whichever ceiling is nearest a goal event',
  };
}

// Best power at each duration across a set of rides.
export function aggregateBestPowers(rides) {
  const best = {};
  for (const r of rides) {
    for (const [dur, entry] of Object.entries(r.peakPowers || {})) {
      const watts = typeof entry === 'number' ? entry : entry?.power;
      if (watts == null) continue;
      if (!best[dur] || watts > best[dur]) best[dur] = watts;
    }
  }
  return best;
}
