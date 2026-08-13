import { READINESS } from './thresholds.js';

// Daily wellness never goes to the model raw. We compute a rolling baseline,
// express today against it, and emit a flag the planner can act on.
//
// The comparison is a z-score of the 7-day rolling mean of ln(rMSSD) against a
// 30-day baseline of the same quantity:
//   - ln, because rMSSD is log-normal and raw percentage deltas are asymmetric;
//   - 7-day mean rather than today's single reading, because one bad night or
//     one late strap reading should not pull a hard session;
//   - the athlete's own SD rather than a population percentage, so an athlete
//     with 12% day-to-day scatter is not flagged permanently and one with 3%
//     scatter is not invisible.
//
// Below READINESS.minBaselineDays readings we fall back to the old percentage
// rule and say so in notes — a z-score off five days is worse than no z-score.

function mean(xs) {
  const vals = xs.filter((x) => x != null && Number.isFinite(x));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sd(xs) {
  const vals = xs.filter((x) => x != null && Number.isFinite(x));
  if (vals.length < 2) return null;
  const m = mean(vals);
  const variance = vals.reduce((acc, x) => acc + (x - m) ** 2, 0) / (vals.length - 1);
  return Math.sqrt(variance);
}

const round = (x, dp = 2) =>
  x == null || !Number.isFinite(x) ? null : Number(x.toFixed(dp));

// --- calendar-day helpers -------------------------------------------------
// Entries are keyed by ISO 'YYYY-MM-DD'. We walk calendar days, not array
// indices, so a skipped check-in is a *gap* rather than a silent shift.

function shiftDay(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function indexByDate(daily) {
  const byDate = new Map();
  for (const d of daily) {
    if (d && typeof d.date === 'string') byDate.set(d.date, d);
  }
  return byDate;
}

// Readings on [anchor - (span-1), anchor], oldest first, missing days omitted.
function windowValues(byDate, anchor, span, field) {
  const out = [];
  for (let i = span - 1; i >= 0; i--) {
    const entry = byDate.get(shiftDay(anchor, -i));
    const v = entry ? entry[field] : null;
    if (v != null && Number.isFinite(v) && (field !== 'hrv' || v > 0)) out.push(v);
  }
  return out;
}

// --- percentage fallback --------------------------------------------------

function percentagePath(byDate, today, notes) {
  const window = windowValues(
    byDate,
    shiftDay(today.date, -1),
    READINESS.fallbackBaselineDays,
    'hrv',
  );

  if (window.length < 3) {
    return {
      available: false,
      flag: 'baseline_building',
      method: 'percent',
      daysCollected: window.length,
      notes: ['not enough history yet to judge today against'],
    };
  }

  const hrvBase = mean(window);
  const hrvDeltaPct =
    hrvBase && today.hrv != null
      ? round(((today.hrv - hrvBase) / hrvBase) * 100, 1)
      : null;

  let flag = 'normal';
  if (hrvDeltaPct != null && hrvDeltaPct <= READINESS.hrvStronglySuppressedPct) {
    flag = 'strongly_suppressed';
    notes.push(`HRV ${Math.abs(hrvDeltaPct)}% below baseline`);
  } else if (hrvDeltaPct != null && hrvDeltaPct <= READINESS.hrvSuppressedPct) {
    flag = 'suppressed';
    notes.push(`HRV ${Math.abs(hrvDeltaPct)}% below baseline`);
  } else if (hrvDeltaPct != null && hrvDeltaPct > 5) {
    flag = 'fresh';
    notes.push(`HRV ${hrvDeltaPct}% above baseline`);
  }

  notes.push(
    `single-day percentage rule — ${window.length} of ${READINESS.minBaselineDays} days needed for a personal baseline`,
  );

  return {
    available: true,
    flag,
    method: 'percent',
    hrvDeltaPct,
    hrvZ: null,
    daysCollected: window.length,
  };
}

/**
 * @param {Array} daily - [{date, hrv, rhr, sleepHours, mood}], newest last
 */
export function computeReadiness(daily) {
  if (!daily || daily.length === 0) {
    return { available: false, flag: 'no_data', notes: [] };
  }

  const sorted = [...daily]
    .filter((d) => d && typeof d.date === 'string')
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return { available: false, flag: 'no_data', notes: [] };

  const today = sorted[sorted.length - 1];
  const byDate = indexByDate(sorted);
  const notes = [];

  // --- baseline on ln(rMSSD) ---------------------------------------------
  const baselineRaw = windowValues(byDate, today.date, READINESS.baselineDays, 'hrv');
  const baselineLn = baselineRaw.map(Math.log);

  let core;
  let consecutiveLow = 0;

  if (baselineLn.length < READINESS.minBaselineDays) {
    core = percentagePath(byDate, today, notes);
    if (!core.available) return { ...core, notes: core.notes };
  } else {
    const baseMean = mean(baselineLn);
    const rawSd = sd(baselineLn);
    const baseSd = Math.max(rawSd ?? 0, READINESS.minBaselineSd);

    // z of a given day: that day's trailing 7-day mean against the baseline.
    const zForDay = (dateIso) => {
      const shortRaw = windowValues(byDate, dateIso, READINESS.shortWindowDays, 'hrv');
      if (!shortRaw.length) return null;
      return (mean(shortRaw.map(Math.log)) - baseMean) / baseSd;
    };

    const shortRaw = windowValues(byDate, today.date, READINESS.shortWindowDays, 'hrv');
    const z = zForDay(today.date);

    // Streak: walk calendar days back. A missing day is *unknown* — it carries
    // the count without incrementing, because skipping the check-in correlates
    // with feeling rough. Only a day that is genuinely not suppressed breaks it.
    //
    // This one uses each day's *own* reading rather than its trailing mean:
    // the 7-day mean is the right smoother for today's flag, but it lags, and
    // a run of suppressed days should be counted as it happens.
    for (let i = 0; i < READINESS.baselineDays; i++) {
      const entry = byDate.get(shiftDay(today.date, -i));
      const v = entry ? entry.hrv : null;
      if (v == null || !Number.isFinite(v) || v <= 0) continue; // unknown day
      const dz = (Math.log(v) - baseMean) / baseSd;
      if (dz <= READINESS.zSuppressed) consecutiveLow++;
      else break;
    }

    let flag = 'normal';
    if (z != null && z <= READINESS.zStronglySuppressed) {
      flag = 'strongly_suppressed';
      notes.push(`HRV ${Math.abs(z).toFixed(2)} SD below your baseline`);
    } else if (z != null && z <= READINESS.zSuppressed) {
      flag = 'suppressed';
      notes.push(`HRV ${Math.abs(z).toFixed(2)} SD below your baseline`);
    } else if (z != null && z >= READINESS.zFresh) {
      flag = 'fresh';
      notes.push(`HRV ${z.toFixed(2)} SD above your baseline`);
    }

    if (shortRaw.length < 3) {
      notes.push(`only ${shortRaw.length} reading(s) in the last 7 days`);
    }

    // hrvDeltaPct kept for display and for anything reading the old field name.
    const hrvBaseRaw = mean(baselineRaw);
    core = {
      available: true,
      flag,
      method: 'zscore',
      hrvZ: round(z),
      hrvShort7: round(mean(shortRaw), 1),
      hrvBaselineMean: round(hrvBaseRaw, 1),
      hrvBaselineSdLn: round(rawSd, 3),
      hrvDeltaPct:
        hrvBaseRaw && today.hrv != null
          ? round(((today.hrv - hrvBaseRaw) / hrvBaseRaw) * 100, 1)
          : null,
      daysCollected: baselineLn.length,
    };
  }

  // --- RHR: independent escalator, absolute bpm --------------------------
  const rhrBase = mean(
    windowValues(byDate, shiftDay(today.date, -1), READINESS.baselineDays, 'rhr'),
  );
  const rhrDelta =
    rhrBase != null && today.rhr != null ? round(today.rhr - rhrBase, 1) : null;

  let flag = core.flag;
  if (rhrDelta != null && rhrDelta >= READINESS.rhrElevatedBpm) {
    notes.push(`resting HR up ${rhrDelta} bpm`);
    if (flag === 'normal' || flag === 'fresh') flag = 'suppressed';
  }
  if (consecutiveLow >= READINESS.consecutiveDaysForFlag) {
    notes.push(`${consecutiveLow} consecutive suppressed days`);
    if (flag === 'suppressed') flag = 'strongly_suppressed';
  }
  if (today.sleepHours != null && today.sleepHours < READINESS.sleepShortHours) {
    notes.push(`${today.sleepHours}h sleep`);
  }
  if (today.mood != null && today.mood <= READINESS.moodLowScore) {
    notes.push(`self-reported mood ${today.mood}/10`);
  }

  return {
    ...core,
    flag,
    rhrDelta,
    consecutiveLowDays: consecutiveLow,
    sleepHours: today.sleepHours ?? null,
    mood: today.mood ?? null,
    notes,
  };
}

// How the planner should respond to a readiness flag.
export function intensityAllowance(readiness) {
  switch (readiness.flag) {
    case 'strongly_suppressed':
      return { maxSessionsHard: 0, note: 'hold all intensity until markers recover' };
    case 'suppressed':
      return { maxSessionsHard: 1, note: 'one hard session only, monitor daily' };
    case 'fresh':
      return { maxSessionsHard: 3, note: 'markers support a full intensity week' };
    default:
      return { maxSessionsHard: 2, note: 'standard intensity distribution' };
  }
}
