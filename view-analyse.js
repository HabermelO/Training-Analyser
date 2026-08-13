// Analyse: upload a ride, see what it was and how it went.
//
// The two-pass parse matters and is not an optimisation. Peak powers, heart
// rate, duration and normalised power need no threshold, so the file is read
// cold first; the profile is derived from that evidence, and only then is the
// ride recomputed with zones, TSS and classification. Assuming a threshold in
// order to compute the evidence that produces it would be circular, and the
// resulting numbers look completely plausible while being wrong.

import { parseFitFile } from './ingest.js';
import { store, summariseRide } from './store.js';
import { deriveAthlete } from './athlete.js';
import { buildVerdict } from './verdict.js';
import { proposeFromRide, acceptProposal, rejectProposal } from './proposals.js';
import { assessThresholdStanding, allowDownwardProposal } from './standing.js';
import { narrate } from './narration.js';
import { createGenerator } from './webllm.js';
import { zoneBars } from './charts.js';
import {
  el, card, stat, statRow, button, toast, badge, note, fmt, clear, empty,
} from './ui.js';

const ZONE_TONES = {
  Z1_Recovery: 'var(--recovery)', Z2_Endurance: 'var(--endurance)',
  Z3_Tempo: 'var(--tempo)', Z4_Threshold: 'var(--threshold)',
  Z5_VO2Max: 'var(--vo2)', Z6_Anaerobic: 'var(--vo2)',
};

let generator; // undefined = not tried, null = unavailable on this device

export function renderAnalyse(root, ctx) {
  clear(root);

  const drop = el('div', 'dropzone');
  drop.tabIndex = 0;
  drop.setAttribute('role', 'button');
  drop.append(el('div', 'dropzone-icon', '↑'));
  drop.append(el('strong', null, 'Add a ride'));
  drop.append(el('span', 'dropzone-hint', 'Drop a .fit file here, or click to choose one'));

  // The input lives outside the drop zone. Nested inside, its own click event
  // bubbles up to the zone's handler, which calls click() on it again;
  // browsers suppress the loop and the picker silently never opens.
  const picker = el('input');
  picker.type = 'file';
  picker.accept = '.fit,application/octet-stream';
  picker.className = 'visually-hidden';

  drop.addEventListener('click', (e) => { if (e.target !== picker) picker.click(); });
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); }
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = e.dataTransfer.files?.[0];
    if (f) ingest(f, root, ctx, results);
  });
  picker.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';   // or picking the same file twice fires no event
    if (f) ingest(f, root, ctx, results);
  });

  const results = el('div', 'results');
  root.append(drop, picker, results);

  const last = store.rides().slice(-1)[0];
  if (last && ctx.lastVerdict) {
    renderVerdict(results, ctx.lastVerdict, ctx.lastRide, ctx);
  } else if (last) {
    results.append(empty(
      'Your last ride is saved',
      'Upload it again to see the full analysis, or add a new one. Rides are summarised when stored, so the detailed view is rebuilt from the file.',
    ));
  }
}

async function ingest(file, root, ctx, results) {
  if (!/\.fit$/i.test(file.name)) {
    return toast('That is not a .fit file. Export the ride from your head unit or Strava.', 'warn');
  }

  clear(results);
  results.append(el('div', 'loading', 'Reading the file…'));

  try {
    const overrides = store.profile();

    const first = await parseFitFile(file, { ftp: 1, maxHr: 1 });
    if (!first.ok) throw new Error(first.reason);

    const stub = {
      date: first.ride.date,
      peakPowers: first.ride.peakPowers,
      maxHr: first.ride.maxHrSustained30s,
      declaredFtp: first.declaredFtp ?? null,
    };

    const history = store.rides().filter((r) => r.date !== stub.date);
    const profile = deriveAthlete([...history, stub], overrides);

    const final = profile.ftp
      ? await parseFitFile(file, { ftp: profile.ftp, maxHr: profile.maxHr, hrZones: profile.hrZones })
      : first;

    const ride = { ...final.ride, declaredFtp: stub.declaredFtp };
    const verdict = buildVerdict({
      ride,
      history,
      daily: store.wellness(),
      athlete: profile,
      prescribed: null,
    });

    store.addRide(summariseRide(ride, { adaptation: verdict.adaptation }));
    ctx.lastVerdict = verdict;
    ctx.lastRide = ride;

    clear(results);
    renderVerdict(results, verdict, ride, ctx);
    ctx.identityChanged?.();
    toast('Ride analysed');
  } catch (e) {
    clear(results);
    results.append(note(`That file could not be read: ${e.message}`, 'warn'));
    console.error(e);
  }
}

