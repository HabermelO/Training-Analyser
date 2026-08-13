// node test/parse.js [path/to/ride.fit]
//
// Runs the parser against a real FIT file when one is present, and falls back
// to the synthetic ride when it is not, so the test stays runnable in a clean
// checkout. Drop files into test/fixtures/ and they are picked up.
//
// The point of the real-file path is the cross-check: head units and
// Intervals.icu already publish NP, TSS and IF in the session message, so we
// get a free oracle for the three numbers everything downstream is built on.
// If those drift, nothing further in the app is trustworthy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRide } from '../src/ingest/metrics.js';
import { buildVerdict } from '../src/engine/verdict.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

function findFixture() {
  const arg = process.argv[2];
  if (arg) return arg;
  if (!fs.existsSync(FIXTURES)) return null;
  const f = fs.readdirSync(FIXTURES).filter((x) => x.toLowerCase().endsWith('.fit'));
  return f.length ? path.join(FIXTURES, f[0]) : null;
}

// --- synthetic fallback ------------------------------------------------
// Same block structure as the original stand-in. Kept because it is
// deterministic, and because a failing real file should not stop the suite
// from telling you whether the maths still works.

function syntheticSamples(ftp) {
  const blocks = [
    { secs: 187, watts: 70 }, { secs: 600, watts: 168 }, { secs: 420, watts: 232 },
    { secs: 180, watts: 110 }, { secs: 180, watts: 238 }, { secs: 150, watts: 105 },
    { secs: 640, watts: 229 }, { secs: 300, watts: 205 }, { secs: 900, watts: 172 },
    { secs: 600, watts: 150 }, { secs: 400, watts: 130 }, { secs: 30, watts: 480 },
    { secs: 570, watts: 120 },
  ];
  let rng = 42;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
  const samples = [];
  const start = Date.parse('2026-04-25T15:00:00Z');
  let t = 0, hr = 95;
  for (const b of blocks) {
    for (let i = 0; i < b.secs; i++) {
      const power = Math.max(0, Math.round(b.watts * (1 + rand() * 0.18)));
      const targetHr = 70 + (b.watts / ftp) * 105 + (t / 3600) * 6;
      hr += (targetHr - hr) * 0.02;
      samples.push({ t: new Date(start + t * 1000), power, hr: Math.round(hr + rand() * 2),
                     speed: 8 + power / 40, cadence: 88 });
      t++;
    }
  }
  return samples;
}

// --- real file ---------------------------------------------------------

