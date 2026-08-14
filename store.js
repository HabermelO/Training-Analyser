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
  rideDetail: 'ta.rideDetail.v1',
  prefs: 'ta.prefs.v1',
};

// Stamped into every export. A backup written by a future version can then be
// refused with a sentence rather than half-imported into a shape that no
// longer matches — silent partial restores are how longitudinal data dies.
export const SCHEMA_VERSION = 1;

// Detail is the expensive key. Storing every ride's verdict forever will hit
// the localStorage quota long before the ride summaries do, and the value of a
// stored detail decays fast — nobody re-reads the verdict from four months
// ago. Keep a rolling window and let the summary carry the long history.
const DETAIL_KEEP = 40;

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
    const detail = read(KEYS.rideDetail, {});
    if (detail[date]) { delete detail[date]; write(KEYS.rideDetail, detail); }
    return rides;
  },

  // --- ride detail ---------------------------------------------------
  // The verdict and the slice of the ride it was computed from, keyed by ride
  // date. Deliberately NOT the record stream: that is the large part, and it
  // is only needed to recompute, which this path never does.
  rideDetail(date) {
    return read(KEYS.rideDetail, {})[date] || null;
  },
  rideDetails: () => read(KEYS.rideDetail, {}),
  setRideDetail(date, detail) {
    const all = read(KEYS.rideDetail, {});
    all[date] = detail;

    // Evict oldest beyond the window. Sorting by the key rather than by the
    // rides list keeps this correct even if a detail outlives its ride.
    const keys = Object.keys(all).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - DETAIL_KEEP))) delete all[k];

    if (!write(KEYS.rideDetail, all)) {
      // Out of quota. Detail is the one thing here that can be regenerated
      // from the file, so shed it rather than letting a failed write cascade
      // into the summary that cannot be.
      write(KEYS.rideDetail, { [date]: detail });
    }
    return all;
  },

  decisions: () => read(KEYS.decisions, []),
  addDecision(d) {
    const all = read(KEYS.decisions, []).concat(d);
    write(KEYS.decisions, all);
    return all;
  },
  // Undo pops by identity, not by position. A second tab that recorded its own
  // decision in between must not have it removed by this one's undo.
  removeDecision(d) {
    const all = read(KEYS.decisions, []);
    const i = all.lastIndexOf(d) >= 0 ? all.lastIndexOf(d) : all.findIndex((x) => same(x, d));
    if (i < 0) return all;
    all.splice(i, 1);
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

  // Interface state — which chart series are on, and so on. Deliberately
  // outside exportAll(): a backup is the athlete's training history, and
  // restoring it onto another device should not carry a legend selection with
  // it.
  prefs: () => read(KEYS.prefs, {}),
  setPref(key, value) {
    const all = read(KEYS.prefs, {});
    all[key] = value;
    write(KEYS.prefs, all);
    return all;
  },

  exportAll() {
    return {
      app: 'training-analyser',
      schema: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      profile: read(KEYS.profile, {}),
      rides: read(KEYS.rides, []),
      decisions: read(KEYS.decisions, []),
      wellness: read(KEYS.wellness, []),
      planEdits: read(KEYS.planEdits, {}),
      rideDetail: read(KEYS.rideDetail, {}),
    };
  },

  /**
   * Replaces everything. The caller confirms first — this function does not
   * ask, it just refuses files it cannot honestly read.
   */
  importAll(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('That file is not a backup.');
    }
    // A missing schema means a backup written before versioning existed. Those
    // are the shape v1 expects, so read them as v1 rather than rejecting a
    // file the athlete made with this same app last month.
    const schema = data.schema ?? SCHEMA_VERSION;
    if (typeof schema !== 'number' || schema > SCHEMA_VERSION) {
      throw new Error(`this backup is from a newer version (schema ${schema}). Update the app, then restore.`);
    }
    if (!data.profile && !Array.isArray(data.rides)) {
      throw new Error('that file has no profile or rides in it.');
    }

    if (data.profile) write(KEYS.profile, data.profile);
    write(KEYS.rides, Array.isArray(data.rides) ? data.rides : []);
    write(KEYS.decisions, Array.isArray(data.decisions) ? data.decisions : []);
    write(KEYS.wellness, Array.isArray(data.wellness) ? data.wellness : []);
    write(KEYS.planEdits, data.planEdits && typeof data.planEdits === 'object' ? data.planEdits : {});
    write(KEYS.rideDetail, data.rideDetail && typeof data.rideDetail === 'object' ? data.rideDetail : {});

    return {
      schema,
      rides: Array.isArray(data.rides) ? data.rides.length : 0,
      wellness: Array.isArray(data.wellness) ? data.wellness.length : 0,
    };
  },

  clearAll() {
    for (const k of Object.values(KEYS)) {
      try { localStorage.removeItem(k); } catch { /* nothing to do */ }
    }
  },
};

/** Only what the engine reads later, so storage does not fill with samples. */
/** Enough to identify a decision record across a serialise/parse round trip. */
const same = (a, b) =>
  a && b && a.at === b.at && a.field === b.field && a.action === b.action;

/**
 * The slice of a computed ride the Ride tab needs to redraw its verdict with
 * no file present. Stamped with the threshold in force at the time, because a
 * verdict computed against a since-moved FTP is stale, and silently
 * recomputing it would rewrite the athlete's history.
 */
export const rideDetailOf = (ride, verdict, ftpUsed) => ({
  schema: SCHEMA_VERSION,
  storedAt: new Date().toISOString(),
  ftpUsed: ftpUsed ?? null,
  verdict,
  ride: {
    date: ride.date,
    durationMin: ride.durationMin,
    np: ride.np,
    tss: ride.tss,
    if: ride.if,
    peakPowers: ride.peakPowers,
    zoneMinutes: ride.zoneMinutes,
    maxHrSustained30s: ride.maxHrSustained30s,
    decouplingPct: ride.decouplingPct,
    efficiencyByZone: ride.efficiencyByZone,
    declaredFtp: ride.declaredFtp ?? null,
  },
});

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
