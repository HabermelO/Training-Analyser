// All tunable numbers live here. Nothing in the engine should hardcode a
// threshold — if you find one inline, move it up into this file.

export const DEFAULT_ATHLETE = {
  ftp: 240,
  maxHr: 198,
  // HR zone upper bounds in bpm
  hrZones: { z1: 124, z2: 154, z3: 168, z4: 180, z5: 999 },
  goals: 'Improve FTP and VO2 Max for road racing.',
};

// Power zones as a fraction of FTP (upper bound, Coggan-style)
export const POWER_ZONES = {
  Z1_Recovery: 0.55,
  Z2_Endurance: 0.75,
  Z3_Tempo: 0.90,
  Z4_Threshold: 1.05,
  Z5_VO2Max: 1.20,
  Z6_Anaerobic: Infinity,
};

export const DECOUPLING = {
  excellent: 2.0,   // < this = engine stable
  acceptable: 5.0,  // < this = normal for the intensity
  elevated: 8.0,    // < this = strained; above = losing efficiency badly
  // Rides shorter than this can't produce a meaningful drift number
  minDurationMin: 45,
};

export const SESSION = {
  // A ride needs this much Z4+ time to count as a threshold session
  thresholdMinZ4Min: 12,
  vo2MinZ5Min: 8,
  tempoMinZ3Min: 20,
  enduranceMinDurationMin: 90,
  // Recovery rides must stay under all of these
  recoveryMaxIf: 0.65,
  recoveryMaxWprimeKj: 2.0,
  recoveryMaxDurationMin: 75,
  // Interval structure: coefficient of variation of work-interval duration
  // above this means the session was fragmented (traffic, terrain, junctions)
  fragmentedCv: 0.35,
  minWorkIntervals: 3,
};

export const READINESS = {
  // z-score path (primary). Baseline is on ln(rMSSD) because rMSSD is
  // log-normal: a 10% drop and a 10% rise are not equally surprising raw.
  baselineDays: 30,
  shortWindowDays: 7,      // today = mean of last 7 days, not a single reading
  minBaselineDays: 14,     // below this many readings, use the % fallback
  zSuppressed: -0.75,
  zStronglySuppressed: -1.5,
  zFresh: 0.75,
  // Guard against a degenerate baseline in an unusually flat stretch — an SD
  // this small would turn ordinary noise into a strong flag.
  minBaselineSd: 0.02,     // in ln units (~2%)

  // Percentage path (fallback only, while the baseline is still filling)
  fallbackBaselineDays: 7,
  hrvSuppressedPct: -8,    // % below rolling baseline
  hrvStronglySuppressedPct: -15,

  // Independent escalators
  rhrElevatedBpm: 5,
  sleepShortHours: 6.5,
  moodLowScore: 4,         // on a 1-10 scale
  consecutiveDaysForFlag: 3,
};

export const LOAD = {
  ctlDays: 42,
  atlDays: 7,
  tsbFreshAbove: 5,
  tsbFatiguedBelow: -20,
  tsbDeepHoleBelow: -30,
  // Week-on-week ramp above this is a red flag
  maxWeeklyRampPct: 15,
};

export const FTP_MODEL = {
  // Minimum spread of durations needed before critical power is trustworthy
  minEffortsForCp: 3,
  minDaysOfHistory: 21,
  // Efforts must sit in this window to inform the CP model (seconds)
  cpWindow: [180, 2400],
  // An effort only counts as maximal if HR got close to max
  maximalEffortHrPct: 0.90,
  confidenceLabels: ['insufficient', 'low', 'moderate', 'good'],
};

export const PRESCRIPTION = {
  // Fractions of the anchor used for the parts of a session the library does
  // not specify, because nobody cares what wattage a warmup is.
  warmupPctCp: 0.55,
  cooldownPctCp: 0.50,
  // W' reconstitutes below CP, but not instantly and not perfectly. This is a
  // deliberately blunt linear stand-in for the exponential recovery model.
  reconstitutionEfficiency: 0.55,
  // Gross W' cost above this multiple of the athlete's own fitted W' means the
  // session is not finishable as written, and reps come off until it is.
  wPrimeCeilingMultiple: 1.4,
  minReps: 2,
};

export const TID = {
  // Six weeks. Shorter and a single recovery week distorts the picture;
  // longer and a block change washes out before it shows up.
  windowDays: 42,
  // Below these the answer is arithmetic on too little, and a distribution
  // read off three rides is a description of three rides.
  minRides: 6,
  minTotalMin: 300,

  // The grey-zone floor. Time in tempo above this share is the classic
  // middle trap: easy days not easy enough to recover from, hard days not
  // hard enough to adapt to.
  greyModeratePct: 20,
  // A deliberate high-intensity block rather than a drifting one.
  thresholdHardPct: 25,
  // Polarised proper. Set at 75 rather than 80 because the classic 80/20 is
  // stated in sessions and this is measured in minutes — warmups and
  // cooldowns of hard sessions land in the easy bucket either way.
  polarisedEasyPct: 75,
};

export const PHASE = {
  // 3:1 loading — three ramping weeks, then a scheduled unload.
  blockWeeks: 4,
  recoveryWeekFraction: 0.6,
  recoveryWeekHardBudget: 1,
  // With no goal date, alternate base/build blocks of this many weeks.
  noGoalBlockWeeks: 8,
  // Days-to-goal boundaries (upper bound of each phase, walking inward).
  taperDays: 14,
  peakDays: 28,
  buildDays: 84,
  // Per-week ramp by phase, capped by LOAD.maxWeeklyRampPct.
  rampPctByPhase: {
    base: 8,
    build: 6,
    peak: 3,
    taper: 0,
    transition: 0,
  },
  intensityBias: {
    base:       { hardBudget: 2, favours: ['threshold_tte', 'lactate_clearance', 'vo2max'] },
    build:      { hardBudget: 3, favours: ['vo2max', 'lactate_clearance', 'threshold_tte'] },
    peak:       { hardBudget: 3, favours: ['vo2max', 'threshold_tte', 'lactate_clearance'] },
    taper:      { hardBudget: 2, favours: ['vo2max', 'threshold_tte', 'lactate_clearance'], preferShortHard: true },
    transition: { hardBudget: 0, favours: ['threshold_tte', 'vo2max', 'lactate_clearance'] },
  },
};
