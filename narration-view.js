// How narration reaches the screen, for both the ride verdict and the daily
// session note.
//
// The old behaviour wrote "Writing…" and then a model-download percentage into
// the box where prose was supposed to be. A first-run athlete saw a number
// they had not asked for, sitting where a sentence should be, with nothing to
// read while it counted up.
//
// The rule here is that the template is a valid answer, not a placeholder. It
// renders immediately, it is always correct, and the model's prose replaces it
// only if it arrives and passes the guard. Nothing on screen is ever empty and
// nothing is ever a spinner over an answer we already have.

import { narrate } from './narration.js';
import {
  buildTodayPrompt, renderTodayTemplate, todayShim, renderTemplate,
} from './narrate.js';
import { createGenerator, MODELS } from './webllm.js';
import { el, clear, skeleton } from './ui.js';

// undefined = not tried, null = unavailable on this device. Shared across
// tabs: the engine is expensive and there is only one of it.
let generator;
let generatorPromise = null;

/**
 * One engine for the whole app. Concurrent callers wait on the same promise
 * rather than each starting a download — two tabs rendering at once must not
 * mean two model loads.
 */
function ensureGenerator(onProgress) {
  if (generator !== undefined) return Promise.resolve(generator);
  if (generatorPromise) return generatorPromise;

  generatorPromise = createGenerator({
    onProgress,
    onUnsupported: () => { /* narrate() falls through to the template */ },
  }).then((g) => {
    generator = g;
    generatorPromise = null;
    return g;
  }).catch(() => {
    generator = null;
    generatorPromise = null;
    return null;
  });
  return generatorPromise;
}

const SIZE_MB = MODELS.small.approxMb;

/**
 * Paint the template, then quietly try to improve on it.
 *
 * @param box     the .prose element to fill
 * @param subject the verdict (or shim) narrate() is given
 * @param opts    passed through to narrate(); `label` names the source line
 */
async function render(box, subject, opts = {}) {
  const { label = true, ...narrateOpts } = opts;

  // 1. The answer we already have, immediately.
  const paint = (text, source) => {
    clear(box);
    for (const para of String(text).split(/\n{2,}/)) box.append(el('p', null, para));
    if (label) {
      box.append(el('span', 'prose-source',
        source === 'template' ? 'Written by the rules engine' : 'Written on this device'));
    }
  };

  const templateText = (narrateOpts.template || renderTemplate)(subject);
  paint(templateText, 'template');

  // 2. The setup notice, if a model is being fetched for the first time. It
  //    sits *under* the prose, so the athlete is reading an answer while it
  //    downloads rather than watching a number.
  let status = null;
  const showStatus = ({ progress }) => {
    if (!status) {
      status = el('div', 'prose-pending');
      status.append(el('p', 'prose-pending-copy',
        `Setting up the on-device writer — one time, about ${SIZE_MB} MB. The summary above is the engine's; the written version replaces it as soon as it is ready.`));
      status.append(skeleton(2));
      const bar = el('div', 'prose-progress');
      bar.append(el('span', 'prose-progress-fill'));
      status.append(bar);
      box.append(status);
    }
    const fill = status.querySelector('.prose-progress-fill');
    if (fill) fill.style.width = `${Math.round((progress || 0) * 100)}%`;
  };

  const generate = await ensureGenerator(showStatus);

  // 3. The model's version, if there is one and it passes the guard.
  if (typeof generate !== 'function') return { source: 'template' };

  try {
    const { text, source } = await narrate(subject, { generate, ...narrateOpts });
    // A detached box means the tab was re-rendered while we were generating.
    // Writing into it would be invisible and would leak the old node.
    if (box.isConnected && source !== 'template') paint(text, source);
    return { source };
  } catch {
    return { source: 'template' };
  } finally {
    // paint() clears the box, so this only matters on the paths that did not
    // repaint — but it must run on all of them.
    status?.remove();
  }
}

/** The ride verdict. Roughly 150 words. */
export function writeNarration(box, verdict) {
  return render(box, verdict);
}

/**
 * Today's session. One decision, one reason, one paragraph — shorter than the
 * ride verdict, so the guard is told to expect a shorter answer rather than
 * rejecting a correct one for being the right size.
 */
export function writeTodayNarration(box, today, { readiness, load } = {}) {
  if (!today) return Promise.resolve({ source: 'template' });
  const shim = todayShim(today, { readiness, load });
  return render(box, shim, {
    buildPrompt: (v) => buildTodayPrompt(today, v),
    template: () => renderTodayTemplate(today),
    guard: { minWords: 40, maxWords: 140 },
    label: false,
  });
}
