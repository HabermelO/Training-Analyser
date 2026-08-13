import { WORKOUTS, byId } from './workouts.js';
import { intensityAllowance } from './readiness.js';
import { computePhase } from './phase.js';
import { prescriber } from './prescribe.js';
import { intensityDistribution } from './load.js';

// Builds the next 7 days by constrained selection, never by generation.
// Rules, in order of authority:
//   0. The phase sets the week's ambition: volume target and hard-day budget.
//   1. Readiness caps the number of hard days — it is a veto, never a licence.
//   2. Hard days are never consecutive, and never the day before the long ride.
//   3. No rest days — easy days are active recovery.
//   4. Only one long ride per week; other easy days stay short.
//   5. Adaptation focus from phenotype bias + gaps in the last 30 days.
//   6. Variety: prefer a workout not already used this week.
//
// Load arithmetic is done on PRESCRIBED TSS — the session as it will actually
// be ridden by this athlete against their own CP — not the library's nominal
// constants. The same 4 x 5 min is a different amount of work at CP 200 and at
// CP 320, and comparing a real last7dTss against a fixed 84 was comparing a
// measurement to a decoration.

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
  // An optional comparator decides WHICH match, which is how the grey-drift
  // correction reaches into the library without a second selection path.
  return (predicate, order) => {
    const matches = WORKOUTS.filter(predicate);
    if (!matches.length) return null;
    const ranked = order ? [...matches].sort(order) : matches;
    const fresh = ranked.filter((w) => !used.has(w.id));
    const choice = (fresh.length ? fresh : ranked)[0];
    used.add(choice.id);
    return choice;
  };
}

// Lowest intensity first. Duration breaks ties, so "easier" never quietly
// becomes "shorter" — the whole point of the correction is to keep the hours.
const byGentlest = (a, b) =>
  (a.work?.onPctCp ?? a.if ?? 1) - (b.work?.onPctCp ?? b.if ?? 1) ||
  (b.durationMin || 0) - (a.durationMin || 0);

