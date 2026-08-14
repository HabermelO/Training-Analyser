// Ride: add a session, see what it was and how it went.
//
// The two-pass parse matters and is not an optimisation. Peak powers, heart
// rate, duration and normalised power need no threshold, so the file is read
// cold first; the profile is derived from that evidence, and only then is the
// ride recomputed with zones, TSS and classification. Assuming a threshold in
// order to compute the evidence that produces it would be circular, and the
// resulting numbers look completely plausible while being wrong.
//
// The verdict is now stored alongside the ride summary, so a returning athlete
// sees their last analysis without the file. What is stored is the computed
// detail, not the record stream — the stream is the large part and is only
// needed to *recompute*, which this path never does.

import { parseFitFile } from './ingest.js';
import { store, summariseRide, rideDetailOf } from './store.js';
import { deriveAthlete } from './athlete.js';
import { buildVerdict } from './verdict.js';
import {
  proposeFromRide, proposeFromStanding, stalenessPrompt, acceptProposal, rejectProposal,
} from './proposals.js';
import { assessThresholdStanding, allowDownwardProposal } from './standing.js';
import { writeNarration } from './narration-view.js';
import { zoneBars } from './charts.js';
import {
  el, card, stat, statRow, button, toast, badge, note, fmt, clear, empty,
} from './ui.js';

const ZONE_TONES = {
  Z1_Recovery: 'var(--recovery)', Z2_Endurance: 'var(--endurance)',
  Z3_Tempo: 'var(--tempo)', Z4_Threshold: 'var(--threshold)',
  Z5_VO2Max: 'var(--vo2)', Z6_Anaerobic: 'var(--vo2)',
};

const RECENT_SHOWN = 8;

export function renderAnalyse(root, ctx) {
  clear(root);

  const drop = el('div', 'dropzone');
  drop.tabIndex = 0;
  drop.setAttribute('role', 'button');
  drop.append(el('div', 'dropzone-icon', '↑'));
  drop.append(el('strong', null, 'Add a ride'));
  drop.append(el('span', 'dropzone-hint', 'Drop .fit files here, or click to choose. Several at once is fine.'));

  // The input lives outside the drop zone. Nested inside, its own click event
  // bubbles up to the zone's handler, which calls click() on it again;
  // browsers suppress the loop and the picker silently never opens.
  const picker = el('input');
  picker.type = 'file';
  picker.accept = '.fit,application/octet-stream';
  picker.multiple = true;
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
    ingestAll([...(e.dataTransfer.files || [])], ctx, results);
  });
  picker.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';   // or picking the same file twice fires no event
    ingestAll(files, ctx, results);
  });

  const results = el('div', 'results');
  root.append(drop, picker, results);

  // --- what to show with no file --------------------------------------
  const rides = store.rides();
  if (!rides.length) {
    results.append(empty(
      'No rides yet',
      'Drop a .fit file above. The first one sets your baseline; after that every ride is judged against the ones before it.',
    ));
    return;
  }

  if (ctx.lastVerdict && ctx.lastRide) {
    renderRecent(results, ctx.lastRide.date, ctx);
    renderVerdict(results, ctx.lastVerdict, ctx.lastRide, ctx);
    return;
  }

  const last = [...rides].reverse().find((r) => store.rideDetail(r.date));
  if (last) {
    showStored(results, last.date, ctx);
    return;
  }

  // Rides exist but none has a stored verdict — every one of them predates
  // this being kept. Say that, rather than implying something went wrong.
  renderRecent(results, null, ctx);
  results.append(empty(
    'These rides were saved before analyses were kept',
    'Their load, form and trends are all intact — only the written verdict was discarded. Add the file again to rebuild one, or just carry on; from now on every new ride keeps its analysis.',
  ));
}

