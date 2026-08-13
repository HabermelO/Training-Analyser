// Profile revisions are OFFERED, never applied. The athlete declares what
// they know at the start; the app watches for sessions that carry real
// evidence and then proposes a change, with its reasoning shown, for a yes or
// a no.
//
// Why not just auto-update: FTP is not only a number, it is the denominator of
// every zone, every TSS and every verdict in the app. Silently moving it
// rewrites the athlete's history and their sense of whether they are
// improving. A number the athlete accepted is one they will trust; a number
// that drifted underneath them is one they will argue with.
//
// The evidence is HR-to-power coupling through sustained efforts, which is
// what makes this work without a formal test:
//
//   Below threshold, oxygen demand is met, HR reaches a steady state, and
//   power-per-beat holds flat across the effort.
//   Above threshold, no steady state exists — HR climbs while power does not,
//   and power-per-beat falls away.
//
// So a long effort that held its coupling says "threshold is AT LEAST this";
// one that came apart says "threshold is BELOW this". Neither is a
// measurement, and both are stated as bounds rather than values.

import { STANDING } from './standing.js';

export const EVIDENCE = {
  // A sustained effort that stayed coupled: threshold is at or above it.
  CLEAN_SUSTAINED: 'clean_sustained_effort',
  // A sustained effort that decoupled badly: threshold is below it.
  DECOUPLED_EFFORT: 'decoupled_effort',
  // Heart rate exceeded what we thought was possible.
  NEW_MAX_HR: 'new_max_hr',
  // Watts per heartbeat has moved and held, across many ordinary rides, with
  // no maximal effort anywhere in it.
  EF_TREND: 'ef_trend',
};

export const PROPOSAL_RULES = {
  // An effort must last this long before its coupling means anything. Shorter
  // than this and HR has not finished responding to the step change in load.
  minEffortSecs: 900,
  // A full 20-minute effort earns higher confidence. Set slightly under 1200
  // because a real effort ends when the road does, not on the round number.
  goodEffortSecs: 1140,
  // Power must be steady enough that the drift reflects intensity rather than
  // the effort swinging either side of threshold.
  maxPowerCv: 0.16,
  // Coupling drift below this counts as "held together".
  cleanDriftPct: 3.5,
  // Above this, the effort came apart.
  decoupledDriftPct: 8.0,
  // Don't bother the athlete over noise.
  minChangePct: 3,
  minChangeWatts: 5,
  // A new max HR must be sustained, not a single-sample spike.
  minMaxHrGainBpm: 2,
  // Physiologically implausible jumps are treated as strap artifacts.
  maxCredibleHrGainBpm: 15,
  // How long a rejected proposal stays rejected before similar evidence may
  // raise it again.
  rejectionCooldownDays: 60,

  // --- efficiency-derived proposals ----------------------------------
  // EF is a proxy, not a measurement, so only half the observed change is
  // carried into the threshold...
  efDampingFraction: 0.5,
  // ...and never more than this, in either direction.
  efMaxPct: 5,
  // Nothing may move the threshold twice inside three weeks. Without this a
  // slow drift compounds weekly into a number nobody ever rode.
  efMinDaysSinceChange: 21,
};

/**
 * Look at one ride and decide whether it justifies proposing a profile change.
 *
 * @param {object} ride     parsed ride, including sustainedEfforts
 * @param {object} profile  current athlete profile { ftp, maxHr }
 * @param {Array}  decisions past accept/reject records
 * @returns {Array} proposals, usually empty
 */
