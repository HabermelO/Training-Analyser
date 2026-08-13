import { buildVerdict } from '../src/engine/verdict.js';
import { narrate, allowedNumbers } from '../src/llm/index.js';

const ride = {
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
const daily = [
  { date: '2026-04-19', hrv: 62, rhr: 48, sleepHours: 7.5, mood: 7 },
  { date: '2026-04-20', hrv: 60, rhr: 49, sleepHours: 7.2, mood: 7 },
  { date: '2026-04-21', hrv: 64, rhr: 47, sleepHours: 8.0, mood: 8 },
  { date: '2026-04-22', hrv: 58, rhr: 50, sleepHours: 6.8, mood: 6 },
  { date: '2026-04-23', hrv: 61, rhr: 48, sleepHours: 7.4, mood: 7 },
  { date: '2026-04-24', hrv: 55, rhr: 52, sleepHours: 6.2, mood: 5 },
  { date: '2026-04-25', hrv: 52, rhr: 54, sleepHours: 6.0, mood: 4 },
];
const v = buildVerdict({ ride, history: [], daily,
  athlete: { ftp: 240, maxHr: 198 }, prescribed: { sessionType: 'threshold_over_under' } });

console.log('allowed numbers:', [...allowedNumbers(v)].sort((a,b)=>a-b).join(' '));

const CLEAN = `The stimulus landed, but the execution was scrappy rather than clean. You spent 20.2 min in Z4 across 86 min of riding, and the work intervals varied widely in length, which means the lactate clearance you were chasing came in fragments rather than in the sustained blocks that drive the adaptation. Decoupling of 5.6% sits at the edge of normal, and ${Math.round(ride.hrRedzoneSecs/60)} min above Z4 heart rate is a lot of cardiac cost for the watts produced. Your markers are strongly suppressed going in, with HRV 13.3% below baseline, resting HR up 5 bpm, and 6h sleep behind you, so the cost of this ride is higher than the numbers alone suggest. With CTL at ${v.load.ctl} and TSB at ${v.load.tsb}, the sensible next move is to let the tank refill before asking for another block like this one.`;

const HALLUCINATED = CLEAN.replace('20.2 min in Z4', '32 min in Z4') + ' Your FTP looks like it is climbing toward 255W.';

const cases = {
  clean:      async () => CLEAN,
  hallucinating: async () => HALLUCINATED,
  hanging:    () => new Promise(() => {}),
  crashing:   async () => { throw new Error('WebGPU device lost'); },
};
// repairs on the second call
let calls = 0;
cases.repairs = async () => (++calls === 1 ? HALLUCINATED : CLEAN);

for (const [name, generate] of Object.entries(cases)) {
  const r = await narrate(v, { generate, timeoutMs: 200,
    onEvent: (e) => console.log(`   [${name}] event: ${e.type}${e.violations ? ' -> ' + e.violations.map(x=>x.token).join(',') : ''}`) });
  console.log(`${name.padEnd(14)} source=${r.source.padEnd(15)} reason=${r.reason ?? '-'}`);
  console.log(`   ${r.text.slice(0, 110)}...`);
}