/** Rebuild a verdict from what was stored, with no file. */
function showStored(results, date, ctx) {
  const detail = store.rideDetail(date);
  if (!detail) return;

  clear(results);
  renderRecent(results, date, ctx);

  // A stored verdict was computed against the threshold in force at the time.
  // If FTP has moved since, every zone, TSS and classification in it is
  // measured against a number the athlete no longer uses. Say so — do not
  // recompute. Recomputing would rewrite the athlete's history, which is the
  // exact failure proposals.js exists to avoid.
  const current = deriveAthlete(store.rides(), store.profile()).ftp;
  if (detail.ftpUsed && current && Math.round(detail.ftpUsed) !== Math.round(current)) {
    results.append(note(
      `This analysis was worked out against a threshold of ${Math.round(detail.ftpUsed)}W. Yours is now ${Math.round(current)}W, so the zones and intensity below are what they were on the day, not what the same ride would score today. That is deliberate — the record stands as it was judged.`,
      'signal',
    ));
  }

  renderVerdict(results, detail.verdict, detail.ride, ctx);
}

/**
 * A short list of rides whose analysis is still on hand. This is the whole
 * point of storing detail: the tab is no longer a dead end that asks you to
 * upload a file you already uploaded.
 */
function renderRecent(results, activeDate, ctx) {
  const stored = store.rideDetails();
  const dates = store.rides()
    .map((r) => r.date)
    .filter((d) => stored[d])
    .reverse()
    .slice(0, RECENT_SHOWN);

  if (dates.length < 2) return;

  const c = card('Recent rides', { hint: 'Analyses kept on this device' });
  const row = el('div', 'ridepicker');
  for (const d of dates) {
    const b = el('button', `ridepick ${d === activeDate ? 'is-active' : ''}`.trim());
    b.type = 'button';
    b.setAttribute('aria-current', String(d === activeDate));
    b.append(el('span', 'ridepick-date', fmt.longDate(d)));
    const v = stored[d]?.verdict;
    if (v?.sessionType) b.append(el('span', 'ridepick-type', fmt.title(v.sessionType)));
    b.addEventListener('click', () => {
      // Switching rides invalidates the in-memory "last" pair, or the tab
      // would snap back to it on the next refresh.
      ctx.lastVerdict = null;
      ctx.lastRide = null;
      showStored(results, d, ctx);
    });
    row.append(b);
  }
  c.body.append(row);
  results.append(c);
}

// --- ingest ---------------------------------------------------------------

/**
 * A returning athlete has a backlog, so several files at once is the normal
 * case rather than the exotic one. They are processed strictly in sequence:
 * ingest.js reuses a single worker, and each ride's verdict is judged against
 * the history *including the rides before it in this batch*. Running them
 * concurrently would race that history and produce verdicts that depend on
 * which file finished first.
 */
async function ingestAll(files, ctx, results) {
  const fits = files.filter((f) => /\.fit$/i.test(f.name));
  const skipped = files.length - fits.length;

  if (!fits.length) {
    return toast(
      files.length
        ? 'None of those are .fit files. Export the ride from your head unit or Strava.'
        : 'No files there.',
      'warn',
    );
  }

  // Oldest first, so the batch builds history in the order it happened. File
  // name is a poor proxy for date, but it is the only ordering available
  // before parsing, and head units name files chronologically.
  fits.sort((a, b) => a.name.localeCompare(b.name));

  clear(results);
  const progress = el('div', 'batch');
  const label = el('div', 'batch-label');
  const bar = el('div', 'batch-bar');
  const fill = el('span', 'batch-fill');
  bar.append(fill);
  progress.append(label, bar);
  const log = el('ul', 'batch-log');
  progress.append(log);
  results.append(progress);

  const done = [];
  const failed = [];

  for (let i = 0; i < fits.length; i++) {
    const f = fits[i];
    label.textContent = fits.length === 1
      ? `Reading ${f.name}…`
      : `Reading ${f.name} — ${i + 1} of ${fits.length}`;
    fill.style.width = `${Math.round((i / fits.length) * 100)}%`;

    try {
      const out = await ingestOne(f, ctx);
      done.push(out);
      log.append(el('li', 'batch-ok', `${fmt.longDate(out.ride.date)} — ${fmt.title(out.verdict.sessionType)}, ${fmt.int(out.ride.tss)} TSS`));
    } catch (e) {
      failed.push({ name: f.name, message: e.message });
      log.append(el('li', 'batch-fail', `${f.name} — ${e.message}`));
      console.error(e);
    }
  }
  fill.style.width = '100%';

  clear(results);

  if (!done.length) {
    results.append(note(
      `Nothing could be read. ${failed.map((x) => `${x.name}: ${x.message}`).join('; ')}`,
      'warn',
    ));
    return;
  }

  // The last ride in the batch is the one worth showing — it is the most
  // recent, and it is the only one whose verdict was judged against all the
  // others.
  const lastOut = done[done.length - 1];
  ctx.lastVerdict = lastOut.verdict;
  ctx.lastRide = lastOut.ride;

  if (fits.length > 1 || failed.length || skipped) {
    const s = card('Batch complete', { hint: `${done.length} of ${fits.length} read` });
    const ul = el('ul', 'notes');
    for (const d of done) {
      ul.append(el('li', null, `${fmt.longDate(d.ride.date)} — ${fmt.title(d.verdict.sessionType)}, ${fmt.int(d.ride.tss)} TSS, ${fmt.int(d.ride.durationMin)} min`));
    }
    s.body.append(ul);
    if (failed.length) {
      s.body.append(note(`Could not read ${failed.map((x) => x.name).join(', ')}. ${failed[0].message}`, 'warn'));
    }
    if (skipped) {
      s.body.append(note(`${skipped} file${skipped === 1 ? '' : 's'} ignored — not .fit.`));
    }
    s.body.append(note('The most recent ride is analysed below. The others are in your trends and in the list above.'));
    results.append(s);
  }

  renderRecent(results, lastOut.ride.date, ctx);
  renderVerdict(results, lastOut.verdict, lastOut.ride, ctx);
  ctx.identityChanged?.();
  toast(done.length === 1 ? 'Ride analysed' : `${done.length} rides analysed`);
}

