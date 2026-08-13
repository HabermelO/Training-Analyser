import { FTP_MODEL, DEFAULT_ATHLETE } from './thresholds.js';
import { estimateFtp } from './ftp.js';

// Works out who the athlete is from what they have ridden, rather than asking
// them to know their own numbers. Two things make this possible:
//
//   1. Peak powers, heart rate and duration are FTP-free. They can be computed
//      from a file before anything is known about the rider, which is what
//      breaks the circularity — you cannot compute zone time without an FTP,
//      but you can compute the evidence that produces one.
//   2. A wrong FTP does not fail loudly. Zone minutes, TSS, IF and W' all stay
//      plausible-looking while being wrong, so a guess is worse than a refusal.
//      Everything here carries a method and a confidence, and 'unknown' is a
//      supported state the app has to render.
//
// Nothing in this file decides that an estimate is good enough to use. That is
// a product judgement — see `usable()` at the bottom and argue with it.

const DURATION_SECS = {
  '1s': 1, '2s': 2, '5s': 5, '10s': 10, '30s': 30,
  '1m': 60, '2m': 120, '5m': 300, '10m': 600, '20m': 1200, '60m': 3600,
};

const watts = (e) => (typeof e === 'number' ? e : e?.power ?? null);
const bpm = (e) => (typeof e === 'number' ? null : e?.hr ?? null);

/**
 * Highest heart rate the athlete has actually been observed to reach.
 *
 * This is a FLOOR, never a true max — it can only rise. That distinction is
 * not pedantry: max HR sets the red-zone threshold and gates which efforts
 * ftp.js will treat as maximal, so an over-estimate quietly suppresses real
 * efforts and an under-estimate inflates cardiac-strain flags.
 *
 * Age-predicted formulas (220-age and friends) carry a standard deviation of
 * 10-12 bpm, which is wider than the entire Z4 band for most riders. They are
 * offered only as a last-resort prior and are labelled as such.
 */
export function estimateMaxHr(rides, opts = {}) {
  let observed = 0;
  let observedDate = null;
  let hardEfforts = 0;

  for (const r of rides || []) {
    for (const [dur, entry] of Object.entries(r.peakPowers || {})) {
      const hr = bpm(entry);
      if (hr == null) continue;
      if (hr > observed) { observed = hr; observedDate = r.date; }
      // A 3-20 min effort is long enough that HR has time to approach max.
      const secs = DURATION_SECS[dur];
      if (secs >= 180 && secs <= 1200) hardEfforts++;
    }
    // A directly recorded ride max beats any peak-window average.
    if (r.maxHr != null && r.maxHr > observed) { observed = r.maxHr; observedDate = r.date; }
  }

  if (opts.declared) {
    return { value: opts.declared, confidence: 'declared', method: 'athlete_supplied',
             observedMax: observed || null, caveats: [] };
  }

  if (!observed) {
    if (opts.age) {
      return {
        value: Math.round(211 - 0.64 * opts.age),
        confidence: 'low', method: 'age_predicted',
        observedMax: null,
        caveats: ['age-predicted max HR is accurate to roughly ±11 bpm; treat every HR-derived judgement as provisional until a hard effort is recorded'],
      };
    }
    return { value: null, confidence: 'unknown', method: 'none', observedMax: null,
             caveats: ['no heart rate recorded yet'] };
  }

  // Riders very rarely touch true max in training. Observed max on sustained
  // hard efforts typically sits a few bpm under it, so the floor is treated as
  // a floor and the caveat says so rather than the number being inflated.
  const confidence = hardEfforts >= 6 ? 'moderate' : hardEfforts >= 2 ? 'low' : 'insufficient';
  const caveats = [
    `highest HR seen so far is ${observed} bpm — a floor, not a true maximum`,
  ];
  if (confidence !== 'moderate') {
    caveats.push('few sustained hard efforts recorded, so this is likely an under-estimate');
  }

  return { value: observed, confidence, method: 'observed_floor',
           observedMax: observed, observedOn: observedDate, caveats };
}

/**
 * FTP, by whichever method the available data actually supports. Ordered best
 * to worst; the first one that qualifies wins, and the method is reported so
 * the UI can say how the number was arrived at.
 */
