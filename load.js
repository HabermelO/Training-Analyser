import { LOAD, TID } from './thresholds.js';

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

// --- Intensity distribution -------------------------------------------------
//
// The planner counts hard *sessions* against a budget. That is a poor proxy for
// what the athlete actually did: three "endurance" rides that each drift into
// tempo read as 80/20 by session count and closer to 50/50 by time. This
// collapses the six power zones to three and measures realised distribution by
// minutes, which is the only way to see the mid-zone trap.
//
// Power zones are used where present. HR zones are the fallback, so a ride from
// a session without a meter still contributes rather than silently vanishing
// and biasing the ratio toward whichever rides happened to have power.

const EASY_POWER_ZONES = ['Z1_Recovery', 'Z2_Endurance'];
const MODERATE_POWER_ZONES = ['Z3_Tempo'];
const HARD_POWER_ZONES = ['Z4_Threshold', 'Z5_VO2Max', 'Z6_Anaerobic'];

const EASY_HR_ZONES = ['z1', 'z2'];
const MODERATE_HR_ZONES = ['z3'];
const HARD_HR_ZONES = ['z4', 'z5'];

const sumZones = (obj, keys) =>
  keys.reduce((s, k) => s + (Number(obj?.[k]) || 0), 0);

/**
 * Realised time-in-zone distribution over a trailing window.
 *
 * @param {Array} rides - each { date, zoneMinutes?, hrZoneMinutes? }
 * @param {object} opts - { days = 42, asOf }
 * @returns {{ easyPct, moderatePct, hardPct, model, rideCount, totalMin,
 *             easyMin, moderateMin, hardMin, source, days, note }}
 */
export function intensityDistribution(rides = [], { days = TID.windowDays, asOf } = {}) {
  const end = asOf ? new Date(asOf) : new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);

  let easyMin = 0;
  let moderateMin = 0;
  let hardMin = 0;
  let rideCount = 0;
  let powerRides = 0;
  let hrOnlyRides = 0;

  for (const r of rides) {
    if (!r?.date) continue;
    const d = new Date(r.date);
    if (!(d > start && d <= end)) continue;

    const pz = r.zoneMinutes || {};
    const hasPower = sumZones(pz, [...EASY_POWER_ZONES, ...MODERATE_POWER_ZONES, ...HARD_POWER_ZONES]) > 0;

    if (hasPower) {
      easyMin += sumZones(pz, EASY_POWER_ZONES);
      moderateMin += sumZones(pz, MODERATE_POWER_ZONES);
      hardMin += sumZones(pz, HARD_POWER_ZONES);
      powerRides += 1;
    } else {
      const hz = r.hrZoneMinutes || {};
      const total = sumZones(hz, [...EASY_HR_ZONES, ...MODERATE_HR_ZONES, ...HARD_HR_ZONES]);
      if (total <= 0) continue;
      easyMin += sumZones(hz, EASY_HR_ZONES);
      moderateMin += sumZones(hz, MODERATE_HR_ZONES);
      hardMin += sumZones(hz, HARD_HR_ZONES);
      hrOnlyRides += 1;
    }
    rideCount += 1;
  }

  const totalMin = easyMin + moderateMin + hardMin;

  if (rideCount < TID.minRides || totalMin < TID.minTotalMin) {
    return {
      easyPct: null,
      moderatePct: null,
      hardPct: null,
      model: 'insufficient',
      rideCount,
      totalMin: Number(totalMin.toFixed(1)),
      easyMin: Number(easyMin.toFixed(1)),
      moderateMin: Number(moderateMin.toFixed(1)),
      hardMin: Number(hardMin.toFixed(1)),
      source: 'none',
      days,
      note: `Only ${rideCount} ride(s) in the last ${days} days — not enough to read a distribution.`,
    };
  }

  const pct = (m) => Number(((m / totalMin) * 100).toFixed(1));
  const easyPct = pct(easyMin);
  const moderatePct = pct(moderateMin);
  const hardPct = pct(hardMin);

  // Order matters: grey is checked first because a week can look polarised on
  // the easy/hard split while still burying a third of its time in tempo.
  let model;
  let note;
  if (moderatePct > TID.greyModeratePct) {
    model = 'grey';
    note = `${moderatePct}% of ride time sits in tempo. Easy days are not easy enough to recover from and not hard enough to adapt to.`;
  } else if (hardPct >= TID.thresholdHardPct) {
    model = 'threshold';
    note = `${hardPct}% of ride time is at threshold or above — a high-intensity block, sustainable only briefly.`;
  } else if (easyPct >= TID.polarisedEasyPct) {
    model = 'polarised';
    note = `${easyPct}% easy / ${hardPct}% hard — a clean polarised split.`;
  } else {
    model = 'grey';
    note = `Only ${easyPct}% of ride time is genuinely easy; the aerobic base is not being loaded.`;
  }

  const source = powerRides && hrOnlyRides ? 'mixed' : powerRides ? 'power' : 'hr';

  return {
    easyPct,
    moderatePct,
    hardPct,
    model,
    rideCount,
    totalMin: Number(totalMin.toFixed(1)),
    easyMin: Number(easyMin.toFixed(1)),
    moderateMin: Number(moderateMin.toFixed(1)),
    hardMin: Number(hardMin.toFixed(1)),
    source,
    days,
    note,
  };
}
