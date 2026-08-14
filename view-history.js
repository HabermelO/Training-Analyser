// Trends: the long view. One chart, several series, each in the colour that
// metric carries everywhere else in the app.
//
// Named for what is on screen. "History" promised a log and delivered a model:
// almost everything here is forward-looking inference — CTL, ATL, TSB,
// efficiency drift, intensity distribution — with the ride log at the bottom.
//
// The series are split across two axes on purpose. Fitness, fatigue and form
// share a unit and belong together; heart rate, threshold and efficiency do
// not, and plotting them on one linear axis would imply a comparison that does
// not exist. Anything on the right axis says so in the legend.

import { store } from './store.js';
import { computeLoad, intensityDistribution } from './load.js';
import { deriveAthlete } from './athlete.js';
import { computeReadiness } from './readiness.js';
import { timeChart, distributionBar } from './charts.js';
import {
  el, card, stat, statRow, button, toast, badge,
  fmt, clear, empty, note,
} from './ui.js';

const SERIES = [
  { key: 'ctl', label: 'Fitness (CTL)', colour: 'var(--load)', axis: 'left', fill: true },
  { key: 'atl', label: 'Fatigue (ATL)', colour: 'var(--fatigue)', axis: 'left', dashed: true },
  { key: 'tsb', label: 'Form (TSB)', colour: 'var(--fresh)', axis: 'left' },
  { key: 'ftp', label: 'Threshold', colour: 'var(--power)', axis: 'right' },
  { key: 'rhr', label: 'Resting HR', colour: 'var(--cardiac)', axis: 'right' },
  { key: 'hrv', label: 'HRV', colour: 'var(--hrv)', axis: 'right' },
  { key: 'ef', label: 'Power per beat', colour: 'var(--effic)', axis: 'right' },
];

const DEFAULT_ON = ['ctl', 'atl', 'tsb'];

// Persisted, not module-level. A Set that resets on reload means an athlete
// who cares about efficiency has to re-select it every single visit, which
// teaches them the chart is not theirs to configure.
const PREF_KEY = 'trendSeries';
function activeSeries() {
  const saved = store.prefs()[PREF_KEY];
  const keys = Array.isArray(saved) && saved.length
    ? saved.filter((k) => SERIES.some((s) => s.key === k))
    : DEFAULT_ON;
  return new Set(keys.length ? keys : DEFAULT_ON);
}