async function loadFit(file) {
  const { default: FitParser } = await import('fit-file-parser');
  const buffer = fs.readFileSync(file);
  const parser = new FitParser({
    force: true, speedUnit: 'm/s', lengthUnit: 'm',
    temperatureUnit: 'celsius', elapsedRecordField: false, mode: 'list',
  });
  return new Promise((resolve, reject) => {
    parser.parse(buffer, (err, data) => (err ? reject(new Error(err)) : resolve(data)));
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toSamples(records) {
  return records
    .filter((r) => r.timestamp)
    .map((r) => ({
      t: r.timestamp,
      power: num(r.power), hr: num(r.heart_rate), cadence: num(r.cadence),
      speed: num(r.speed), distance: num(r.distance),
      altitude: num(r.altitude ?? r.enhanced_altitude),
    }));
}

// --- report ------------------------------------------------------------

function compare(label, ours, theirs, tolerance) {
  if (theirs == null) return `  ${label.padEnd(6)} ${String(ours).padStart(7)}   (device did not report)`;
  const delta = ours - theirs;
  const pct = theirs ? Math.abs(delta / theirs) * 100 : 0;
  const verdict = pct <= tolerance ? 'ok' : 'DRIFT';
  return `  ${label.padEnd(6)} ours ${String(ours).padStart(7)}  device ${String(theirs).padStart(7)}  ` +
         `delta ${(delta >= 0 ? '+' : '') + delta.toFixed(2)} (${pct.toFixed(1)}%)  ${verdict}`;
}

const file = findFixture();

if (!file) {
  console.log('No .fit fixture found. Using the synthetic ride.');
  console.log('Drop a file into test/fixtures/ or pass a path as argv[2].\n');
  const FTP = 240;
  const { ride, quality } = buildRide(syntheticSamples(FTP), { ftp: FTP, maxHr: 198 });
  report(ride, quality, null, { ftp: FTP, maxHr: 198 });
} else {
  console.log(`fixture: ${path.basename(file)}\n`);
  const data = await loadFit(file);
  const session = data.sessions?.[0] || {};

  // The head unit's own FTP is better evidence than any default. If the file
  // carries one, use it — a parser run against the wrong FTP produces zone
  // times and TSS that look plausible and are wrong.
  const ftp = num(session.threshold_power) ?? 240;
  // No FIT field for max HR, so infer a floor from the ride itself and say so.
  const observedMaxHr = Math.max(
    0, ...data.records.map((r) => num(r.heart_rate) ?? 0)
  );
  const athlete = { ftp, maxHr: observedMaxHr || 198 };

  console.log(`athlete: FTP ${ftp} (from file), maxHr ${athlete.maxHr} ` +
              `(highest HR in THIS ride — a floor, not a true max)\n`);

  const { ok, ride, quality, reason } = buildRide(toSamples(data.records), athlete);
  if (!ok) { console.log('parse failed:', reason); process.exit(1); }

  report(ride, quality, { session, laps: data.laps || [] }, athlete);
}

function report(ride, quality, device, athlete) {
  if (device) {
    console.log('=== CROSS-CHECK AGAINST DEVICE ===');
    console.log(compare('NP', ride.np, num(device.session.normalized_power), 2));
    console.log(compare('TSS', ride.tss, num(device.session.training_stress_score), 3));
    console.log(compare('IF', ride.if, num(device.session.intensity_factor), 2));
    console.log(compare('mins', ride.durationMin,
      num(device.session.total_timer_time) ? Number((device.session.total_timer_time / 60).toFixed(1)) : null, 3));
    console.log('');
  }

  console.log('=== PARSED RIDE ===');
  console.log(JSON.stringify({
    date: ride.date, durationMin: ride.durationMin, elapsedMin: ride.elapsedMin,
    np: ride.np, tss: ride.tss, if: ride.if, decouplingPct: ride.decouplingPct,
    wPrimeKj: ride.wPrimeKj, hrRedzoneSecs: ride.hrRedzoneSecs,
    zoneMinutes: ride.zoneMinutes, hrZoneMinutes: ride.hrZoneMinutes,
  }, null, 2));

  console.log('\n=== QUALITY ===');
  console.log(JSON.stringify(quality));

  console.log('\n=== DETECTED INTERVALS ===');
  for (const i of ride.intervals) {
    console.log(`  ${String(i.type).padEnd(14)} ${String(i.durationSecs).padStart(5)}s  ${i.averagePower}W`);
  }

  if (device?.laps?.length) {
    // Laps recorded on the head unit are evidence of intent; our segmentation
    // is inference. Printed side by side because the gap between them is the
    // honest measure of how well detectIntervals() is doing.
    console.log('\n=== DEVICE LAPS (ground truth for intent) ===');
    for (const l of device.laps) {
      if (!(l.total_timer_time > 0)) continue;
      console.log(`  ${String(Math.round(l.total_timer_time)).padStart(5)}s  ` +
        `${String(l.avg_power ?? '?').padStart(4)}W  max ${String(l.max_power ?? '?').padStart(4)}W  ` +
        `${l.intensity ?? ''}`);
    }
    const work = ride.intervals.filter(
      (i) => ['Z3_Tempo', 'Z4_Threshold', 'Z5_VO2Max', 'Z6_Anaerobic'].includes(i.type) && i.durationSecs >= 60
    ).length;
    const active = device.laps.filter((l) => l.intensity === 'active').length;
    console.log(`\n  detected work intervals ${work}  vs  device active laps ${active}`);
  }

  const v = buildVerdict({ ride, history: [], daily: [], athlete, prescribed: null });
  console.log('\n=== ENGINE ===');
  console.log(`  ${v.sessionType} | ${v.classificationConfidence} | ${v.intentMatch} | ${v.verdict}`);
  console.log('  reasons: ' + v.classificationReasons.join('; '));
  console.log('  flags:   ' + (v.executionFlags.map((f) => f.code).join(', ') || 'none'));
  for (const f of v.executionFlags) console.log(`    - ${f.detail}`);
}