/** Parse, judge and store one file. Throws with a readable message. */
async function ingestOne(file, ctx) {
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
  // Stamped with the threshold that produced it, so a later redisplay can say
  // whether it still stands.
  store.setRideDetail(ride.date, rideDetailOf(ride, verdict, profile.ftp));

  return { ride, verdict };
}

// --- verdict --------------------------------------------------------------

function renderVerdict(root, verdict, ride, ctx) {
  const profile = deriveAthlete(store.rides(), store.profile());

  if (verdict.status === 'calibrating') {
    const c = card('This ride', { hint: fmt.longDate(ride.date) });
    c.body.append(statRow([
      stat('Duration', fmt.int(ride.durationMin), { unit: 'min' }),
      stat('Normalised power', fmt.int(ride.np), { unit: 'W', tone: 'np', define: 'np' }),
      stat('Best 20 min', fmt.int(ride.peakPowers?.['20m']?.power), { unit: 'W', tone: 'ftp' }),
    ]));
    root.append(c);

    const waiting = card('Threshold not set');
    waiting.body.append(note(verdict.message));
    waiting.body.append(el('div', 'actions').appendChild(button('Set your threshold', {
      variant: 'primary',
      onClick: () => ctx.go('profile'),
    })).parentNode);
    root.append(waiting);
    return;
  }

  // --- headline ------------------------------------------------------
  const head = card('This ride', { hint: fmt.longDate(ride.date) });
  head.body.append(statRow([
    stat('Duration', fmt.int(ride.durationMin), { unit: 'min' }),
    stat('Normalised power', fmt.int(ride.np), { unit: 'W', tone: 'np', define: 'np' }),
    stat('Training stress', fmt.int(ride.tss), { tone: 'tss', define: 'tss' }),
    stat('Intensity', fmt.dec(ride.if, 2), { define: 'if' }),
    stat('Fitness', fmt.dec(verdict.load.ctl), { tone: 'ctl', define: 'ctl' }),
    stat('Form', fmt.signed(verdict.load.tsb), { tone: 'tsb', define: 'tsb' }),
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
  // The template renders immediately and the model's prose replaces it if it
  // arrives. Nothing here is ever a blank box or a bare percentage.
  const prose = card('Summary');
  const box = el('div', 'prose');
  prose.body.append(box);
  root.append(prose);
  writeNarration(box, verdict);

  // --- proposals -----------------------------------------------------
  renderProposals(root, ride, profile, ctx);
}

// --- proposals ------------------------------------------------------------

function renderProposals(root, ride, profile, ctx) {
  const rides = store.rides();
  const standing = assessThresholdStanding(rides, profile);
  let proposals = proposeFromRide(ride, profile, store.decisions());

  // A single decoupled effort must not talk a threshold down while efficiency
  // across ordinary training says nothing is wrong.
  if (!allowDownwardProposal(standing)) {
    proposals = proposals.filter((p) => p.direction !== 'down');
  }
  // The efficiency route into FTP. standing.js's own bump is the more heavily
  // gated of the two and covers the same evidence, so it takes precedence —
  // the athlete should be asked once, not twice about the same trend.
  if (standing.proposal) {
    proposals = [standing.proposal, ...proposals];
  } else {
    proposals = [
      ...proposeFromStanding(standing, profile, store.decisions()),
      ...proposals,
    ];
  }

  const stale = stalenessPrompt(standing, { pendingProposals: proposals });

  // The standing *summary* has moved to Profile — it is a statement about the
  // athlete, not about this ride. What stays here is the part this ride's
  // evidence triggered, where the context is the point.
  if (stale) {
    const s = card('Threshold age');
    const row = el('div', 'standing-head');
    row.append(badge(`${stale.ageDays} days`, 'signal'));
    s.body.append(row);
    s.body.append(el('p', null, stale.message));
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
      onClick: () => acceptWithUndo(p, profile, ctx),
    }));
    actions.append(button('Not now', {
      onClick: () => rejectWithUndo(p, profile, box),
    }));
    box.append(actions);
    c.body.append(box);
  }
  root.append(c);
}

