// DOM helpers and the small set of components every view is built from.
// Kept deliberately plain — no framework, no build step, and no component
// abstraction beyond what three or four views actually reuse.

export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/** The colour a metric family carries everywhere it appears. */
export const METRIC_COLOUR = {
  ftp: 'var(--power)',
  np: 'var(--power)',
  tss: 'var(--load)',
  ctl: 'var(--load)',
  atl: 'var(--fatigue)',
  tsb: 'var(--fresh)',
  rhr: 'var(--cardiac)',
  hrv: 'var(--cardiac)',
  ef: 'var(--effic)',
};

export function card(title, opts = {}) {
  const c = el('section', 'card');
  if (title) {
    const head = el('div', 'card-head');
    head.append(el('h2', null, title));
    if (opts.hint) head.append(el('span', 'hint', opts.hint));
    if (opts.action) head.append(opts.action);
    c.append(head);
  }
  const body = el('div', 'card-body');
  c.append(body);
  c.body = body;
  return c;
}

/**
 * Short definitions for the quantities the app models but has never explained.
 * The stat note is a label; this is the answer to "yes, but what IS that".
 */
export const GLOSSARY = {
  ctl: 'Chronic training load — an exponentially weighted average of your daily training stress over about six weeks. It moves slowly and stands in for fitness.',
  atl: 'Acute training load — the same average over about a week. It moves fast and stands in for fatigue.',
  tsb: 'Training stress balance — fitness minus fatigue. Positive means fresher than your recent training; negative means you are carrying load. Neither is good or bad on its own; it depends what you are doing next.',
  tss: 'Training stress score — one hour at your threshold is 100. It combines how long you rode with how hard, so a long easy ride and a short hard one can score the same.',
  np: 'Normalised power — what a ride cost you physiologically, as opposed to average power, which under-reads any ride with surges in it.',
  if: 'Intensity factor — normalised power as a fraction of your threshold. 1.0 is an hour at threshold.',
  ftp: 'Functional threshold power — roughly the highest power you could hold for an hour. Every zone and every TSS figure in the app is derived from it.',
  ef: 'Efficiency factor — normalised power per heartbeat. Rising over weeks at the same heart rate is aerobic fitness improving.',
  drift: 'Aerobic decoupling — how much the power-to-heart-rate relationship fell away over the ride. Above about 5% on a steady ride suggests the effort was beyond your current aerobic durability.',
  readiness: 'How today\'s HRV and resting heart rate compare with your own recent baseline. It can veto intensity; it never prescribes it.',
};

/**
 * A number with its label and unit. `tone` picks the metric colour so the same
 * quantity reads the same way on every screen.
 *
 * `lead` promotes one stat in a row to a larger size — a row where everything
 * is equally loud tells the athlete nothing about what to act on. `define`
 * turns the label into the tap target for a short definition, since the app
 * models sophisticated quantities and otherwise explains them in six words.
 */
export function stat(label, value, opts = {}) {
  const s = el('div', `stat${opts.lead ? ' stat-lead' : ''}`);

  if (opts.define && GLOSSARY[opts.define]) {
    const btn = el('button', 'stat-label stat-label-define');
    btn.type = 'button';
    btn.append(document.createTextNode(label));
    btn.append(el('span', 'stat-define-mark', '?'));
    btn.setAttribute('aria-expanded', 'false');
    btn.title = `What is ${label}?`;

    const def = el('div', 'stat-def', GLOSSARY[opts.define]);
    def.hidden = true;

    btn.addEventListener('click', () => {
      def.hidden = !def.hidden;
      btn.setAttribute('aria-expanded', String(!def.hidden));
    });
    s.append(btn);
    s.__def = def;   // appended after the value, below
  } else {
    s.append(el('div', 'stat-label', label));
  }

  const v = el('div', 'stat-value');
  v.textContent = value ?? '—';
  if (opts.tone) v.style.color = METRIC_COLOUR[opts.tone] || opts.tone;
  if (opts.unit) {
    const u = el('span', 'stat-unit', opts.unit);
    v.append(u);
  }
  s.append(v);
  if (opts.note) s.append(el('div', 'stat-note', opts.note));
  if (s.__def) { s.append(s.__def); delete s.__def; }
  return s;
}