function renderVerdict(root, verdict, ride, ctx) {
  const profile = deriveAthlete(store.rides(), store.profile());

  if (verdict.status === 'calibrating') {
    const c = card('This ride', { hint: fmt.longDate(ride.date) });
    c.body.append(statRow([
      stat('Duration', fmt.int(ride.durationMin), { unit: 'min' }),
      stat('Normalised power', fmt.int(ride.np), { unit: 'W', tone: 'np' }),
      stat('Best 20 min', fmt.int(ride.peakPowers?.['20m']?.power), { unit: 'W', tone: 'ftp' }),
    ]));
    root.append(c);

    const waiting = card('Threshold not set');
    waiting.body.append(note(verdict.message));
    root.append(waiting);
    return;
  }

  // --- headline ------------------------------------------------------
  const head = card('This ride', { hint: fmt.longDate(ride.date) });
  head.body.append(statRow([
    stat('Duration', fmt.int(ride.durationMin), { unit: 'min' }),
    stat('Normalised power', fmt.int(ride.np), { unit: 'W', tone: 'np' }),
    stat('Training stress', fmt.int(ride.tss), { tone: 'tss' }),
    stat('Intensity', fmt.dec(ride.if, 2), {}),
    stat('Fitness', fmt.dec(verdict.load.ctl), { tone: 'ctl' }),
    stat('Form', fmt.signed(verdict.load.tsb), { tone: 'tsb' }),
  ]));
  root.append(head);

  // --- verdict -------------------------------------------------------
  const v = card('Verdict');
  const headline = el('div', 'verdict-headline');
  headline.append(el('span', 'verdict-type', fmt.title(verdict.sessionType)));
  headline.append(badge(fmt.title(verdict.verdict), toneForVerdict(verdict.verdict)));
  headline.append(badge(`${fmt.title(verdict.classificationConfidence)} confidence`, 'neutral'));
  v.body.append(headline);

  if (verdict.classificationReasons?.length) {
    v.body.append(el('p', 'note', verdict.classificationReasons.join('; ')));
  }
  if (verdict.executionFlags.length) {
    const ul = el('ul', 'flags');
    for (const f of verdict.executionFlags) {
      const li = el('li', `flag flag-${toneForFlag(f.code)}`);
      li.append(el('span', 'flag-name', fmt.title(f.code)));
      li.append(el('span', 'flag-detail', f.detail));
      ul.append(li);
    }
    v.body.append(ul);
  }
  root.append(v);

  // --- time in zone --------------------------------------------------
  if (ride.zoneMinutes && Object.keys(ride.zoneMinutes).length) {
    const z = card('Where the time went');
    z.body.append(zoneBars(ride.zoneMinutes, { tones: ZONE_TONES }));
    root.append(z);
  }

  // --- narration -----------------------------------------------------
  const prose = card('Summary');
  const box = el('div', 'prose');
  box.append(el('p', 'muted', 'Writing…'));
  prose.body.append(box);
  root.append(prose);
  writeNarration(box, verdict);

  // --- proposals -----------------------------------------------------
  renderProposals(root, ride, profile, ctx);
}

async function writeNarration(box, verdict) {
  if (generator === undefined) {
    generator = await createGenerator({
      onProgress: ({ progress }) => {
        clear(box);
        box.append(el('p', 'muted', `Loading the on-device writer, ${Math.round(progress * 100)}%…`));
      },
      onUnsupported: () => { /* narrate() falls through to the template */ },
    });
  }
  const { text, source } = await narrate(verdict, { generate: generator });
  clear(box);
  for (const para of text.split(/\n{2,}/)) box.append(el('p', null, para));
  box.append(el('span', 'prose-source',
    source === 'template' ? 'Written by the rules engine' : 'Written on this device'));
}

function renderProposals(root, ride, profile, ctx) {
  const rides = store.rides();
  const standing = assessThresholdStanding(rides, profile);
  let proposals = proposeFromRide(ride, profile, store.decisions());

  // A single decoupled effort must not talk a threshold down while efficiency
  // across ordinary training says nothing is wrong.
  if (!allowDownwardProposal(standing)) {
    proposals = proposals.filter((p) => p.direction !== 'down');
  }
  if (standing.proposal) proposals = [standing.proposal, ...proposals];

  if (standing.message && standing.standing !== 'unknown') {
    const s = card('Threshold standing');
    s.body.append(el('div', 'standing-head')).append(
      badge(fmt.title(standing.standing), standing.standing === 'holding' ? 'good' : 'signal'));
    s.body.append(el('p', null, standing.message));
    if (standing.action?.suggestion) s.body.append(note(standing.action.suggestion, 'signal'));
    root.append(s);
  }

  if (!proposals.length) return;

  const c = card('Suggested changes', { hint: 'Nothing changes unless you accept' });
  for (const p of proposals) {
    const box = el('div', 'proposal');
    const h = el('div', 'proposal-head');
    h.append(el('span', 'proposal-field', p.field === 'ftp' ? 'Threshold power' : 'Max heart rate'));
    h.append(el('span', 'proposal-change', `${p.current ?? '—'} → ${p.proposed}`));
    h.append(badge(fmt.title(p.confidence), p.confidence === 'good' ? 'good' : 'signal'));
    box.append(h);
    box.append(el('p', 'proposal-why', p.rationale));
    if (p.caution) box.append(note(p.caution, 'signal'));
    box.append(el('p', 'proposal-affects', `Affects ${p.affects}`));

    const actions = el('div', 'actions');
    actions.append(button('Accept', {
      variant: 'primary',
      onClick: () => {
        const { profile: next, decision } = acceptProposal(profile, p);
        store.addDecision(decision);
        store.patchProfile({
          [decision.field]: decision.proposed,
          confirmedFtp: next.confirmedFtp,
          ftpSetAt: next.ftpSetAt,
          lastBumpAt: next.lastBumpAt,
        });
        toast(`${p.field === 'ftp' ? 'Threshold' : 'Max heart rate'} set to ${p.proposed}`);
        ctx.refresh();
      },
    }));
    actions.append(button('Not now', {
      onClick: () => {
        store.addDecision(rejectProposal(profile, p).decision);
        toast('Noted. This will not come up again for a while.');
        box.remove();
      },
    }));
    box.append(actions);
    c.body.append(box);
  }
  root.append(c);
}

const toneForVerdict = (v) =>
  ({ executed_well: 'good', recovery_clean: 'good', productive_but_ragged: 'signal',
     off_plan: 'signal', recovery_compromised: 'warn', overreached_for_the_zone: 'warn' }[v] || 'neutral');

const toneForFlag = (code) =>
  ({ engine_stable: 'good', efficient_output: 'good', recovery_discipline: 'good',
     aerobic_drift: 'warn', high_cardiac_strain: 'warn', recovery_surge: 'warn' }[code] || 'signal');
