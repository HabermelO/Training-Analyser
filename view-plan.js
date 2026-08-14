// Plan: what the week should look like, and why.
//
// The plan is a suggestion the athlete can rearrange. Dragging a session to a
// different day is stored as an override keyed by date, so it survives the
// plan being recomputed after the next ride — the engine keeps its opinion,
// and the athlete's edit sits on top of it rather than being overwritten.
//
// What is deliberately NOT allowed: dragging two hard sessions onto
// consecutive days without being told. The app does not block it, because it
// is the athlete's week, but it says what it thinks.

import { store, todayIso } from './store.js';
import { deriveAthlete } from './athlete.js';
import { computeLoad, computePhenotype, aggregateBestPowers } from './load.js';
import { computeReadiness } from './readiness.js';
import { estimateFtp } from './ftp.js';
import { planWeek, suggestToday } from './planner.js';
import { WORKOUTS, ADAPTATIONS } from './workouts.js';
import { checkInCard, baselineNote } from './checkin.js';
import { writeTodayNarration } from './narration-view.js';
import {
  el, card, stat, statRow, badge, button, toast, note, fmt, clear, empty,
  ADAPTATION_TONE,
} from './ui.js';

// Distinct from "no edit for this day", which falls back to the plan.
const REST = '__rest__';

