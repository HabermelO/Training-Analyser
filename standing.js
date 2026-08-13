// Does the athlete's current threshold still stand?
//
// The premise, which is the athlete's own: a threshold does not need to be
// re-demonstrated with a 20-minute effort every few weeks. If watts-per-beat
// in the ordinary training zones is holding, the number underneath those zones
// is still right. It is only when efficiency moves that the app has anything
// to say — and even then, what it should say is "go and show me", not "I have
// changed your FTP".
//
// This exists because the alternative is worse in both directions. Silently
// decaying an FTP because it is old punishes riders who are training
// consistently and well. Never questioning it lets a number go stale through
// illness, a layoff, or a season of genuine improvement.
//
// WHAT THIS IS NOT: a fitness test. Efficiency factor moves with heat,
// hydration, fatigue, caffeine, altitude, sleep and cadence. A single ride
// means nothing here. Only a sustained shift across many rides, in the zone
// that ride was actually about, is treated as signal.

export const STANDING = {
  // Zones worth trending. Z1 is excluded deliberately: on any ride with
  // intervals it is mostly recovery between efforts, where HR is still coming
  // down from the previous rep, so its efficiency reads low for reasons that
  // have nothing to do with fitness. Z5+ is too brief and too anaerobic.
  zones: ['Z2_Endurance', 'Z3_Tempo', 'Z4_Threshold'],
  // A ride only contributes its Z2 number if the ride was genuinely ABOUT Z2.
  // Comparing the Z2 efficiency of an interval session against that of a
  // steady endurance ride compares two different things.
  minZoneShareOfRide: 0.4,
  minZoneSecs: 600,
  // Enough rides on each side of the comparison to average out a bad day.
  minRidesPerWindow: 4,
  recentDays: 28,
  baselineDays: 90,
  // Movement smaller than this is noise. EF swings a few percent day to day
  // on hydration alone.
  materialChangePct: 4,
  // ...and the floor is not fixed, because scatter differs hugely between
  // riders and between indoor and outdoor riding. A shift must also clear this
  // multiple of the athlete's OWN dispersion. Without it, a rider whose
  // efficiency naturally swings 6% gets told their threshold is questioned
  // every four weeks.
  noiseMultiple: 2.0,
  // Sustained means most of the recent rides agree, not just the average.
  agreementFraction: 0.6,
  // How long a threshold may stand on efficiency evidence alone before the
  // app asks for a real effort regardless.
  maxStandingDays: 120,

  // --- conservative upward bumps -------------------------------------
  // An improvement must PERSIST before it counts. A single strong ride, a cool
  // morning, or a week of good sleep can all lift efficiency briefly; only a
  // shift held across several rides and more than a few days is describing a
  // change in the athlete rather than in the conditions.
  bumpMinRides: 5,
  bumpMinSpanDays: 7,
  bumpMinAgreement: 0.8,
  // Efficiency gains do not map one-for-one onto threshold. Some of a rise in
  // watts-per-beat is aerobic economy at submaximal intensity, which does not
  // move the ceiling. Half is a deliberately pessimistic share.
  bumpFractionOfGain: 0.5,
  // Hard ceiling per bump regardless of what the gain looks like.
  bumpMaxPct: 3,
  // Bumps cannot stack week on week. Efficiency is a lagging, noisy signal and
  // repeated small increases would compound into a number nobody ever rode.
  bumpCooldownDays: 21,
  // Total drift permitted above the last DIRECTLY CONFIRMED threshold — one
  // the athlete tested, declared, or accepted off a real effort. Past this the
  // app stops bumping and insists on evidence.
  bumpMaxDriftFromConfirmedPct: 8,
};

/**
 * @param {Array} rides - each { date, efficiencyByZone, zoneMinutes, durationMin }
 * @param {object} profile - { ftp, ftpSetAt }
 * @param {Date} asOf
 */
