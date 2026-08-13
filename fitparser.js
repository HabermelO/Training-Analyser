// Resolves `fit-file-parser` in both environments.
//
// This exists because of a limitation that is easy to miss: **a module worker
// does not inherit the document's import map.** The map in index.html resolves
// bare specifiers for the main thread only, so `import FitParser from
// 'fit-file-parser'` inside fit.worker.js fails at load — and a worker whose
// module fails to load reports nothing useful, it just never answers.
//
// Node cannot import an https URL and the browser cannot resolve a bare
// specifier, so the choice has to be made at runtime rather than by the module
// resolver. The dynamic import keeps both paths valid.

const CDN = 'https://esm.sh/fit-file-parser@1.9.5';

const isNode =
  typeof process !== 'undefined' && process.versions?.node != null;

let cached = null;

export async function loadFitParser() {
  if (cached) return cached;
  const mod = isNode ? await import('fit-file-parser') : await import(/* @vite-ignore */ CDN);
  // The package ships both CJS and ESM shapes depending on how it is bundled,
  // so the default export is sometimes the constructor and sometimes a wrapper
  // around it.
  cached = mod.default?.default ?? mod.default ?? mod;
  if (typeof cached !== 'function') {
    throw new Error('fit-file-parser did not export a constructor');
  }
  return cached;
}
