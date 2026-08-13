// Verdicts spanning the space the narration layer actually has to cover.
// The point is variety along the axes that change what the model is asked to
// say: session type, verdict, readiness flag, TSB sign, and whether the
// optional evidence fields are present at all.
//
// Shared by the node audit and the browser one, so both measure the same
// thing and the numbers are comparable.

import { buildVerdict } from '../src/engine/verdict.js';

const ATHLETE = { ftp: 240, maxHr: 198 };

const THRESHOLD_RIDE = {
  date: '2026-04-25T15:00:00Z', durationMin: 86, np: 189, tss: 89, if: 0.79,
  decouplingPct: 5.6, wPrimeKj: 20.3, hrRedzoneSecs: 1548,
  peakPowers: { '1s': { power: 493, hr: 162 }, '5m': { power: 229, hr: 177 },
                '20m': { power: 207, hr: 171 }, '60m': { power: 183, hr: 163 } },
  zoneMinutes: { Z1_Recovery: 24.1, Z2_Endurance: 24.7, Z3_Tempo: 11.1,
                 Z4_Threshold: 20.2, Z5_VO2Max: 5.0, Z6_Anaerobic: 0.8 },
  hrZoneMinutes: { Z1_Recovery: 3.6, Z2_Aerobic: 39.2, Z3_Tempo: 8.3,
                   Z4_Threshold: 31.9, Z5_Maximum: 2.9 },
  intervals: [
    { type: 'Warm Up', durationSecs: 187, averagePower: 70 },
    { type: 'Z4_Threshold', durationSecs: 420, averagePower: 232 },
    { type: 'Z1_Recovery', durationSecs: 180, averagePower: 110 },
    { type: 'Z4_Threshold', durationSecs: 180, averagePower: 238 },
    { type: 'Z1_Recovery', durationSecs: 150, averagePower: 105 },
    { type: 'Z4_Threshold', durationSecs: 640, averagePower: 229 },
    { type: 'Z3_Tempo', durationSecs: 300, averagePower: 205 },
  ],
};

const RECOVERY_RIDE = {
  date: '2026-04-26T08:00:00Z', durationMin: 44, np: 118, tss: 22, if: 0.52,
  decouplingPct: 1.2, wPrimeKj: 0.4, hrRedzoneSecs: 0,
  peakPowers: { '1s': { power: 210, hr: 128 }, '5m': { power: 132, hr: 122 } },
  zoneMinutes: { Z1_Recovery: 33.0, Z2_Endurance: 11.0, Z3_Tempo: 0,
                 Z4_Threshold: 0, Z5_VO2Max: 0, Z6_Anaerobic: 0 },
  hrZoneMinutes: { Z1_Recovery: 30.1, Z2_Aerobic: 13.9, Z3_Tempo: 0,
                   Z4_Threshold: 0, Z5_Maximum: 0 },
  intervals: [{ type: 'Warm Up', durationSecs: 2640, averagePower: 115 }],
};

// Same ride, but a sprint out of a junction blows the recovery discipline.
const RECOVERY_SPOILED = {
  ...RECOVERY_RIDE,
  date: '2026-04-27T08:00:00Z',
  wPrimeKj: 1.4,
  peakPowers: { '1s': { power: 512, hr: 141 }, '5m': { power: 134, hr: 123 } },
};

const ENDURANCE_DRIFTED = {
  date: '2026-04-28T07:00:00Z', durationMin: 194, np: 162, tss: 131, if: 0.68,
  decouplingPct: 9.4, wPrimeKj: 3.1, hrRedzoneSecs: 0,
  peakPowers: { '5m': { power: 198, hr: 154 }, '20m': { power: 178, hr: 151 },
                '60m': { power: 168, hr: 149 } },
  zoneMinutes: { Z1_Recovery: 41.0, Z2_Endurance: 138.0, Z3_Tempo: 13.0,
                 Z4_Threshold: 2.0, Z5_VO2Max: 0, Z6_Anaerobic: 0 },
  hrZoneMinutes: { Z1_Recovery: 12.0, Z2_Aerobic: 149.0, Z3_Tempo: 31.0,
                   Z4_Threshold: 2.0, Z5_Maximum: 0 },
  intervals: [{ type: 'Warm Up', durationSecs: 900, averagePower: 128 },
              { type: 'Z2_Endurance', durationSecs: 10740, averagePower: 165 }],
};

