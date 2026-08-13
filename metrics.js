import { POWER_ZONES, DEFAULT_ATHLETE } from '../engine/thresholds.js';

// Everything here is pure: samples in, ride object out. No FIT decoding, no
// DOM, no worker APIs — so it can be unit-tested against synthetic rides and
// reused if the file format ever changes.
//
// Input sample shape (what the FIT record mesg gives us, normalised):
//   { t: Date|number(ms), power, hr, cadence, speed (m/s), distance, altitude }

export const INGEST = {
  // Gaps longer than this are treated as the device being paused/stopped and
  // are dropped rather than zero-filled — otherwise a cafe stop destroys NP.
  maxGapSecs: 30,
  // A sample counts as moving if either of these holds.
  movingMinSpeed: 0.5,
  movingMinPower: 1,
  // Smoothing window for interval detection (not for any reported number).
  segmentSmoothSecs: 15,
  // Segments shorter than this get merged into a neighbour.
  minSegmentSecs: 45,
  // Time at or above this fraction of max HR counts as red zone.
  redzoneHrPctOfMax: 0.90,
  npWindowSecs: 30,
  // Sustained-effort detection, used to propose a threshold from ride data.
  minEffortSecs: 300,
  effortFloorFraction: 0.88,
  effortMaxDipSecs: 20,
  // HR lags power at the start of a ride, so the opening minutes read as
  // falsely efficient and are excluded from the trend.
  efWarmupSkipSecs: 600,
  efMinZoneSecs: 300,
};

const PEAK_DURATIONS = {
  '1s': 1, '2s': 2, '5s': 5, '10s': 10, '30s': 30,
  '1m': 60, '2m': 120, '5m': 300, '10m': 600, '20m': 1200, '60m': 3600,
};

const POWER_ZONE_ORDER = [
  'Z1_Recovery', 'Z2_Endurance', 'Z3_Tempo',
  'Z4_Threshold', 'Z5_VO2Max', 'Z6_Anaerobic',
];

const HR_ZONE_KEYS = {
  z1: 'Z1_Recovery', z2: 'Z2_Aerobic', z3: 'Z3_Tempo',
  z4: 'Z4_Threshold', z5: 'Z5_Maximum',
};

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));

/**
 * Put samples on a strict 1 Hz grid. Short gaps are held (last value carried,
 * power decayed to the next real reading), long gaps are cut out entirely and
 * recorded so downstream code knows the timeline is not contiguous.
 */
export function resampleTo1Hz(samples, opts = {}) {
  const cfg = { ...INGEST, ...opts };
  const clean = samples
    .filter((s) => s && s.t != null)
    .map((s) => ({ ...s, ts: Math.round(ms(s.t) / 1000) }))
    .sort((a, b) => a.ts - b.ts);
  if (!clean.length) return { grid: [], gaps: [], startTs: null };

  const grid = [];
  const gaps = [];
  let prev = null;

  for (const s of clean) {
    if (prev) {
      const gap = s.ts - prev.ts;
      if (gap > cfg.maxGapSecs) {
        gaps.push({ atTs: prev.ts, secs: gap });
      } else {
        // Fill the interior seconds. Power is a rate, so a held value is a
        // lie; interpolate it. HR is a state, so carrying it is honest.
        for (let k = 1; k < gap; k++) {
          const f = k / gap;
          grid.push({
            ts: prev.ts + k,
            power: interp(prev.power, s.power, f),
            hr: interp(prev.hr, s.hr, f),
            cadence: interp(prev.cadence, s.cadence, f),
            speed: interp(prev.speed, s.speed, f),
            altitude: interp(prev.altitude, s.altitude, f),
            filled: true,
          });
        }
      }
    }
    grid.push({ ...s, filled: false });
    prev = s;
  }
  return { grid, gaps, startTs: grid[0].ts };
}

function interp(a, b, f) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return a + (b - a) * f;
}

function isMoving(s, cfg) {
  return (s.speed ?? 0) >= cfg.movingMinSpeed || (s.power ?? 0) >= cfg.movingMinPower;
}

function rollingMean(arr, win) {
  const out = new Array(arr.length).fill(null);
  if (arr.length < win) return out;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= win) sum -= arr[i - win];
    if (i >= win - 1) out[i] = sum / win;
  }
  return out;
}

