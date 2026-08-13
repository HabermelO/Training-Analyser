// The model's ONLY job is to turn the verdict object into prose. It is given
// the numbers it may cite and nothing else, and it is never asked to decide
// anything. This is what makes a 1B model viable here.

export function buildNarrationPrompt(v) {
  const evidence = v.keyEvidence
    .map((e) => `- ${e.label}: ${e.value}${e.reading ? ` (${e.reading})` : ''}`)
    .join('\n');
  const flags = v.executionFlags.map((f) => `- ${f.detail}`).join('\n') || '- none';

  return {
    system: [
      'You are a cycling coach writing directly to the athlete, in second person.',
      'You will be given a completed analysis. Your job is ONLY to express it as prose.',
      'Rules you must not break:',
      '1. Use ONLY the numbers listed under EVIDENCE. Never introduce a number that is not there.',
      '2. Do not calculate anything. Do not estimate FTP.',
      '3. Do not flatter. State what happened and what it did physiologically.',
      '4. Write 120-180 words as flowing prose. No headings, no bullet points, no markdown.',
    ].join('\n'),
    user: [
      `SESSION TYPE: ${v.sessionType} (confidence: ${v.classificationConfidence})`,
      `VERDICT: ${v.verdict}`,
      `ADAPTATION TARGETED: ${v.adaptation}`,
      '',
      'EVIDENCE:',
      evidence,
      '',
      'EXECUTION NOTES:',
      flags,
      '',
      `READINESS: ${v.readiness.flag}${v.readiness.notes?.length ? ` (${v.readiness.notes.join('; ')})` : ''}`,
      `TRAINING STATE: ${v.load.state}, CTL ${v.load.ctl}, TSB ${v.load.tsb}`,
      '',
      'Write the coaching paragraph now.',
    ].join('\n'),
  };
}

const VERDICT_PHRASES = {
  executed_well: 'You hit the target for this one.',
  productive_but_ragged:
    'The stimulus landed, but the execution was scrappy rather than clean.',
  recovery_clean: 'A properly disciplined recovery ride.',
  recovery_compromised:
    'This was meant to be recovery and you let the power spike out of it.',
  off_plan: 'This was not the session that was planned.',
  overreached_for_the_zone:
    'You rode this harder than the zone called for and the engine showed it.',
};

// Used when WebGPU is unavailable, the model fails to load, or the user opts
// out. Same advice, plainer voice — the app never depends on the LLM.
export function renderTemplate(v) {
  const lines = [];
  lines.push(VERDICT_PHRASES[v.verdict] || 'Session analysed.');
  lines.push(
    `Classified as ${v.sessionType.replace(/_/g, ' ')} (${v.classificationConfidence} confidence): ${v.classificationReasons.join(', ')}.`
  );
  lines.push(
    'Key numbers: ' +
      v.keyEvidence.map((e) => `${e.label} ${e.value}`).join(', ') + '.'
  );
  if (v.executionFlags.length) {
    lines.push('Execution: ' + v.executionFlags.map((f) => f.detail).join('; ') + '.');
  }
  lines.push(
    `Training state: CTL ${v.load.ctl}, TSB ${v.load.tsb} (${v.load.state}), 7-day TSS ${v.load.last7dTss}.`
  );
  if (v.readiness.available) {
    lines.push(`Readiness: ${v.readiness.flag}${v.readiness.notes.length ? ` — ${v.readiness.notes.join(', ')}` : ''}.`);
  }
  if (v.ftpEstimate.value) {
    lines.push(
      `Modelled critical power ${v.ftpEstimate.value}W (${v.ftpEstimate.confidence} confidence, r² ${v.ftpEstimate.r2}).` +
        (v.ftpEstimate.caveats?.length ? ` Caveats: ${v.ftpEstimate.caveats.join('; ')}.` : '')
    );
  } else {
    lines.push(
      `FTP not estimated: ${v.ftpEstimate.caveats?.join('; ') || 'insufficient data'}. ${v.ftpEstimate.recommendation || ''}`.trim()
    );
  }
  return lines.join(' ');
}

// The <=1000 char digest that gets stored and fed into future 30-day context.
export function buildDigest(v) {
  const parts = [
    `${v.ride.date.slice(0, 10)} | ${v.sessionType} | ${v.ride.durationMin}min NP${v.ride.np}W TSS${v.ride.tss} IF${v.ride.if}`,
    `Verdict: ${v.verdict}. Adaptation: ${v.adaptation}.`,
    v.keyEvidence.map((e) => `${e.label} ${e.value}`).join(', ') + '.',
    v.executionFlags.map((f) => f.code).join(', ') || 'no flags',
    `CTL ${v.load.ctl} TSB ${v.load.tsb}. Readiness ${v.readiness.flag}.`,
  ];
  return parts.join(' ').slice(0, 1000);
}
