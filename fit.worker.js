// Runs off the main thread: decode FIT bytes, normalise records, hand back a
// ride object. A 4-hour ride is ~15k records; doing this inline janks the UI.
//
// The worker never sees the athlete's history and never makes a judgement —
// it produces the same shape a manual entry form would, and buildVerdict()
// takes it from there.

import { loadFitParser } from './fitparser.js';
import { buildRide } from './metrics.js';

function normaliseRecords(records) {
  const out = [];
  for (const r of records) {
    if (!r.timestamp) continue;
    out.push({
      t: r.timestamp,
      // Garmin/Wahoo agree on these names; the parser already unit-converts.
      power: num(r.power),
      hr: num(r.heart_rate),
      cadence: num(r.cadence),
      speed: num(r.speed),               // m/s (mode: 'both' gives us this)
      distance: num(r.distance),
      altitude: num(r.altitude ?? r.enhanced_altitude),
      temperature: num(r.temperature),
    });
  }
  return out;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Laps recorded on the head unit are better evidence of intent than anything
// we can infer, so we pass them through for the caller to prefer if present.
function normaliseLaps(laps = []) {
  return laps
    .filter((l) => l.total_timer_time > 0)
    .map((l) => ({
      startTime: l.start_time,
      durationSecs: Math.round(l.total_timer_time),
      averagePower: num(l.avg_power),
      maxPower: num(l.max_power),
      averageHr: num(l.avg_heart_rate),
      intensity: l.intensity ?? null,
    }));
}

export async function parseFitBuffer(buffer, athlete = {}, opts = {}) {
  const FitParser = await loadFitParser();
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force: true,               // salvage what we can from a truncated file
      speedUnit: 'm/s',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      elapsedRecordField: false,
      mode: 'list',
    });

    parser.parse(buffer, (error, data) => {
      if (error) return reject(new Error(`FIT decode failed: ${error}`));
      try {
        const records = normaliseRecords(data.records || []);
        if (!records.length) {
          return resolve({ ok: false, reason: 'file contained no record messages' });
        }
        const result = buildRide(records, athlete, opts);
        if (!result.ok) return resolve(result);

        result.laps = normaliseLaps(data.laps);
        result.device = data.file_ids?.[0]?.manufacturer ?? null;
        result.sport = data.sessions?.[0]?.sport ?? null;
        // The FTP configured on the head unit. Stronger evidence than anything
        // we can model, so athlete.js prefers it — but it is whatever the rider
        // last typed into their device, not a measurement.
        result.declaredFtp = num(data.sessions?.[0]?.threshold_power);
        // The device's own NP/TSS/IF, kept for the cross-check in test/parse.js.
        result.deviceMetrics = {
          np: num(data.sessions?.[0]?.normalized_power),
          tss: num(data.sessions?.[0]?.training_stress_score),
          if: num(data.sessions?.[0]?.intensity_factor),
        };
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Worker message protocol: { id, buffer, athlete, opts } in,
// { id, ok, result } or { id, ok: false, error } out.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async (ev) => {
    const { id, buffer, athlete, opts } = ev.data || {};
    try {
      const result = await parseFitBuffer(buffer, athlete, opts);
      self.postMessage({ id, ok: true, result });
    } catch (e) {
      self.postMessage({ id, ok: false, error: e?.message || String(e) });
    }
  };
}