export function proposeFromRide(ride, profile, decisions = []) {
  const out = [];
  const rules = PROPOSAL_RULES;

  // --- max HR ---------------------------------------------------------
  const sustained = ride.maxHrSustained30s;
  if (sustained && (!profile.maxHr || sustained > profile.maxHr + rules.minMaxHrGainBpm)) {
    const gain = profile.maxHr ? sustained - profile.maxHr : null;
    const implausible = gain != null && gain > rules.maxCredibleHrGainBpm;
    out.push({
      id: `maxhr:${ride.date}:${sustained}`,
      field: 'maxHr',
      current: profile.maxHr ?? null,
      proposed: sustained,
      evidence: EVIDENCE.NEW_MAX_HR,
      confidence: implausible ? 'low' : 'good',
      // Held for 30 seconds, so not a dropout — but a big jump is still more
      // often a strap problem than a physiological revelation.
      rationale: profile.maxHr
        ? `You held ${sustained} bpm for half a minute on this ride, ${gain} bpm above the highest we had seen.`
        : `Highest heart rate held for half a minute on this ride was ${sustained} bpm.`,
      caution: implausible
        ? 'That is a large jump. Check the ride for heart-rate spikes or a loose strap before accepting.'
        : null,
      affects: 'red-zone time, and which efforts count as maximal when estimating threshold',
    });
  }

  // --- threshold ------------------------------------------------------
  const efforts = (ride.sustainedEfforts || []).filter(
    (e) =>
      e.durationSecs >= rules.minEffortSecs &&
      e.couplingDriftPct != null &&
      e.powerCv <= rules.maxPowerCv
  );

  for (const e of efforts) {
    const mins = Math.round(e.durationSecs / 60);

    if (e.couplingDriftPct <= rules.cleanDriftPct) {
      // Held together, so threshold is at least this. Only interesting if it
      // is above what we currently believe.
      // Must be ABOVE the current profile. A clean effort below threshold is
      // exactly what an endurance ride looks like and says nothing new — an
      // earlier version of this treated the comparison as symmetric and
      // proposed LOWERING a 285W profile to a comfortable 275W effort.
      if (!profile.ftp ||
          (e.averagePower > profile.ftp && exceeds(e.averagePower, profile.ftp, rules))) {
        out.push({
          id: `ftp-up:${ride.date}:${e.startSecs}`,
          field: 'ftp',
          direction: 'up',
          current: profile.ftp ?? null,
          proposed: e.averagePower,
          evidence: EVIDENCE.CLEAN_SUSTAINED,
          confidence: e.durationSecs >= rules.goodEffortSecs ? 'good' : 'moderate',
          rationale:
            `You held ${e.averagePower}W for ${mins} minutes with heart rate staying coupled to power ` +
            `(${e.couplingDriftPct}% drift). An effort that steady is at or below threshold, ` +
            `so your threshold is at least ${e.averagePower}W.`,
          caution:
            profile.ftp && e.averagePower > profile.ftp * 1.15
              ? 'That is a large jump for one session. Worth confirming with a second effort before it reshapes your zones.'
              : null,
          affects: 'all power zones, TSS, and how future sessions are classified',
          bound: 'lower',
        });
      }
    } else if (e.couplingDriftPct >= rules.decoupledDriftPct) {
      // Came apart, so threshold is below this. Only interesting if we
      // currently believe threshold is at or above the effort — i.e. the
      // profile says this should have been sustainable and it was not.
      if (profile.ftp && profile.ftp >= e.averagePower) {
        const suggested = Math.round(e.averagePower * 0.95);
        if (exceeds(profile.ftp, suggested, rules)) {
          out.push({
            id: `ftp-down:${ride.date}:${e.startSecs}`,
            field: 'ftp',
            direction: 'down',
            current: profile.ftp,
            proposed: suggested,
            evidence: EVIDENCE.DECOUPLED_EFFORT,
            confidence: 'low',
            rationale:
              `You rode ${e.averagePower}W for ${mins} minutes and heart rate climbed away from power ` +
              `(${e.couplingDriftPct}% drift${e.hrRiseBpm != null ? `, HR up ${e.hrRiseBpm} bpm` : ''}). ` +
              `Your profile says that should have been sustainable, which suggests threshold sits lower than ${profile.ftp}W.`,
            // Fatigue, heat and dehydration all produce the same signature, so
            // this is the one direction where a single ride should not be
            // enough on its own.
            caution:
              'Fatigue, heat and poor fuelling all look like this. If the session felt unusually hard for other reasons, decline.',
            affects: 'all power zones, TSS, and how future sessions are classified',
            bound: 'upper',
          });
        }
      }
    }
  }

  return out.filter((p) => !suppressed(p, decisions, ride.date));
}

/**
 * The efficiency route into the threshold, for the athlete who trains
 * consistently and never rides a maximal effort. Without this their number is
 * frozen for as long as they keep training well, and their zones drift
 * progressively wrong underneath them.
 *
 * This deliberately covers the DOWNWARD direction only. Upward movement is
 * already handled by conservativeBump() in standing.js, which is the more
 * heavily gated of the two — it carries a persistence rule, a cooldown, and a
 * total-drift ceiling above the last confirmed figure. Duplicating it here
 * would ask the athlete the same question twice with two different numbers,
 * and worse, would let a proposal blocked there reappear unblocked here.
 *
 * @param {object} standing  output of assessThresholdStanding()
 * @param {object} profile   { ftp, ftpSetAt, lastBumpAt }
 * @param {Array}  decisions past accept/reject records
 */
