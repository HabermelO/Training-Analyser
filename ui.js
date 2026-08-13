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
 * A number with its label and unit. `tone` picks the metric colour so the
 * same quantity reads the same way on every screen.
 */
export function stat(label, value, opts = {}) {
  const s = el('div', 'stat');
  s.append(el('div', 'stat-label', label));
  const v = el('div', 'stat-value');
  v.textContent = value ?? '—';
  if (opts.tone) v.style.color = METRIC_COLOUR[opts.tone] || opts.tone;
  if (opts.unit) {
    const u = el('span', 'stat-unit', opts.unit);
    v.append(u);
  }
  s.append(v);
  if (opts.note) s.append(el('div', 'stat-note', opts.note));
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

/** Non-blocking confirmation. Errors state what happened; they don't apologise. */
let toastTimer = null;
export function toast(message, tone = 'ok') {
  let t = $('#toast');
  if (!t) {
    t = el('div', 'toast');
    t.id = 'toast';
    document.body.append(t);
  }
  t.className = `toast toast-${tone} is-visible`;
  t.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-visible'), 3600);
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