function prefix(arr) {
  const p = new Float64Array(arr.length + 1);
  for (let i = 0; i < arr.length; i++) p[i + 1] = p[i] + arr[i];
  return p;
}

// Best mean power at each duration, carrying the HR it was set at. The HR is
// what lets the CP model in ftp.js reject submaximal efforts, so it matters
// as much as the watts do.
export function peakPowers(power, hr) {
  const pp = prefix(power);
  const hasHr = hr.some((h) => h != null);
  const hp = prefix(hr.map((h) => h ?? 0));
  const hn = prefix(hr.map((h) => (h == null ? 0 : 1)));

  const out = {};
  for (const [label, secs] of Object.entries(PEAK_DURATIONS)) {
    if (power.length < secs) continue;
    let bestSum = -Infinity;
    let bestI = 0;
    for (let i = 0; i + secs <= power.length; i++) {
      const s = pp[i + secs] - pp[i];
      if (s > bestSum) { bestSum = s; bestI = i; }
    }
    const entry = { power: Math.round(bestSum / secs) };
    if (hasHr) {
      const n = hn[bestI + secs] - hn[bestI];
      if (n > 0) entry.hr = Math.round((hp[bestI + secs] - hp[bestI]) / n);
    }
    out[label] = entry;
  }
  return out;
}

export function normalisedPower(power, win = INGEST.npWindowSecs) {
  if (power.length < win) return null;
  const roll = rollingMean(power, win);
  let sum = 0;
  let n = 0;
  for (const v of roll) {
    if (v == null) continue;
    sum += v ** 4;
    n++;
  }
  return n ? Math.round((sum / n) ** 0.25) : null;
}

