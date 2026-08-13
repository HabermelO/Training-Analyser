import { PRESCRIPTION } from './thresholds.js';

// Turns a library entry into a session for THIS athlete.
//
// The library stores structure (reps, durations, fractions of CP) and never
// absolute numbers. Absolute numbers are produced here, against the athlete's
// own critical power, because a fixed `tss: 85` means one thing at CP 200 and
// something entirely different at CP 320 — and the weekly volume cap in
// planner.js was comparing a real last7dTss against exactly those constants.
//
// Two things come out of this that could not before:
//   - an actual prescription ("5 x 4 min at 262 W"), not just a workout name
//   - a W' feasibility check, which is the anaerobic half of the CP model
//     finally being used for something rather than fitted and discarded.

const round5 = (w) => Math.round(w / 5) * 5;

/**
 * Which number the prescription is anchored to, and how much to trust it.
 *
 * CP and FTP are not the same quantity. CP is an asymptote fitted from maximal
 * efforts; a declared FTP is a number someone typed. Treating the second as
 * the first would silently invent a W' that was never measured, so when we
 * fall back we say so and skip every W'-dependent judgement.
 */
export function anchorFor({ cp, wPrimeKj, cpConfidence, cpSource, ftp } = {}) {
  const cpUsable =
    cp > 0 &&
    cpConfidence &&
    cpConfidence !== 'insufficient' &&
    cpSource !== 'declared';

  if (cpUsable) {
    return {
      watts: cp,
      basis: 'cp',
      wPrimeKj: wPrimeKj > 0 ? wPrimeKj : null,
      label: `% of CP (${Math.round(cp)} W)`,
    };
  }
  if (ftp > 0) {
    return {
      watts: ftp,
      basis: 'ftp',
      wPrimeKj: null,
      label: `% of FTP (${Math.round(ftp)} W)`,
      note:
        "anchored to FTP, not a fitted critical power — targets are approximate and W' is unknown, so the anaerobic feasibility check is skipped",
    };
  }
  return null;
}

// Normalised power over a piecewise-constant profile. No 30 s smoothing: the
// profile is already made of blocks far longer than the smoothing window, and
// pretending otherwise would add precision the structure does not carry.
function normalisedPower(segments) {
  const totalSecs = segments.reduce((s, x) => s + x.secs, 0);
  if (!totalSecs) return 0;
  const fourth = segments.reduce((s, x) => s + x.watts ** 4 * x.secs, 0) / totalSecs;
  return fourth ** 0.25;
}

function profileFor(workout, anchor, reps) {
  const w = workout.work;
  const at = (pct) => round5(anchor.watts * pct);
  const segs = [];

  if (workout.warmupMin) {
    segs.push({ secs: workout.warmupMin * 60, watts: at(PRESCRIPTION.warmupPctCp), kind: 'warmup' });
  }
  for (let i = 0; i < reps; i++) {
    segs.push({ secs: Math.round(w.onMin * 60), watts: at(w.onPctCp), kind: 'on' });
    // The last recovery is dropped — it is indistinguishable from the
    // cooldown, and counting it inflates both duration and TSS.
    if (w.offMin && i < reps - 1) {
      segs.push({ secs: Math.round(w.offMin * 60), watts: at(w.offPctCp ?? 0.5), kind: 'off' });
    }
  }
  if (workout.cooldownMin) {
    segs.push({ secs: workout.cooldownMin * 60, watts: at(PRESCRIPTION.cooldownPctCp), kind: 'cooldown' });
  }
  return segs;
}

/**
 * W' spent across the work intervals, with partial reconstitution during the
 * recoveries. Gross cost is what the spec asks for; peak deficit is the number
 * that actually decides whether the session can be finished, because W'
 * recovered between reps was never simultaneously outstanding.
 */
function wPrimeCost(segments, cpWatts) {
  let gross = 0;
  let deficit = 0;
  let peak = 0;
  for (const s of segments) {
    if (s.watts > cpWatts) {
      const spend = (s.watts - cpWatts) * s.secs;
      gross += spend;
      deficit += spend;
      peak = Math.max(peak, deficit);
    } else {
      const recovered = (cpWatts - s.watts) * s.secs * PRESCRIPTION.reconstitutionEfficiency;
      deficit = Math.max(0, deficit - recovered);
    }
  }
  return { grossKj: gross / 1000, peakKj: peak / 1000 };
}

