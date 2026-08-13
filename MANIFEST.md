# File manifest

Drop the `src/` and `test/` trees straight into the repo root. Everything is
plain ES modules, no build step.

```
src/
  engine/
    thresholds.js    unchanged   all tunable numbers
    classify.js      unchanged   ride -> session type
    load.js          unchanged   CTL/ATL/TSB, phenotype
    ftp.js           unchanged   critical-power model
    readiness.js     unchanged   HRV/RHR/sleep -> readiness flag
    planner.js       unchanged   7-day plan by constrained selection
    workouts.js      moved       now at src/data/workouts.js (planner imports ../data/)
    execution.js     CHANGED     peakPowers object bug
    verdict.js       CHANGED     refuses to guess an FTP; calibrating mode
    athlete.js       NEW         derives FTP / max HR from ride history
    proposals.js     NEW         offers profile changes for accept/reject
    standing.js      NEW         efficiency trend; keeps a threshold valid
  data/
    workouts.js      unchanged   moved here from engine/
  ingest/
    fit.worker.js    unchanged   off-thread FIT decode
    index.js         unchanged   main-thread worker wrapper
    metrics.js       CHANGED     sustained efforts, per-zone efficiency, sustained max HR
  llm/
    narrate.js       unchanged   prompt builder + template renderer
    guard.js         CHANGED     sign-aware number extraction
    index.js         unchanged   narrate(): generate -> validate -> repair -> template
    webllm.js        NEW         supplies generate() from WebLLM
    audit.js         NEW         measures where narration lands
test/
  parse.js           REPLACED    real .fit with synthetic fallback + device cross-check
  scenarios.js       NEW         verdict fixtures spanning the space
  sources.js         NEW         node audit (mock generator, plumbing only)
  sources.html       NEW         browser audit (real model, the number that matters)
```

## What changed in the files marked CHANGED

**`engine/execution.js`** — `peakPowers['1s']` is a `{power, hr}` object, but the
recovery check compared it directly against a number. Always false, so
`recovery_surge` could never fire, and the flag detail read
`peak power held to [object Object]W` — which went into `keyEvidence` and
straight into the model's prompt.

**`engine/verdict.js`** — no longer spreads `DEFAULT_ATHLETE` over a missing
FTP. Without a threshold it returns a `calibrating` verdict carrying only the
FTP-free evidence. This is the change that makes the whole athlete-derivation
path actually bind; without it a missing FTP silently became 240W.

**`ingest/metrics.js`** — three additions, all FTP-free so they work on a first
upload: `analyseEfforts()` (sustained efforts with HR/power coupling),
`efficiencyByZone()` (watts per heartbeat by zone), and `maxHrSustained30s`.

**`llm/guard.js`** — sign-aware number extraction, so `TSB at +22.9` no longer
validates against a TSB of `-22.9`.

## Order to wire it up

1. `deriveAthlete(rides, overrides)` → profile. Overrides are whatever the
   athlete entered at onboarding; all optional.
2. `buildVerdict({ ride, history, daily, athlete: profile, prescribed })`.
   Check `verdict.status === 'calibrating'` and render the reduced view.
3. `proposeFromRide(ride, profile, decisions)` after each upload → zero or more
   proposals to show. `acceptProposal` / `rejectProposal` return a new profile
   plus a decision record for you to persist.
4. `assessThresholdStanding(rides, profile)` periodically. Gate any downward
   proposal behind `allowDownwardProposal(standing)`.
5. `narrate(verdict, { generate })` for the prose, with `generate` from
   `createGenerator()`.

## Still outstanding

- `DEFAULT_ATHLETE.ftp` is still 240. Nothing reads it as fact any more, but it
  should become a last-resort prior rather than looking like a profile.
- `redzoneHrPctOfMax` (0.90) and the HR zone bands in `thresholds.js` are still
  defaults, not calibrated. `deriveHrZones()` in `athlete.js` supersedes the
  static bands once max HR is known — wire it in.
- `overallVerdict()` in `execution.js` checks `intervals_fragmented` before
  `intentMatch`, so a fragmented ride can never report as `off_plan`. Semantics
  call, left alone.
- `classify.js` has no mixed-session type. A ride with one long threshold block
  plus two short maximal efforts reads as "fragmented" when it was ridden that
  way on purpose.
- `test/fixtures/` is gitignored-by-absence; drop `.fit` files there and
  `test/parse.js` picks them up.
