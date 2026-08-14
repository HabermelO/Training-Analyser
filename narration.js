import { buildNarrationPrompt, renderTemplate, buildDigest } from './narrate.js';
import { validateNarration, repairInstruction, allowedNumbers } from './guard.js';

export const NARRATION_SOURCE = {
  MODEL: 'model',
  MODEL_REPAIRED: 'model_repaired',
  TEMPLATE: 'template',
};

export async function narrate(v, opts = {}) {
  const {
    generate, timeoutMs = 20000, repair = true, onEvent = () => {},
    // Length bounds belong to the caller, not the guard: a ride verdict is a
    // 150-word paragraph and a daily note is an 80-word one, and judging both
    // against one range rejects a correct answer for being the right size.
    guard: guardOpts = {},
    buildPrompt = buildNarrationPrompt,
    template = renderTemplate,
  } = opts;

  // The digest is a ride-shaped artefact (it keys off v.ride). Callers that
  // narrate something other than a ride verdict have no digest to build, and
  // failing to build one must not fail the narration.
  let digest = null;
  try { digest = v.ride ? buildDigest(v) : null; } catch { digest = null; }
  const fallback = (reason, violations = []) => ({
    text: template(v), source: NARRATION_SOURCE.TEMPLATE, reason, violations, digest,
  });

  if (typeof generate !== 'function') return fallback('no_generator');

  const prompt = buildPrompt(v);

  let first;
  try {
    first = await withTimeout(generate(prompt, {}), timeoutMs);
  } catch (e) {
    onEvent({ type: 'generation_failed', error: e?.message });
    return fallback(e?.message === 'timeout' ? 'timeout' : 'generation_failed');
  }

  const check = validateNarration(first, v, guardOpts);
  if (check.ok && !check.violations.length) {
    return { text: first.trim(), source: NARRATION_SOURCE.MODEL, violations: [], digest };
  }
  onEvent({ type: 'validation_failed', violations: check.violations });

  if (check.ok) {
    return { text: first.trim(), source: NARRATION_SOURCE.MODEL, violations: check.violations, digest };
  }
  if (!repair) return fallback('validation_failed', check.violations);

  const repairPrompt = {
    system: prompt.system,
    user: `${prompt.user}\n\nYour previous attempt was rejected. ${repairInstruction(check.violations)}`,
  };

  let second;
  try {
    second = await withTimeout(generate(repairPrompt, {}), timeoutMs);
  } catch {
    return fallback('repair_failed', check.violations);
  }

  const recheck = validateNarration(second, v, guardOpts);
  if (recheck.ok) {
    return { text: second.trim(), source: NARRATION_SOURCE.MODEL_REPAIRED, violations: recheck.violations, digest };
  }
  onEvent({ type: 'repair_rejected', violations: recheck.violations });
  return fallback('repair_rejected', recheck.violations);
}

function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]);
}

export { allowedNumbers, validateNarration, buildDigest, renderTemplate };
