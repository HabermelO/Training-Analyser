import { FTP_MODEL } from './thresholds.js';

// FTP from a 2-parameter critical power model: P(t) = CP + W'/t
// Fitted by linear regression of work (P*t) against time, where the slope is
// CP and the intercept is W'. Deliberately ignores IF, TSS and current FTP.
//
// The important behaviour here is refusal: if the efforts feeding the model
// were not maximal, or do not span enough of the curve, we say so rather than
// producing a number that looks authoritative.

const DURATION_SECS = {
  '1s': 1, '2s': 2, '5s': 5, '10s': 10, '30s': 30,
  '1m': 60, '2m': 120, '5m': 300, '10m': 600, '20m': 1200, '60m': 3600,
};

function linearFit(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce(
    (s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0
  );
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

/**
 * @param {Array} rides - each with peakPowers {dur: {power, hr}} and date
 * @param {object} athlete - { maxHr, ftp }
 */
export function estimateFtp(rides, athlete) {
  if (!rides.length) {
    return { value: null, confidence: 'insufficient', basis: 'no rides' };
  }

  const dates = rides.map((r) => new Date(r.date)).sort((a, b) => a - b);
  const spanDays = (dates[dates.length - 1] - dates[0]) / 86400000;

  // Best effort at each duration, keeping the HR it was set at.
  const best = {};
  for (const r of rides) {
    for (const [dur, entry] of Object.entries(r.peakPowers || {})) {
      const secs = DURATION_SECS[dur];
      if (!secs || secs < FTP_MODEL.cpWindow[0] || secs > FTP_MODEL.cpWindow[1]) continue;
      const power = typeof entry === 'number' ? entry : entry?.power;
      const hr = typeof entry === 'number' ? null : entry?.hr;
      if (power == null) continue;
      if (!best[dur] || power > best[dur].power) best[dur] = { power, hr, secs, date: r.date };
    }
  }

  const candidates = Object.values(best);
  const hrCeiling = athlete.maxHr * FTP_MODEL.maximalEffortHrPct;
  const maximal = candidates.filter((c) => c.hr != null && c.hr >= hrCeiling);
  const rejected = candidates.length - maximal.length;

  const caveats = [];
  if (spanDays < FTP_MODEL.minDaysOfHistory) {
    caveats.push(`only ${Math.round(spanDays)} days of history`);
  }
  if (rejected > 0) {
    caveats.push(
      `${rejected} of ${candidates.length} best efforts were set below ${Math.round(hrCeiling)} bpm and were not treated as maximal`
    );
  }

  if (maximal.length < FTP_MODEL.minEffortsForCp) {
    return {
      value: null,
      confidence: 'insufficient',
      basis: 'critical_power_2p',
      caveats: [
        ...caveats,
        `need ${FTP_MODEL.minEffortsForCp} maximal efforts across the 3-40 min range, have ${maximal.length}`,
      ],
      recommendation:
        'Ride a genuine maximal effort of 8-12 min and another of 20+ min to anchor the curve.',
    };
  }

  // Work-time form: W = CP*t + W'
  const fit = linearFit(maximal.map((c) => ({ x: c.secs, y: c.power * c.secs })));
  if (!fit || fit.slope <= 0) {
    return { value: null, confidence: 'insufficient', basis: 'critical_power_2p', caveats };
  }

  const cp = Math.round(fit.slope);
  const wPrimeKj = Number((fit.intercept / 1000).toFixed(1));

  let confidence = 'low';
  if (fit.r2 > 0.99 && maximal.length >= 4 && spanDays >= FTP_MODEL.minDaysOfHistory) {
    confidence = 'good';
  } else if (fit.r2 > 0.97 && maximal.length >= 3) {
    confidence = 'moderate';
  }
  if (wPrimeKj < 5 || wPrimeKj > 40) {
    caveats.push(`fitted W' of ${wPrimeKj} kJ is physiologically implausible — treat CP with suspicion`);
    confidence = 'low';
  }

  return {
    value: cp,
    wPrimeKj,
    r2: Number(fit.r2.toFixed(4)),
    effortsUsed: maximal.length,
    confidence,
    basis: 'critical_power_2p',
    changeFromCurrent: athlete.ftp ? cp - athlete.ftp : null,
    caveats,
  };
}