export function renderHistory(root, ctx) {
  clear(root);
  const rides = store.rides();
  const wellness = store.wellness();
  const profile = deriveAthlete(rides, store.profile());

  if (!rides.length) {
    root.append(empty(
      'No rides yet',
      'Add a .fit file on the Ride tab and your trends start building from there.',
      button('Go to Ride', { variant: 'primary', onClick: () => ctx.go('ride') }),
    ));
    return;
  }

  const active = activeSeries();

  const load = computeLoad(rides, new Date());
  const readiness = computeReadiness(wellness);

  // --- headline ------------------------------------------------------
  const now = card('Where you are today');
  // Form leads. Five stats at equal weight is five things to act on, which is
  // none — and of these, form is the one that changes what you do today. The
  // rest sit a step down. Labels are the tap target for a definition, because
  // the app models these carefully and until now explained them in six words.
  now.body.append(statRow([
    stat('Form', fmt.signed(load.tsb), {
      tone: 'tsb', lead: true, define: 'tsb', note: fmt.title(load.state),
    }),
    stat('Fitness', fmt.dec(load.ctl), { tone: 'ctl', define: 'ctl', note: 'CTL, 42-day load' }),
    stat('Fatigue', fmt.dec(load.atl), { tone: 'atl', define: 'atl', note: 'ATL, 7-day load' }),
    stat('Last 7 days', fmt.int(load.last7dTss), { tone: 'tss', define: 'tss', note: 'TSS' }),
    stat('Readiness', fmt.title(readiness.flag), { define: 'readiness' }),
  ]));
  if (load.rampWarning) {
    now.body.append(note(`Weekly load is up ${load.rampPct}% on the previous week. That is a fast ramp — worth easing before it becomes a hole.`, 'signal'));
  }
  if (readiness.notes?.length) {
    const ul = el('ul', 'notes');
    for (const n of readiness.notes) ul.append(el('li', null, n));
    now.body.append(ul);
  }
  root.append(now);

  // --- intensity distribution ----------------------------------------
  // Session counting cannot see this. Three "endurance" rides that each drift
  // into tempo read as an easy week by session and as a middling one by time,
  // and time is what the body responds to.
  const dist = intensityDistribution(rides, { asOf: new Date() });
  const tid = card('How hard you have actually been riding', {
    hint: `Last ${dist.days} days`,
  });
  tid.body.append(distributionBar(dist));
  if (dist.model !== 'insufficient') {
    const row = el('div', 'today-head');
    row.append(badge(fmt.title(dist.model), dist.model === 'polarised' ? 'good' : 'signal'));
    tid.body.append(row);
  }
  if (dist.note) tid.body.append(el('p', null, dist.note));
  tid.body.append(note(
    dist.source === 'hr'
      ? 'Measured from heart-rate zones, because these rides had no power. Heart rate lags, so the easy share here is slightly generous.'
      : 'Measured in minutes, not sessions — a ride labelled easy that spent an hour in tempo counts as an hour in tempo.',
  ));
  root.append(tid);

  // --- trends --------------------------------------------------------
  const trends = card('Trends');
  const data = buildSeries(rides, wellness, load, profile);
  const legend = el('div', 'legend');

  const redraw = () => {
    const plot = trends.body.querySelector('.chart');
    const next = timeChart(
      SERIES.filter((s) => active.has(s.key) && data[s.key]?.length)
        .map((s) => ({ ...s, points: data[s.key] })),
      { height: 340, ariaLabel: 'Training history' },
    );
    if (plot) plot.replaceWith(next); else trends.body.append(next);
  };

  for (const s of SERIES) {
    const has = data[s.key]?.length;
    const chip = el('button', `legend-chip ${active.has(s.key) ? 'is-on' : ''}`);
    chip.disabled = !has;
    chip.style.setProperty('--chip', s.colour);
    chip.append(el('span', 'legend-swatch'));
    chip.append(el('span', 'legend-label', s.label));
    if (s.axis === 'right') chip.append(el('span', 'legend-axis', 'R'));
    chip.addEventListener('click', () => {
      if (active.has(s.key)) active.delete(s.key); else active.add(s.key);
      chip.classList.toggle('is-on');
      chip.setAttribute('aria-pressed', String(active.has(s.key)));
      store.setPref(PREF_KEY, [...active]);
      redraw();
    });
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(active.has(s.key)));
    if (!has) chip.title = 'No data for this yet';
    legend.append(chip);
  }
  trends.body.append(legend);
  redraw();
  trends.body.append(note('Fitness, fatigue and form share the left axis. Everything else is on the right, marked R, because those quantities do not share a unit.'));
  root.append(trends);

  // --- rides ---------------------------------------------------------
  const list = card('Every ride', { hint: `${rides.length} total` });
  const table = el('table', 'ridetable');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Date', 'Duration', 'NP', 'TSS', 'IF', 'Drift', '']) hr.append(el('th', null, h));
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  const ordered = [...rides].reverse();
  const PAGE = 12;
  let shown = Math.min(PAGE, ordered.length);

  const rowFor = (r) => {
    const tr = el('tr');
    tr.append(el('td', null, fmt.longDate(r.date)));
    tr.append(el('td', 'num', `${fmt.int(r.durationMin)}m`));
    tr.append(el('td', 'num', r.np ? `${fmt.int(r.np)}W` : '—'));
    tr.append(el('td', 'num', fmt.int(r.tss)));
    tr.append(el('td', 'num', fmt.dec(r.if, 2)));
    tr.append(el('td', 'num', r.decouplingPct == null ? '—' : `${fmt.dec(r.decouplingPct)}%`));
    const del = el('td', 'num');
    del.append(button('Remove', {
      variant: 'quiet',
      onClick: () => {
        if (!confirm(`Remove the ride from ${fmt.longDate(r.date)}?`)) return;
        store.removeRide(r.date);
        toast('Ride removed');
        ctx.refresh();
      },
    }));
    tr.append(del);
    return tr;
  };

  const draw = () => {
    clear(tbody);
    for (const r of ordered.slice(0, shown)) tbody.append(rowFor(r));
  };
  draw();
  table.append(tbody);
  list.body.append(table);

  if (ordered.length > PAGE) {
    const more = button(`Show ${Math.min(PAGE, ordered.length - shown)} more`, {
      variant: 'quiet',
      onClick: () => {
        shown = Math.min(shown + PAGE, ordered.length);
        draw();
        more.textContent = shown >= ordered.length
          ? 'All rides shown'
          : `Show ${Math.min(PAGE, ordered.length - shown)} more`;
        more.disabled = shown >= ordered.length;
      },
    });
    list.body.append(el('div', 'actions').appendChild(more).parentNode);
  }
  root.append(list);
}

/**
 * Build every plottable series. Load comes from the model rather than the
 * rides directly, so the curve is smooth between rides rather than spiking on
 * ride days only.
 */
function buildSeries(rides, wellness, load, profile) {
  const out = { ctl: [], atl: [], tsb: [], ftp: [], rhr: [], hrv: [], ef: [] };

  // computeLoad() starts its window well before the first ride so the
  // exponential averages have somewhere to ramp from. Those leading zeros are
  // real but they are not history, and plotting them spends half the chart
  // width on a flat line. Start at the first day that actually carried load.
  const series = load.series || [];
  const firstReal = series.findIndex((p) => p.tss > 0);
  for (const p of series.slice(Math.max(0, firstReal))) {
    out.ctl.push({ x: p.date, y: p.ctl });
    out.atl.push({ x: p.date, y: p.atl });
    out.tsb.push({ x: p.date, y: p.tsb });
  }

  for (const w of wellness) {
    if (w.rhr) out.rhr.push({ x: w.date, y: w.rhr });
    if (w.hrv) out.hrv.push({ x: w.date, y: w.hrv });
  }

  // Threshold over time: whatever the app believed on the day of each ride.
  // A flat line is the honest picture when nothing has moved it.
  for (const r of rides) {
    if (r.declaredFtp) out.ftp.push({ x: r.date, y: r.declaredFtp });
  }
  if (!out.ftp.length && profile.ftp && rides.length) {
    out.ftp.push({ x: rides[0].date, y: profile.ftp });
    out.ftp.push({ x: rides[rides.length - 1].date, y: profile.ftp });
  }

  // Power per beat, from whichever trained zone the ride was actually about.
  for (const r of rides) {
    const zones = r.efficiencyByZone || {};
    const best = ['Z4_Threshold', 'Z3_Tempo', 'Z2_Endurance']
      .map((z) => zones[z]).find((z) => z && z.secs >= 600);
    if (best) out.ef.push({ x: r.date, y: best.ef });
  }

  return out;
}
