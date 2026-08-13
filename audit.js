// Measures where narration actually lands across a set of verdicts.
//
// The question this answers: of N real verdicts, how many come back as
// `model`, how many needed a repair pass, and how many fell through to
// `renderTemplate()`? Until that ratio is known there is no way to tell
// whether the prompt or the guard is the limiting factor, and tuning either
// one is guesswork.
//
// Deliberately generator-agnostic — pass the WebLLM generate() in a browser,
// or an injected one in node. The harness has no opinion about which.

import { narrate } from './narration.js';
import { validateNarration } from './guard.js';

/**
 * @param {object} opts
 *   verdicts  - [{ name, verdict }]
 *   generate  - the generate fn under test (or null, to measure the floor)
 *   runs      - repeats per verdict; >1 exposes sampling variance
 *   repair    - passed through to narrate()
 *   timeoutMs - passed through to narrate()
 */
export async function auditSources(opts) {
  const {
    verdicts, generate, runs = 1, repair = true,
    timeoutMs = 20000, onProgress = () => {},
  } = opts;

  const rows = [];
  const total = verdicts.length * runs;
  let done = 0;

  for (const { name, verdict } of verdicts) {
    for (let i = 0; i < runs; i++) {
      const events = [];
      const t0 = Date.now();
      const r = await narrate(verdict, {
        generate, repair, timeoutMs,
        onEvent: (e) => events.push(e),
      });
      const ms = Date.now() - t0;

      // Re-validate model-sourced text only. The guard is scoped to what the
      // MODEL may say, not to what the engine may say: renderTemplate() cites
      // FTP, r², 7-day TSS and the classification reasons, none of which are
      // in the prompt and all of which the guard would reject. That is correct
      // in both directions — the template is licensed by construction, so
      // running it through a model-scoped guard measures nothing.
      const shown =
        r.source === 'template'
          ? { violations: [], words: r.text.trim().split(/\s+/).filter(Boolean).length }
          : validateNarration(r.text, verdict);

      rows.push({
        scenario: name,
        run: i + 1,
        source: r.source,
        reason: r.reason ?? null,
        ms,
        words: shown.words,
        // Every token the guard objected to at any stage, first pass included.
        rejected: events
          .flatMap((e) => e.violations || [])
          .map((v) => ({ kind: v.kind, token: v.token, detail: v.detail })),
        shownViolations: shown.violations,
      });
      onProgress({ done: ++done, total, scenario: name, source: r.source });
    }
  }

  return { rows, summary: summarise(rows) };
}

function summarise(rows) {
  const bySource = tally(rows.map((r) => r.source));
  const byReason = tally(rows.filter((r) => r.reason).map((r) => r.reason));

  // Which guard rule is doing the rejecting. This is the number that says
  // whether to tune the prompt (mostly fabricated_number -> the model is not
  // reading the EVIDENCE block) or the guard itself (mostly length, or the
  // same legitimate token recurring).
  const byKind = tally(rows.flatMap((r) => r.rejected.map((v) => v.kind)));
  const byToken = tally(
    rows.flatMap((r) =>
      r.rejected.filter((v) => v.kind === 'fabricated_number').map((v) => v.token)
    )
  );
  const signErrors = rows.flatMap((r) =>
    r.rejected.filter((v) => v.detail?.includes('wrong sign'))
  ).length;

  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const repaired = rows.filter((r) => r.source === 'model_repaired').length;
  const repairAttempts = rows.filter(
    (r) => r.source === 'model_repaired' || r.reason === 'repair_rejected' || r.reason === 'repair_failed'
  ).length;

  // Prose that reached the athlete but still violates. Should be zero — a
  // non-zero count here means either the length band is wrong for the
  // template renderer, or something is escaping validation.
  const shownDirty = rows.filter((r) =>
    r.shownViolations.some((v) => v.kind !== 'length')
  ).length;

  return {
    n: rows.length,
    bySource,
    byReason,
    rejectionsByKind: byKind,
    rejectedTokens: byToken,
    signErrors,
    repairSuccessRate: repairAttempts ? Number((repaired / repairAttempts).toFixed(2)) : null,
    repairAttempts,
    medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
    p90Ms: times.length ? times[Math.floor(times.length * 0.9)] : null,
    shownWithViolations: shownDirty,
  };
}

