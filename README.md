# Training Analyser

An offline cycling analyser. Upload a `.fit` file, get a verdict on the
session, a profile the app works out from your riding, and a plan for the week.
Nothing is uploaded anywhere — every calculation happens in the browser.

## Installing

Every file goes in the **root** of the repository, next to `index.html`. No
folders, no build step. Turn on GitHub Pages, deploying from a branch, folder
`/ (root)`.

If a file is missing, the page says which one on load rather than failing
silently.

## Tabs

**Analyse** — drop in a ride. Two-pass parse: the file is read once with no
profile (peak powers, heart rate, duration and normalised power need no
threshold), the profile is derived from that evidence, then the ride is
recomputed with zones, TSS and classification. Assuming a threshold in order to
compute the evidence that produces it would be circular, and the numbers would
look plausible while being wrong.

**History** — a daily check-in for HRV, resting heart rate, sleep and how you
feel, then the long view. Fitness, fatigue and form share the left axis; heart
rate, threshold and power-per-beat are on the right, marked `R`, because those
quantities do not share a unit and plotting them together would imply a
comparison that does not exist.

**Plan** — the week the engine suggests, with what each session is for. Drag a
session to another day, or tap it and tap the day. Dropping onto an occupied
day swaps the two rather than deleting one. Moves are stored as overrides
keyed by date, so they survive the plan being recomputed; "Reset to suggested"
always gets you back.

**Profile** — what you know about yourself, and what the app worked out, shown
side by side. A number you typed and a number modelled from your riding are
different kinds of fact and the screen does not blur them. Export and restore
live here too.

## Colour

Each metric family carries one colour everywhere it appears — chart line,
badge, calendar chip, sparkline. Power and threshold are yellow, anything
cardiac is pink, training load is blue, form is green. The palette is from
Grand Tour jerseys, and it is meant to be learned once and then read at a
glance.

## Two files were renamed

The nested layout had two files called `index.js`, which cannot both live in
the root:

| was | now |
| --- | --- |
| `src/ingest/index.js` | `ingest.js` |
| `src/llm/index.js` | `narration.js` |

## Working on it

Run it locally before pushing — module imports and workers both need a real
HTTP server, so opening `index.html` from the filesystem will not work:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`. That is a two-second feedback loop instead
of waiting for a Pages rebuild.

## Rest days

The planner can now leave days empty. It brings a week under its load target in
order of what costs the least adaptation: endurance days become recovery spins,
the long ride shortens, recovery spins become rest, and only then does
intensity go. A tolerance of 8% stops it destroying a week to shed the last few
TSS. If the target still cannot be met, the plan says so rather than quietly
overshooting.

## Known limitations

- The first visit needs a network connection: `fit-file-parser` and WebLLM load
  from a CDN. After that the browser has them cached. A service worker is the
  honest fix if offline-from-first-load matters.
- On-device narration needs WebGPU. Without it every summary comes from the
  rules engine instead, which is a supported state rather than a failure.
- Rides are summarised when stored, so reopening the app shows history and
  trends but not the full per-ride breakdown. Upload the file again for that.