/**
 * Placeholder shaped like the thing that is coming. A skeleton says "prose
 * belongs here and is on its way"; a percentage says nothing at all to
 * somebody who did not ask for a download.
 */
export function skeleton(lines = 2) {
  const s = el('div', 'skeleton');
  s.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < lines; i++) {
    const line = el('span', 'skeleton-line');
    // Last line short, so the block reads as a paragraph rather than a table.
    if (i === lines - 1) line.style.width = '62%';
    s.append(line);
  }
  return s;
}

export function statRow(stats) {
  const row = el('div', 'stat-row');
  for (const s of stats) row.append(s);
  return row;
}

export function badge(text, tone = 'neutral') {
  return el('span', `badge badge-${tone}`, text);
}

export function note(text, tone = '') {
  return el('p', `note ${tone}`.trim(), text);
}

export function field(labelText, input, hint) {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'field-label', labelText));
  wrap.append(input);
  if (hint) wrap.append(el('span', 'field-hint', hint));
  return wrap;
}

export function numberInput(id, opts = {}) {
  const i = el('input');
  i.type = 'number';
  i.id = id;
  if (opts.min != null) i.min = opts.min;
  if (opts.max != null) i.max = opts.max;
  if (opts.step != null) i.step = opts.step;
  if (opts.value != null && opts.value !== '') i.value = opts.value;
  i.placeholder = opts.placeholder ?? '—';
  return i;
}

export function textInput(id, opts = {}) {
  const i = el('input');
  i.type = opts.type || 'text';
  i.id = id;
  if (opts.value) i.value = opts.value;
  i.placeholder = opts.placeholder ?? '';
  return i;
}

export function button(label, opts = {}) {
  const b = el('button', `btn ${opts.variant ? 'btn-' + opts.variant : ''}`.trim(), label);
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  if (opts.type) b.type = opts.type;
  return b;
}

/**
 * Non-blocking confirmation. Errors state what happened; they don't apologise.
 *
 * `opts.action` puts a button in the toast — used for undo, where the window
 * in which reversing is cheap is exactly the window the toast is up for.
 */
let toastTimer = null;
export function toast(message, tone = 'ok', opts = {}) {
  let t = $('#toast');
  if (!t) {
    t = el('div', 'toast');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    document.body.append(t);
  }
  clear(t);
  t.className = `toast toast-${tone} is-visible`;
  t.append(el('span', 'toast-text', message));

  // An action gets longer on screen. Four seconds is enough to read a
  // confirmation and not enough to decide you did not mean it.
  let life = 3600;
  if (opts.action) {
    life = opts.life ?? 9000;
    const b = el('button', 'toast-action', opts.action.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      t.classList.remove('is-visible');
      clearTimeout(toastTimer);
      opts.action.onClick();
    });
    t.append(b);
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-visible'), life);
}

/**
 * What to show when a screen has nothing yet. An empty screen is an
 * invitation to act, so every one of these names the next step.
 */
export function empty(title, body, action) {
  const e = el('div', 'empty');
  e.append(el('div', 'empty-title', title));
  e.append(el('p', 'empty-body', body));
  if (action) e.append(action);
  return e;
}

export const fmt = {
  int: (n) => (n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString()),
  dec: (n, p = 1) => (n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(p)),
  signed: (n, p = 1) => (n == null || Number.isNaN(n) ? '—' : (n > 0 ? '+' : '') + Number(n).toFixed(p)),
  date: (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
  longDate: (d) => new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
  hours: (min) => (min == null ? '—' : `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}`),
  title: (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
};

/** Adaptations carry a colour too, so a plan reads at a glance. */
export const ADAPTATION_TONE = {
  vo2max: 'vo2',
  anaerobic_capacity: 'vo2',
  neuromuscular: 'vo2',
  lactate_clearance: 'threshold',
  threshold_tte: 'threshold',
  sweetspot: 'tempo',
  aerobic_base: 'endurance',
  recovery: 'recovery',
  mixed: 'neutral',
};