export function proposeFromStanding(standing, profile, decisions = [], asOf = new Date()) {
  const rules = PROPOSAL_RULES;
  if (!profile?.ftp) return [];
  // Only when the app has actually decided the threshold is in question. A
  // 'holding' or 'improving' verdict is not evidence for a reduction.
  if (standing?.standing !== 'questioned') return [];

  const zones = Object.entries(standing.zones || {})
    .filter(([, z]) => z.verdict === 'declining')
    // The gates the spec asks for, stated explicitly rather than inherited:
    // the change must be consistent across rides, and must clear the
    // athlete's OWN scatter rather than a population constant.
    .filter(([, z]) => z.agreement >= EF_AGREEMENT)
    .filter(([, z]) => Math.abs(z.changePct) >= (z.thresholdPct ?? Infinity));
  if (!zones.length) return [];

  // Nothing may move the number twice inside the cooldown, whichever route
  // moved it last.
  const now = new Date(asOf).getTime();
  const lastChange = [profile.ftpSetAt, profile.lastBumpAt]
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .sort((a, b) => b - a)[0];
  if (lastChange != null) {
    const since = (now - lastChange) / 86400000;
    if (since < rules.efMinDaysSinceChange) return [];
  }

  // Threshold-zone evidence outranks endurance-zone evidence, same weighting
  // the standing summary uses.
  const rank = (n) => (n === 'Z4_Threshold' ? 3 : n === 'Z3_Tempo' ? 2 : 1);
  const [zoneName, zone] = zones.sort(
    (a, b) => rank(b[0]) - rank(a[0]) || a[1].changePct - b[1].changePct
  )[0];

  // Half the observed change, clamped. EF moves for reasons that have nothing
  // to do with the ceiling — economy at submaximal intensity, cadence, heat —
  // so carrying it across one-for-one would overshoot every time.
  const damped = clampPct(zone.changePct * rules.efDampingFraction, rules.efMaxPct);
  const proposed = Math.round(profile.ftp * (1 + damped / 100));
  if (proposed >= profile.ftp) return [];
  if (!exceeds(profile.ftp, proposed, rules)) return [];

  const proposal = {
    // Keyed by the number rather than the day, so re-rendering the tab does
    // not manufacture a new question every time.
    id: `ftp-ef:${proposed}`,
    field: 'ftp',
    direction: 'down',
    current: profile.ftp,
    proposed,
    evidence: EVIDENCE.EF_TREND,
    confidence: 'low',
    // Inferred, never confirmed — same reasoning as the upward bump. A number
    // nothing demonstrated must not become the baseline that future drift is
    // measured against.
    confirms: false,
    rationale:
      `Watts per heartbeat in ${zoneLabel(zoneName)} is down ${Math.abs(zone.changePct)}% on your baseline, ` +
      `agreeing across ${Math.round(zone.agreement * 100)}% of ${zone.recentRides} recent rides` +
      // Where scatter is unusually tight the real gate is the fixed
      // material-change floor, not the athlete's dispersion. Claiming to have
      // cleared a 0% band would be a boast about nothing.
      (zone.noisePct >= 1
        ? ` and clearing your own ride-to-ride scatter of ${zone.noisePct}%. `
        : ` and clearing the ${zone.thresholdPct}% floor below which this is treated as noise. `) +
      `That supports a threshold nearer ${proposed}W. ` +
      `The reduction is half the efficiency change and capped at ${rules.efMaxPct}%, because efficiency is a ` +
      `proxy for threshold rather than a measurement of it.`,
    caution:
      'Illness, a heavy block, heat and poor sleep all produce this signature. If you know why the last few ' +
      'weeks have been hard, decline — a 20-minute effort would settle it properly.',
    affects: 'all power zones, TSS, and how future sessions are classified',
    bound: 'upper',
  };

  return [proposal].filter((p) => !suppressed(p, decisions, asOf));
}

/**
 * `ageDays` was being computed on every render and acted on by nothing. A
 * threshold that nothing has tested for four months is not wrong, but the
 * athlete should know the number is old — and should only be told once there
 * is no live proposal already asking for their attention.
 */
export function stalenessPrompt(standing, { pendingProposals = [] } = {}) {
  if (!standing || standing.ageDays == null) return null;
  if (standing.ageDays <= STANDING.maxStandingDays) return null;
  // Don't stack a nag on top of a question. If something is already asking to
  // move the number, that is the more useful thing on screen.
  if (pendingProposals.some((p) => p.field === 'ftp')) return null;
  // 'questioned' already renders its own request for an effort.
  if (standing.standing === 'questioned') return null;

  return {
    kind: 'threshold_stale',
    ageDays: standing.ageDays,
    message:
      `Your threshold has stood for ${standing.ageDays} days and nothing has tested it directly in that time. ` +
      (standing.standing === 'holding'
        ? 'Your efficiency says it is still right, so there is no urgency — but next time a hard 20-minute effort fits the plan, take it.'
        : 'There has not been enough comparable riding to confirm it either way. A 20-minute effort would put it back on solid ground.'),
  };
}

