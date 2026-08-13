import { READINESS } from './thresholds.js';

// Daily wellness never goes to the model raw. We compute a rolling baseline,
// express today as a delta, and emit a flag the planner can act on.

function mean(xs) {
  const vals = xs.filter((x) => x != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * @param {Array} daily - [{date, hrv, rhr, sleepHours, mood}], newest last
 */
export function computeReadiness(daily) {
  if (!daily || daily.length === 0) {
    return { available: false, flag: 'no_data', notes: [] };
  }
  const today = daily[daily.length - 1];
  const window = daily.slice(-1 - READINESS.baselineDays, -1);

  if (window.length < 3) {
    return {
      available: false,
      flag: 'baseline_building',
      daysCollected: window.length,
      notes: ['not enough history yet to judge today against'],
    };
  }

  const hrvBase = mean(window.map((d) => d.hrv));
  const rhrBase = mean(window.map((d) => d.rhr));
  const notes = [];

  const hrvDeltaPct =
    hrvBase && today.hrv != null
      ? Number((((today.hrv - hrvBase) / hrvBase) * 100).toFixed(1))
      : null;
  const rhrDelta =
    rhrBase != null && today.rhr != null
      ? Number((today.rhr - rhrBase).toFixed(1))
      : null;

  // How many consecutive days has HRV sat below baseline?
  let consecutiveLow = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    const d = daily[i];
    if (d.hrv != null && hrvBase && (d.hrv - hrvBase) / hrvBase * 100 < READINESS.hrvSuppressedPct) {
      consecutiveLow++;
    } else break;
  }

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

  if (rhrDelta != null && rhrDelta >= READINESS.rhrElevatedBpm) {
    notes.push(`resting HR up ${rhrDelta} bpm`);
    if (flag === 'normal') flag = 'suppressed';
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
    available: true,
    flag,
    hrvDeltaPct,
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
