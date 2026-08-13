// Everything the app remembers, in one place.
//
// localStorage, deliberately: the app's promise is that nothing leaves the
// device, and a key-value store is enough until the ride count makes it
// awkward. Every read is defensive — a corrupted key should cost you that
// key's data, not the whole app.

const KEYS = {
  profile: 'ta.profile.v2',
  rides: 'ta.rides.v2',
  decisions: 'ta.decisions.v2',
  wellness: 'ta.wellness.v1',
  planEdits: 'ta.planEdits.v1',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota, or private mode with storage blocked. The app keeps working for
    // this session; it just will not remember.
    return false;
  }
}

export const store = {
  profile: () => read(KEYS.profile, {}),
  setProfile: (p) => write(KEYS.profile, p),
  patchProfile(patch) {
    const next = { ...read(KEYS.profile, {}), ...patch };
    write(KEYS.profile, next);
    return next;
  },

  rides: () => read(KEYS.rides, []),
  addRide(ride) {
    // Same ride uploaded twice replaces rather than duplicates: the date is
    // the natural key, since two files cannot start at the same second.
    const rides = read(KEYS.rides, [])
      .filter((r) => r.date !== ride.date)
      .concat(ride)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    write(KEYS.rides, rides);
    return rides;
  },
  removeRide(date) {
    const rides = read(KEYS.rides, []).filter((r) => r.date !== date);
    write(KEYS.rides, rides);
    return rides;
  },

  decisions: () => read(KEYS.decisions, []),
  addDecision(d) {
    const all = read(KEYS.decisions, []).concat(d);
    write(KEYS.decisions, all);
    return all;
  },

  // Daily check-in: HRV, resting HR, sleep, how you feel. One entry per day,
  // keyed by date, so saving twice corrects rather than duplicates.
  wellness: () => read(KEYS.wellness, []),
  setWellness(entry) {
    const all = read(KEYS.wellness, [])
      .filter((w) => w.date !== entry.date)
      .concat(entry)
      .sort((a, b) => a.date.localeCompare(b.date));
    write(KEYS.wellness, all);
    return all;
  },

  // Workouts the athlete has dragged to a different day. Keyed by ISO date so
  // a moved session survives the plan being recomputed.
  planEdits: () => read(KEYS.planEdits, {}),
  setPlanEdit(dateIso, workoutId) {
    const edits = read(KEYS.planEdits, {});
    if (workoutId == null) delete edits[dateIso];
    else edits[dateIso] = workoutId;
    write(KEYS.planEdits, edits);
    return edits;
  },
  clearPlanEdits: () => write(KEYS.planEdits, {}),

  exportAll() {
    return {
      exportedAt: new Date().toISOString(),
      profile: read(KEYS.profile, {}),
      rides: read(KEYS.rides, []),
      decisions: read(KEYS.decisions, []),
      wellness: read(KEYS.wellness, []),
      planEdits: read(KEYS.planEdits, {}),
    };
  },

  importAll(data) {
    if (!data || typeof data !== 'object') throw new Error('That file is not a backup.');
    if (data.profile) write(KEYS.profile, data.profile);
    if (Array.isArray(data.rides)) write(KEYS.rides, data.rides);
    if (Array.isArray(data.decisions)) write(KEYS.decisions, data.decisions);
    if (Array.isArray(data.wellness)) write(KEYS.wellness, data.wellness);
    if (data.planEdits) write(KEYS.planEdits, data.planEdits);
  },

  clearAll() {
    for (const k of Object.values(KEYS)) {
      try { localStorage.removeItem(k); } catch { /* nothing to do */ }
    }
  },
};

/** Only what the engine reads later, so storage does not fill with samples. */
export const summariseRide = (ride, extra = {}) => ({
  date: ride.date,
  durationMin: ride.durationMin,
  np: ride.np,
  tss: ride.tss,
  if: ride.if,
  decouplingPct: ride.decouplingPct,
  peakPowers: ride.peakPowers,
  maxHr: ride.maxHrSustained30s,
  hrRedzoneSecs: ride.hrRedzoneSecs,
  zoneMinutes: ride.zoneMinutes,
  efficiencyByZone: ride.efficiencyByZone,
  declaredFtp: ride.declaredFtp ?? null,
  ...extra,
});

export const todayIso = () => new Date().toISOString().slice(0, 10);
