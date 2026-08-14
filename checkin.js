// The daily check-in, and the one-line strip it collapses to.
//
// This card used to live on History. That was the wrong place and it was
// quietly expensive: the check-in is an *input* to computeReadiness(), which
// is the veto term in planWeek() and the first step in suggestToday()'s trace.
// readiness.js needs READINESS.minBaselineDays readings before the z-score
// path activates, and with the form parked on a tab nobody opens daily, that
// threshold was rarely reached — so the most carefully built part of the
// readiness model ran on its percentage fallback forever.
//
// It now sits at the top of Today, where the day actually starts. Its own file
// because Today is long enough already, and because a card this load-bearing
// should be findable by name.

import { store, todayIso } from './store.js';
import { READINESS } from './thresholds.js';
import { sparkline } from './charts.js';
import {
  el, card, field, numberInput, button, toast, note, clear,
} from './ui.js';

/**
 * @param ctx     the app context — needs refresh()
 * @param wellness  every entry, newest last
 * @returns a <section> that is either the form or the collapsed strip
 */
export function checkInCard(ctx, wellness) {
  const today = todayIso();
  const existing = wellness.find((w) => w.date === today);

  // Once today is answered, this is no longer the question — the session is.
  // Collapse to a strip so the session card takes the top slot, but keep the
  // numbers visible, because a saved value the athlete cannot see is a value
  // they will not trust or correct.
  const host = el('div', 'checkin-host');
  const draw = (expanded) => {
    clear(host);
    host.append(existing && !expanded
      ? summaryStrip(existing, () => draw(true))
      : formCard(ctx, wellness, existing, expanded ? () => draw(false) : null));
  };
  draw(false);
  return host;
}

function summaryStrip(entry, onEdit) {
  const strip = el('div', 'checkin-strip');
  const parts = [];
  if (entry.hrv != null) parts.push(['HRV', entry.hrv]);
  if (entry.rhr != null) parts.push(['RHR', entry.rhr]);
  if (entry.sleepHours != null) parts.push(['Sleep', `${entry.sleepHours}h`]);
  if (entry.mood != null) parts.push(['Feel', `${entry.mood}/10`]);

  strip.append(el('span', 'checkin-strip-label', 'Checked in'));
  const vals = el('span', 'checkin-strip-values');
  for (const [k, v] of parts) {
    const item = el('span', 'checkin-strip-item');
    item.append(el('span', 'checkin-strip-key', k));
    item.append(el('span', 'checkin-strip-num', String(v)));
    vals.append(item);
  }
  strip.append(vals);
  strip.append(button('Edit', { variant: 'quiet', onClick: onEdit }));
  return strip;
}

function formCard(ctx, wellness, existing, onCancel) {
  const c = card('Check in', {
    hint: existing ? 'Saved — change it any time' : 'Takes ten seconds',
  });

  const hrv = numberInput('w-hrv', { value: existing?.hrv ?? '', min: 10, max: 200 });
  const rhr = numberInput('w-rhr', { value: existing?.rhr ?? '', min: 25, max: 120 });
  const sleep = numberInput('w-sleep', { value: existing?.sleepHours ?? '', min: 0, max: 14, step: 0.1 });
  const mood = numberInput('w-mood', { value: existing?.mood ?? '', min: 1, max: 10 });

  const grid = el('div', 'field-grid field-grid-4');
  grid.append(
    field('HRV', hrv, 'From your watch or strap'),
    field('Resting HR', rhr, 'On waking'),
    field('Sleep (h)', sleep),
    field('How you feel', mood, '1 to 10'),
  );
  c.body.append(grid);

  const recent = wellness.slice(-21);
  if (recent.length > 2) {
    const spark = el('div', 'spark-row');
    spark.append(el('span', 'spark-label', 'HRV'));
    spark.append(sparkline(recent.map((w) => w.hrv), 'var(--hrv)'));
    spark.append(el('span', 'spark-label', 'Resting HR'));
    spark.append(sparkline(recent.map((w) => w.rhr), 'var(--cardiac)'));
    c.body.append(spark);
  }

  const actions = el('div', 'actions');
  actions.append(button('Save today', {
    variant: 'primary',
    onClick: () => {
      const entry = {
        date: todayIso(),
        hrv: Number(hrv.value) || null,
        rhr: Number(rhr.value) || null,
        sleepHours: Number(sleep.value) || null,
        mood: Number(mood.value) || null,
      };
      if (!entry.hrv && !entry.rhr && !entry.sleepHours && !entry.mood) {
        return toast('Nothing to save yet — fill in at least one.', 'warn');
      }
      store.setWellness(entry);
      toast('Saved');
      // A full refresh, not a local redraw: readiness feeds the plan, so
      // saving this changes the card underneath it.
      ctx.refresh();
    },
  }));
  if (onCancel) actions.append(button('Cancel', { variant: 'quiet', onClick: onCancel }));
  c.body.append(actions);

  c.body.append(note(
    `Readiness compares today against your own baseline. It needs about ${READINESS.minBaselineDays} days of entries before it can do that properly — until then it uses a simpler percentage rule.`,
  ));
  return c;
}

/**
 * The line the session card carries when readiness is still running on its
 * fallback. This makes the value of the habit legible instead of asking for
 * the data on faith. Returns null when there is nothing worth saying.
 */
export function baselineNote(readiness, entries = []) {
  if (!readiness) return null;
  // Nothing to explain once the z-score path is live — the note exists only to
  // account for the fallback, and repeating it after that is noise.
  if (readiness.method !== 'percent') return null;

  const need = READINESS.minBaselineDays;

  // Count what the athlete has actually logged, not what the fallback window
  // happened to look at. The fallback reads a rolling
  // READINESS.fallbackBaselineDays, so an athlete on day 13 would otherwise be
  // told they had 7 — which is true of the calculation and false of them, and
  // reads as the app losing their data.
  const logged = entries.filter((w) => w && w.hrv != null).length;
  const days = Math.max(logged, readiness.daysCollected ?? 0);
  if (days >= need) return null;

  return days === 0
    ? `No check-ins with HRV yet — ${need} days of them lets readiness judge today against your own baseline rather than a flat percentage.`
    : `Based on ${days} day${days === 1 ? '' : 's'} of check-ins — ${need} gives a firmer baseline.`;
}
