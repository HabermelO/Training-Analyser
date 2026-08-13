// Supplies the `generate` function that src/llm/index.js expects. Nothing
// else in the app imports WebLLM — if this file is absent, unsupported, or
// throws, narrate() falls to renderTemplate() and the athlete sees prose
// anyway. That is the whole contract.
//
//   import { createGenerator } from './webllm.js';
//   const generate = await createGenerator({ onProgress: p => ... });
//   const result = await narrate(v, { generate });
//
// createGenerator() resolves to null when the device can't run a model.
// narrate() already treats a non-function generator as 'no_generator', so
// passing the null straight through is correct and needs no branch at the
// call site.

export const MODELS = {
  // id must match a key in WebLLM's prebuilt config.
  small: {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    approxMb: 880,
  },
  medium: {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    approxMb: 2200,
  },
};

// Deterministic-ish. The engine has already made every judgement; we are only
// asking for word order, so sampling entropy buys nothing and costs guard
// violations.
const GEN_DEFAULTS = {
  temperature: 0.3,
  top_p: 0.9,
  max_tokens: 320,
};

export async function detectSupport() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { ok: false, reason: 'no_webgpu' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'no_adapter' };
    // f16 is what the q4f16 builds need; without it WebLLM will load and then
    // fail at the first forward pass, which is a much worse place to find out.
    const f16 = adapter.features?.has?.('shader-f16') ?? false;
    return { ok: true, f16, adapter: adapter.info ?? null };
  } catch (e) {
    return { ok: false, reason: e?.message || 'adapter_request_failed' };
  }
}

let enginePromise = null;
let loadedModelId = null;

/**
 * @param {object} opts
 *   model      - key of MODELS, or a raw WebLLM model id
 *   onProgress - ({ progress, text }) => void, called during download
 * @returns {Promise<Function|null>} generate({system,user},{signal}) => string
 */
export async function createGenerator(opts = {}) {
  const support = await detectSupport();
  if (!support.ok) {
    opts.onUnsupported?.(support);
    return null;
  }
  if (!support.f16 && !opts.allowNoF16) {
    opts.onUnsupported?.({ ok: false, reason: 'no_shader_f16' });
    return null;
  }

  const modelId = MODELS[opts.model]?.id || opts.model || MODELS.small.id;

  let engine;
  try {
    engine = await loadEngine(modelId, opts.onProgress);
  } catch (e) {
    opts.onUnsupported?.({ ok: false, reason: e?.message || 'load_failed' });
    return null;
  }

  return async function generate(prompt, { signal } = {}) {
    const reply = await engine.chat.completions.create({
      ...GEN_DEFAULTS,
      ...(opts.generation || {}),
      stream: false,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    });

    // narrate() races this against its own timeout, but an abort should also
    // stop the GPU work rather than leaving it running behind a rejected
    // promise — on device that is the difference between one slow response
    // and a queue of them.
    if (signal?.aborted) {
      await engine.interruptGenerate?.();
      throw new Error('aborted');
    }

    const text = reply?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('empty_completion');
    }
    return text;
  };
}

async function loadEngine(modelId, onProgress) {
  if (enginePromise && loadedModelId === modelId) return enginePromise;
  if (enginePromise && loadedModelId !== modelId) {
    await disposeGenerator();
  }
  loadedModelId = modelId;
  enginePromise = (async () => {
    const webllm = await import('@mlc-ai/web-llm');
    return webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (r) =>
        onProgress?.({ progress: r.progress ?? 0, text: r.text ?? '' }),
    });
  })();

  try {
    return await enginePromise;
  } catch (e) {
    enginePromise = null;
    loadedModelId = null;
    throw e;
  }
}

export async function disposeGenerator() {
  const p = enginePromise;
  enginePromise = null;
  loadedModelId = null;
  if (!p) return;
  try {
    const engine = await p;
    await engine.unload?.();
  } catch {
    /* already dead */
  }
}
