// The model is only allowed to say numbers the engine already decided. This
// file works out what that set is, and checks generated prose against it.
//
// The allowed set is derived from the VERDICT OBJECT, not from the prompt
// string. That distinction matters: the system prompt contains digits of its
// own ("120-180 words", the numbered rules), and building the allowlist from
// the prompt text would quietly license the model to emit "180W".

// Sign-aware. A leading -/+ only counts as a sign when it opens a token,
// so "Z4-Z5" and "120-180" still read as two unsigned numbers rather than
// one number and one negative. Without this, "TSB at +22.9" validates
// against a TSB of -22.9, which is the one number in the whole object where
// the sign carries the entire meaning.
const NUM = /(?:(?<=^)|(?<=[\s(“"'>[]))([+-]?)(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)/g;

function numbersIn(str) {
  const out = [];
  for (const m of String(str ?? '').matchAll(NUM)) {
    const raw = m[3] ?? `${m[1] || ''}${m[2]}`;
    const n = Number(raw.replace('+', ''));
    if (Number.isFinite(n)) out.push({ raw, n });
  }
  return out;
}

// Cardinals the model might write out. 'one' is excluded deliberately — it is
// far more often a pronoun ("one of the reps") than a quantity.
const WORD_NUMBERS = {
  two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Every number the narration layer is permitted to use, derived from exactly
 * the fields buildNarrationPrompt() puts in front of the model.
 */
export function allowedNumbers(v) {
  const allowed = new Set();
  const add = (x) => { for (const { n } of numbersIn(x)) allowed.add(n); };

  for (const e of v.keyEvidence || []) { add(e.value); add(e.label); }
  for (const f of v.executionFlags || []) add(f.detail);
  for (const n of v.readiness?.notes || []) add(n);
  add(v.load?.ctl);
  add(v.load?.tsb);

  // Rounded forms of anything allowed. The model writing "20 min in Z4" off
  // the back of "20.2 min" is a presentation choice, not a fabrication.
  for (const n of [...allowed]) {
    allowed.add(Math.round(n));
    allowed.add(Math.trunc(n));
  }
  return allowed;
}

function isAllowed(n, allowed) {
  if (allowed.has(n)) return true;
  // Tolerate a decimal being rendered to fewer places (5.6 -> 5.60, 5.6).
  for (const a of allowed) if (Math.abs(a - n) < 0.05) return true;
  return false;
}

/**
 * @returns {{ok: boolean, violations: Array<{kind, token, detail}>}}
 */
export function validateNarration(text, v, opts = {}) {
  const violations = [];
  const allowed = allowedNumbers(v);

  for (const { raw, n } of numbersIn(text)) {
    if (!isAllowed(n, allowed)) {
      violations.push({
        kind: 'fabricated_number',
        token: raw,
        // Called out separately because the repair instruction "remove 22.9"
        // is wrong advice when the number is right and the sign is not.
        detail: isAllowed(-n, allowed)
          ? `${raw} has the wrong sign`
          : `${raw} does not appear in the evidence`,
      });
    }
  }

  for (const [word, n] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text) && !isAllowed(n, allowed)) {
      violations.push({
        kind: 'fabricated_number',
        token: word,
        detail: `"${word}" is a quantity not present in the evidence`,
      });
    }
  }

  // Format rules. These are not correctness failures on their own, but a
  // model that starts emitting headings is usually also drifting elsewhere.
  if (/^\s*[#*\-•]|\n\s*[#*\-•]/.test(text)) {
    violations.push({ kind: 'formatting', token: 'markdown', detail: 'headings or bullets in prose output' });
  }

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const min = opts.minWords ?? 90;
  const max = opts.maxWords ?? 220;
  if (words < min || words > max) {
    violations.push({ kind: 'length', token: String(words), detail: `${words} words, expected ${min}-${max}` });
  }

  // Anything that reads like the model estimating fitness itself. FTP is not
  // in the prompt at all, so any mention of it is invention by definition.
  if (/\b(FTP|critical power|CP)\b/i.test(text)) {
    violations.push({ kind: 'out_of_scope', token: 'ftp', detail: 'narration must not discuss FTP; ftp.js owns that judgement' });
  }

  const fatal = violations.filter((x) => x.kind !== 'length');
  return { ok: fatal.length === 0, violations, words };
}

// Fed back to the model on the single repair attempt.
export function repairInstruction(violations) {
  const signWrong = violations.filter((v) => v.detail?.includes('wrong sign')).map((v) => v.token);
  const bad = violations
    .filter((v) => v.kind === 'fabricated_number' && !v.detail?.includes('wrong sign'))
    .map((v) => v.token);
  const notes = [];
  if (bad.length) notes.push(`Remove these numbers, which are not in the EVIDENCE: ${[...new Set(bad)].join(', ')}.`);
  if (signWrong.length) notes.push(`These numbers have the wrong sign — copy them exactly as written in the EVIDENCE: ${[...new Set(signWrong)].join(', ')}.`);
  if (violations.some((v) => v.kind === 'formatting')) notes.push('Write flowing prose only — no bullets, no headings.');
  if (violations.some((v) => v.kind === 'out_of_scope')) notes.push('Do not mention FTP or critical power.');
  if (violations.some((v) => v.kind === 'length')) notes.push('Keep it to a single paragraph of roughly 150 words.');
  return notes.join(' ') + ' Rewrite the paragraph.';
}
