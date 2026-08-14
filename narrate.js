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

// --- today ----------------------------------------------------------------
//
// The ride verdict asks the model to hold a whole session's analysis in view.
// Today asks it to explain one decision. That is the easier job and the more
// useful paragraph, and it is squarely inside a 1B model's reliable range:
// one decision, one reason, one paragraph.

/**
 * A verdict-shaped view of suggestToday()'s output, so guard.js can derive the
 * allowlist from exactly the fields the prompt exposes without needing to know
 * anything about plans. The shim is the contract — if a number is not on here,
 * the model may not say it.
 */
export function todayShim(today, { readiness, load } = {}) {
  // The value AND its effect. The effect is the reasoning — "targets about
  // 480 TSS this week" is the entire point of the phase step, and a model
  // given only "build, week 2" has nothing to explain. Folding it in here
  // also puts its numbers on the allowlist, which is correct: the engine
  // wrote them, so the model may repeat them.
  const evidence = today.trace.map((t) => ({
    label: t.step,
    value: `${t.value} — ${t.effect}`,
  }));

  if (today.session) {
    evidence.push({ label: 'Duration', value: `${today.session.durationMin} min` });
    const tss = Math.round(today.prescription?.tss ?? today.session.tss);
    if (Number.isFinite(tss)) evidence.push({ label: 'Training stress', value: `${tss} TSS` });
    if (today.prescription?.targetWatts) {
      evidence.push({ label: 'Target power', value: `${Math.round(today.prescription.targetWatts)}W` });
    }
  }

  return {
    keyEvidence: evidence,
    // The headline names the session, and the model is asked to name it too.
    // Several SYSTM workouts have cardinals in their names ("Nine Hammers"),
    // so without this the guard rejects the model for repeating the one string
    // it was explicitly given.
    allowedText: [today.headline, today.session?.systm].filter(Boolean),
    // The engine's own prose about this day, which the model may quote numbers
    // from because the engine put them there.
    executionFlags: today.note ? [{ code: 'plan_note', detail: today.note }] : [],
    readiness: readiness || { flag: 'no_data', notes: [] },
    load: { ctl: load?.ctl ?? null, tsb: load?.tsb ?? null },
  };
}

export function buildTodayPrompt(today, shim) {
  const evidence = shim.keyEvidence.map((e) => `- ${e.label}: ${e.value}`).join('\n');

  return {
    system: [
      'You are a cycling coach writing directly to the athlete, in second person.',
      "You will be given today's session and the reasoning that produced it. Your job is ONLY to express that reasoning as prose.",
      'Rules you must not break:',
      '1. Use ONLY the numbers listed under REASONING. Never introduce a number that is not there.',
      '2. Do not decide anything. The session has already been chosen; explain why, do not re-argue it.',
      '3. Do not flatter and do not motivate. Say what today is for and what would undo it.',
      '4. Write a single paragraph of 50-110 words. No headings, no bullet points, no markdown.',
    ].join('\n'),
    user: [
      `TODAY: ${today.headline}`,
      today.wasOverridden ? 'NOTE: the athlete moved this session here themselves.' : '',
      today.alreadyRidden ? 'NOTE: this day has already been ridden.' : '',
      '',
      'REASONING:',
      evidence,
      '',
      shim.executionFlags.length ? `PLAN NOTE: ${shim.executionFlags[0].detail}` : '',
      `READINESS: ${shim.readiness.flag}${shim.readiness.notes?.length ? ` (${shim.readiness.notes.join('; ')})` : ''}`,
      '',
      'Write the paragraph now.',
    ].filter(Boolean).join('\n'),
  };
}

/**
 * The deterministic answer. Always correct, always available, never empty —
 * and it is what the athlete reads while the model loads, so it has to be
 * prose rather than a data dump.
 *
 * The trace steps carry effects written as fragments of different shapes
 * ("no objection", "targets about 480 TSS this week", "within the normal
 * training range"). Joining them with a single connective produces nonsense,
 * so each step is rendered as its own clause with the effect in apposition,
 * which reads correctly whatever shape the fragment takes.
 */
export function renderTodayTemplate(today) {
  const lines = [];

  const opener = today.session
    ? `${today.headline}: ${today.session.durationMin} minutes, about ${Math.round(today.prescription?.tss ?? today.session.tss)} TSS.`
    : `${today.headline}.`;
  lines.push(opener);

  if (today.alreadyRidden) {
    lines.push('You have already ridden today, so this is a report rather than a prescription.');
  }
  if (today.wasOverridden) {
    lines.push("This is your own edit rather than the engine's pick, and it stays until you reset the week.");
  }

  const clauses = today.trace.map((t) => {
    const step = String(t.step).replace(/_/g, ' ');
    const value = String(t.value).replace(/_/g, ' ');
    return `${step} ${value} — ${t.effect}`;
  });
  if (clauses.length) lines.push(`Why: ${clauses.join('; ')}.`);

  if (today.note) lines.push(today.note);
  return lines.join(' ');
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
