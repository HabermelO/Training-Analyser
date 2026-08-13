// Wires the pieces together in the order the manifest describes:
//   parse -> derive profile -> verdict -> proposals -> narration
//
// Rides and decisions are kept in localStorage. That is deliberate for a first
// deployment: the whole point of the app is that nothing leaves the device, and
// a key-value store is enough until the ride count makes it awkward.

import { parseFitFile } from './ingest/index.js';
import { deriveAthlete, explainProfile } from './engine/athlete.js';
import { buildVerdict } from './engine/verdict.js';
import { proposeFromRide, acceptProposal, rejectProposal, onboardingProfile } from './engine/proposals.js';
import { assessThresholdStanding, allowDownwardProposal } from './engine/standing.js';
import { narrate } from './llm/index.js';
import { createGenerator } from './llm/webllm.js';

const KEY = { rides: 'rides.v1', decisions: 'decisions.v1', profile: 'profile.v1' };

const load = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let state = {
  rides: load(KEY.rides, []),
  decisions: load(KEY.decisions, []),
  overrides: load(KEY.profile, {}),
  generator: undefined,   // undefined = not tried yet, null = unavailable
};

// --- onboarding --------------------------------------------------------

function readOverrides() {
  const ftp = Number($('ftp').value) || null;
  const maxHr = Number($('maxhr').value) || null;
  const o = {};
  if (ftp) o.ftp = ftp;
  if (maxHr) o.maxHr = maxHr;
  // A number the athlete typed is demonstrated by definition, so it anchors
  // the drift cap in standing.js.
  if (ftp) { o.confirmedFtp = ftp; o.ftpSetAt = new Date().toISOString(); }
  return o;
}

function syncOnboarding() {
  state.overrides = { ...state.overrides, ...readOverrides() };
  save(KEY.profile, state.overrides);
  $('onboarding-note').textContent = onboardingProfile(state.overrides).note;
}

$('ftp').value = state.overrides.ftp ?? '';
$('maxhr').value = state.overrides.maxHr ?? '';
$('ftp').addEventListener('change', syncOnboarding);
$('maxhr').addEventListener('change', syncOnboarding);
syncOnboarding();

// --- file intake -------------------------------------------------------

const drop = $('drop');
const filePicker = $('file');

// The input lives outside the drop zone in the markup, so this cannot loop
// back on itself. Keeping the guard anyway: if the markup is ever changed to
// nest it, the failure is silent and very hard to spot.
drop.addEventListener('click', (e) => {
  if (e.target === filePicker) return;
  filePicker.click();
});
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filePicker.click(); }
});
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files?.[0];
  if (f) handleFile(f);
});
filePicker.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
  // Reset, or selecting the same file twice in a row fires no change event.
  e.target.value = '';
});

async function handleFile(file) {
  try {
    await ingest(file);
  } catch (e) {
    // Anything unexpected reaches the page rather than only the console.
    status(`Something went wrong reading that ride: ${e?.message || e}`);
    console.error(e);
  }
}

async function ingest(file) {
  if (!/\.fit$/i.test(file.name)) {
    return status('That is not a .fit file. Export the ride from your head unit or Strava and try again.');
  }
  status('Reading…');

  // Two-pass, and the order matters. The first pass computes only the things
  // that need no profile — peak powers, heart rate, duration, NP — because a
  // threshold cannot be assumed before it has been derived. The profile comes
  // out of that evidence, and only then is the ride recomputed properly.
  let first;
  try {
    first = await parseFitFile(file, { ftp: 1, maxHr: 1 });
  } catch (e) {
    return status(`Could not read that file: ${e.message}`);
  }
  if (!first.ok) return status(`Could not read that file: ${first.reason}`);

  const stub = {
    date: first.ride.date,
    peakPowers: first.ride.peakPowers,
    maxHr: first.ride.maxHrSustained30s,
    declaredFtp: first.declaredFtp ?? null,
  };

  const profile = deriveAthlete([...state.rides, stub], state.overrides);

  const final = profile.ftp
    ? await parseFitFile(file, { ftp: profile.ftp, maxHr: profile.maxHr, hrZones: profile.hrZones })
    : first;

  const ride = { ...final.ride, declaredFtp: stub.declaredFtp };

  state.rides = [...state.rides.filter((r) => r.date !== ride.date), summarise(ride)]
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  save(KEY.rides, state.rides);

  status('');
  render(ride, profile, final.quality);
}

