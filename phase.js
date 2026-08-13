import { LOAD, PHASE } from './thresholds.js';

// Periodisation — the axis the planner was missing.
//
// planWeek() answers "what should this week look like given how I feel now".
// This module answers "where am I in a progression", which is the input the
// decision tree opens with. It is deliberately arithmetic, not adaptive: the
// engine decides, and every number here can be read off the calendar.

const DAY = 86400000;
const day = (d) => Math.floor(new Date(d).getTime() / DAY);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Monday-anchored week index so a block boundary always lands on a week
// boundary, whatever weekday the athlete first opened the app.
function weeksBetween(fromDay, toDay) {
  return Math.floor((toDay - fromDay) / 7);
}

function phaseFromGoal(daysToGoal) {
  if (daysToGoal == null) return null;
  if (daysToGoal < 0) return 'transition';
  if (daysToGoal < PHASE.taperDays) return 'taper';
  if (daysToGoal < PHASE.peakDays) return 'peak';
  if (daysToGoal < PHASE.buildDays) return 'build';
  return 'base';
}

// No goal date: alternate base/build in blocks of `blockWeeks * 2`, so the
// athlete still gets a direction rather than a permanent maintenance week.
function phaseFromCycle(weeksElapsed) {
  const cycle = PHASE.noGoalBlockWeeks * 2;
  const pos = ((weeksElapsed % cycle) + cycle) % cycle;
  return pos < PHASE.noGoalBlockWeeks ? 'base' : 'build';
}

export function computePhase({ goalDate, startedAt, load, asOf } = {}) {
  const now = asOf ? new Date(asOf) : new Date();
  const today = day(now);
  const reasons = [];

  const anchor = startedAt ? day(startedAt) : today;
  const weeksElapsed = Math.max(0, weeksBetween(anchor, today));

  const daysToGoal = goalDate ? day(goalDate) - today : null;
  let phase = phaseFromGoal(daysToGoal);
  if (phase) {
    reasons.push(
      daysToGoal < 0
        ? 'goal event has passed, so this is a transition week'
        : `${Math.round(daysToGoal / 7)} weeks to the goal event, so this is the ${phase} phase`
    );
  } else {
    phase = phaseFromCycle(weeksElapsed);
    reasons.push(`no goal date set, so running ${PHASE.noGoalBlockWeeks}-week ${phase} blocks`);
  }

  // 3:1 loading. Week 4 of every block unloads on the schedule rather than
  // waiting for HRV to be suppressed, which is a week too late.
  const weekInBlock = (weeksElapsed % PHASE.blockWeeks) + 1;
  const isRecoveryWeek = phase === 'transition' || weekInBlock === PHASE.blockWeeks;

  // Baseline for the ramp is CTL-derived where possible: CTL*7 is what the
  // athlete's fitness says they are currently absorbing, whereas last7dTss is
  // whatever happened to happen, which is how the target drifted before.
  const ctl = load?.ctl ?? null;
  const base = ctl ? ctl * 7 : load?.last7dTss ?? null;

  const rampPct = Math.min(LOAD.maxWeeklyRampPct, PHASE.rampPctByPhase[phase] ?? 0);
  let weeklyTssTarget = null;
  let ctlTarget = null;

  if (base) {
    if (isRecoveryWeek) {
      weeklyTssTarget = Math.round(base * PHASE.recoveryWeekFraction);
      ctlTarget = ctl ? Math.round(ctl) : null;
      reasons.push(
        `week ${weekInBlock} of ${PHASE.blockWeeks}: scheduled recovery week, load dropped to ~${PHASE.recoveryWeekFraction * 100}%`
      );
    } else {
      // Ramp compounds within the block, not across it — weeks 1–3 step up,
      // week 4 resets the base. Cap the compounded step at the ramp warning
      // threshold so the plan can never propose a week load.js would flag.
      const steps = weekInBlock - 1;
      const growth = clamp(
        Math.pow(1 + rampPct / 100, steps),
        1,
        1 + LOAD.maxWeeklyRampPct / 100
      );
      weeklyTssTarget = Math.round(base * growth);
      ctlTarget = ctl ? Math.round(ctl * (1 + rampPct / 200)) : null;
      reasons.push(
        `week ${weekInBlock} of ${PHASE.blockWeeks}: ramping toward ~${weeklyTssTarget} TSS`
      );
    }
  } else {
    reasons.push('no load history yet, so the week is not ramped against a target');
  }

  const bias = PHASE.intensityBias[phase];
  const hardBudget = isRecoveryWeek
    ? Math.min(bias.hardBudget, PHASE.recoveryWeekHardBudget)
    : bias.hardBudget;

  return {
    phase,
    weekInBlock,
    isRecoveryWeek,
    weeksElapsed,
    daysToGoal,
    ctlTarget,
    weeklyTssTarget,
    intensityBias: {
      hardBudget,
      favours: bias.favours,
      preferShortHard: !!bias.preferShortHard,
    },
    reasons,
  };
}