const VO2_RIDE = {
  date: '2026-04-29T17:00:00Z', durationMin: 68, np: 214, tss: 82, if: 0.89,
  decouplingPct: 3.8, wPrimeKj: 28.6, hrRedzoneSecs: 980,
  peakPowers: { '1s': { power: 604, hr: 171 }, '1m': { power: 331, hr: 186 },
                '5m': { power: 276, hr: 191 }, '20m': { power: 212, hr: 178 } },
  zoneMinutes: { Z1_Recovery: 22.0, Z2_Endurance: 18.0, Z3_Tempo: 6.0,
                 Z4_Threshold: 8.0, Z5_VO2Max: 11.4, Z6_Anaerobic: 2.6 },
  hrZoneMinutes: { Z1_Recovery: 4.0, Z2_Aerobic: 21.0, Z3_Tempo: 12.0,
                   Z4_Threshold: 24.0, Z5_Maximum: 7.0 },
  intervals: [
    { type: 'Warm Up', durationSecs: 600, averagePower: 118 },
    { type: 'Z5_VO2Max', durationSecs: 180, averagePower: 288 },
    { type: 'Z1_Recovery', durationSecs: 180, averagePower: 108 },
    { type: 'Z5_VO2Max', durationSecs: 180, averagePower: 281 },
    { type: 'Z1_Recovery', durationSecs: 180, averagePower: 106 },
    { type: 'Z5_VO2Max', durationSecs: 180, averagePower: 272 },
  ],
};

// Enough volume to push CTL up and TSB deep negative.
const HEAVY_HISTORY = [
  { date: '2026-04-05T07:00:00Z', tss: 118, adaptation: 'aerobic_base' },
  { date: '2026-04-07T07:00:00Z', tss: 92, adaptation: 'threshold_tte' },
  { date: '2026-04-09T07:00:00Z', tss: 140, adaptation: 'aerobic_base' },
  { date: '2026-04-11T07:00:00Z', tss: 88, adaptation: 'vo2max' },
  { date: '2026-04-13T07:00:00Z', tss: 155, adaptation: 'aerobic_base' },
  { date: '2026-04-15T07:00:00Z', tss: 95, adaptation: 'sweetspot' },
  { date: '2026-04-18T06:22:00Z', tss: 28, adaptation: 'recovery' },
  { date: '2026-04-20T08:28:00Z', tss: 149, adaptation: 'lactate_clearance',
    peakPowers: { '5m': { power: 243, hr: 178 }, '20m': { power: 206, hr: 168 },
                  '10m': { power: 226, hr: 181 } } },
  { date: '2026-04-22T08:00:00Z', tss: 162, adaptation: 'aerobic_base',
    peakPowers: { '5m': { power: 182, hr: 147 }, '20m': { power: 169, hr: 144 } } },
  { date: '2026-04-23T08:00:00Z', tss: 131, adaptation: 'sweetspot' },
  { date: '2026-04-24T08:00:00Z', tss: 118, adaptation: 'aerobic_base' },
];

// A taper: real CTL, almost no recent load, so TSB goes positive.
const TAPERED_HISTORY = [
  { date: '2026-03-20T07:00:00Z', tss: 130, adaptation: 'aerobic_base' },
  { date: '2026-03-25T07:00:00Z', tss: 140, adaptation: 'aerobic_base' },
  { date: '2026-03-30T07:00:00Z', tss: 125, adaptation: 'threshold_tte' },
  { date: '2026-04-04T07:00:00Z', tss: 135, adaptation: 'aerobic_base' },
  { date: '2026-04-09T07:00:00Z', tss: 120, adaptation: 'sweetspot' },
  { date: '2026-04-14T07:00:00Z', tss: 110, adaptation: 'vo2max' },
  { date: '2026-04-19T07:00:00Z', tss: 40, adaptation: 'recovery' },
  { date: '2026-04-22T07:00:00Z', tss: 30, adaptation: 'recovery' },
];