const HARD = new Set(['vo2max', 'anaerobic_capacity', 'lactate_clearance', 'threshold_tte']);
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function renderPlan(root, ctx) {
  clear(root);
  const rides = store.rides();
  const profile = deriveAthlete(rides, store.profile());

  if (!profile.ftp) {
    root.append(empty(
      'A plan needs a threshold',
      'Enter your threshold power on the Profile tab, or upload a few rides and the app will work one out. Without it, prescribing intensity would be guesswork.',
      button('Go to Profile', { variant: 'primary', onClick: () => ctx.go('profile') }),
    ));
    return;
  }

  const asOf = new Date();
  const load = computeLoad(rides, asOf);
  const readiness = computeReadiness(store.wellness());
  const phenotype = computePhenotype(aggregateBestPowers(rides.slice(-90)));
  const ftpEstimate = estimateFtp(rides.slice(-90), profile);
  const planCtx = {
    rides, readiness, phenotype, load, asOf,
    athlete: profile, ftpEstimate,
    profile: store.profile(),
    planEdits: store.planEdits(),
    longRideDay: store.profile().longRideDay ?? 6,
  };
  const plan = planWeek(planCtx);
  const today = suggestToday({ ...planCtx, plan });

  // --- check-in ------------------------------------------------------
  // Unanswered, it is the first thing on screen: readiness is the veto term in
  // everything below it, so asking after showing the answer would be asking
  // too late. Answered, it collapses to a strip and moves under the session
  // card, which is then the thing worth reading first.
  const wellness = store.wellness();
  const answered = wellness.some((w) => w.date === todayIso());
  const checkIn = checkInCard(ctx, wellness);
  if (!answered) root.append(checkIn);

  // --- today ---------------------------------------------------------
  // The headline. A week shape answers "what does this block look like"; this
  // answers the question the athlete actually opened the app with.
  root.append(todayCard(today, { readiness, load, rides, wellness }));
  if (answered) root.append(checkIn);

  // With a threshold but no rides, the plan is built entirely from the
  // declared numbers and the phase model. That is a real answer, not an error,
  // and saying so beats letting the athlete wonder what it is missing.
  if (!rides.length) {
    root.append(empty(
      'No rides recorded yet',
      'Everything above comes from your threshold and where you are in the block — it can prescribe a session, but not judge how the last ones went. Add a ride and load, form and readiness all start working.',
      button('Add a ride', { variant: 'primary', onClick: () => ctx.go('ride') }),
    ));
    return;
  }

  // --- summary -------------------------------------------------------
  const head = card('This week', { hint: fmt.title(readiness.flag) });
  head.body.append(statRow([
    stat('Planned load', fmt.int(plan.plannedTss), {
      tone: 'tss',
      note: plan.weeklyTssCap ? `TSS, target ~${plan.weeklyTssCap}` : 'TSS',
    }),
    stat('Time', `${plan.plannedHours}`, { unit: 'h' }),
    stat('Hard sessions', `${plan.hardSessions}`, { note: `of ${plan.hardBudget} allowed` }),
    stat('Rest days', `${plan.restDays ?? 0}`, { note: plan.restDays ? 'earned' : 'none this week' }),
    stat('Form now', fmt.signed(load.tsb), { tone: 'tsb', note: fmt.title(load.state) }),
  ]));

  // A plan that overshoots its own target says so. Silently exceeding it reads
  // as a considered number while describing a week nobody chose.
  if (plan.capRespected === false) {
    head.body.append(note(
      `This week comes to ${plan.plannedTss} TSS against a target of ${plan.weeklyTssCap}. There is nothing left to cut without an empty week — the target is low because recent load and readiness are both down.`,
      'signal',
    ));
  }

  if (plan.rationale?.length) {
    const ul = el('ul', 'notes');
    for (const r of plan.rationale) ul.append(el('li', null, r));
    head.body.append(ul);
  }
  root.append(head);

  // --- calendar ------------------------------------------------------
  const edits = store.planEdits();
  const monday = startOfWeek(asOf);
  const cal = card('Your week', {
    hint: 'Drag a session to another day',
    action: button('Reset to suggested', {
      variant: 'quiet',
      onClick: () => { store.clearPlanEdits(); toast('Back to the suggested week'); ctx.refresh(); },
    }),
  });

  const grid = el('div', 'calendar');
  const byDay = new Map(plan.days.map((d) => [d.day, d]));

  // HTML5 drag-and-drop does not fire on touch devices at all, so the same
  // move is available as tap-to-pick then tap-to-place. Both paths end in the
  // same moveSession() call.
  let picked = null;
  const setPicked = (next) => {
    picked = next;
    for (const c of grid.querySelectorAll('.chip')) c.classList.remove('is-picked');
    for (const c of grid.querySelectorAll('.day')) c.classList.toggle('is-target', !!next);
    if (next) {
      const chip = grid.querySelector(`.chip[data-date="${next.fromDate}"]`);
      chip?.classList.add('is-picked');
    }
  };

  // Dropping onto a day that already has a session SWAPS them rather than
  // overwriting. Overwriting silently deletes a session the athlete never
  // asked to lose, and "move the hard day to Thursday" almost always means
  // "and put Thursday's easy one where it was".
  const moveSession = (toIso, workoutId, fromIso) => {
    if (fromIso === toIso) return setPicked(null);
    const displaced = occupantOf(toIso);
    store.setPlanEdit(toIso, workoutId);
    store.setPlanEdit(fromIso, displaced ? displaced.id : REST);
    warnIfStacked(toIso, workoutId, monday);
    ctx.refresh();
  };

  // What is on a given day right now, edits included.
  const occupantOf = (iso) => {
    const edit = store.planEdits()[iso];
    if (edit === REST) return null;
    if (edit) return WORKOUTS.find((w) => w.id === edit) || null;
    const dayIdx = (new Date(iso).getDay() + 6) % 7;
    return byDay.get(dayIdx)?.workout || null;
  };

  for (let i = 0; i < 7; i++) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);
    const iso = date.toISOString().slice(0, 10);

    const planned = byDay.get(i);
    const overrideId = edits[iso];
    const workout = overrideId === REST
      ? null
      : overrideId
        ? WORKOUTS.find((w) => w.id === overrideId) || planned?.workout
        : planned?.workout;

    const cell = el('div', 'day');
    if (isToday(date)) cell.classList.add('is-today');
    cell.dataset.date = iso;

    const dh = el('div', 'day-head');
    dh.append(el('span', 'day-name', DAY_NAMES[i]));
    dh.append(el('span', 'day-num', String(date.getDate())));
    cell.append(dh);

    if (planned?.frozen) {
      // A day already lived is reported, not prescribed, and cannot be a drop
      // target — moving a session onto Tuesday on Thursday is not a plan
      // change, it is a fiction.
      cell.classList.add('is-past');
      const a = planned.actual;
      cell.append(el('div', 'day-rest', a
        ? `Ridden — ${Math.round(a.tss)} TSS`
        : 'Not ridden'));
      grid.append(cell);
      continue;
    }

    if (workout) {
      cell.append(workoutChip(workout, iso, planned, overrideId != null, setPicked, () => picked));
    } else {
      cell.append(el('div', 'day-rest', overrideId === REST ? 'Rest — you moved it' : 'Rest'));
    }

    // Drop target
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('is-drop'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('is-drop'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('is-drop');
      const payload = e.dataTransfer.getData('text/plain');
      if (!payload) return;
      const { workoutId, fromDate } = JSON.parse(payload);
      // Vacating the source day is an explicit rest. There is no rest workout
      // in the library — rest is the absence of one — so this is stored as a
      // sentinel the render step reads as "deliberately empty".
      moveSession(iso, workoutId, fromDate);
    });

    // Tap-to-place, the touch equivalent of the drop above.
    cell.addEventListener('click', () => {
      if (!picked) return;
      moveSession(iso, picked.workoutId, picked.fromDate);
    });

    grid.append(cell);
  }
  cal.body.append(grid);
  cal.body.append(note('Tap a session then tap a day to move it, or drag it. Moved sessions stay where you put them. The engine keeps planning underneath, so "Reset to suggested" always gets you back.'));
  root.append(cal);

  // --- session detail ------------------------------------------------
  const detail = card('What each session is for');
  const seen = new Set();
  for (const d of plan.days) {
    const w = d.workout;
    if (!w || seen.has(w.id)) continue;
    seen.add(w.id);

    const row = el('div', 'session');
    const tone = ADAPTATION_TONE[w.adaptation] || 'neutral';
    row.append(el('span', `session-dot session-dot-${tone}`));

    const body = el('div', 'session-body');
    const t = el('div', 'session-title');
    t.append(el('strong', null, w.systm || w.id));
    t.append(badge(`${w.durationMin} min`, 'neutral'));
    t.append(badge(`${w.tss} TSS`, 'neutral'));
    body.append(t);
    body.append(el('p', 'session-goal', ADAPTATIONS[w.adaptation] || ''));
    if (w.outdoor) {
      body.append(el('p', 'session-outdoor', `Outdoors: ${w.outdoor.name} — ${w.outdoor.prescription}`));
    }
    if (d.note) body.append(note(d.note, 'signal'));
    row.append(body);
    detail.body.append(row);
  }
  root.append(detail);
}

