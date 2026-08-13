import { classifySession, matchIntent } from './classify.js';
import { evaluateExecution, keyEvidence, overallVerdict } from './execution.js';
import { computeReadiness } from './readiness.js';
import { computeLoad, computePhenotype, aggregateBestPowers } from './load.js';
import { estimateFtp } from './ftp.js';
import { planWeek } from './planner.js';
import { DEFAULT_ATHLETE } from './thresholds.js';

/**
 * The one function the app calls. Everything downstream — the local model, the
 * API model, the plain-text fallback renderer — consumes this object and only
 * this object.
 *
 * @param {object} input
 *   ride:     current ride metrics
 *   history:  previous rides (summaries are enough)
 *   daily:    daily wellness entries
 *   athlete:  profile
 *   prescribed: what was planned for today, if anything
 */
export function buildVerdict(input) {
  // A profile must be supplied. Spreading DEFAULT_ATHLETE over a missing FTP
  // was the old behaviour and it was the worst possible failure: zone times,
  // TSS and every verdict downstream come out looking entirely plausible while
  // being computed against someone else's threshold. Refusing is the honest
  // answer, and calibratingVerdict() still returns everything that does not
  // depend on a threshold.
  if (!input.athlete?.ftp) {
    return calibratingVerdict(input);
  }
  const athlete = { ...DEFAULT_ATHLETE, ...(input.athlete || {}) };
  const ride = { ...input.ride, ftp: athlete.ftp };
  const history = input.history || [];

  const classification = classifySession(ride);
  const intent = matchIntent(classification, input.prescribed);
  const execution = evaluateExecution(ride, classification);
  const evidence = keyEvidence(ride, classification, execution);
  const verdict = overallVerdict(classification, execution, intent);

  const readiness = computeReadiness(input.daily || []);
  const allRides = [...history, ride].filter((r) => r.date);
  const asOf = new Date(ride.date);
  const load = computeLoad(allRides, asOf);
  const bestPowers = aggregateBestPowers(allRides.slice(-90));
  const phenotype = computePhenotype(bestPowers);
  const ftp = estimateFtp(allRides.slice(-90), athlete);

  const plan = planWeek({
    rides: allRides,
    readiness,
    phenotype,
    load,
    asOf,
    longRideDay: input.longRideDay,
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ride: {
      date: ride.date,
      durationMin: Math.round(ride.durationMin),
      np: ride.np,
      tss: ride.tss,
      if: ride.if,
    },
    sessionType: classification.type,
    classificationConfidence: classification.confidence,
    classificationReasons: classification.reasons,
    intentMatch: intent,
    executionFlags: execution.flags,
    keyEvidence: evidence,
    verdict,
    adaptation: adaptationFor(classification.type),
    readiness,
    load: {
      ctl: load.ctl, atl: load.atl, tsb: load.tsb,
      state: load.state, last7dTss: load.last7dTss,
      rampPct: load.rampPct, rampWarning: load.rampWarning,
    },
    phenotype,
    ftpEstimate: ftp,
    plan,
  };
}

/**
 * What the app can still say about a ride when no threshold is known yet.
 * Everything here is FTP-free: duration, normalised power, peak powers, heart
 * rate and how much of the file was usable.
 */
export function calibratingVerdict(input) {
  const ride = input.ride || {};
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'calibrating',
    ride: {
      date: ride.date,
      durationMin: Math.round(ride.durationMin || 0),
      np: ride.np ?? null,
    },
    sessionType: 'unclassified',
    classificationConfidence: 'insufficient',
    classificationReasons: ['no threshold set, so intensity cannot be judged'],
    intentMatch: 'no_plan',
    executionFlags: [],
    keyEvidence: [
      { label: 'Duration', value: `${Math.round(ride.durationMin || 0)} min` },
      ...(ride.np ? [{ label: 'NP', value: `${ride.np}W` }] : []),
      ...(ride.peakPowers?.['20m']?.power
        ? [{ label: 'Best 20 min', value: `${ride.peakPowers['20m'].power}W` }]
        : []),
    ],
    verdict: 'awaiting_threshold',
    adaptation: 'unknown',
    readiness: computeReadiness(input.daily || []),
    load: { ctl: null, atl: null, tsb: null, state: 'unknown', last7dTss: null },
    phenotype: { label: 'unknown', confidence: 'insufficient', ratios: {} },
    ftpEstimate: { value: null, confidence: 'insufficient', basis: 'no_profile' },
    plan: null,
    missing: ['ftp'],
    message:
      'Ride recorded. Power zones, training load and session analysis will appear once your threshold is set — ' +
      'either enter it, or ride a sustained effort of 15 minutes or more and the app will propose one.',
  };
}

function adaptationFor(sessionType) {
  const map = {
    vo2max: 'vo2max',
    threshold_steady: 'threshold_tte',
    threshold_over_under: 'lactate_clearance',
    tempo_sweetspot: 'sweetspot',
    endurance: 'aerobic_base',
    active_recovery: 'recovery',
    unstructured_ride: 'mixed',
  };
  return map[sessionType] || 'mixed';
}
