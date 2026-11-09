# Store screenshots

Reproducible store images: the real app on the dev estate, rendered at exact store sizes in the light
theme, composed by script on the yellow field with a Fredoka caption. Decided by the owner
(2026-11-09); the rules for what may appear on screen are
[store-listings](../../docs/wiki/store-listings.md) sections 4 and 9. Nothing here uploads to a store.

| File | Role |
| --- | --- |
| `scenario.json` | the demo week (invented first names, generic associations, one group chat, one poll, one event), the six shots, their captions in fr and en, the strings that MUST and MUST NOT be on screen |
| `sizes.json` | Apple 6.9in 1320x2868, Apple 6.5in 1284x2778, Play phone 1080x1920, Play feature graphic 1024x500; the capture viewport; the field and ink colours |
| `shots.mjs` | `capture`, `verify`, `compose`, `all` |
| `lib.mjs` | CDP tab, static server, PNG flattener (stores refuse an alpha channel; the output is RGB, no metadata) |
| `photos.titles.json`, `photos.manifest.json`, `photos.mjs` | free-licence demo photos: the manifest (source URL, author, licence) is committed, the files are downloaded by `bun photos.mjs fetch` |

## Run it

1. **A Chrome signed in on dev and unlocked**, on a debugging port (default 9231), with its own profile
   (never a campaign profile). With the cross-client rig: start Chrome with
   `--remote-debugging-port=9231 --user-data-dir=<state dir>/chrome-store-shots`, then
   `bun login.mjs --port 9231 --account <a dev account>` and `bun pin.mjs --port 9231 --account <same> --stay`
   from `tools/cross-client-harness`. The tool only opens its own tabs.
2. `bun shots.mjs capture --work DIR` opens every route in fr then en, 390x1000 CSS px at 3x, light theme,
   dev banner closed, and stores the PNG plus the page text.
3. `bun shots.mjs verify --work DIR` reads that text: every `expect` string of the scenario present, no
   `forbiddenOnScreen` string (`Canari Test`, `Fictif`...).
4. `bun shots.mjs compose --work DIR --out DIR` writes `<out>/<size>/<lang>/<shot>.png`. It REFUSES while
   verify has problems; `--allow-dirty` writes `PREVIEW-` files that must never be uploaded.

Fredoka comes from the app's own package (`frontend/node_modules`, so run `bun install` in `frontend/`),
or `STORE_SHOTS_FONT=<file.woff2>`. The tool refuses any site other than `dev.canari-emse.fr`.

## What the demo content needs on dev (the seed is NOT automated)

Posts, events and associations are rows, but a conversation and a community are MLS state: only live
clients can create them. Until a person (or the rig) has created the content of `scenario.json` on dev
under fictional display names, `verify` fails, which is the point. The accounts of the rig carry the
display name `Canari Test ...`, so the six shots are not publishable before those names, the group
chat, the poll, the event and the photos exist ([store-listings](../../docs/wiki/store-listings.md#9-the-reproducible-screenshot-pipeline-decided-2026-11-09)).
