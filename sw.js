// Offline shell.
//
// The app was offline-capable in design — everything is computed on device and
// nothing is fetched at runtime — but it was not offline-capable in fact,
// because the modules themselves came off the network every load. This caches
// them.
//
// The one thing this worker must NOT touch is model weights. WebLLM already
// stores them in IndexedDB, they are the better part of a gigabyte, and
// putting them in the Cache Storage API as well would mean carrying two copies
// of the largest asset in the app. Those requests are passed straight through
// to the network, untouched, and the check for them runs before anything else.

const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;

// Everything needed to boot with no network. Fonts and the two CDN packages
// are deliberately absent from the precache — they are cross-origin, they are
// large, and a failed precache entry fails the whole install. They are cached
// opportunistically instead, once they have been fetched successfully at least
// once.
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app.js',
  './ui.js',
  './charts.js',
  './store.js',
  './checkin.js',
  './view-profile.js',
  './view-analyse.js',
  './view-history.js',
  './view-plan.js',
  './workouts.js',
  './athlete.js',
  './classify.js',
  './execution.js',
  './ftp.js',
  './load.js',
  './planner.js',
  './phase.js',
  './prescribe.js',
  './proposals.js',
  './readiness.js',
  './standing.js',
  './thresholds.js',
  './verdict.js',
  './fit.worker.js',
  './fitparser.js',
  './ingest.js',
  './metrics.js',
  './guard.js',
  './narration.js',
  './narration-view.js',
  './narrate.js',
  './webllm.js',
];

// Hosts whose responses are worth keeping but must never block an install.
const RUNTIME_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'esm.sh',
];

/**
 * Model weights and anything else that has no business in the cache.
 * MLC serves weights from huggingface and from its own CDN, and the shard
 * files are recognisable by name regardless of where they came from.
 */
function isModelWeight(url) {
  const host = url.hostname;
  if (host.endsWith('huggingface.co') || host.endsWith('hf.co')) return true;
  if (host.endsWith('mlc.ai') || host.endsWith('githubusercontent.com')) return true;
  return /params_shard|\.bin$|ndarray-cache|mlc-chat-config|tokenizer/.test(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Added one at a time rather than with addAll(), which rejects the whole
    // install if any single file 404s. A missing module should cost that
    // module's offline availability, not the entire worker.
    await Promise.all(SHELL_FILES.map((f) =>
      cache.add(new Request(f, { cache: 'reload' })).catch(() => { /* skip */ })
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Model weights: not our business. Returning without calling respondWith()
  // leaves the request entirely to the browser.
  if (isModelWeight(url)) return;

  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !RUNTIME_HOSTS.some((h) => url.hostname.endsWith(h))) return;

  // Navigations get the network first so a deployed change is picked up on the
  // next load rather than the one after, and fall back to the cached shell
  // when there is no network at all.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Everything else is cache-first: the modules are the app, they change only
  // on deploy, and the activate step already cleared the previous version.
  event.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    try {
      const response = await fetch(request);
      // Opaque cross-origin responses are cached too — they are the fonts, and
      // an opaque hit still renders. Errors are not.
      if (response && (response.ok || response.type === 'opaque')) {
        const cache = await caches.open(SHELL);
        cache.put(request, response.clone());
      }
      return response;
    } catch (e) {
      return hit || Response.error();
    }
  })());
});