function tally(xs) {
  const out = {};
  for (const x of xs) out[x] = (out[x] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

// Reads the summary and says what to do about it. The thresholds are
// judgement calls, not physiology — argue with them freely.
export function interpret(summary) {
  const n = summary.n || 1;
  const pct = (k) => (summary.bySource[k] || 0) / n;
  const notes = [];

  if (pct('template') > 0.3) {
    const kinds = Object.keys(summary.rejectionsByKind);
    notes.push(
      kinds[0] === 'fabricated_number'
        ? 'Template rate is high and the failures are fabricated numbers — the model is not treating EVIDENCE as a closed set. Tighten rule 1 in the system prompt before loosening the guard.'
        : `Template rate is high and the dominant failure is "${kinds[0]}" — that is a prompt-format problem, not a numeracy one.`
    );
  } else if (pct('model') > 0.8) {
    notes.push('Model output is passing cleanly. The guard is not the limiting factor; leave it alone.');
  }

  if (summary.repairAttempts >= 5 && summary.repairSuccessRate != null && summary.repairSuccessRate < 0.5) {
    notes.push(
      `Repairs succeed ${Math.round(summary.repairSuccessRate * 100)}% of the time across ${summary.repairAttempts} attempts. A second inference pass is not paying for itself — set repair: false and go straight to template.`
    );
  }

  if (summary.signErrors > 0) {
    notes.push(
      `${summary.signErrors} sign errors on TSB. The guard caught them, but the model is clearly not reading the minus — drop TSB from buildNarrationPrompt and pass load.state alone.`
    );
  }

  const single = Object.entries(summary.rejectedTokens)[0];
  if (single && single[1] >= 3) {
    notes.push(
      `Token "${single[0]}" was rejected ${single[1]} times. If that number is legitimately derivable from the evidence, the allowlist is too narrow rather than the model too loose.`
    );
  }

  if (summary.shownWithViolations > 0) {
    notes.push(
      `${summary.shownWithViolations} outputs reached the athlete while still violating. Investigate before anything else — the fallback is meant to be unconditionally safe.`
    );
  }

  if (summary.p90Ms > 8000) {
    notes.push(`p90 latency ${summary.p90Ms}ms. On device that is a visible wait; consider dropping repair or streaming the template first.`);
  }

  return notes.length ? notes : ['Nothing stands out. Widen the scenario set or the run count.'];
}

export function formatReport(summary) {
  const lines = [];
  const n = summary.n;
  const bar = (c) => '█'.repeat(Math.round((c / n) * 30));
  lines.push(`n = ${n}`);
  lines.push('');
  for (const [k, c] of Object.entries(summary.bySource)) {
    lines.push(`  ${k.padEnd(15)} ${String(c).padStart(3)}  ${String(Math.round((c / n) * 100)).padStart(3)}%  ${bar(c)}`);
  }
  if (Object.keys(summary.byReason).length) {
    lines.push('', '  fallback reasons:');
    for (const [k, c] of Object.entries(summary.byReason)) lines.push(`    ${k.padEnd(20)} ${c}`);
  }
  if (Object.keys(summary.rejectionsByKind).length) {
    lines.push('', '  rejections by kind:');
    for (const [k, c] of Object.entries(summary.rejectionsByKind)) lines.push(`    ${k.padEnd(20)} ${c}`);
  }
  if (Object.keys(summary.rejectedTokens).length) {
    lines.push('', '  rejected tokens: ' +
      Object.entries(summary.rejectedTokens).map(([t, c]) => `${t}(${c})`).join(' '));
  }
  lines.push('');
  lines.push(`  repair attempts ${summary.repairAttempts}, success rate ${summary.repairSuccessRate ?? 'n/a'}`);
  lines.push(`  sign errors ${summary.signErrors}   shown-with-violations ${summary.shownWithViolations}`);
  lines.push(`  latency median ${summary.medianMs}ms  p90 ${summary.p90Ms}ms`);
  return lines.join('\n');
}
