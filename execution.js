import { DECOUPLING } from './thresholds.js';

// Judgements about *how* the ride was ridden, independent of what type it was.
// Each flag is a fact the narration layer is allowed to talk about.

// peakPowers entries are {power, hr} objects — metrics.js carries the HR so
// ftp.js can reject submaximal efforts. Manual entry may still supply a bare
// number, so accept both rather than assuming either.
const watts = (entry) =>
  typeof entry === 'number' ? entry : entry?.power ?? null;

export function readDecoupling(pct, durationMin) {
  if (pct == null) return { value: null, reading: 'unavailable' };
  if (durationMin < DECOUPLING.minDurationMin) {
    return {
      value: pct,
      reading: 'not_meaningful',
      note: 'ride too short for drift to mean anything',
    };
  }
  let reading = 'severe';
  if (pct < DECOUPLING.excellent) reading = 'excellent';
  else if (pct < DECOUPLING.acceptable) reading = 'normal';
  else if (pct < DECOUPLING.elevated) reading = 'elevated';
  return { value: pct, reading };
}

export function evaluateExecution(ride, classification) {
  const flags = [];
  const z = ride.zoneMinutes || {};
  const drift = readDecoupling(ride.decouplingPct, ride.durationMin);

  if (classification.fragmented) {
    flags.push({
      code: 'intervals_fragmented',
      detail: `work intervals varied widely in length (CV ${classification.workDurationCv})`,
    });
  }

  if (classification.type === 'active_recovery') {
    const peak1s = watts(ride.peakPowers?.['1s']);
    if (peak1s != null && peak1s > ride.ftp * 1.5) {
      flags.push({
        code: 'recovery_surge',
        detail: `peak 1s of ${peak1s}W on a recovery ride`,
      });
    } else if (peak1s != null) {
      flags.push({
        code: 'recovery_discipline',
        detail: `peak power held to ${peak1s}W`,
      });
    }
    // No 1s peak recorded at all: say nothing rather than praising discipline
    // we have no evidence of.
  }

  if (drift.reading === 'elevated' || drift.reading === 'severe') {
    flags.push({
      code: 'aerobic_drift',
      detail: `decoupling ${drift.value}% — efficiency fell away in the second half`,
    });
  }
  if (drift.reading === 'excellent' && ride.durationMin >= 90) {
    flags.push({
      code: 'engine_stable',
      detail: `decoupling ${drift.value}% across ${Math.round(ride.durationMin)} min`,
    });
  }

  // Mechanical output outrunning cardiac cost is a hallmark of a strong base.
  const powerZ3plus = (z.Z3_Tempo || 0) + (z.Z4_Threshold || 0);
  const hrZ3plus =
    (ride.hrZoneMinutes?.Z3_Tempo || 0) + (ride.hrZoneMinutes?.Z4_Threshold || 0);
  if (powerZ3plus > hrZ3plus * 1.3 && powerZ3plus > 15) {
    flags.push({
      code: 'efficient_output',
      detail: `${powerZ3plus.toFixed(0)} min of tempo-or-harder watts for only ${hrZ3plus.toFixed(0)} min of matching HR cost`,
    });
  }

  if ((ride.hrRedzoneSecs ?? 0) > 600) {
    flags.push({
      code: 'high_cardiac_strain',
      detail: `${Math.round(ride.hrRedzoneSecs / 60)} min above Z4 heart rate`,
    });
  }

  return { flags, drift };
}

// The short list of numbers the narration layer may cite. Anything not in
// here should not appear in the prose.
export function keyEvidence(ride, classification, execution) {
  const z = ride.zoneMinutes || {};
  const items = [
    { label: 'Duration', value: `${Math.round(ride.durationMin)} min` },
    { label: 'NP', value: `${ride.np}W` },
    { label: 'TSS', value: `${ride.tss}` },
  ];
  const notable = ['Z4_Threshold', 'Z5_VO2Max', 'Z3_Tempo', 'Z2_Endurance'];
  for (const key of notable) {
    if ((z[key] || 0) >= 5) {
      items.push({
        label: `Time in ${key.split('_')[0]}`,
        value: `${z[key].toFixed(1)} min`,
      });
    }
  }
  if (execution.drift.reading !== 'unavailable') {
    items.push({
      label: 'Decoupling',
      value: `${execution.drift.value}%`,
      reading: execution.drift.reading,
    });
  }
  if (ride.wPrimeKj != null) {
    items.push({ label: "W' spent", value: `${ride.wPrimeKj.toFixed(1)} kJ` });
  }
  return items;
}

// Overall verdict on the session, from type + flags.
export function overallVerdict(classification, execution, intentMatch) {
  const codes = new Set(execution.flags.map((f) => f.code));
  if (classification.type === 'active_recovery') {
    return codes.has('recovery_surge') ? 'recovery_compromised' : 'recovery_clean';
  }
  if (codes.has('intervals_fragmented')) return 'productive_but_ragged';
  if (intentMatch === 'mismatch') return 'off_plan';
  if (codes.has('aerobic_drift') && classification.type === 'endurance') {
    return 'overreached_for_the_zone';
  }
  return 'executed_well';
}