// Only what the engine needs later, so localStorage does not fill with
// second-by-second data it will never read again.
const summarise = (ride) => ({
  date: ride.date,
  durationMin: ride.durationMin,
  tss: ride.tss,
  peakPowers: ride.peakPowers,
  maxHr: ride.maxHrSustained30s,
  efficiencyByZone: ride.efficiencyByZone,
  declaredFtp: ride.declaredFtp,
  adaptation: ride.adaptation,
});

const status = (msg) => { $('status').textContent = msg; };

// --- render ------------------------------------------------------------

async function render(ride, profile, quality) {
  const out = $('results');
  out.innerHTML = '';
  out.classList.remove('hidden');

  const verdict = buildVerdict({
    ride,
    history: state.rides.slice(0, -1),
    daily: [],
    athlete: profile,
    prescribed: null,
  });

  // Calibrating is a real state, not an error. Show what is known and say
  // plainly what is waiting on a threshold.
  if (verdict.status === 'calibrating') {
    out.append(section('This ride', metrics([
      ['Duration', `${verdict.ride.durationMin}<small> min</small>`],
      ['Normalised power', `${verdict.ride.np ?? '—'}<small>W</small>`],
      ['Best 20 min', ride.peakPowers?.['20m']?.power ? `${ride.peakPowers['20m'].power}<small>W</small>` : '—'],
    ])));
    const b = el('div', 'banner');
    b.append(el('h3', null, 'Threshold not set'));
    b.append(el('p', null, esc(verdict.message)));
    out.append(b);
  } else {
    out.append(section('This ride', metrics([
      ['Duration', `${Math.round(ride.durationMin)}<small> min</small>`],
      ['NP', `${ride.np}<small>W</small>`],
      ['TSS', String(ride.tss)],
      ['IF', String(ride.if)],
      ['CTL', verdict.load.ctl ?? '—'],
      ['TSB', verdict.load.tsb ?? '—'],
    ])));

    out.append(section('Verdict', (() => {
      const wrap = el('div');
      wrap.append(el('p', null,
        `<strong>${esc(verdict.sessionType.replace(/_/g, ' '))}</strong> — ${esc(verdict.verdict.replace(/_/g, ' '))}` +
        ` <span class="muted">(${esc(verdict.classificationConfidence)} confidence)</span>`));
      if (verdict.executionFlags.length) {
        const ul = el('ul', 'notes');
        for (const f of verdict.executionFlags) ul.append(el('li', null, esc(f.detail)));
        wrap.append(ul);
      }
      return wrap;
    })()));
  }

  // Profile, with its provenance. How a number was arrived at is as much a
  // part of it as its value.
  out.append(section('Your profile', (() => {
    const wrap = el('div');
    wrap.append(metrics([
      ['Threshold', profile.ftp ? `${profile.ftp}<small>W</small>` : '—'],
      ['Max HR', profile.maxHr ? `${profile.maxHr}<small> bpm</small>` : '—'],
      ['Status', `<span style="font-size:1rem">${esc(profile.status)}</span>`],
    ]));
    const ul = el('ul', 'notes');
    for (const line of explainProfile(profile)) ul.append(el('li', null, esc(line)));
    wrap.append(ul);
    return wrap;
  })()));

  renderProposals(out, ride, profile);
  renderNarration(out, verdict);

  if (quality?.gapsExcised) {
    out.append(el('p', 'muted', `${quality.gapsExcised} gap(s) excised from the file; ${quality.usablePct}% of samples usable.`));
  }
}

