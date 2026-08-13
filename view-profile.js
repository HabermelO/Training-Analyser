// Profile: what the athlete knows about themselves, and what the app has
// worked out. The two are shown side by side on purpose — a number you typed
// and a number that was modelled from your riding are different kinds of fact,
// and the screen should not blur them.

import { store, todayIso } from './store.js';
import { deriveAthlete, explainProfile } from './athlete.js';
import { onboardingProfile } from './proposals.js';
import {
  el, card, stat, statRow, field, numberInput, textInput, button, toast,
  badge, fmt, clear,
} from './ui.js';

export function renderProfile(root, ctx) {
  clear(root);
  const saved = store.profile();
  const rides = store.rides();
  const derived = deriveAthlete(rides, saved);

  // --- what you know -------------------------------------------------
  const you = card('About you', { hint: 'All optional' });

  const name = textInput('p-name', { value: saved.name || '', placeholder: 'Your name' });
  const age = numberInput('p-age', { value: saved.age ?? '', min: 10, max: 100 });
  const weight = numberInput('p-weight', { value: saved.weightKg ?? '', min: 30, max: 200, step: 0.1 });

  const grid = el('div', 'field-grid');
  grid.append(
    field('Name', name),
    field('Age', age, 'Only used as a last-resort fallback for max heart rate'),
    field('Weight (kg)', weight, 'Enables watts per kilo'),
  );
  you.body.append(grid);

  // --- physiology ----------------------------------------------------
  const phys = card('Your numbers', { hint: 'Leave blank and the app works them out' });

  const ftp = numberInput('p-ftp', { value: saved.ftp ?? '', min: 80, max: 600 });
  const maxHr = numberInput('p-maxhr', { value: saved.maxHr ?? '', min: 120, max: 230 });

  const physGrid = el('div', 'field-grid');
  physGrid.append(
    field('Threshold power (W)', ftp, 'A figure you have tested or been given'),
    field('Max heart rate (bpm)', maxHr, 'The highest you have genuinely seen'),
  );
  phys.body.append(physGrid);
  phys.body.append(el('p', 'note', onboardingProfile({
    ftp: saved.ftp, maxHr: saved.maxHr, age: saved.age,
  }).note));

  const save = button('Save profile', {
    variant: 'primary',
    onClick: () => {
      const next = {
        ...saved,
        name: name.value.trim() || null,
        age: Number(age.value) || null,
        weightKg: Number(weight.value) || null,
        ftp: Number(ftp.value) || null,
        maxHr: Number(maxHr.value) || null,
      };
      // A number the athlete typed is demonstrated by definition, so it
      // anchors the drift cap that stops an inferred threshold walking upward.
      if (next.ftp && next.ftp !== saved.ftp) {
        next.confirmedFtp = next.ftp;
        next.ftpSetAt = new Date().toISOString();
        next.lastBumpAt = null;
      }
      store.setProfile(next);
      toast('Profile saved');
      ctx.refresh();
    },
  });
  phys.body.append(el('div', 'actions').appendChild(save).parentNode);

  // --- what the app worked out ---------------------------------------
  const worked = card('What your rides say', {
    hint: rides.length ? `${rides.length} ride${rides.length === 1 ? '' : 's'}` : 'No rides yet',
  });

  const wkg = derived.ftp && saved.weightKg
    ? (derived.ftp / saved.weightKg).toFixed(2)
    : null;

  worked.body.append(statRow([
    stat('Threshold', derived.ftp ?? '—', { unit: derived.ftp ? 'W' : '', tone: 'ftp' }),
    stat('Watts / kg', wkg ?? '—', { tone: 'ftp', note: saved.weightKg ? null : 'Add your weight' }),
    stat('Max heart rate', derived.maxHr ?? '—', { unit: derived.maxHr ? 'bpm' : '', tone: 'rhr' }),
    stat('Confidence', fmt.title(derived.status), {}),
  ]));

  const prov = el('ul', 'notes');
  for (const line of explainProfile(derived)) prov.append(el('li', null, line));
  worked.body.append(prov);

  if (derived.hrZones) {
    const zones = el('div', 'zonestrip');
    const bands = [
      ['Z1', 0, derived.hrZones.z1], ['Z2', derived.hrZones.z1, derived.hrZones.z2],
      ['Z3', derived.hrZones.z2, derived.hrZones.z3], ['Z4', derived.hrZones.z3, derived.hrZones.z4],
      ['Z5', derived.hrZones.z4, derived.maxHr],
    ];
    for (const [name_, lo, hi] of bands) {
      const b = el('div', 'zonechip');
      b.append(el('span', 'zonechip-name', name_));
      b.append(el('span', 'zonechip-range', `${Math.round(lo)}–${Math.round(hi)}`));
      zones.append(b);
    }
    worked.body.append(el('h3', 'sub', 'Heart rate zones'));
    worked.body.append(zones);
    worked.body.append(el('p', 'note', 'Derived from your max heart rate, so they move when it does.'));
  }

  // --- your data -----------------------------------------------------
  const data = card('Your data', { hint: 'Stored on this device only' });
  const actions = el('div', 'actions');

  actions.append(button('Export a backup', {
    onClick: () => {
      const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `training-analyser-${todayIso()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Backup downloaded');
    },
  }));

  const importer = el('input');
  importer.type = 'file';
  importer.accept = 'application/json';
  importer.className = 'visually-hidden';
  importer.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      store.importAll(JSON.parse(await f.text()));
      toast('Backup restored');
      ctx.refresh();
    } catch (err) {
      toast(`That file could not be read: ${err.message}`, 'warn');
    }
  });
  actions.append(button('Restore a backup', { onClick: () => importer.click() }), importer);

  actions.append(button('Delete everything', {
    variant: 'danger',
    onClick: () => {
      if (!confirm('Delete every ride, decision and setting on this device? This cannot be undone.')) return;
      store.clearAll();
      toast('All data deleted');
      ctx.refresh();
    },
  }));

  data.body.append(actions);
  data.body.append(el('p', 'note',
    'Nothing is uploaded anywhere. That also means clearing your browser data clears this, so keep a backup.'));

  root.append(you, phys, worked, data);
}
