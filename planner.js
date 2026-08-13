import { WORKOUTS, byId } from './workouts.js';
import { intensityAllowance } from './readiness.js';

// Builds the next 7 days by constrained selection, never by generation.
// Rules, in order of authority:
//   1. Readiness caps the number of hard days.
//   2. Hard days are never consecutive, and never the day before the long ride.
//   3. No rest days — easy days are active recovery.
//   4. Only one long ride per week; other easy days stay short.
//   5. Adaptation focus from phenotype bias + gaps in the last 30 days.
//   6. Variety: prefer a workout not already used this week.

const HARD_ADAPTATIONS = ['vo2max', 'threshold_tte', 'lactate_clearance', 'anaerobic_capacity'];
const isHard = (a) => HARD_ADAPTATIONS.includes(a);

function recentAdaptationCounts(rides, days = 30, asOf = new Date()) {
  const cutoff = new Date(asOf).getTime() - days * 86400000;
  const counts = {};
  for (const r of rides) {
    if (new Date(r.date).getTime() < cutoff) continue;
    const a = r.adaptation || r.sessionType;
    if (a) counts[a] = (counts[a] || 0) + 1;
  }
  return counts;
}

function selector(used) {
  // Prefer an unused workout matching the filter; fall back to any match.
  return (predicate) => {
    const matches = WORKOUTS.filter(predicate);
    if (!matches.length) return null;
    const fresh = matches.filter((w) => !used.has(w.id));
    const choice = (fresh.length ? fresh : matches)[0];
    used.add(choice.id);
    return choice;
  };
}

export function planWeek(ctx) {
  const asOf = ctx.asOf ? new Date(ctx.asOf) : new Date();
  const allowance = intensityAllowance(ctx.readiness || { flag: 'no_data' });
  const counts = recentAdaptationCounts(ctx.rides || [], 30, asOf);
  const rationale = [allowance.note];

  // Least-trained hard adaptations first.
  const hardPriority = ['vo2max', 'threshold_tte', 'lactate_clearance']
    .sort((a, b) => (counts[a] || 0) - (counts[b] || 0));

  const pheno = ctx.phenotype?.label;
  if (pheno === 'time_trial_diesel') {
    hardPriority.sort((a, b) => (a === 'vo2max' ? -1 : b === 'vo2max' ? 1 : 0));
    rationale.push('aerobically strong phenotype, so VO2 work leads the week');
  } else if (pheno === 'sprinter' || pheno === 'puncheur') {
    hardPriority.sort((a, b) => (a === 'threshold_tte' ? -1 : b === 'threshold_tte' ? 1 : 0));
    rationale.push('strong top end, so threshold TTE leads the week');
  }

  let hardBudget = allowance.maxSessionsHard;
  if (ctx.load?.state === 'deep_hole') {
    hardBudget = Math.min(hardBudget, 1);
    rationale.push('TSB deeply negative, so intensity is capped regardless of markers');
  }
  if (ctx.load?.rampWarning) {
    rationale.push(`weekly load ramped ${ctx.load.rampPct}%, so volume is held flat`);
  }

  const used = new Set();
  const pick = selector(used);
  const longRideDay = ctx.longRideDay ?? 6;
  const suppressed = hardBudget === 0;

  const days = [];
  let hardPlaced = 0;
  let priorityIdx = 0;

  for (let d = 0; d < 7; d++) {
    if (d === longRideDay) {
      // Under strong suppression the long ride still happens, but shortened.
      const w = suppressed
        ? byId('endurance_medium')
        : pick((x) => x.adaptation === 'aerobic_base' && x.durationMin >= 150) ||
          byId('endurance_long');
      days.push({
        day: d,
        purpose: 'long_ride',
        workout: w,
        note: suppressed ? 'shortened while recovery markers are suppressed' : null,
      });
      continue;
    }

    const prev = days[days.length - 1];
    const prevHard = prev && isHard(prev.workout?.adaptation);
    const canGoHard = hardPlaced < hardBudget && !prevHard && d !== longRideDay - 1;

    if (canGoHard) {
      const adaptation = hardPriority[priorityIdx % hardPriority.length];
      priorityIdx++;
      const w = pick((x) => x.adaptation === adaptation);
      if (w) {
        days.push({ day: d, purpose: 'key_session', workout: w });
        hardPlaced++;
        continue;
      }
    }

    // Easy days: recovery after a hard day, otherwise short/medium endurance.
    if (prevHard || suppressed) {
      days.push({ day: d, purpose: 'active_recovery', workout: byId('recovery_spin') });
    } else {
      const w =
        pick((x) => x.adaptation === 'aerobic_base' && x.durationMin < 150) ||
        byId('endurance_medium');
      days.push({ day: d, purpose: 'endurance', workout: w });
    }
  }

  if (suppressed) {
    rationale.push('all intensity replaced with active recovery; no rest days taken');
  }

  // Volume cap. Without this, dropping intensity can paradoxically INCREASE
  // weekly load, because easy days get filled with endurance rides.
  const baseline = ctx.load?.last7dTss || (ctx.load?.ctl ? ctx.load.ctl * 7 : null);
  const scale =
    { strongly_suppressed: 0.6, suppressed: 0.85, fresh: 1.1 }[
      ctx.readiness?.flag
    ] ?? 1.0;
  const cap = baseline ? baseline * scale : null;

  const totalTss = () => days.reduce((s, d) => s + (d.workout?.tss || 0), 0);
  if (cap) {
    // Downgrade endurance days to recovery, latest first, until under cap.
    for (let i = days.length - 1; i >= 0 && totalTss() > cap; i--) {
      if (days[i].purpose === 'endurance') {
        days[i] = {
          day: days[i].day,
          purpose: 'active_recovery',
          workout: byId('recovery_spin'),
          note: 'downgraded to keep weekly load under target',
        };
      }
    }
    if (totalTss() > cap) {
      const li = days.findIndex((d) => d.purpose === 'long_ride');
      if (li >= 0 && days[li].workout.id === 'endurance_long') {
        days[li] = {
          ...days[li],
          workout: byId('endurance_medium'),
          note: 'shortened to keep weekly load under target',
        };
      }
    }
    rationale.push(`weekly load targeted at ~${Math.round(cap)} TSS`);
  }

  const plannedTss = totalTss();
  const plannedHours = Number(
    (days.reduce((s, d) => s + (d.workout?.durationMin || 0), 0) / 60).toFixed(1)
  );

  return {
    days, hardSessions: hardPlaced, hardBudget,
    plannedTss, plannedHours, weeklyTssCap: cap ? Math.round(cap) : null,
    rationale,
  };
}