// Aerobic decoupling: efficiency factor (NP per beat) in the first half of the
// ride against the second. Reported raw — execution.js decides whether the
// ride was long enough for it to mean anything.
export function decoupling(power, hr) {
  const half = Math.floor(power.length / 2);
  if (half < 60) return null;
  const ef = (p, h) => {
    const hrVals = h.filter((x) => x != null && x > 0);
    if (hrVals.length < p.length * 0.5) return null;
    const np = normalisedPower(p) ?? mean(p);
    const meanHr = mean(hrVals);
    return np && meanHr ? np / meanHr : null;
  };
  const first = ef(power.slice(0, half), hr.slice(0, half));
  const second = ef(power.slice(half), hr.slice(half));
  if (!first || !second) return null;
  return Number((((first - second) / first) * 100).toFixed(1));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Gross W' expenditure: joules spent above critical power. No reconstitution
// term — this is "how much did you dip into the tank", which is what the
// recovery-ride check in classify.js is actually asking.
export function wPrimeSpentKj(power, cp) {
  let j = 0;
  for (const p of power) if (p > cp) j += p - cp;
  return Number((j / 1000).toFixed(1));
}

export function powerZoneMinutes(power, ftp) {
  const mins = Object.fromEntries(POWER_ZONE_ORDER.map((k) => [k, 0]));
  for (const p of power) {
    const frac = p / ftp;
    const zone = POWER_ZONE_ORDER.find((k) => frac <= POWER_ZONES[k]) || 'Z6_Anaerobic';
    mins[zone] += 1 / 60;
  }
  for (const k of POWER_ZONE_ORDER) mins[k] = Number(mins[k].toFixed(1));
  return mins;
}

export function hrZoneMinutes(hr, hrZones) {
  const mins = Object.fromEntries(Object.values(HR_ZONE_KEYS).map((k) => [k, 0]));
  for (const h of hr) {
    if (h == null || h <= 0) continue;
    const key = Object.keys(HR_ZONE_KEYS).find((z) => h <= hrZones[z]) || 'z5';
    mins[HR_ZONE_KEYS[key]] += 1 / 60;
  }
  for (const k of Object.keys(mins)) mins[k] = Number(mins[k].toFixed(1));
  return mins;
}

/**
 * Segment the ride into intervals by zone occupancy. This is the one piece of
 * genuine inference in the parser, and it feeds classify.js's structured /
 * fragmented judgement, so it is deliberately conservative: smooth hard, merge
 * anything short into whichever neighbour it resembles, and never invent a
 * label for a segment that is too brief to be an interval.
 */
export function detectIntervals(power, ftp, opts = {}) {
  const cfg = { ...INGEST, ...opts };
  if (!power.length) return [];

  const smooth = centredSmooth(power, cfg.segmentSmoothSecs);
  const zoneOf = (p) => {
    const frac = p / ftp;
    return POWER_ZONE_ORDER.find((k) => frac <= POWER_ZONES[k]) || 'Z6_Anaerobic';
  };

  // Collapse Z5/Z6 noise into the block they sit inside; the engine only cares
  // about work-vs-recovery structure at interval scale.
  let segs = [];
  let cur = null;
  for (let i = 0; i < smooth.length; i++) {
    const z = zoneOf(smooth[i]);
    if (cur && cur.type === z) { cur.end = i; continue; }
    if (cur) segs.push(cur);
    cur = { type: z, start: i, end: i };
  }
  if (cur) segs.push(cur);

  // Merge short segments into the adjacent one with the closer mean power,
  // then re-derive each segment's label from what it now actually contains and
  // coalesce neighbours that ended up the same. Without the relabel step a
  // recovery valley that swallowed a sprint keeps calling itself recovery.
  const meanOf = (s) => mean(power.slice(s.start, s.end + 1));
  for (let pass = 0; pass < 20; pass++) {
    let merged = false;
    while (segs.length > 1) {
      let shortest = -1;
      let shortestLen = Infinity;
      for (let i = 0; i < segs.length; i++) {
        const len = segs[i].end - segs[i].start + 1;
        if (len < cfg.minSegmentSecs && len < shortestLen) { shortest = i; shortestLen = len; }
      }
      if (shortest === -1) break;
      const left = segs[shortest - 1];
      const right = segs[shortest + 1];
      const m = meanOf(segs[shortest]);
      const target =
        !left ? right
          : !right ? left
          : Math.abs(meanOf(left) - m) <= Math.abs(meanOf(right) - m) ? left : right;
      target.start = Math.min(target.start, segs[shortest].start);
      target.end = Math.max(target.end, segs[shortest].end);
      segs.splice(shortest, 1);
      merged = true;
    }

    for (const s of segs) s.type = zoneOf(meanOf(s));

    const coalesced = [];
    for (const s of segs) {
      const last = coalesced[coalesced.length - 1];
      if (last && last.type === s.type) { last.end = s.end; merged = true; continue; }
      coalesced.push(s);
    }
    segs = coalesced;
    if (!merged) break;
  }

  const out = segs.map((s) => ({
    type: s.type,
    durationSecs: s.end - s.start + 1,
    averagePower: Math.round(meanOf(s)),
    startSecs: s.start,
  }));

  // The opening low-intensity block is a warm-up, not a recovery interval.
  if (out.length && out[0].startSecs === 0 &&
      (out[0].type === 'Z1_Recovery' || out[0].type === 'Z2_Endurance')) {
    out[0].type = 'Warm Up';
  }
  return out;
}

function centredSmooth(arr, win) {
  const half = Math.floor(win / 2);
  const p = prefix(arr);
  return arr.map((_, i) => {
    const a = Math.max(0, i - half);
    const b = Math.min(arr.length, i + half + 1);
    return (p[b] - p[a]) / (b - a);
  });
}

/**
 * Find sustained efforts and measure whether heart rate stayed coupled to
 * power through each one. This is the evidence that lets the app propose a
 * threshold without the athlete ever doing a formal test.
 *
 * The physiology: below threshold, oxygen demand is met and HR settles into a
 * steady state, so efficiency (power per beat) holds across the effort. Above
 * threshold, the steady state does not exist — HR climbs while power does not,
 * and efficiency falls away. So an effort held for 20+ minutes with flat
 * coupling is evidence that threshold is AT LEAST that power, and one that
 * decoupled badly is evidence it is BELOW that power.
 *
 * Deliberately FTP-free: efforts are found relative to the rider's own best
 * 20-minute power within this ride, not against any configured zone. That is
 * what lets this run on the very first file, before a profile exists.
 */
export function analyseEfforts(power, hr, opts = {}) {
  const cfg = { ...INGEST, ...opts };
  const minSecs = cfg.minEffortSecs ?? 300;
  if (power.length < minSecs) return [];

  // Anchor: the rider's own best sustained power in this ride. An effort is a
  // stretch held near that level or above.
  const window = Math.min(1200, Math.floor(power.length / 2));
  const anchor = bestMean(power, window);
  if (!anchor) return [];
  const floor = anchor * (cfg.effortFloorFraction ?? 0.88);

  const smooth = centredSmooth(power, cfg.segmentSmoothSecs);
  const efforts = [];
  let start = null;
  // Brief dips below the floor (a junction, a corner) should not end an
  // effort; only a sustained drop should.
  let dip = 0;
  const maxDip = cfg.effortMaxDipSecs ?? 20;

  for (let i = 0; i <= smooth.length; i++) {
    const above = i < smooth.length && smooth[i] >= floor;
    if (above) {
      if (start == null) start = i;
      dip = 0;
    } else if (start != null) {
      dip++;
      if (dip > maxDip || i === smooth.length) {
        const end = i - dip;
        if (end - start + 1 >= minSecs) efforts.push(describeEffort(power, hr, start, end));
        start = null;
        dip = 0;
      }
    }
  }
  return efforts.filter(Boolean);
}

function describeEffort(power, hr, start, end) {
  const p = power.slice(start, end + 1);
  const h = hr.slice(start, end + 1);
  const half = Math.floor(p.length / 2);

  const ef = (pp, hh) => {
    const beats = hh.filter((x) => x != null && x > 0);
    if (beats.length < pp.length * 0.8) return null;
    const mp = mean(pp);
    const mh = mean(beats);
    return mp && mh ? mp / mh : null;
  };

  const first = ef(p.slice(0, half), h.slice(0, half));
  const second = ef(p.slice(half), h.slice(half));
  const hrVals = h.filter((x) => x != null && x > 0);

  // Power must be genuinely steady for the coupling reading to mean anything.
  // A ragged effort can hold its average while swinging either side of
  // threshold, and the drift then reflects the swings, not the intensity.
  const mp = mean(p);
  const sd = Math.sqrt(mean(p.map((x) => (x - mp) ** 2)));

  return {
    startSecs: start,
    durationSecs: end - start + 1,
    averagePower: Math.round(mp),
    powerCv: Number((sd / (mp || 1)).toFixed(3)),
    averageHr: hrVals.length ? Math.round(mean(hrVals)) : null,
    peakHr: hrVals.length ? Math.max(...hrVals) : null,
    // Positive = efficiency fell across the effort = HR climbed away from power.
    couplingDriftPct:
      first && second ? Number((((first - second) / first) * 100).toFixed(1)) : null,
    // HR rise from the first minute of the effort to the last.
    hrRiseBpm:
      hrVals.length > 120
        ? Math.round(mean(h.slice(-60).filter(Boolean)) - mean(h.slice(0, 60).filter(Boolean)))
        : null,
  };
}

function bestMean(arr, win) {
  if (arr.length < win) return null;
  const p = prefix(arr);
  let best = 0;
  for (let i = 0; i + win <= arr.length; i++) {
    const m = (p[i + win] - p[i]) / win;
    if (m > best) best = m;
  }
  return best;
}

/**
 * Efficiency factor per power zone: watts produced per heartbeat while riding
 * in that zone. This is the maintenance signal — the thing that lets a
 * threshold stand without being re-tested every few weeks.
 *
 * The logic: if FTP is still correct and fitness is unchanged, then the watts
 * you produce per beat at a given zone should be stable over time. It does not
 * matter that no single ride proves anything; the point is the trend across
 * many ordinary rides.
 *
 * Two corrections matter and both are applied:
 *   - The opening minutes are dropped. HR lags power at the start of a ride by
 *     several minutes, so early samples read as artificially efficient.
 *   - Only zones with real time in them are reported. A stray thirty seconds
 *     in Z5 produces a number that looks like data and is noise.
 */
export function efficiencyByZone(power, hr, ftp, opts = {}) {
  const cfg = { ...INGEST, ...opts };
  const skip = cfg.efWarmupSkipSecs ?? 600;
  const minSecs = cfg.efMinZoneSecs ?? 300;

  const buckets = {};
  for (let i = skip; i < power.length; i++) {
    const h = hr[i];
    if (h == null || h <= 0) continue;
    const p = power[i];
    if (p <= 0) continue;
    const zone = POWER_ZONE_ORDER.find((k) => p / ftp <= POWER_ZONES[k]) || 'Z6_Anaerobic';
    (buckets[zone] ||= { p: 0, h: 0, n: 0 });
    buckets[zone].p += p;
    buckets[zone].h += h;
    buckets[zone].n += 1;
  }

  const out = {};
  for (const [zone, b] of Object.entries(buckets)) {
    if (b.n < minSecs) continue;
    out[zone] = {
      secs: b.n,
      meanPower: Math.round(b.p / b.n),
      meanHr: Math.round(b.h / b.n),
      ef: Number((b.p / b.h).toFixed(3)),
    };
  }
  return out;
}

/**
 * The whole job: samples -> the exact object buildVerdict() expects.
 */
export function buildRide(samples, athleteInput = {}, opts = {}) {
  const cfg = { ...INGEST, ...opts };
  const athlete = { ...DEFAULT_ATHLETE, ...athleteInput };
  const cp = athlete.cp ?? athlete.ftp;

  const { grid, gaps, startTs } = resampleTo1Hz(samples, cfg);
  if (!grid.length) {
    return { ok: false, reason: 'no usable records in file' };
  }

  const moving = grid.filter((s) => isMoving(s, cfg));
  const power = moving.map((s) => Math.max(0, Math.round(s.power ?? 0)));
  const hr = moving.map((s) => (s.hr != null && s.hr > 0 ? Math.round(s.hr) : null));

  const hasPower = power.some((p) => p > 0);
  const durationMin = Number((power.length / 60).toFixed(1));
  const np = hasPower ? normalisedPower(power, cfg.npWindowSecs) : null;
  const intensity = np && athlete.ftp ? Number((np / athlete.ftp).toFixed(2)) : null;
  const tss =
    np && intensity
      ? Math.round((power.length * np * intensity) / (athlete.ftp * 3600) * 100)
      : null;

  // Max HR sustained for half a minute. A single-sample spike is far more
  // often a strap dropout or a cross-talk artifact than a physiological max,
  // and max HR is the one profile field where a bad reading is sticky.
  const hrRoll = rollingMean(hr.map((h) => h ?? 0), 30);
  const maxHrSustained30s = Math.round(Math.max(0, ...hrRoll.filter((x) => x != null))) || null;

  const redzoneHr = athlete.maxHr * cfg.redzoneHrPctOfMax;
  const hrRedzoneSecs = hr.filter((h) => h != null && h >= redzoneHr).length;

  const ride = {
    date: new Date(startTs * 1000).toISOString(),
    durationMin,
    elapsedMin: Number(((grid[grid.length - 1].ts - startTs) / 60).toFixed(1)),
    np,
    tss,
    if: intensity,
    decouplingPct: hasPower ? decoupling(power, hr) : null,
    wPrimeKj: hasPower ? wPrimeSpentKj(power, cp) : null,
    hrRedzoneSecs,
    maxHrSustained30s,
    peakPowers: hasPower ? peakPowers(power, hr) : {},
    zoneMinutes: hasPower ? powerZoneMinutes(power, athlete.ftp) : {},
    hrZoneMinutes: hrZoneMinutes(hr, athlete.hrZones),
    intervals: hasPower ? detectIntervals(power, athlete.ftp, cfg).map(({ startSecs, ...i }) => i) : [],
    // FTP-free, so it is valid even on a first upload with no profile yet.
    sustainedEfforts: hasPower ? analyseEfforts(power, hr, cfg) : [],
    // Watts per heartbeat by zone. Feeds the standing check that keeps a
    // threshold valid without re-testing it.
    efficiencyByZone: hasPower && athlete.ftp ? efficiencyByZone(power, hr, athlete.ftp, cfg) : {},
  };

  // Everything the engine should know about how trustworthy this ride is.
  const quality = {
    hasPower,
    hasHr: hr.some((h) => h != null),
    gaps: gaps.length,
    gapSecs: gaps.reduce((s, g) => s + g.secs, 0),
    filledPct: Number(((grid.filter((s) => s.filled).length / grid.length) * 100).toFixed(1)),
    stoppedMin: Number(((grid.length - moving.length) / 60).toFixed(1)),
    warnings: [],
  };
  if (!quality.hasPower) quality.warnings.push('no power data — the engine cannot classify this ride');
  if (!quality.hasHr) quality.warnings.push('no heart rate — decoupling and FTP estimation are disabled');
  if (quality.filledPct > 10) quality.warnings.push(`${quality.filledPct}% of samples were interpolated across dropouts`);
  if (quality.gapSecs > 300) quality.warnings.push(`${Math.round(quality.gapSecs / 60)} min of the timeline was cut out as stopped`);

  return { ok: true, ride, quality };
}