const EF_AGREEMENT = STANDING.agreementFraction;
const clampPct = (v, max) => Math.min(max, Math.max(-max, Number(v.toFixed(2))));
const zoneLabel = (zone) =>
  ({ Z2_Endurance: 'endurance riding', Z3_Tempo: 'tempo', Z4_Threshold: 'threshold work' }[zone] || zone);

function exceeds(a, b, rules) {
  const delta = Math.abs(a - b);
  return delta >= rules.minChangeWatts && (delta / (b || 1)) * 100 >= rules.minChangePct;
}

/**
 * A rejection is a real answer and has to stick. Re-asking the same question
 * after a "no" is how an app teaches people to dismiss everything it says.
 */
function suppressed(proposal, decisions, rideDate) {
  const now = new Date(rideDate).getTime();
  for (const d of decisions) {
    if (d.field !== proposal.field) continue;
    if (d.action !== 'rejected') continue;
    const ageDays = (now - new Date(d.date).getTime()) / 86400000;
    if (ageDays > PROPOSAL_RULES.rejectionCooldownDays) continue;
    // Same answer, already refused. A materially different number is a new
    // question and may be asked.
    const same = Math.abs(d.proposed - proposal.proposed) < Math.max(
      PROPOSAL_RULES.minChangeWatts,
      d.proposed * (PROPOSAL_RULES.minChangePct / 100)
    );
    if (same) return true;
  }
  return false;
}

/**
 * Apply an accepted proposal. Returns a NEW profile plus the decision record
 * to append — nothing is mutated, so the caller controls persistence.
 */
export function acceptProposal(profile, proposal, at = new Date()) {
  const decision = {
    date: new Date(at).toISOString(),
    action: 'accepted',
    field: proposal.field,
    from: proposal.current,
    proposed: proposal.proposed,
    evidence: proposal.evidence,
    proposalId: proposal.id,
  };
  // An inferred bump is NOT a confirmation. If accepting one reset the
  // confirmed value, the drift cap in standing.js would rebase every time and
  // the threshold could walk upward indefinitely, 3% at a time, each step
  // "only 3% above the last confirmed figure".
  const confirms = proposal.confirms !== false;

  return {
    profile: {
      ...profile,
      [proposal.field]: proposal.proposed,
      ...(proposal.field === 'ftp'
        ? {
            ftpSetAt: decision.date,
            confirmedFtp: confirms ? proposal.proposed : profile.confirmedFtp ?? profile.ftp,
            ...(confirms ? {} : { lastBumpAt: decision.date }),
          }
        : {}),
      // An accepted value is the athlete's own, so it outranks anything
      // modelled from here on.
      derivation: {
        ...(profile.derivation || {}),
        [proposal.field]: {
          value: proposal.proposed,
          confidence: confirms ? 'declared' : 'low',
          method: confirms ? 'athlete_accepted' : 'athlete_accepted_inferred_bump',
          basis: proposal.evidence,
          caveats: [],
        },
      },
    },
    decision,
  };
}

export function rejectProposal(profile, proposal, at = new Date(), note = null) {
  return {
    profile,
    decision: {
      date: new Date(at).toISOString(),
      action: 'rejected',
      field: proposal.field,
      from: proposal.current,
      proposed: proposal.proposed,
      evidence: proposal.evidence,
      proposalId: proposal.id,
      note,
    },
  };
}

/**
 * Onboarding. Everything is optional — the point is to let someone who knows
 * their numbers say so, not to block someone who does not.
 */
export function onboardingProfile(input = {}) {
  const known = ['ftp', 'maxHr', 'age', 'goals'].filter((k) => input[k] != null);
  return {
    overrides: Object.fromEntries(known.map((k) => [k, input[k]])),
    declared: known,
    // What the app can and cannot do with what it was given.
    note: input.ftp
      ? 'Full analysis available from the first ride.'
      : input.maxHr
      ? 'Heart-rate analysis available immediately; power zones and TSS will appear once a sustained effort gives us a threshold.'
      : 'Upload a ride and the app will show duration, normalised power, peak powers and heart rate while it works out your thresholds.',
  };
}
