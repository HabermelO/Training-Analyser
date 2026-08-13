// Main-thread entry point. One worker, reused; buffers are transferred rather
// than copied, so a 3 MB FIT file costs nothing to hand over.

let worker = null;
let seq = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./fit.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, ok, result, error } = ev.data || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'worker crashed'));
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

/**
 * @param {File|ArrayBuffer} file
 * @param {object} athlete - { ftp, maxHr, hrZones, cp? }
 * @returns {Promise<{ok, ride?, quality?, laps?, reason?}>}
 */
export async function parseFitFile(file, athlete, opts = {}) {
  const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, buffer, athlete, opts }, [buffer]);
  });
}

export function disposeFitWorker() {
  worker?.terminate();
  worker = null;
  pending.clear();
}
