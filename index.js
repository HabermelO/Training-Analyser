import { buildNarrationPrompt, renderTemplate, buildDigest } from './narrate.js';
import { validateNarration, repairInstruction, allowedNumbers } from './guard.js';

// The one function the UI calls. It is written so that every failure mode —
// no WebGPU, model won't load, generation hangs, model invents a number —
// lands on the same place: renderTemplate(). The app never shows the athlete
// a sentence the engine did not license.
//
// `generate` is injected rather than imported so this file has no opinion
// about WebLLM, Transformers.js, or a remote API. Signature:
//   generate({ system, user }, { signal }) => Promise<string>

export const NARRATION_SOURCE = {
  MODEL: 'model',
  MODEL_REPAIRED: 'model_repaired',
  TEMPLATE: 'template',
};

export async function narrate(v, opts = {}) {
  const {
    generate,
    timeoutMs = 20000,
    repair = true,
    onEvent = () => {},
  } = opts;

  const digest = buildDigest(v);
  const fallback = (reason, violations = []) => ({
    text: renderTemplate(v),
    source: NARRATION_SOURCE.TEMPLATE,
    reason,
    violations,
    digest,
  });

  if (typeof generate !== 'function') return fallback('no_generator');

  const prompt = buildNarrationPrompt(v);

  let first;
  try {
    first = await withTimeout(generate(prompt, {}), timeoutMs);
  } catch (e) {
    onEvent({ type: 'generation_failed', error: e?.message });
    return fallback(e?.message === 'timeout' ? 'timeout' : 'generation_failed');
  }

  const check = validateNarration(first, v);
  if (check.ok && !check.violations.length) {
    return { text: first.trim(), source: NARRATION_SOURCE.MODEL, violations: [], digest };
  }
  onEvent({ type: 'validation_failed', violations: check.violations });

  // A length-only complaint is not worth a second inference pass on device.
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

  const recheck = validateNarration(second, v);
  if (recheck.ok) {
    return {
      text: second.trim(),
      source: NARRATION_SOURCE.MODEL_REPAIRED,
      violations: recheck.violations,
      digest,
    };
  }
  onEvent({ type: 'repair_rejected', violations: recheck.violations });
  return fallback('repair_rejected', recheck.violations);
}

function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]);
}

export { allowedNumbers, validateNarration, buildDigest, renderTemplate };
