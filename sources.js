// node test/sources.js [--runs N] [--no-repair] [--seed N]
//
// Runs the source audit against a MOCK generator. The ratios this prints are
// NOT a measurement of any model — the mock's fault rate is a number I chose.
// What it measures is the plumbing: that every failure mode reaches the right
// terminal state, that the summary arithmetic is right, and that the scenario
// set exercises the guard rules you care about.
//
// The real number comes from test/sources.html, which runs this same audit
// against WebLLM in a browser. Compare the two: the shapes should differ, and
// if they do not, the mock is being flattered.

import { auditSources, formatReport, interpret } from '../src/llm/audit.js';
import { scenarios } from './scenarios.js';
import { renderTemplate } from '../src/llm/narrate.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const RUNS = flag('runs', 3);
const REPAIR = !args.includes('--no-repair');
let seed = flag('seed', 7);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// Faults the mock injects, at roughly the rates a small model produces them.
// Sign inversion is over-represented on purpose: it is the one failure the
// guard exists to catch, and a run with zero of them proves nothing.
const FAULTS = [
  { p: 0.22, name: 'invent_number' },
  { p: 0.16, name: 'flip_tsb_sign' },
  { p: 0.10, name: 'mention_ftp' },
  { p: 0.07, name: 'bullet_list' },
  { p: 0.05, name: 'too_short' },
];

function mockGenerate(prompt) {
  // Reconstruct plausible prose from the prompt the way a model would: it can
  // only see the EVIDENCE block, so that is all the mock reads.
  const evidence = (prompt.user.match(/^- .+$/gm) || []).map((l) => l.slice(2));
  const tsb = prompt.user.match(/TSB (-?\d+(?:\.\d+)?)/)?.[1] ?? '0';
  const ctl = prompt.user.match(/CTL (-?\d+(?:\.\d+)?)/)?.[1] ?? '0';
  const repairing = prompt.user.includes('previous attempt was rejected');

  let text =
    `You got through this one and the session did what it was built to do. ` +
    evidence.map((e) => `The numbers show ${e.replace(/^([^:]+): /, '$1 of ')}.`).join(' ') +
    ` Taken together that is a real stimulus rather than a token one, and the ` +
    `way the effort was distributed across the ride matters as much as the ` +
    `total. With CTL at ${ctl} and TSB at ${tsb}, the balance between what you ` +
    `have built and what you are currently carrying is the thing to watch over ` +
    `the coming days. Let the next few sessions sit easier so the work you have ` +
    `already done has somewhere to land, and come back to intensity when the ` +
    `markers say you are ready rather than when the calendar does.`;

  // A repair pass is where a real model mostly complies. Mostly.
  const faultScale = repairing ? 0.25 : 1;
  for (const f of FAULTS) {
    if (rand() >= f.p * faultScale) continue;
    if (f.name === 'invent_number') text += ` Your 5-minute power sat around 274W for that block.`;
    if (f.name === 'flip_tsb_sign') text = text.replace(`TSB at ${tsb}`, `TSB at +${tsb.replace('-', '')}`);
    if (f.name === 'mention_ftp') text += ` That points to an FTP that is trending upward.`;
    if (f.name === 'bullet_list') text = `- Session summary\n` + text;
    if (f.name === 'too_short') text = text.split(' ').slice(0, 40).join(' ');
  }
  return text;
}

const cases = scenarios();

console.log(`scenarios ${cases.length}  runs ${RUNS}  repair ${REPAIR}\n`);

// Floor first: what the athlete sees when there is no model at all. Every
// number in the run below has to be read against this.
const floor = await auditSources({ verdicts: cases, generate: null, runs: 1 });
console.log('--- no generator (template floor) ---');
console.log(formatReport(floor.summary));

const { rows, summary } = await auditSources({
  verdicts: cases,
  generate: async (p) => mockGenerate(p),
  runs: RUNS,
  repair: REPAIR,
});

console.log('\n--- mock generator ---');
console.log(formatReport(summary));

console.log('\n--- per scenario ---');
const byScenario = {};
for (const r of rows) {
  (byScenario[r.scenario] ||= []).push(r.source);
}
for (const [name, sources] of Object.entries(byScenario)) {
  const counts = sources.reduce((a, s) => ((a[s] = (a[s] || 0) + 1), a), {});
  console.log(
    `  ${name.padEnd(32)} ` +
      ['model', 'model_repaired', 'template']
        .map((k) => `${k.split('_')[0][0].toUpperCase()}${(k.split('_')[1] || '').slice(0, 3)}:${counts[k] || 0}`)
        .join('  ')
  );
}

console.log('\n--- reading ---');
for (const n of interpret(summary)) console.log(`  * ${n}`);

// Not a pass/fail check. The template legitimately cites things the model may
// not — FTP, r², 7-day TSS — so it "fails" a model-scoped guard by design.
// Printed as a reminder of that asymmetry, and because a sudden change in the
// count means renderTemplate() started saying something new.
console.log('\n--- template scope (expected non-zero) ---');
const { validateNarration } = await import('../src/llm/guard.js');
for (const c of cases) {
  const r = validateNarration(renderTemplate(c.verdict), c.verdict);
  const fatal = r.violations.filter((v) => v.kind !== 'length');
  console.log(`  ${c.name.padEnd(32)} ${String(fatal.length).padStart(2)} guard-external claims, ${r.words} words`);
}