export function estimateAthleteFtp(rides, opts = {}) {
  const maxHr = opts.maxHr;
  const caveats = [];

  // 0. Declared beats modelled. Someone who has done a ramp test in a lab
  //    knows more than we can infer, and a file that carries threshold_power
  //    is reporting a value the athlete already configured somewhere.
  if (opts.declared) {
    return { value: opts.declared, confidence: 'declared', method: 'athlete_supplied', caveats: [] };
  }
  const fromFile = fileDeclaredFtp(rides);
  if (fromFile && !opts.ignoreFileFtp) {
    return {
      value: fromFile.value, confidence: 'declared', method: 'recorded_in_file',
      caveats: [`taken from the ${fromFile.count === 1 ? 'ride file' : 'most recent ride file'}; it reflects whatever was configured on the head unit, not a measurement`],
    };
  }

  // 1. The critical-power model, when the curve is genuinely covered.
  //
  // Gated on efforts coming from DIFFERENT rides. Within one ride the peak
  // 5/10/20-minute windows overlap each other and share the same fatigue
  // state, so the regression fits the shape of a single effort rather than the
  // shape of the athlete. Tested against a real 66-minute mixed ride this
  // under-read a declared 292W as 223W at 'moderate' confidence — confidently,
  // by 24%, in the direction that makes every future session too easy.
  const rideDates = new Set((rides || []).map((r) => String(r.date).slice(0, 10)));
  if (maxHr && rideDates.size >= 2) {
    const cp = estimateFtp(rides, { maxHr, ftp: null });
    if (cp.value) {
      return {
        value: cp.value, confidence: cp.confidence, method: 'critical_power_2p',
        wPrimeKj: cp.wPrimeKj, r2: cp.r2, effortsUsed: cp.effortsUsed,
        caveats: cp.caveats || [],
      };
    }
    caveats.push(...(cp.caveats || []));
  } else if (maxHr) {
    caveats.push('all best efforts come from a single ride, which cannot anchor a power-duration curve');
  } else {
    caveats.push('max HR unknown, so efforts cannot be screened for whether they were maximal');
  }

  // 2. Single-effort proxies. Weaker, because nothing verifies the effort was
  //    maximal, but far better than a default. Longer efforts are preferred:
  //    the 0.95 factor on a 20-minute effort is a population average that
  //    individuals miss by up to 8%, whereas 60-minute power IS the definition.
  const best = bestEfforts(rides);
  const p60 = best['60m'];
  if (p60 && looksHard(p60, maxHr, 0.85)) {
    return {
      value: Math.round(p60.power), confidence: 'moderate', method: 'sixty_minute_power',
      caveats: [...caveats, 'taken directly from a 60-minute effort; if that hour was not close to maximal this under-reads'],
    };
  }
  const p20 = best['20m'];
  if (p20 && looksHard(p20, maxHr, 0.88)) {
    return {
      value: Math.round(p20.power * 0.95), confidence: 'low', method: 'twenty_minute_x095',
      caveats: [...caveats, 'the 0.95 factor on 20-minute power is a population average; individuals deviate by up to 8% either way'],
    };
  }

  // 3. Nothing defensible.
  return {
    value: null, confidence: 'unknown', method: 'none',
    caveats: [...caveats, 'no effort long or hard enough to anchor a threshold yet'],
    recommendation:
      'Ride one genuine maximal effort of 8-12 minutes and another of 20 minutes or more. They do not have to be on the same day.',
  };
}

function looksHard(effort, maxHr, pct) {
  if (effort.hr == null) return false;      // unverifiable, so not trusted
  if (!maxHr) return false;
  return effort.hr >= maxHr * pct;
}

function bestEfforts(rides) {
  const best = {};
  for (const r of rides || []) {
    for (const [dur, entry] of Object.entries(r.peakPowers || {})) {
      const power = watts(entry);
      if (power == null) continue;
      if (!best[dur] || power > best[dur].power) {
        best[dur] = { power, hr: bpm(entry), date: r.date };
      }
    }
  }
  return best;
}

function fileDeclaredFtp(rides) {
  const withFtp = (rides || []).filter((r) => r.declaredFtp > 0);
  if (!withFtp.length) return null;
  const latest = withFtp.reduce((a, b) => (new Date(a.date) > new Date(b.date) ? a : b));
  return { value: latest.declaredFtp, count: withFtp.length };
}

/**
 * HR zones as fractions of max. Only meaningful once max HR is credible, so
 * this returns null rather than fabricating bands off a floor that is still
 * climbing. Percentages are the standard Coggan-style LTHR-independent split.
 */
export function deriveHrZones(maxHr) {
  if (!maxHr) return null;
  const at = (pct) => Math.round(maxHr * pct);
  return { z1: at(0.68), z2: at(0.83), z3: at(0.90), z4: at(0.96), z5: 999 };
}

// Which FTP methods count as DIRECTLY DEMONSTRATED. standing.js measures
// upward drift against the last such value, so an inference must never
// qualify — otherwise the drift cap rebases itself and the threshold can walk
// upward indefinitely. 20-minute x 0.95 is excluded on purpose: the 0.95 is a
// population average, not this rider's measurement.
const CONFIRMING_METHODS = new Set([
  'athlete_supplied',
  'recorded_in_file',
  'critical_power_2p',
  'sixty_minute_power',
  'athlete_accepted',
]);