/**
 * Today, and the reasoning behind it, in the order the decision was actually
 * made. The trace is shown rather than summarised because "why" is the part
 * an athlete argues with, and an argument needs the steps.
 */
function todayCard(today, { readiness, load, rides, wellness } = {}) {
  const c = card('Today', {
    hint: today.alreadyRidden ? 'Already ridden' : today.wasOverridden ? 'Your edit' : null,
  });

  const head = el('div', 'today-head');
  head.append(el('span', 'today-title', today.headline));
  if (today.session) {
    head.append(badge(`${today.session.durationMin} min`, 'neutral'));
    const p = today.prescription;
    if (p?.targetWatts) head.append(badge(`${Math.round(p.targetWatts)}W`, 'signal'));
    head.append(badge(`${Math.round(p?.tss ?? today.session.tss)} TSS`, 'neutral'));
  }
  c.body.append(head);

  if (today.session?.outdoor) {
    c.body.append(el('p', 'session-goal', today.session.outdoor.prescription));
  }
  if (today.note) c.body.append(note(today.note, 'signal'));
  if (today.wasOverridden) {
    c.body.append(note(
      `This is not what the engine would have picked — ${today.overrideReason}. It stays until you reset the week.`,
      'signal',
    ));
  }

  // One decision, one reason, one paragraph — squarely inside what a 1B model
  // narrates reliably, and the tab that most benefits from a sentence of
  // explanation. The template renders immediately; the model's prose replaces
  // it if and when it arrives.
  const prose = el('div', 'prose prose-today');
  c.body.append(prose);
  writeTodayNarration(prose, today, { readiness, load });

  const ul = el('ul', 'trace');
  for (const t of today.trace) {
    const li = el('li');
    li.append(el('span', 'trace-step', t.step));
    const body = el('span', 'trace-body');
    body.append(el('span', 'trace-value', fmt.title(String(t.value))));
    body.append(document.createTextNode(` — ${t.effect}`));
    li.append(body);
    ul.append(li);
  }
  c.body.append(ul);

  // Says what the readiness step is actually running on. Without it the trace
  // line reads as a measurement when it is a fallback, and the athlete has no
  // reason to believe the check-in habit is buying them anything.
  const baseline = baselineNote(readiness, wellness);
  if (baseline && rides?.length) c.body.append(note(baseline));

  return c;
}

