// Boot and routing. Four tabs, one container, no framework — each view is a
// function that fills an element and is re-run whenever anything changes.
// Re-rendering a whole tab is cheap at this size and removes an entire class
// of stale-UI bug.
//
// The tabs are named and ordered by the question the athlete is asking, not by
// the order data flows through the app. Today is asked daily, Ride after each
// session, Trends weekly, Profile once. That is the order they sit in.

import { renderProfile } from './view-profile.js';
import { renderAnalyse } from './view-analyse.js';
import { renderHistory } from './view-history.js';
import { renderPlan } from './view-plan.js';
import { store, todayIso } from './store.js';
import { deriveAthlete } from './athlete.js';
import { computeLoad } from './load.js';
import { assessThresholdStanding } from './standing.js';
import { proposeFromStanding } from './proposals.js';
import { el, clear, fmt } from './ui.js';

const TABS = [
  { id: 'today', label: 'Today', render: renderPlan, badge: needsCheckIn },
  { id: 'ride', label: 'Ride', render: renderAnalyse, badge: hasPendingProposal },
  { id: 'trends', label: 'Trends', render: renderHistory },
  { id: 'profile', label: 'Profile', render: renderProfile },
];

// Old hashes stay live. A bookmark or a shared link from before the rename
// should land where it meant to, not silently on the first tab.
const ALIASES = { plan: 'today', analyse: 'ride', history: 'trends' };

const ctx = {
  lastVerdict: null,
  lastRide: null,
  go: (id) => navigate(id),
  refresh: () => navigate(current, { keepScroll: true }),
  // Called when data changes without a re-render — the header carries the
  // derived threshold, and a stale one there is worse than none.
  identityChanged: () => { renderIdentity(); renderBadges(); },
};

let current = 'today';

const resolve = (id) => ALIASES[id] || id;

function navigate(id, opts = {}) {
  const tab = TABS.find((t) => t.id === resolve(id)) || TABS[0];
  current = tab.id;
  const y = opts.keepScroll ? window.scrollY : 0;

  for (const b of document.querySelectorAll('.tab')) {
    const on = b.dataset.tab === tab.id;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  }

  const view = document.getElementById('view');
  clear(view);
  view.dataset.tab = tab.id;
  tab.render(view, ctx);

  if (location.hash.slice(1) !== tab.id) history.replaceState(null, '', `#${tab.id}`);
  window.scrollTo({ top: y });
  renderIdentity();
  renderBadges();
}

/**
 * The header carries the two facts an athlete checks without having a
 * question: what their threshold is, and what state their form is in. One
 * chip, two readings — the single-glance answer for someone who opened the
 * app without a question.
 */
function renderIdentity() {
  const profile = store.profile();
  const rides = store.rides();
  const derived = deriveAthlete(rides, profile);
  const slot = document.getElementById('identity');
  clear(slot);

  if (profile.name) slot.append(el('span', 'who', profile.name));
  if (!derived.ftp) return;

  // A button, not a span: it navigates, so it has to be reachable by keyboard
  // and announce itself as something that does anything at all.
  const chip = el('button', 'ftp-chip');
  chip.type = 'button';
  chip.append(el('span', 'ftp-value', String(derived.ftp)));
  chip.append(el('span', 'ftp-unit', 'W'));

  const load = rides.length ? computeLoad(rides, new Date()) : null;
  let label = `Threshold power — ${fmt.title(derived.status)}`;

  if (load && load.tsb != null) {
    const dot = el('span', `form-dot form-dot-${FORM_TONE[load.state] || 'neutral'}`);
    dot.setAttribute('aria-hidden', 'true');
    chip.append(dot);
    chip.append(el('span', 'form-value', fmt.signed(load.tsb, 0)));
    label += `. Form ${fmt.signed(load.tsb, 0)}, ${fmt.title(load.state)}. Opens Trends.`;
  }

  chip.title = label;
  chip.setAttribute('aria-label', label);
  chip.addEventListener('click', () => navigate('trends'));
  slot.append(chip);
}

// The states the palette already distinguishes. `productive` gets no colour of
// its own on purpose — it is the default, and colouring the default spends a
// signal on the absence of news.
const FORM_TONE = {
  fresh: 'fresh',
  productive: 'neutral',
  fatigued: 'signal',
  deep_hole: 'warn',
};

/**
 * A dot on a tab means something is waiting there. It is a state, not
 * decoration, so it is recomputed on every navigation and disappears the
 * moment the thing is dealt with.
 */
function renderBadges() {
  for (const t of TABS) {
    const b = document.querySelector(`.tab[data-tab="${t.id}"]`);
    if (!b) continue;
    let on = false;
    try { on = !!t.badge?.(); } catch { on = false; }

    b.classList.toggle('has-dot', on);
    const existing = b.querySelector('.tab-dot');
    if (on && !existing) {
      const dot = el('span', 'tab-dot');
      dot.setAttribute('aria-hidden', 'true');
      b.append(dot);
    } else if (!on && existing) {
      existing.remove();
    }
    // The dot is visual; the label carries the same fact for a screen reader.
    b.setAttribute('aria-label', on ? `${t.label} — needs attention` : t.label);
  }
}

/** No check-in saved for today. Not worth asking before there is any habit. */
function needsCheckIn() {
  const wellness = store.wellness();
  if (!wellness.length && !store.rides().length) return false;
  return !wellness.some((w) => w.date === todayIso());
}

/**
 * A threshold change is waiting. This deliberately checks only the standing
 * route, which needs rides and a profile — the per-ride route needs a parsed
 * ride, and parsing a file to decide whether to draw a dot is not a trade
 * worth making on every navigation.
 */
function hasPendingProposal() {
  const rides = store.rides();
  if (rides.length < 3) return false;
  const profile = deriveAthlete(rides, store.profile());
  if (!profile.ftp) return false;
  const standing = assessThresholdStanding(rides, profile);
  if (standing.proposal) return true;
  return proposeFromStanding(standing, profile, store.decisions()).length > 0;
}

/**
 * Where to land with no hash. Today is the daily question, so it is the
 * default — but a first-run athlete cannot render a plan at all
 * (view-plan.js bails without a threshold), and landing on a dead end is a bad
 * first impression. Send those to Profile instead. A hash always wins.
 */
function landingTab() {
  const hash = resolve(location.hash.slice(1));
  if (hash && TABS.some((t) => t.id === hash)) return hash;

  const profile = store.profile();
  const rides = store.rides();
  if (!rides.length && !profile.ftp) return 'profile';
  return 'today';
}

function boot() {
  const nav = document.getElementById('tabs');
  for (const t of TABS) {
    const b = el('button', 'tab');
    b.append(el('span', 'tab-label', t.label));
    b.dataset.tab = t.id;
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => navigate(t.id));
    nav.append(b);
  }

  window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || landingTab()));
  navigate(landingTab());

  // Offline shell. Registration failing is not worth surfacing — the app works
  // without it, which is the point of a progressive enhancement.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(new URL('./sw.js', import.meta.url))
        .catch(() => { /* http://, private mode, or unsupported. Carry on. */ });
    });
  }
}

boot();