export function planWeek(ctx) {
  const asOf = ctx.asOf ? new Date(ctx.asOf) : new Date();
  const allowance = intensityAllowance(ctx.readiness || { flag: 'no_data' });
  const counts = recentAdaptationCounts(ctx.rides || [], 30, asOf);
  const rationale = [allowance.note];

  // Where the athlete is in a progression. Passed in where the caller already
  // has one, otherwise derived here from the profile so no call site is
  // obliged to change.
  const phase =
    ctx.phase ||
    computePhase({
      goalDate: ctx.profile?.goalDate,
      startedAt: ctx.profile?.trainingStartedAt,
      load: ctx.load,
      asOf,
    });
  rationale.push(...(phase.reasons || []));

  // What the athlete has ACTUALLY been doing, by minutes rather than by
  // session count. Counting hard sessions against a budget cannot see three
  // "endurance" rides that all drifted into tempo: that week reads as 80/20
  // by session and is nearer 50/50 by time.
  const distribution =
    ctx.distribution || intensityDistribution(ctx.rides || [], { asOf });
  // Adding intensity to a grey block is the wrong correction — the problem is
  // that the easy days are not easy, not that the hard days are missing.
  const greyDrift = distribution.model === 'grey' && distribution.moderatePct != null;
  if (greyDrift) {
    rationale.push(
      `${distribution.moderatePct}% of the last ${distribution.days} days' riding sat in tempo — ` +
      `easy days are pulled genuinely easy rather than another hard day being added`
    );
  }

  // Least-trained hard adaptations first, then the phase gets the casting
  // vote: rotating least-trained-first forever is what produced a permanent
  // maintenance week with no block structure.
  const favours = phase.intensityBias?.favours || [];
  const hardPriority = ['vo2max', 'threshold_tte', 'lactate_clearance']
    .sort((a, b) => (counts[a] || 0) - (counts[b] || 0))
    .sort((a, b) => {
      const ai = favours.indexOf(a), bi = favours.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

  const pheno = ctx.phenotype?.label;
  if (pheno === 'time_trial_diesel') {
    hardPriority.sort((a, b) => (a === 'vo2max' ? -1 : b === 'vo2max' ? 1 : 0));
    rationale.push('aerobically strong phenotype, so VO2 work leads the week');
  } else if (pheno === 'sprinter' || pheno === 'puncheur') {
    hardPriority.sort((a, b) => (a === 'threshold_tte' ? -1 : b === 'threshold_tte' ? 1 : 0));
    rationale.push('strong top end, so threshold TTE leads the week');
  }

  // Readiness stays a veto, never a licence: the phase says how hard the week
  // is allowed to be, and readiness can only scale that down.
  let hardBudget = Math.min(
    allowance.maxSessionsHard,
    phase.intensityBias?.hardBudget ?? allowance.maxSessionsHard
  );
  if (phase.isRecoveryWeek) {
    rationale.push('scheduled recovery week, so intensity is held back by design rather than in reaction');
  }
  if (ctx.load?.state === 'deep_hole') {
    hardBudget = Math.min(hardBudget, 1);
    rationale.push('TSB deeply negative, so intensity is capped regardless of markers');
  }
  if (ctx.load?.rampWarning) {
    rationale.push(`weekly load ramped ${ctx.load.rampPct}%, so volume is held flat`);
  }

  // One anchor for the week, results cached per workout id. Falls back to
  // %FTP where CP is untrustworthy, and to the library's nominal numbers where
  // there is no threshold at all.
  const rx = prescriber({
    cp: ctx.ftpEstimate?.value ?? ctx.athlete?.cp,
    wPrimeKj: ctx.ftpEstimate?.wPrimeKj ?? ctx.athlete?.wPrimeKj,
    cpConfidence: ctx.ftpEstimate?.confidence,
    cpSource: ctx.ftpEstimate?.basis === 'critical_power_2p' ? 'modelled' : 'declared',
    ftp: ctx.athlete?.ftp ?? ctx.profile?.ftp,
  });
  // Frozen days carry what was ridden, not what was prescribed. The cap has
  // to be spent against reality or a heavy Monday buys a free Saturday.
  const tssOf = (d) =>
    d?.frozen ? d.actual?.tss || 0 : rx(d?.workout)?.tss ?? d?.workout?.tss ?? 0;
  const minsOf = (d) =>
    d?.frozen ? d.actual?.durationMin || 0 : rx(d?.workout)?.durationMin ?? d?.workout?.durationMin ?? 0;

  const used = new Set();
  const pick = selector(used);
  const longRideDay = ctx.longRideDay ?? 6;
  const suppressed = hardBudget === 0;

  // Days already lived are not planning problems. Re-planning Monday on
  // Thursday produces a week that keeps rearranging behind the athlete, and a
  // volume cap computed against sessions that were never ridden is arithmetic
  // about a fiction. Past days read what actually happened.
  const freezePast = ctx.freezePast !== false;
  const weekStart = startOfWeek(asOf);
  const todayIdx = Math.min(6, Math.max(0, dayIndexOf(asOf, weekStart)));
  const ridden = new Map();
  for (const r of ctx.rides || []) {
    const idx = dayIndexOf(r.date, weekStart);
    if (idx < 0 || idx > 6) continue;
    const prev = ridden.get(idx);
    ridden.set(idx, {
      tss: (prev?.tss || 0) + (r.tss || 0),
      durationMin: (prev?.durationMin || 0) + (r.durationMin || 0),
      adaptation: r.adaptation || r.sessionType || prev?.adaptation || null,
    });
  }

  const days = [];
  let hardPlaced = 0;
  let priorityIdx = 0;

  for (let d = 0; d < 7; d++) {
    if (freezePast && d < todayIdx) {
      const actual = ridden.get(d);
      // A hard day already ridden spends the budget. Otherwise a mid-week
      // recompute hands back allowance the athlete has already used.
      if (actual && isHard(actual.adaptation)) hardPlaced++;
      days.push({
        day: d,
        purpose: actual ? 'completed' : 'not_ridden',
        frozen: true,
        workout: null,
        actual: actual || null,
        note: actual ? null : 'nothing recorded for this day',
      });
      continue;
    }

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
        pick(
          (x) => x.adaptation === 'aerobic_base' && x.durationMin < 150,
          greyDrift ? byGentlest : null
        ) || byId('endurance_medium');
      days.push({
        day: d,
        purpose: 'endurance',
        workout: w,
        note: greyDrift ? 'held at the bottom of the aerobic range to break the middle-zone drift' : null,
      });
    }
  }

  if (suppressed) {
    rationale.push('all intensity replaced with active recovery; no rest days taken');
  }

  // Volume cap. Without this, dropping intensity can paradoxically INCREASE
  // weekly load, because easy days get filled with endurance rides.
  // The cap baseline is the phase's target, not last week's actual. Deriving
  // it from last7dTss meant the plan tracked whatever happened and CTL drifted
  // wherever it drifted — a ramp warning with no ramp target.
  const baseline =
    phase.weeklyTssTarget ||
    ctx.load?.last7dTss ||
    (ctx.load?.ctl ? ctx.load.ctl * 7 : null);
  const scale =
    { strongly_suppressed: 0.6, suppressed: 0.85, fresh: 1.1 }[
      ctx.readiness?.flag
    ] ?? 1.0;
  const cap = baseline ? baseline * scale : null;

  const totalTss = () => days.reduce((s, d) => s + tssOf(d), 0);

  // A cap is a target, not a limit, and the last few TSS are not worth what it
  // costs to shed them. Without this tolerance the ordered sacrifice below
  // overshoots absurdly: a week sitting at 165 against a 162 cap would pull
  // its hard session and land at 85, destroying the point of the week to save
  // three points of load.
  const CAP_TOLERANCE = 0.08;
  if (cap) {
    const tolerant = cap * (1 + CAP_TOLERANCE);
    // Bringing a week under its cap, in order of what costs the least
    // adaptation. Each step is only taken if the week is still over after the
    // one before it.
    //
    // Rest is the last resort but it IS one of the options. An earlier version
    // had no rest concept — every one of the seven days carried a session — so
    // a cap below about 290 TSS was arithmetically unreachable and the plan
    // quietly ignored it. A cap that cannot be met is worse than no cap: it
    // reads as a considered target while describing a week nobody planned.

    // 1. Endurance days become recovery spins.
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

    // 2. The long ride shortens before it disappears — the weekly long ride is
    //    the single most valuable session for aerobic base, so it is defended.
    if (totalTss() > cap) {
      const li = days.findIndex((d) => d.purpose === 'long_ride');
      if (li >= 0 && days[li].workout?.id === 'endurance_long') {
        days[li] = {
          ...days[li],
          workout: byId('endurance_medium'),
          note: 'shortened to keep weekly load under target',
        };
      }
    }

    // 3. Recovery spins become rest. They are the cheapest thing on the board
    //    at 25 TSS, but they are also the least costly to lose: an easy spin
    //    aids recovery a little, a day off aids it more.
    for (let i = days.length - 1; i >= 0 && totalTss() > tolerant; i--) {
      if (days[i].purpose === 'active_recovery') {
        days[i] = {
          day: days[i].day,
          purpose: 'rest',
          workout: null,
          note: 'rest day, to keep the week under target',
        };
      }
    }

    // 4. Only now does intensity go. A hard session is the reason the week
    //    exists, so it is the last thing surrendered — and when it is, the
    //    plan says so rather than letting it vanish quietly.
    if (totalTss() > tolerant) {
      for (let i = days.length - 1; i >= 0 && totalTss() > tolerant; i--) {
        if (isHard(days[i].workout?.adaptation)) {
          days[i] = {
            day: days[i].day,
            purpose: 'rest',
            workout: null,
            note: 'intensity pulled — the week could not carry it and stay under target',
          };
          hardPlaced = Math.max(0, hardPlaced - 1);
        }
      }
    }

    // 5. The long ride itself, if the cap is lower than one long ride.
    if (totalTss() > tolerant) {
      const li = days.findIndex((d) => d.purpose === 'long_ride');
      if (li >= 0) {
        days[li] = {
          ...days[li],
          workout: byId('recovery_spin'),
          note: 'cut right back — recent load and readiness will not support a long ride this week',
        };
      }
    }

    rationale.push(`weekly load targeted at ~${Math.round(cap)} TSS`);
  }

  const plannedTss = totalTss();
  const plannedHours = Number(
    (days.reduce((s, d) => s + minsOf(d), 0) / 60).toFixed(1)
  );

  // Whether the cap was actually achieved. A plan that quietly overshoots its
  // own target is not a plan, and the UI should be able to say so.
  // intensityAllowance() writes its note before the cap is applied, so a line
  // like "no rest days taken" can survive into a week the cap then emptied.
  // A rationale that contradicts the calendar next to it costs more trust than
  // the note was ever worth.
  const restDays = days.filter((d) => d.purpose === 'rest').length;
  const cleanedRationale = rationale
    .filter((r) => !(restDays > 0 && /no rest days taken/i.test(r)))
    .map((r) => (restDays > 0 ? r.replace(/;?\s*no rest days taken/i, '') : r));
  if (restDays > 0) {
    cleanedRationale.push(
      `${restDays} rest day${restDays === 1 ? '' : 's'} to bring the week under target`
    );
  }

  // Hang the prescription off each day so the UI can show watts rather than a
  // workout name, and so a reduced-rep session carries its own reason.
  for (const d of days) {
    const p = rx(d.workout);
    if (!p) continue;
    d.prescription = p;
    if (p.repsDropped > 0 || p.feasible === false) {
      d.note = d.note ? `${d.note}; ${p.note}` : p.note;
    }
  }

  if (rx.anchor?.basis === 'cp') {
    cleanedRationale.push(
      `sessions prescribed against your fitted CP of ${Math.round(rx.anchor.watts)} W`
    );
  } else if (rx.anchor?.basis === 'ftp') {
    cleanedRationale.push(
      'sessions prescribed as %FTP — there is no trustworthy critical power fit yet, so targets are approximate'
    );
  }
  const trimmed = days.filter((d) => d.prescription?.repsDropped > 0).length;
  if (trimmed > 0) {
    cleanedRationale.push(
      `${trimmed} session${trimmed === 1 ? '' : 's'} shortened by a rep to stay inside your fitted W'`
    );
  }

  const capRespected = cap == null ? null : plannedTss <= Math.round(cap * (1 + CAP_TOLERANCE));
  if (capRespected === false) {
    cleanedRationale.push(
      `could not get the week under ${Math.round(cap)} TSS without removing everything — showing ${plannedTss} TSS instead`
    );
  }

  return {
    days, hardSessions: hardPlaced, hardBudget,
    prescribedFrom: rx.anchor?.basis ?? 'library_nominal',
    anchorWatts: rx.anchor ? Math.round(rx.anchor.watts) : null,
    phase,
    distribution,
    todayIndex: todayIdx,
    weekStart: weekStart.toISOString().slice(0, 10),
    plannedTss, plannedHours, weeklyTssCap: cap ? Math.round(cap) : null,
    capRespected,
    restDays,
    rationale: cleanedRationale,
  };
}

/**
 * One decision, one reason. The week shape answers "what does this block look
 * like"; this answers "what am I doing today, and why" — which is the question
 * the athlete actually opens the app with, and the only one small enough for
 * the narration layer to write a reliable paragraph about.
 *
 * The trace is ordered the way the decision is actually made: readiness can
 * only veto, TSB can only cap, the phase sets the ambition, and the adaptation
 * gap picks between what is left.
 *
 * @param {object} ctx  same shape as planWeek, plus optional { planEdits }
 */
export function suggestToday(ctx) {
  const plan = ctx.plan || planWeek(ctx);
  const asOf = ctx.asOf ? new Date(ctx.asOf) : new Date();
  const today = plan.days.find((d) => d.day === plan.todayIndex) || plan.days[0];

  // An edit the athlete made outranks the suggestion. Saying so is the point:
  // a plan that silently reverts to its own opinion teaches people their
  // changes do not stick.
  const iso = new Date(asOf).toISOString().slice(0, 10);
  const editId = ctx.planEdits?.[iso];
  const overridden = editId != null && editId !== today?.workout?.id;
  const session = overridden
    ? WORKOUTS.find((w) => w.id === editId) || today?.workout || null
    : today?.workout || null;

  const trace = [];

  // 1. Readiness — veto only.
  const flag = ctx.readiness?.flag || 'no_data';
  trace.push({
    step: 'readiness',
    value: flag,
    effect:
      flag === 'strongly_suppressed'
        ? 'blocks intensity outright'
        : flag === 'suppressed'
        ? 'reduces the intensity allowance'
        : flag === 'no_data'
        ? 'no check-in data, so it neither permits nor blocks anything'
        : 'no objection',
  });

  // 2. Form.
  if (ctx.load) {
    trace.push({
      step: 'form',
      value: `TSB ${ctx.load.tsb > 0 ? '+' : ''}${Math.round(ctx.load.tsb)}`,
      effect:
        ctx.load.state === 'deep_hole'
          ? 'deep enough to cap the week at one hard day regardless of markers'
          : ctx.load.state === 'fresh'
          ? 'fresh enough to absorb a key session'
          : 'within the normal training range',
    });
  }

  // 3. Phase — the ambition.
  trace.push({
    step: 'phase',
    value: `${plan.phase.phase}, week ${plan.phase.weekInBlock}`,
    effect: plan.phase.isRecoveryWeek
      ? 'scheduled unload week, so volume drops by design'
      : `targets about ${plan.phase.weeklyTssTarget ?? '—'} TSS this week`,
  });

  // 4. Distribution — what has actually been ridden.
  if (plan.distribution?.model && plan.distribution.model !== 'insufficient') {
    trace.push({
      step: 'distribution',
      value: plan.distribution.model,
      effect:
        plan.distribution.model === 'grey'
          ? 'easy days are pulled lower rather than another hard day being added'
          : 'the split across the last six weeks is where it should be',
    });
  }

  // 5. The gap this session fills.
  if (session) {
    trace.push({
      step: 'adaptation',
      value: session.adaptation,
      effect:
        today?.purpose === 'long_ride'
          ? 'the week\'s long ride, the single most valuable session for aerobic base'
          : isHard(session.adaptation)
          ? 'the least-trained hard quality the phase currently favours'
          : 'aerobic volume without cost to tomorrow',
    });
  }

  const done = today?.frozen || plan.todayIndex == null;

  return {
    date: iso,
    day: plan.todayIndex,
    purpose: today?.purpose ?? null,
    session,
    prescription: overridden ? null : today?.prescription ?? null,
    note: today?.note ?? null,
    trace,
    wasOverridden: overridden,
    overrideReason: overridden ? 'you moved this session here yourself' : null,
    // Today already has a ride against it — the day is being reported, not
    // prescribed.
    alreadyRidden: !!done && !!today?.actual,
    headline: session
      ? `${session.systm || session.id} — ${
          // The engine's slot purpose describes the session it chose, not the
          // one the athlete put there. Carrying it over labels a VO2 session
          // "active recovery", which is worse than saying nothing.
          overridden ? 'your choice for today' : labelPurpose(today?.purpose)
        }`
      : today?.purpose === 'rest'
      ? 'Rest day'
      : 'Nothing scheduled',
  };
}

const labelPurpose = (p) =>
  ({
    key_session: 'the week\'s key session',
    long_ride: 'the long ride',
    endurance: 'aerobic volume',
    active_recovery: 'active recovery',
    rest: 'rest',
  }[p] || 'scheduled');

function startOfWeek(d) {
  const date = new Date(d);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));  // Monday = 0
  date.setHours(0, 0, 0, 0);
  return date;
}

function dayIndexOf(date, weekStart) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return Math.floor((d - weekStart) / 86400000);
}
