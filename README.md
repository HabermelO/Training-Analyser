# Flat layout

Every file sits in the repository root. No folders, so nothing depends on the
folder structure being reproduced correctly — which is what was failing.

Upload all of these to the root of the repository, alongside `index.html` and
`.nojekyll`. If files from an earlier attempt are still there under different
names, delete them first: a stale `fit_worker.js` or `src/` folder does no harm
but will confuse the next person to read the repo.

## Two files were renamed

The nested layout had two files called `index.js` (`src/ingest/index.js` and
`src/llm/index.js`), which cannot both live in the root. They are now:

| was | now |
| --- | --- |
| `src/ingest/index.js` | `ingest.js` |
| `src/llm/index.js` | `narration.js` |

Every import has been rewritten to match. Nothing else changed — the engine,
parser, guard and narration code are byte-identical to the nested version.

## What the page does on load

Before importing anything it checks all 21 module files are actually reachable
and, if any are missing, names them with the URL it tried. "Importing a module
script failed" is all the browser gives you otherwise, and it never says which
file.

## Note on tests

`test/parse.js`, `test/sources.js` and `test/scenarios.js` still expect the
nested layout, since they run under Node rather than being served. Keep them in
a `test/` folder if you want them, or leave them out of this repository — the
app does not import them.
