# Store screenshots

Reproducible store images: the real app on the dev estate, rendered at exact store sizes in the light
theme, composed by script on the yellow field with a Fredoka caption. Decided by the owner
(2026-11-09); the rules for what may appear on screen are
[store-listings](../../docs/wiki/store-listings.md) sections 4 and 9. Nothing here uploads to a store.

| File | Role |
| --- | --- |
| `scenario.json` | the demo week (invented first names, generic associations, one group chat, one poll, one event), the six shots, their captions in fr and en, the strings that MUST and MUST NOT be on screen |
| `sizes.json` | Apple 1206x2622 (the only mandatory iPhone class), Play phone 1080x1920, Play feature graphic 1024x500; the capture viewport; the field and ink colours |
| `shots.mjs` | `capture`, `verify`, `compose`, `all` |
| `lib.mjs` | CDP tab, static server, PNG flattener (stores refuse an alpha channel; the output is RGB, no metadata) |
| `photos.titles.json`, `photos.manifest.json`, `photos.mjs` | free-licence demo photos: the manifest (source URL, author, licence) is committed, the files are downloaded by `bun photos.mjs fetch` |

## Run it

FINAL images come from the PHONES only (owner, 2026-11-09): the installed dev app with its real native
chrome. The web capture is a layout preview, and `compose` writes `PREVIEW-` files for anything that is
not a native capture without problems.

1. **Demo content on dev.** `bun seed.mjs apply` (display names of the bench accounts, four invented
   people, three generic associations with the bench accounts as officers, three posts with a poll and its
   votes, four events; `teardown` removes exactly those rows) then `bun chat-seed.mjs --lang fr --ports
   third=P1,owner=P2,peer=P3,fourth=P4` with four signed-in, unlocked Chromes (one per bench account, own
   profiles, ports of your choice): it creates the group conversation and speaks in it as each member.
2. **Android** (Mi 9T): `bun native.mjs --platform android --lang fr,en`: theme and language set in the
   WebView's `localStorage` over CDP, each route opened, the pixels from `adb screencap`, system UI demo
   mode for the status bar. **iOS** is not wired (see below).
3. `bun shots.mjs verify --source android --lang fr --work DIR`: every `expect` string present, none of
   `forbiddenOnScreen`, no visible initials avatar (`.avatar-placeholder`), no image that failed to load.
4. `bun shots.mjs compose --work DIR --out DIR --lang fr` writes `<out>/<size>/<lang>/<shot>.png`. It REFUSES
   while a native source has problems; `--allow-dirty` writes `PREVIEW-` files that must never be uploaded.
   Apple sizes read the `ios` capture, Play sizes the `android` one.

Browser preview (layout only): `bun shots.mjs capture --port <chrome port>`, a Chrome signed in on dev
through the rig's `login.mjs` and `pin.mjs`.

Fredoka comes from the app's own package (`frontend/node_modules`, so run `bun install` in `frontend/`),
or `STORE_SHOTS_FONT=<file.woff2>`. The browser tool refuses any site other than `dev.canari-emse.fr`.

## What is blocked (2026-11-09), and what lifts each

| Blocked | Why | What lifts it |
| --- | --- | --- |
| People's photos | a user's avatar is served by the photo gallery (MiGallery), which Canari reads and cannot write; every chat bubble and member row shows an initials circle, and `verify` fails on it | the owner decides: photos for the four bench accounts in the gallery, or a dev-only avatar override in core-service |
| Test names in a conversation | the join lines ("X a ajouté Y") carry the names the clients cached before the rename; they scroll off in a long conversation, but the list preview and the first screen of a short one show them | a longer script (done for fr), or re-enrolling the seats after the rename |
| iOS capture | `native.mjs --platform ios` is not wired: the iPhone has WDA screenshots (`ios.mjs shot`) but no navigation here (the WebKit inspector bridge of the rig is needed), and the status bar cannot be forced | wire the rig's I1 bridge into `native.mjs`; the clock stays real |
| English set | the English group conversation is not created yet (`bun chat-seed.mjs --lang en ...`) | run it |
| Communities, post media, covers | the community and its channel are MLS state (rig `comm.mjs`), post images and covers go through the encrypted media flow | not built |
| Leftovers | the demo conversation holds one deleted-message tombstone (a duplicated send); the phone account's chat list holds test-campaign debris (old groups, tombstones); Android keeps the app's own notification icons in the status bar | recreate the group, leave or delete the old conversations, clear notifications |