export const isConfirmingMethod = (method) => CONFIRMING_METHODS.has(method);

/**
 * The one call the app makes. Give it every ride it has; it returns the
 * profile to use, what is still missing, and how much to trust it.
 */
export function deriveAthlete(rides, overrides = {}) {
  const list = rides || [];

  const maxHr = estimateMaxHr(list, { declared: overrides.maxHr, age: overrides.age });
  const ftp = estimateAthleteFtp(list, {
    maxHr: maxHr.value,
    declared: overrides.ftp,
    ignoreFileFtp: overrides.ignoreFileFtp,
  });

  const hrZones = overrides.hrZones || deriveHrZones(maxHr.value);

  const spanDays = list.length
    ? (Math.max(...list.map((r) => new Date(r.date))) -
       Math.min(...list.map((r) => new Date(r.date)))) / 86400000
    : 0;

  const missing = [];
  if (!ftp.value) missing.push('ftp');
  if (!maxHr.value) missing.push('maxHr');
  if (list.length < FTP_MODEL.minEffortsForCp) missing.push('rides');

  return {
    ftp: ftp.value,
    maxHr: maxHr.value,
    hrZones,
    // The anchor for drift. Null when nothing has been demonstrated yet, which
    // standing.js reads as "no cap applies until something is".
    confirmedFtp: ftp.value && isConfirmingMethod(ftp.method) ? ftp.value : (overrides.confirmedFtp ?? null),
    ftpSetAt: overrides.ftpSetAt ?? null,
    lastBumpAt: overrides.lastBumpAt ?? null,
    goals: overrides.goals || DEFAULT_ATHLETE.goals,
    // Provenance travels with the profile so nothing downstream has to guess.
    derivation: {
      ftp, maxHr,
      hrZonesFrom: overrides.hrZones ? 'athlete_supplied' : maxHr.value ? 'pct_of_max_hr' : 'none',
      ridesUsed: list.length,
      spanDays: Math.round(spanDays),
    },
    missing,
    status: status(ftp, maxHr, list.length, spanDays),
  };
}

function status(ftp, maxHr, rideCount, spanDays) {
  if (!ftp.value) return 'calibrating';
  if (ftp.confidence === 'declared') return 'declared';
  if (ftp.confidence === 'good' && maxHr.confidence === 'moderate') return 'established';
  if (rideCount < 5 || spanDays < FTP_MODEL.minDaysOfHistory) return 'provisional';
  return 'estimated';
}

/**
 * Whether the derived profile is solid enough to hang athlete-facing
 * judgements on. Deliberately separate from deriveAthlete(): this is a product
 * decision about how wrong is too wrong, not a physiological one.
 *
 * 'calibrating' means the app should still show the FTP-free half of the
 * analysis — duration, normalised power, peak powers, heart rate, decoupling —
 * and say plainly that zones, TSS and session classification are waiting on a
 * hard effort. Showing those computed against a guess is the failure mode this
 * whole file exists to prevent.
 */
export function usable(profile) {
  return profile.status !== 'calibrating';
}

/**
 * What to tell the athlete, in plain words, about where their profile stands.
 */
export function explainProfile(profile) {
  const d = profile.derivation;
  const lines = [];

  if (!profile.ftp) {
    lines.push(
      `Still working out your threshold from ${d.ridesUsed} ride${d.ridesUsed === 1 ? '' : 's'}. ` +
      (d.ftp.recommendation || '')
    );
  } else {
    const how = {
      athlete_supplied: 'from the figure you entered',
      recorded_in_file: 'from the figure recorded in your ride files',
      critical_power_2p: `modelled from ${d.ftp.effortsUsed} maximal efforts across your power curve`,
      sixty_minute_power: 'taken from your best hour of riding',
      twenty_minute_x095: 'estimated from your best 20-minute effort',
    }[d.ftp.method] || 'estimated';
    lines.push(`Threshold ${profile.ftp}W, ${how} (${d.ftp.confidence} confidence).`);
  }

  if (profile.maxHr) {
    lines.push(
      d.maxHr.method === 'observed_floor'
        ? `Max heart rate taken as ${profile.maxHr} bpm, the highest you have recorded so far. It will rise if you go deeper.`
        : `Max heart rate ${profile.maxHr} bpm (${d.maxHr.method.replace(/_/g, ' ')}).`
    );
  } else {
    lines.push('No heart rate recorded yet, so cardiac strain and effort screening are unavailable.');
  }

  for (const c of [...(d.ftp.caveats || []), ...(d.maxHr.caveats || [])]) lines.push(c);
  return lines;
}
