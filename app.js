// Boot and routing. Four tabs, one container, no framework — each view is a
// function that fills an element and is re-run whenever anything changes.
// Re-rendering a whole tab is cheap at this size and removes an entire class
// of stale-UI bug.

import { renderProfile } from './view-profile.js';
import { renderAnalyse } from './view-analyse.js';
import { renderHistory } from './view-history.js';
import { renderPlan } from './view-plan.js';
import { store } from './store.js';
import { deriveAthlete } from './athlete.js';
import { el, $, clear, fmt } from './ui.js';

const TABS = [
  { id: 'analyse', label: 'Analyse', render: renderAnalyse },
  { id: 'history', label: 'History', render: renderHistory },
  { id: 'plan', label: 'Plan', render: renderPlan },
  { id: 'profile', label: 'Profile', render: renderProfile },
];

const ctx = {
  lastVerdict: null,
  lastRide: null,
  go: (id) => navigate(id),
  refresh: () => navigate(current, { keepScroll: true }),
  // Called when data changes without a re-render — the header carries the
  // derived threshold, and a stale one there is worse than none.
  identityChanged: () => renderIdentity(),
};

let current = 'analyse';

function navigate(id, opts = {}) {
  const tab = TABS.find((t) => t.id === id) || TABS[0];
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
}

/** The header carries the one number the athlete checks most. */
function renderIdentity() {
  const profile = store.profile();
  const derived = deriveAthlete(store.rides(), profile);
  const slot = document.getElementById('identity');
  clear(slot);

  if (profile.name) slot.append(el('span', 'who', profile.name));
  if (derived.ftp) {
    const chip = el('span', 'ftp-chip');
    chip.append(el('span', 'ftp-value', String(derived.ftp)));
    chip.append(el('span', 'ftp-unit', 'W'));
    chip.title = `Threshold power — ${fmt.title(derived.status)}`;
    slot.append(chip);
  }
}

function boot() {
  const nav = document.getElementById('tabs');
  for (const t of TABS) {
    const b = el('button', 'tab', t.label);
    b.dataset.tab = t.id;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => navigate(t.id));
    nav.append(b);
  }

  window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || 'analyse'));
  navigate(location.hash.slice(1) || 'analyse');
}

boot();