const dailyFrom = (hrvs, rhrs, sleeps, moods, start = 19) =>
  hrvs.map((h, i) => ({
    date: `2026-04-${String(start + i).padStart(2, '0')}`,
    hrv: h, rhr: rhrs[i], sleepHours: sleeps[i], mood: moods[i],
  }));

const DAILY_SUPPRESSED = dailyFrom(
  [62, 60, 64, 58, 61, 55, 52], [48, 49, 47, 50, 48, 52, 54],
  [7.5, 7.2, 8.0, 6.8, 7.4, 6.2, 6.0], [7, 7, 8, 6, 7, 5, 4]
);
const DAILY_FRESH = dailyFrom(
  [58, 59, 57, 60, 61, 63, 68], [50, 49, 50, 48, 48, 47, 45],
  [7.8, 8.1, 7.9, 8.3, 8.0, 8.2, 8.4], [7, 8, 7, 8, 8, 8, 9]
);
const DAILY_NORMAL = dailyFrom(
  [60, 61, 59, 62, 60, 61, 60], [49, 48, 49, 48, 49, 48, 49],
  [7.4, 7.6, 7.2, 7.5, 7.3, 7.6, 7.4], [7, 7, 7, 7, 7, 7, 7]
);

/**
 * Each entry pins one axis of variation. Names are what shows up in the
 * report, so they say what is being varied, not what the ride was.
 */
export function scenarios() {
  const specs = [
    { name: 'threshold/no-history',
      ride: THRESHOLD_RIDE, history: [], daily: DAILY_SUPPRESSED,
      prescribed: { sessionType: 'threshold_over_under' } },

    { name: 'threshold/deep-hole',
      ride: THRESHOLD_RIDE, history: HEAVY_HISTORY, daily: DAILY_SUPPRESSED,
      prescribed: { sessionType: 'threshold_over_under' } },

    { name: 'threshold/off-plan',
      ride: THRESHOLD_RIDE, history: HEAVY_HISTORY, daily: DAILY_NORMAL,
      prescribed: { sessionType: 'active_recovery' } },

    { name: 'threshold/tapered-positive-tsb',
      ride: THRESHOLD_RIDE, history: TAPERED_HISTORY, daily: DAILY_FRESH,
      prescribed: { sessionType: 'threshold_over_under' } },

    { name: 'recovery/clean',
      ride: RECOVERY_RIDE, history: HEAVY_HISTORY, daily: DAILY_SUPPRESSED,
      prescribed: { sessionType: 'active_recovery' } },

    { name: 'recovery/compromised',
      ride: RECOVERY_SPOILED, history: HEAVY_HISTORY, daily: DAILY_SUPPRESSED,
      prescribed: { sessionType: 'active_recovery' } },

    { name: 'endurance/drifted',
      ride: ENDURANCE_DRIFTED, history: TAPERED_HISTORY, daily: DAILY_NORMAL,
      prescribed: { sessionType: 'endurance' } },

    { name: 'vo2/fresh',
      ride: VO2_RIDE, history: TAPERED_HISTORY, daily: DAILY_FRESH,
      prescribed: { sessionType: 'vo2max' } },

    // No wellness at all — readiness.notes is empty, so the prompt has one
    // fewer source of licensed numbers. Worth its own row: a model that only
    // behaves when the evidence block is rich is not actually behaving.
    { name: 'vo2/no-wellness',
      ride: VO2_RIDE, history: TAPERED_HISTORY, daily: [],
      prescribed: { sessionType: 'vo2max' } },

    { name: 'endurance/no-plan',
      ride: ENDURANCE_DRIFTED, history: HEAVY_HISTORY, daily: DAILY_NORMAL,
      prescribed: null },
  ];

  return specs.map((s) => ({
    name: s.name,
    verdict: buildVerdict({
      ride: s.ride, history: s.history, daily: s.daily,
      athlete: ATHLETE, prescribed: s.prescribed,
    }),
  }));
}
