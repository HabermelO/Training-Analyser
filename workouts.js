// The planner selects from this library. It is deliberately data, not prose,
// so a small model can never invent a session that does not exist.
//
// Entries store STRUCTURE, not numbers: reps, durations, and fractions of the
// athlete's critical power. `durationMin`, `tss` and `if` are kept only as
// nominal values (roughly what the session comes to at CP 240) for callers
// that have no threshold to prescribe against yet — prescribe.js turns the
// `work` block into the athlete's own watts and TSS, which is the only version
// the volume cap in planner.js should ever be doing arithmetic on.
//
// NOTE: verify the `systm` names against your own SYSTM library before
// shipping and prune anything you don't actually have access to. Every entry
// needs an outdoor equivalent that drives the SAME adaptation — that is the
// whole point of the pairing, not just matching the duration.

export const ADAPTATIONS = {
  neuromuscular: 'Recruitment and rate coding, no metabolic cost',
  anaerobic_capacity: "W' expansion, lactate tolerance",
  vo2max: 'Maximal oxygen uptake, cardiac output',
  lactate_clearance: 'Shuttling and clearing lactate at high aerobic load',
  threshold_tte: 'Extending time-to-exhaustion at FTP',
  sweetspot: 'High aerobic stimulus at sustainable cost',
  aerobic_base: 'Mitochondrial density, fat oxidation, capillarisation',
  recovery: 'Parasympathetic restoration, blood flow without load',
};

export const WORKOUTS = [
  {
    id: 'recovery_spin',
    systm: 'Recovery',
    adaptation: 'recovery',
    durationMin: 45,
    tss: 25,
    if: 0.55,
    warmupMin: 0, cooldownMin: 0,
    work: { reps: 1, onMin: 45, offMin: 0, onPctCp: 0.55 },
    outdoor: {
      name: 'Flat easy spin',
      prescription:
        'Keep HR strictly under Z1 ceiling. Cap any peak effort at 1.2x FTP even out of junctions. High cadence, small gear, no hills.',
    },
  },
  {
    id: 'endurance_long',
    systm: 'The Butter Tarts',
    adaptation: 'aerobic_base',
    durationMin: 180,
    tss: 150,
    if: 0.65,
    warmupMin: 0, cooldownMin: 0,
    work: { reps: 1, onMin: 180, offMin: 0, onPctCp: 0.68 },
    outdoor: {
      name: 'Long steady ride',
      prescription:
        'Hard-cap HR at the Z2 ceiling for the full duration. Power may sit in Z3 on climbs — that is fine as long as HR stays capped. Fuel from the first hour.',
    },
  },
  {
    id: 'endurance_medium',
    systm: 'Half Is Easy',
    adaptation: 'aerobic_base',
    durationMin: 105,
    tss: 85,
    if: 0.68,
    warmupMin: 0, cooldownMin: 0,
    work: { reps: 1, onMin: 105, offMin: 0, onPctCp: 0.68 },
    outdoor: {
      name: 'Rolling endurance',
      prescription:
        'Continuous Z2, no stops longer than a minute. Ride the flats and let climbs drift to low Z3 without chasing them.',
    },
  },
  {
    id: 'sweetspot_blocks',
    systm: 'Tune Up',
    adaptation: 'sweetspot',
    durationMin: 75,
    tss: 78,
    if: 0.82,
    warmupMin: 15, cooldownMin: 10,
    work: { reps: 3, onMin: 15, offMin: 5, onPctCp: 0.90, offPctCp: 0.50 },
    outdoor: {
      name: '3 x 15 min sweet spot',
      prescription:
        '88-93% FTP on a steady drag or into a headwind so the load stays continuous. 5 min easy between. Pick terrain without junctions.',
    },
  },
  {
    id: 'threshold_tte',
    systm: 'The Wretched',
    adaptation: 'threshold_tte',
    durationMin: 80,
    tss: 92,
    if: 0.86,
    warmupMin: 15, cooldownMin: 10,
    work: { reps: 2, onMin: 20, offMin: 8, onPctCp: 1.00, offPctCp: 0.50 },
    outdoor: {
      name: '2 x 20 min at FTP',
      prescription:
        '98-102% FTP, uninterrupted. A long climb or a quiet exposed road is essential — every stop truncates the adaptation you are chasing.',
    },
  },
  {
    id: 'over_unders',
    systm: 'Fast Aggressive',
    adaptation: 'lactate_clearance',
    durationMin: 75,
    tss: 85,
    if: 0.85,
    warmupMin: 15, cooldownMin: 10,
    work: { reps: 3, onMin: 9, offMin: 5, onPctCp: 0.98, offPctCp: 0.50 },
    outdoor: {
      name: '3 x 9 min over-under',
      prescription:
        '2 min at 95% FTP, 1 min at 105%, repeated. Needs a long uninterrupted climb — the "under" is recovery only if it is genuinely continuous.',
    },
  },
  {
    id: 'vo2_short',
    systm: 'Nine Hammers',
    adaptation: 'vo2max',
    durationMin: 65,
    tss: 80,
    if: 0.88,
    warmupMin: 15, cooldownMin: 10,
    work: { reps: 5, onMin: 3, offMin: 3, onPctCp: 1.12, offPctCp: 0.45 },
    outdoor: {
      name: '5 x 3 min maximal',
      prescription:
        'Ride each to the highest power you can hold for the full 3 min, not to a target number. Equal recovery. A 4-6% gradient is ideal.',
    },
  },
  {
    id: 'vo2_long',
    systm: 'The Cure',
    adaptation: 'vo2max',
    durationMin: 70,
    tss: 84,
    if: 0.87,
    warmupMin: 15, cooldownMin: 10,
    work: { reps: 4, onMin: 5, offMin: 5, onPctCp: 1.06, offPctCp: 0.45 },
    outdoor: {
      name: '4 x 5 min hard',
      prescription:
        'Target the highest sustainable power across all four. HR should reach 90%+ of max in the back half of each rep.',
    },
  },
  {
    id: 'anaerobic',
    systm: 'Igniter',
    adaptation: 'anaerobic_capacity',
    durationMin: 60,
    tss: 70,
    if: 0.83,
    warmupMin: 15, cooldownMin: 10,
    work: { reps: 8, onMin: 0.75, offMin: 3, onPctCp: 1.50, offPctCp: 0.40 },
    outdoor: {
      name: '8 x 45s maximal',
      prescription:
        'Full gas from a rolling start, long recoveries. Expect and accept large W\u2032 expenditure — that is the stimulus.',
    },
  },
  {
    id: 'neuromuscular',
    systm: 'Primers',
    adaptation: 'neuromuscular',
    durationMin: 45,
    tss: 35,
    if: 0.62,
    warmupMin: 15, cooldownMin: 10,
    work: { reps: 6, onMin: 0.167, offMin: 4, onPctCp: 2.00, offPctCp: 0.50 },
    outdoor: {
      name: 'Openers with sprints',
      prescription:
        '6 x 10s maximal sprints with 5 min full recovery. Total work is tiny; the point is nervous system activation, not fatigue.',
    },
  },
];

export const byAdaptation = (adaptation) =>
  WORKOUTS.filter((w) => w.adaptation === adaptation);

export const byId = (id) => WORKOUTS.find((w) => w.id === id);