/**
 * Accepting moves FTP, and FTP moves every zone, TSS and verdict downstream.
 * That is a large consequence for one tap, so the tap is reversible for as
 * long as the toast is up — after which it is a considered decision and
 * belongs in the record.
 */
function acceptWithUndo(p, profile, ctx) {
  const before = store.profile();
  const { profile: next, decision } = acceptProposal(profile, p);

  store.addDecision(decision);
  store.patchProfile({
    [decision.field]: decision.proposed,
    confirmedFtp: next.confirmedFtp,
    ftpSetAt: next.ftpSetAt,
    lastBumpAt: next.lastBumpAt,
  });

  const name = p.field === 'ftp' ? 'Threshold' : 'Max heart rate';
  toast(`${name} set to ${p.proposed}`, 'ok', {
    action: {
      label: 'Undo',
      onClick: () => {
        // Restore by key rather than by wholesale replace: anything the
        // athlete changed in another tab while the toast was up is theirs to
        // keep, and this undo has no opinion about it.
        store.patchProfile({
          [decision.field]: before[decision.field] ?? null,
          confirmedFtp: before.confirmedFtp ?? null,
          ftpSetAt: before.ftpSetAt ?? null,
          lastBumpAt: before.lastBumpAt ?? null,
        });
        store.removeDecision(decision);
        toast(`${name} put back to ${before[decision.field] ?? '—'}`);
        ctx.refresh();
      },
    },
  });
  ctx.refresh();
}

/**
 * Rejecting is not free either: it writes a decision record with a cooldown,
 * so a mis-tap silences that evidence for weeks. Same window, same reversal.
 */
function rejectWithUndo(p, profile, box) {
  const { decision } = rejectProposal(profile, p);
  store.addDecision(decision);
  box.remove();

  toast('Noted. This will not come up again for a while.', 'ok', {
    action: {
      label: 'Undo',
      onClick: () => {
        store.removeDecision(decision);
        toast('Suggestion restored. It will appear again after your next ride.');
      },
    },
  });
}

const toneForVerdict = (v) =>
  ({ executed_well: 'good', recovery_clean: 'good', productive_but_ragged: 'signal',
     off_plan: 'signal', recovery_compromised: 'warn', overreached_for_the_zone: 'warn' }[v] || 'neutral');

const toneForFlag = (code) =>
  ({ engine_stable: 'good', efficient_output: 'good', recovery_discipline: 'good',
     aerobic_drift: 'warn', high_cardiac_strain: 'warn', recovery_surge: 'warn' }[code] || 'signal');
