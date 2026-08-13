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
  baselineDays: 7,
  hrvSuppressedPct: -8,    // % below rolling baseline
  hrvStronglySuppressedPct: -15,
  rhrElevatedBpm: 5,
  sleepShortHours: 6.5,
  moodLowScore: 4,         // on a 1-10 scale
  consecutiveDaysForFlag: 2,
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