function renderProposals(out, ride, profile) {
  const standing = assessThresholdStanding(state.rides, profile);
  let proposals = proposeFromRide(ride, profile, state.decisions);

  // A single decoupled effort must not be able to talk a threshold down while
  // efficiency across ordinary training says nothing is wrong.
  if (!allowDownwardProposal(standing)) {
    proposals = proposals.filter((p) => p.direction !== 'down');
  }
  if (standing.proposal) proposals = [standing.proposal, ...proposals];

  if (standing.message && standing.standing !== 'unknown') {
    const b = el('div', `banner ${standing.standing === 'holding' ? 'good' : ''}`);
    b.append(el('h3', null, `Threshold ${esc(standing.standing)}`));
    b.append(el('p', null, esc(standing.message)));
    if (standing.action?.suggestion) b.append(el('p', 'caution', esc(standing.action.suggestion)));
    out.append(section('Standing', b));
  }

  if (!proposals.length) return;

  const wrap = el('div');
  for (const p of proposals) {
    const b = el('div', 'banner');
    b.append(el('h3', null, `${esc(p.field === 'ftp' ? 'Threshold' : 'Max heart rate')} ${p.current ?? '—'} → ${p.proposed}`));
    b.append(el('p', null, esc(p.rationale)));
    if (p.caution) b.append(el('p', 'caution', esc(p.caution)));

    const actions = el('div', 'actions');
    const yes = el('button', 'primary', 'Accept');
    const no = el('button', null, 'Not now');
    yes.onclick = () => decide(acceptProposal(profile, p), p);
    no.onclick = () => decide(rejectProposal(profile, p), p);
    actions.append(yes, no);
    b.append(actions);
    wrap.append(b);
  }
  out.append(section('Suggested changes', wrap));
}

function decide({ profile: next, decision }) {
  state.decisions = [...state.decisions, decision];
  save(KEY.decisions, state.decisions);
  // Accepted values become overrides so they survive a reload and outrank
  // anything modelled from here on.
  if (decision.action === 'accepted') {
    state.overrides = {
      ...state.overrides,
      [decision.field]: decision.proposed,
      confirmedFtp: next.confirmedFtp,
      ftpSetAt: next.ftpSetAt,
      lastBumpAt: next.lastBumpAt,
    };
    save(KEY.profile, state.overrides);
    $('ftp').value = state.overrides.ftp ?? '';
    $('maxhr').value = state.overrides.maxHr ?? '';
  }
  status(decision.action === 'accepted' ? 'Saved. Load the ride again to see it applied.' : 'Noted — this will not be suggested again for a while.');
  // Remove the card that was answered rather than re-rendering everything.
  document.querySelectorAll('#results .banner button').forEach((b) => { b.disabled = true; });
}

async function renderNarration(out, verdict) {
  const box = el('div', 'prose', '<span class="muted">Writing…</span>');
  out.append(section('Summary', box));

  if (state.generator === undefined) {
    state.generator = await createGenerator({
      onProgress: ({ progress }) => { box.innerHTML = `<span class="muted">Loading model ${Math.round(progress * 100)}%…</span>`; },
      onUnsupported: () => { /* narrate() falls through to the template */ },
    });
  }

  const { text, source } = await narrate(verdict, { generate: state.generator });
  box.innerHTML = '';
  for (const para of text.split(/\n{2,}/)) box.append(el('p', null, esc(para)));
  box.append(el('span', 'src', source === 'template' ? 'Written by the rules engine' : 'Written on device'));
}

function section(title, node) {
  const s = el('section');
  s.append(el('h2', null, esc(title)));
  s.append(node);
  return s;
}

function metrics(pairs) {
  const g = el('div', 'grid');
  for (const [k, v] of pairs) {
    const c = el('div', 'cell');
    c.append(el('div', 'k', esc(k)));
    c.append(el('div', 'v', String(v)));
    g.append(c);
  }
  return g;
}