function build(workout, anchor, reps) {
  const segs = profileFor(workout, anchor, reps);
  const totalSecs = segs.reduce((s, x) => s + x.secs, 0);
  const durationMin = Math.round(totalSecs / 60);
  const np = normalisedPower(segs);
  const ifEst = np / anchor.watts;
  const tss = Math.round((totalSecs / 3600) * ifEst ** 2 * 100);
  const cost = wPrimeCost(segs, anchor.watts);
  return { segs, durationMin, ifEst: Number(ifEst.toFixed(3)), tss, cost, reps };
}

/**
 * @param {object} workout - a WORKOUTS entry with `work` structure
 * @param {object} athlete - { cp, wPrimeKj, cpConfidence, cpSource, ftp }
 * @returns {object|null} prescription, or null when there is no anchor at all
 */
export function prescribe(workout, athlete = {}) {
  const anchor = athlete.anchor || anchorFor(athlete);
  if (!workout || !workout.work || !anchor) return null;

  const w = workout.work;
  let reps = w.reps || 1;
  let built = build(workout, anchor, reps);
  const notes = [];
  if (anchor.note) notes.push(anchor.note);

  // The feasibility check. Only meaningful with a fitted W' — with a declared
  // FTP we have no idea how deep the athlete's anaerobic tank is, and guessing
  // one would be worse than not checking.
  let feasible = true;
  let repsDropped = 0;
  if (anchor.wPrimeKj) {
    const ceiling = anchor.wPrimeKj * PRESCRIPTION.wPrimeCeilingMultiple;
    while (built.cost.grossKj > ceiling && reps > PRESCRIPTION.minReps) {
      reps -= 1;
      repsDropped += 1;
      built = build(workout, anchor, reps);
    }
    feasible = built.cost.grossKj <= ceiling;
    if (repsDropped > 0) {
      notes.push(
        `cut from ${w.reps} to ${reps} reps — at ${round5(anchor.watts * w.onPctCp)} W the full session costs more W' than your fitted ${anchor.wPrimeKj} kJ can carry`
      );
    }
    if (!feasible) {
      notes.push(
        `even at ${reps} reps this asks more of W' than ${anchor.wPrimeKj} kJ supports — expect to fall short of the last rep`
      );
    }
  }

  const targetWatts = round5(anchor.watts * w.onPctCp);
  const offWatts = w.offMin ? round5(anchor.watts * (w.offPctCp ?? 0.5)) : null;

  return {
    workoutId: workout.id,
    basis: anchor.basis,          // 'cp' | 'ftp'
    anchorWatts: Math.round(anchor.watts),
    targetWatts,
    offWatts,
    reps,
    repsPrescribed: w.reps || 1,
    repsDropped,
    onMin: w.onMin,
    offMin: w.offMin || 0,
    durationMin: built.durationMin,
    tss: built.tss,
    ifEst: built.ifEst,
    wPrimeCostKj: Number(built.cost.grossKj.toFixed(1)),
    wPrimePeakKj: Number(built.cost.peakKj.toFixed(1)),
    feasible,
    note: notes.length ? notes.join('; ') : null,
    text: describe(workout, { targetWatts, offWatts, reps, basis: anchor.basis }),
  };
}

function describe(workout, { targetWatts, offWatts, reps, basis }) {
  const w = workout.work;
  const unit = basis === 'cp' ? 'CP' : 'FTP';
  const pct = Math.round(w.onPctCp * 100);
  if (reps === 1 && !w.offMin) {
    return `${w.onMin} min steady at ~${targetWatts} W (${pct}% of ${unit})`;
  }
  const on = w.onMin < 1 ? `${Math.round(w.onMin * 60)} s` : `${w.onMin} min`;
  const rec = offWatts ? `, ${w.offMin} min at ${offWatts} W between` : '';
  return `${reps} x ${on} at ${targetWatts} W (${pct}% of ${unit})${rec}`;
}

/**
 * Convenience for callers that prescribe a whole week: one anchor, many
 * workouts, results cached by id.
 */
export function prescriber(athlete = {}) {
  const anchor = anchorFor(athlete);
  const cache = new Map();
  const fn = (workout) => {
    if (!workout || !anchor) return null;
    if (!cache.has(workout.id)) cache.set(workout.id, prescribe(workout, { anchor }));
    return cache.get(workout.id);
  };
  fn.anchor = anchor;
  return fn;
}