export function assessThresholdStanding(rides, profile, asOf = new Date()) {
  const now = new Date(asOf).getTime();
  const zones = {};

  for (const zone of STANDING.zones) {
    const points = collectZone(rides, zone);
    if (!points.length) continue;

    const recent = points.filter((p) => days(now, p.date) <= STANDING.recentDays);
    const baseline = points.filter(
      (p) => days(now, p.date) > STANDING.recentDays && days(now, p.date) <= STANDING.baselineDays
    );

    if (recent.length < STANDING.minRidesPerWindow || baseline.length < STANDING.minRidesPerWindow) {
      zones[zone] = { verdict: 'insufficient', recentRides: recent.length, baselineRides: baseline.length };
      continue;
    }

    // Median rather than mean: one dehydrated ride in a heatwave should not
    // move the answer.
    const rEf = median(recent.map((p) => p.ef));
    const bEf = median(baseline.map((p) => p.ef));
    const changePct = Number((((rEf - bEf) / bEf) * 100).toFixed(1));

    // Agreement: how many recent rides individually sit on the same side of
    // the baseline as the median does. A shifted median built from two
    // outliers and two contradictions is not a trend.
    const side = Math.sign(changePct);
    const agreeing = recent.filter((p) => Math.sign(p.ef - bEf) === side).length;
    const agreement = Number((agreeing / recent.length).toFixed(2));

    // The athlete's own scatter, as a percentage. Median absolute deviation
    // rather than standard deviation, so a single outlier does not inflate the
    // noise floor and mask a real trend.
    const all = [...baseline, ...recent].map((p) => p.ef);
    const mad = median(all.map((x) => Math.abs(x - median(all))));
    const noisePct = Number(((mad / median(all)) * 100).toFixed(1));
    const threshold = Math.max(STANDING.materialChangePct, noisePct * STANDING.noiseMultiple);

    let verdict = 'holding';
    if (Math.abs(changePct) >= threshold && agreement >= STANDING.agreementFraction) {
      verdict = changePct > 0 ? 'improving' : 'declining';
    }

    const span = (recent[recent.length - 1].date - recent[0].date) / 86400000;

    zones[zone] = {
      verdict, changePct, agreement, noisePct, thresholdPct: Number(threshold.toFixed(1)),
      spanDays: Number(span.toFixed(1)),
      recentEf: Number(rEf.toFixed(3)), baselineEf: Number(bEf.toFixed(3)),
      recentRides: recent.length, baselineRides: baseline.length,
    };
  }

  return summarise(zones, profile, now);
}

