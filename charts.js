// Charts, drawn as SVG by hand.
//
// No charting library: the app has no build step, and the three chart types it
// actually needs are less code than the import would be. Everything scales to
// its container via viewBox, so there is no resize handling to get wrong.

const NS = 'http://www.w3.org/2000/svg';

const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
};

const niceStep = (range, target = 5) => {
  if (!(range > 0)) return 1;
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
};

/**
 * Multi-series time chart. Series that share a unit share an axis; anything
 * else gets normalised and labelled as such, because plotting HRV and CTL on
 * one linear axis would imply a comparison that does not exist.
 *
 * series: [{ key, label, colour, points: [{x: Date|ms, y}], axis: 'left'|'right', dashed }]
 */
export function timeChart(series, opts = {}) {
  const W = 1000;
  const H = opts.height || 320;
  const M = { top: 16, right: 52, bottom: 30, left: 46 };

  const live = series.filter((s) => s.points && s.points.length);
  const wrap = document.createElement('div');
  wrap.className = 'chart';

  if (!live.length) {
    wrap.innerHTML = '<div class="chart-empty">Nothing to plot yet.</div>';
    return wrap;
  }

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart-svg',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': opts.ariaLabel || 'Time series chart',
  });

  const xs = live.flatMap((s) => s.points.map((p) => +new Date(p.x)));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const xScale = (v) => M.left + ((+new Date(v) - x0) / (x1 - x0 || 1)) * (W - M.left - M.right);

  // One scale per axis side.
  const scaleFor = (side) => {
    const pts = live.filter((s) => (s.axis || 'left') === side).flatMap((s) => s.points.map((p) => p.y));
    if (!pts.length) return null;
    let lo = Math.min(...pts);
    let hi = Math.max(...pts);
    if (lo === hi) { lo -= 1; hi += 1; }
    // Keep zero visible when the data straddles it — TSB above and below the
    // line is the whole point of that series.
    if (lo > 0 && lo / hi > 0.6) lo = 0;
    if (hi < 0) hi = 0;
    const pad = (hi - lo) * 0.08;
    return { lo: lo - pad, hi: hi + pad };
  };

  const left = scaleFor('left');
  const right = scaleFor('right');
  const yOf = (v, side) => {
    const s = side === 'right' ? right : left;
    if (!s) return H - M.bottom;
    return M.top + (1 - (v - s.lo) / (s.hi - s.lo)) * (H - M.top - M.bottom);
  };

  // Horizontal gridlines from the left axis.
  if (left) {
    const step = niceStep(left.hi - left.lo);
    const start = Math.ceil(left.lo / step) * step;
    for (let v = start; v <= left.hi; v += step) {
      const y = yOf(v, 'left');
      svg.append(svgEl('line', { x1: M.left, x2: W - M.right, y1: y, y2: y, class: 'grid' }));
      const t = svgEl('text', { x: M.left - 8, y: y + 4, class: 'axis-label', 'text-anchor': 'end' });
      t.textContent = Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v * 10) / 10;
      svg.append(t);
    }
  }

  // Zero line, if the left scale crosses it.
  if (left && left.lo < 0 && left.hi > 0) {
    const y = yOf(0, 'left');
    svg.append(svgEl('line', { x1: M.left, x2: W - M.right, y1: y, y2: y, class: 'grid grid-zero' }));
  }

  if (right) {
    const step = niceStep(right.hi - right.lo);
    const start = Math.ceil(right.lo / step) * step;
    for (let v = start; v <= right.hi; v += step) {
      const t = svgEl('text', { x: W - M.right + 8, y: yOf(v, 'right') + 4, class: 'axis-label', 'text-anchor': 'start' });
      t.textContent = Math.round(v * 10) / 10;
      svg.append(t);
    }
  }

  // Date ticks.
  const spanDays = (x1 - x0) / 86400000;
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = x0 + ((x1 - x0) / ticks) * i;
    const t = svgEl('text', { x: xScale(v), y: H - 8, class: 'axis-label', 'text-anchor': 'middle' });
    t.textContent = new Date(v).toLocaleDateString(undefined,
      spanDays > 300 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });
    svg.append(t);
  }

  for (const s of live) {
    const pts = [...s.points].sort((a, b) => +new Date(a.x) - +new Date(b.x));
    const side = s.axis || 'left';
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xScale(p.x).toFixed(1)},${yOf(p.y, side).toFixed(1)}`).join(' ');

    if (s.fill) {
      const base = yOf(side === 'right' ? right.lo : Math.max(left.lo, 0), side);
      const area = `${d} L${xScale(pts[pts.length - 1].x).toFixed(1)},${base.toFixed(1)} L${xScale(pts[0].x).toFixed(1)},${base.toFixed(1)} Z`;
      svg.append(svgEl('path', { d: area, fill: s.colour, opacity: 0.12, stroke: 'none' }));
    }

    svg.append(svgEl('path', {
      d, fill: 'none', stroke: s.colour, 'stroke-width': s.width || 2.5,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'stroke-dasharray': s.dashed ? '5 5' : null,
      class: 'series', 'data-key': s.key,
    }));

    // Dots only when there are few enough that they read as data points
    // rather than a thicker line.
    if (pts.length <= 40) {
      for (const p of pts) {
        svg.append(svgEl('circle', { cx: xScale(p.x), cy: yOf(p.y, side), r: 3, fill: s.colour, class: 'dot' }));
      }
    }
  }

  wrap.append(svg);
  return wrap;
}

/** Small inline trend line. No axes — it shows shape, not values. */
export function sparkline(values, colour, opts = {}) {
  const W = 120;
  const H = opts.height || 32;
  const wrap = document.createElement('span');
  wrap.className = 'spark';
  const vals = values.filter((v) => v != null && !Number.isNaN(v));
  if (vals.length < 2) return wrap;

  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const y = (v) => 3 + (1 - (v - lo) / ((hi - lo) || 1)) * (H - 6);
  const x = (i) => (i / (vals.length - 1)) * W;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark-svg', 'aria-hidden': 'true' });
  svg.append(svgEl('path', {
    d: vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    fill: 'none', stroke: colour, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));
  svg.append(svgEl('circle', { cx: x(vals.length - 1), cy: y(vals[vals.length - 1]), r: 2.8, fill: colour }));
  wrap.append(svg);
  return wrap;
}

/** Horizontal bars for time-in-zone. Zones are ordered, so bars are too. */
/**
 * Realised intensity distribution as one bar in three parts. Deliberately not
 * a pie and not three separate bars: the whole point is the proportion between
 * them, and the middle segment growing is the thing worth seeing.
 */
export function distributionBar(dist) {
  const wrap = document.createElement('div');
  wrap.className = 'tidbar';
  if (!dist || dist.easyPct == null) {
    wrap.innerHTML = '<div class="chart-empty">Not enough riding yet to read a distribution.</div>';
    return wrap;
  }

  const segments = [
    { key: 'easy', label: 'Easy', pct: dist.easyPct, mins: dist.easyMin, colour: 'var(--fresh)' },
    { key: 'moderate', label: 'Tempo', pct: dist.moderatePct, mins: dist.moderateMin, colour: 'var(--power)' },
    { key: 'hard', label: 'Hard', pct: dist.hardPct, mins: dist.hardMin, colour: 'var(--fatigue)' },
  ];

  const track = document.createElement('div');
  track.className = 'tidbar-track';
  track.setAttribute('role', 'img');
  track.setAttribute(
    'aria-label',
    segments.map((s) => `${s.label} ${s.pct}%`).join(', ')
  );
  for (const s of segments) {
    if (!s.pct) continue;
    const seg = document.createElement('span');
    seg.className = `tidbar-seg tidbar-seg-${s.key}`;
    seg.style.width = `${s.pct}%`;
    seg.style.background = s.colour;
    seg.title = `${s.label}: ${s.pct}% (${Math.round(s.mins)} min)`;
    if (s.pct >= 12) seg.textContent = `${Math.round(s.pct)}%`;
    track.append(seg);
  }
  wrap.append(track);

  const key = document.createElement('div');
  key.className = 'tidbar-key';
  for (const s of segments) {
    const item = document.createElement('span');
    item.className = 'tidbar-keyitem';
    const dot = document.createElement('span');
    dot.className = 'tidbar-dot';
    dot.style.background = s.colour;
    item.append(dot);
    item.append(document.createTextNode(`${s.label} ${s.pct}%`));
    key.append(item);
  }
  wrap.append(key);
  return wrap;
}

export function zoneBars(zoneMinutes, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'zonebars';
  const entries = Object.entries(zoneMinutes || {}).filter(([, v]) => v > 0);
  if (!entries.length) {
    wrap.innerHTML = '<div class="chart-empty">No zone data for this ride.</div>';
    return wrap;
  }
  const max = Math.max(...entries.map(([, v]) => v));
  const tone = opts.tones || {};

  for (const [zone, mins] of entries) {
    const row = document.createElement('div');
    row.className = 'zonebar';
    const label = document.createElement('span');
    label.className = 'zonebar-label';
    label.textContent = zone.split('_')[0];
    const track = document.createElement('span');
    track.className = 'zonebar-track';
    const fill = document.createElement('span');
    fill.className = 'zonebar-fill';
    fill.style.width = `${(mins / max) * 100}%`;
    fill.style.background = tone[zone] || 'var(--load)';
    track.append(fill);
    const val = document.createElement('span');
    val.className = 'zonebar-value';
    val.textContent = `${mins.toFixed(0)}m`;
    row.append(label, track, val);
    wrap.append(row);
  }
  return wrap;
}
