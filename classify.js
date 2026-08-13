import { SESSION } from './thresholds.js';

// Turn a ride's zone distribution and detected intervals into a session type.
// Outdoors this is genuinely hard, so every result carries a confidence and we
// fall back to 'unstructured_ride' rather than forcing a label we don't believe.

const WORK_TYPES = new Set(['Z3_Tempo', 'Z4_Threshold', 'Z5_VO2Max', 'Z6_Anaerobic']);

function coefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * @param {object} ride - { durationMin, if, zoneMinutes, hrZoneMinutes,
 *                          intervals: [{type, durationSecs, averagePower}],
 *                          wPrimeKj }
 */
export function classifySession(ride) {
  const z = ride.zoneMinutes || {};
  const z3 = z.Z3_Tempo || 0;
  const z4 = z.Z4_Threshold || 0;
  const z5 = z.Z5_VO2Max || 0;
  const z6 = z.Z6_Anaerobic || 0;

  const intervals = ride.intervals || [];
  const work = intervals.filter(
    (i) => WORK_TYPES.has(i.type) && i.durationSecs >= 60
  );
  const workDurations = work.map((i) => i.durationSecs);
  const cv = coefficientOfVariation(workDurations);
  const structured =
    work.length >= SESSION.minWorkIntervals && cv <= SESSION.fragmentedCv;
  const fragmented =
    work.length >= SESSION.minWorkIntervals && cv > SESSION.fragmentedCv;

  const reasons = [];
  let type = null;
  let confidence = 'low';

  if (
    ride.if <= SESSION.recoveryMaxIf &&
    (ride.wPrimeKj ?? 0) <= SESSION.recoveryMaxWprimeKj &&
    ride.durationMin <= SESSION.recoveryMaxDurationMin &&
    z4 + z5 + z6 < 2
  ) {
    type = 'active_recovery';
    confidence = 'good';
    reasons.push(`IF ${ride.if} with ${(ride.wPrimeKj ?? 0).toFixed(1)} kJ W' spent`);
  } else if (z5 + z6 >= SESSION.vo2MinZ5Min) {
    type = 'vo2max';
    confidence = structured ? 'good' : 'moderate';
    reasons.push(`${(z5 + z6).toFixed(1)} min above threshold power`);
  } else if (z4 >= SESSION.thresholdMinZ4Min) {
    // Over-unders alternate above and below FTP; a steady block does not.
    const alternating = work.length >= 4 && z3 >= z4 * 0.4;
    type = alternating ? 'threshold_over_under' : 'threshold_steady';
    confidence = structured ? 'good' : 'moderate';
    reasons.push(`${z4.toFixed(1)} min in Z4`);
    if (alternating) reasons.push(`paired with ${z3.toFixed(1)} min Z3`);
  } else if (z3 >= SESSION.tempoMinZ3Min) {
    type = 'tempo_sweetspot';
    confidence = 'moderate';
    reasons.push(`${z3.toFixed(1)} min in Z3 with limited Z4`);
  } else if (ride.durationMin >= SESSION.enduranceMinDurationMin) {
    type = 'endurance';
    confidence = 'good';
    reasons.push(`${Math.round(ride.durationMin)} min with intensity held low`);
  } else {
    type = 'unstructured_ride';
    confidence = 'low';
    reasons.push('no dominant intensity block detected');
  }

  return {
    type,
    confidence,
    structured,
    fragmented,
    workIntervalCount: work.length,
    workDurationCv: Number(cv.toFixed(2)),
    reasons,
  };
}

/**
 * Compare what was detected against what was prescribed, if anything was.
 * Returns 'no_plan' when there is nothing to compare against — we never
 * penalise an athlete for deviating from a plan that did not exist.
 */
export function matchIntent(classification, prescribed) {
  if (!prescribed || !prescribed.sessionType) return 'no_plan';
  if (prescribed.sessionType === classification.type) {
    return classification.fragmented ? 'partial' : 'match';
  }
  const family = (t) => t.split('_')[0];
  if (family(prescribed.sessionType) === family(classification.type)) {
    return 'partial';
  }
  return 'mismatch';
}