function summarise(zones, profile, now) {
  const usable = Object.entries(zones).filter(([, z]) => z.verdict !== 'insufficient');
  const declining = usable.filter(([, z]) => z.verdict === 'declining');
  const improving = usable.filter(([, z]) => z.verdict === 'improving');

  const setAt = profile?.ftpSetAt ? new Date(profile.ftpSetAt).getTime() : null;
  const ageDays = setAt != null ? Math.round(days(now, setAt)) : null;
  const stale = ageDays != null && ageDays > STANDING.maxStandingDays;

  if (!usable.length) {
    return {
      standing: 'unknown', zones, ageDays,
      message: 'Not enough comparable riding yet to tell whether your threshold still holds.',
      action: null,
    };
  }

  // Threshold-zone evidence outranks endurance-zone evidence: it is closer to
  // the number in question. Z2 moving alone is more likely to be aerobic
  // fitness shifting underneath an unchanged threshold.
  const weight = (name) => (name === 'Z4_Threshold' ? 3 : name === 'Z3_Tempo' ? 2 : 1);
  const decliningWeight = declining.reduce((s, [n]) => s + weight(n), 0);
  const improvingWeight = improving.reduce((s, [n]) => s + weight(n), 0);

  if (decliningWeight > improvingWeight && decliningWeight >= 2) {
    const worst = declining.sort((a, b) => a[1].changePct - b[1].changePct)[0];
    return {
      standing: 'questioned', zones, ageDays,
      message:
        `Your watts per heartbeat in ${label(worst[0])} has drifted down ${Math.abs(worst[1].changePct)}% ` +
        `over the last four weeks, across ${worst[1].recentRides} rides. That does not necessarily mean your ` +
        `threshold has fallen — illness, a heavy block, heat and poor sleep all look the same — but it is the ` +
        `first thing that has suggested it.`,
      action: {
        kind: 'request_effort',
        // Never an automatic downgrade. The athlete's own evidence decides.
        why: 'confirm where threshold actually sits now',
        suggestion:
          'A 20-minute effort on a climb or a quiet road, ridden as hard as you can hold evenly, would settle it. ' +
          'Do it on a day you feel fresh, not at the end of a hard week.',
        keepCurrentMeanwhile: true,
      },
    };
  }

  if (improvingWeight >= 2) {
    const best = improving.sort((a, b) => b[1].changePct - a[1].changePct)[0];
    const bump = conservativeBump(best[1], profile, now);

    return {
      standing: 'improving', zones, ageDays,
      message:
        `Your watts per heartbeat in ${label(best[0])} is up ${best[1].changePct}% on your baseline, ` +
        `held across ${best[1].recentRides} rides. Your threshold is probably higher than the ` +
        `${profile?.ftp ?? 'current'}W we are using, which means your zones are set slightly easy.`,
      // Both offered together. The bump keeps the analysis honest in the
      // meantime; the test is what actually settles it.
      proposal: bump.proposal,
      bumpBlocked: bump.blocked,
      action: {
        kind: bump.proposal ? 'offer_bump_or_effort' : 'request_effort',
        why: 'capture a gain you have already made',
        suggestion: bump.proposal
          ? `Take the increase to ${bump.proposal.proposed}W now, or ride a 20-minute maximal effort to pin it down properly. ` +
            `The increase is deliberately smaller than your efficiency gain suggests, so it should not overshoot.`
          : bump.blockedReason ||
            'A 20-minute maximal effort would let the app move your threshold up. Until then the analysis stays conservative.',
        keepCurrentMeanwhile: true,
      },
    };
  }

  if (stale) {
    return {
      standing: 'stale', zones, ageDays,
      message:
        `Your threshold has been steady for ${ageDays} days and your efficiency has not moved, so nothing ` +
        `suggests it is wrong. It has just been a long time since anything confirmed it directly.`,
      action: {
        kind: 'request_effort',
        why: 'refresh the evidence',
        suggestion: 'No urgency. Next time a hard 20-minute effort fits the plan, take it.',
        keepCurrentMeanwhile: true,
      },
    };
  }

  return {
    standing: 'holding', zones, ageDays,
    message:
      `Your watts per heartbeat is steady across ${usable.map(([n]) => label(n)).join(' and ')}, so your ` +
      `threshold of ${profile?.ftp ?? '—'}W still describes you. No test needed.`,
    action: null,
  };
}

/**
 * A small, deliberately pessimistic increase, offered only when the
 * improvement has held long enough to be describing the athlete.
 *
 * Every guard here exists to stop the same failure: a threshold that walks
 * upward on its own, a few percent at a time, until it describes a rider who
 * does not exist and every session is prescribed too hard.
 */