function workoutChip(workout, iso, planned, isMoved, setPicked, getPicked) {
  const tone = ADAPTATION_TONE[workout.adaptation] || 'neutral';
  const chip = el('div', `chip chip-${tone}`);
  chip.draggable = true;
  chip.append(el('span', 'chip-name', workout.systm || fmt.title(workout.adaptation)));
  const meta = el('span', 'chip-meta');
  meta.append(el('span', null, `${workout.durationMin}m`));
  meta.append(el('span', null, `${workout.tss} TSS`));
  chip.append(meta);
  if (isMoved) chip.append(el('span', 'chip-moved', 'moved'));
  if (planned?.note) chip.title = planned.note;

  chip.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ workoutId: workout.id, fromDate: iso }));
    e.dataTransfer.effectAllowed = 'move';
    chip.classList.add('is-dragging');
  });
  chip.addEventListener('dragend', () => chip.classList.remove('is-dragging'));

  chip.dataset.date = iso;
  chip.tabIndex = 0;
  chip.setAttribute('role', 'button');
  chip.setAttribute('aria-label', `${workout.systm || workout.id}. Select to move to another day.`);

  const pick = (e) => {
    const cur = getPicked();
    // Something is already picked and it is not this one: let the click reach
    // the day underneath, which places (and swaps). Without this, tapping an
    // occupied day just re-picks and the move never happens.
    if (cur && cur.fromDate !== iso) return;
    e.stopPropagation();
    setPicked(cur ? null : { workoutId: workout.id, fromDate: iso });
  };
  chip.addEventListener('click', pick);
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); }
  });
  return chip;
}

/**
 * Say something when an edit puts two hard days back to back. The athlete is
 * allowed to do it — they know things the app does not — but a plan that
 * silently accepts it is not being honest about the cost.
 */
function warnIfStacked(iso, workoutId, monday) {
  const w = WORKOUTS.find((x) => x.id === workoutId);
  if (!w || !HARD.has(w.adaptation)) return toast('Session moved');

  const edits = store.planEdits();
  const day = new Date(iso);
  for (const delta of [-1, 1]) {
    const nb = new Date(day);
    nb.setDate(day.getDate() + delta);
    const nbIso = nb.toISOString().slice(0, 10);
    const nbW = WORKOUTS.find((x) => x.id === edits[nbIso]);
    if (nbW && HARD.has(nbW.adaptation)) {
      return toast('Moved. That puts two hard sessions on consecutive days — the second one usually gets the fatigue, not the adaptation.', 'signal');
    }
  }
  toast('Session moved');
}

function startOfWeek(d) {
  const date = new Date(d);
  const day = (date.getDay() + 6) % 7;   // Monday = 0
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date;
}

const isToday = (d) => d.toDateString() === new Date().toDateString();