export function conservativeBump(zoneResult, profile, now = Date.now()) {
  const R = STANDING;
  const ftp = profile?.ftp;
  if (!ftp) return { proposal: null, blocked: true, blockedReason: 'No threshold set yet.' };

  // 1. Persistence. One good ride is weather, not fitness.
  if (zoneResult.recentRides < R.bumpMinRides) {
    return {
      proposal: null, blocked: true,
      blockedReason:
        `The improvement is only in ${zoneResult.recentRides} rides so far. ` +
        `It needs to hold across at least ${R.bumpMinRides} before it means anything.`,
    };
  }
  if (zoneResult.spanDays != null && zoneResult.spanDays < R.bumpMinSpanDays) {
    return {
      proposal: null, blocked: true,
      blockedReason: `Those rides span ${Math.round(zoneResult.spanDays)} days. A week or more is needed to rule out a good patch.`,
    };
  }
  // 2. Consistency. A median dragged up by two outstanding rides while the
  //    others sat flat is not an improvement.
  if (zoneResult.agreement < R.bumpMinAgreement) {
    return {
      proposal: null, blocked: true,
      blockedReason: 'The gain is not showing up consistently across rides yet.',
    };
  }

  // 3. Cooldown. Bumps must not stack.
  const lastBump = profile?.lastBumpAt ? new Date(profile.lastBumpAt).getTime() : null;
  if (lastBump != null && days(now, lastBump) < R.bumpCooldownDays) {
    return {
      proposal: null, blocked: true,
      blockedReason: `Your threshold was already raised ${Math.round(days(now, lastBump))} days ago. ` +
        `Give it ${R.bumpCooldownDays} days between increases.`,
    };
  }

  // 4. Total drift from the last directly confirmed value.
  const confirmed = profile?.confirmedFtp ?? null;
  if (confirmed) {
    const driftPct = ((ftp - confirmed) / confirmed) * 100;
    if (driftPct >= R.bumpMaxDriftFromConfirmedPct) {
      return {
        proposal: null, blocked: true,
        blockedReason:
          `Your threshold has already climbed ${Math.round(driftPct)}% above the last figure you actually ` +
          `demonstrated. Before it goes any higher it needs a real effort behind it.`,
      };
    }
  }

  // Only a fraction of the efficiency gain, and capped.
  const rawPct = zoneResult.changePct * R.bumpFractionOfGain;
  const pct = Math.min(rawPct, R.bumpMaxPct);
  const proposed = Math.round(ftp * (1 + pct / 100));
  if (proposed <= ftp) {
    return { proposal: null, blocked: true, blockedReason: 'The gain is too small to change the number.' };
  }

  return {
    blocked: false,
    proposal: {
      id: `ftp-bump:${new Date(now).toISOString().slice(0, 10)}:${proposed}`,
      field: 'ftp',
      direction: 'up',
      current: ftp,
      proposed,
      evidence: 'sustained_efficiency_gain',
      confidence: 'low',
      // Explicitly NOT a confirmed value: accepting it must not reset
      // confirmedFtp, or the drift cap above becomes meaningless.
      confirms: false,
      rationale:
        `Watts per heartbeat is up ${zoneResult.changePct}% across ${zoneResult.recentRides} rides. ` +
        `That supports a threshold nearer ${proposed}W. The increase is half the efficiency gain and capped ` +
        `at ${R.bumpMaxPct}%, because some of a rise in efficiency is economy at submaximal intensity rather ` +
        `than a higher ceiling.`,
      caution:
        'This is inferred, not measured. A 20-minute maximal effort would replace it with something solid.',
      affects: 'all power zones, TSS, and how future sessions are classified',
    },
  };
}

/**
 * Pull one zone's efficiency from every ride where that zone was actually the
 * point of the ride. This filter is what makes the numbers comparable.
 */
function collectZone(rides, zone) {
  const out = [];
  for (const r of rides || []) {
    const ef = r.efficiencyByZone?.[zone];
    if (!ef || ef.secs < STANDING.minZoneSecs) continue;
    const totalSecs = (r.durationMin || 0) * 60;
    if (!totalSecs) continue;
    if (ef.secs / totalSecs < STANDING.minZoneShareOfRide) continue;
    out.push({ date: new Date(r.date).getTime(), ef: ef.ef, secs: ef.secs });
  }
  return out.sort((a, b) => a.date - b.date);
}

const days = (now, then) => (now - then) / 86400000;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const label = (zone) =>
  ({ Z2_Endurance: 'endurance riding', Z3_Tempo: 'tempo', Z4_Threshold: 'threshold work' }[zone] || zone);

/**
 * Whether a downward FTP proposal should be allowed to reach the athlete at
 * all. Wire this into proposals.js: a single decoupled effort is weak evidence
 * on its own, and it should not be able to talk someone's threshold down while
 * their efficiency across ordinary training says nothing is wrong.
 */
export function allowDownwardProposal(standing) {
  return standing?.standing === 'questioned' || standing?.standing === 'unknown';
}
