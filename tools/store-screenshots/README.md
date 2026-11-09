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
   mode for the status bar. **iOS**: `native.mjs --platform ios` taps through the native tab bar and in-app links (`ios` steps per shot in `scenario.json`) and probes the page through WDA's accessibility tree (`treeProbe`); it needs the iPhone signed in with the theme and language already set in Settings > Preferences.
3. `bun shots.mjs verify --source android --lang fr --work DIR`: every `expect` string present, none of
   `forbiddenOnScreen`, no visible initials avatar (`.avatar-placeholder`), no image that failed to load.
4. `bun shots.mjs compose --work DIR --out DIR --lang fr` writes `<out>/<size>/<lang>/<shot>.png`. It REFUSES
   while a native source has problems; `--allow-dirty` writes `PREVIEW-` files that must never be uploaded.
   Apple sizes read the `ios` capture, Play sizes the `android` one.

Browser preview (layout only): `bun shots.mjs capture --port <chrome port>`, a Chrome signed in on dev
through the rig's `login.mjs` and `pin.mjs`.

Fredoka comes from the app's own package (`frontend/node_modules`, so run `bun install` in `frontend/`),
or `STORE_SHOTS_FONT=<file.woff2>`. The browser tool refuses any site other than `dev.canari-emse.fr`.

## What is blocked (2026-11-09, evening), and what lifts each

| Blocked | Why | What lifts it |
| --- | --- | --- |
| People's photos | a user's avatar is served by the gallery, which dev lacks: every face is an initials circle and `verify` fails on it. The fix is the dev-only avatar override of core-service (PR #3219, geometric portraits) | #3219 merged, a pre-release deployed to dev, the `DEV_AVATAR_OVERRIDE_EXTRA` value set; then re-capture |
| iOS capture | the code path is written and unit-tested on a synthetic tree, but never run: the iPhone is signed out (the Authentik service-account sheet refused the rig password three times, so it waits for the lead). The `ios` steps of shots 5 (agenda, reached from the dashboard tab) and 6 (privacy) are unconfirmed on a phone; the status bar cannot be forced and is cropped at compose; a broken image is not visible in the tree | the iPhone signed in as Lina, then one run and a look at each shot |
| English set | the English group, DMs and community lines are created per language. The French ones exist on dev now; for the English pass the French group is deleted (the product's own delete, as `purge.mjs` did) and `chat-seed.mjs`, `dm-seed.mjs` and `comm-seed.mjs` are run with `--lang en`. Community NAMES are language-neutral, their lines are not | run the pass after the French capture |
| Event covers | an event's poster shows only in its detail modal, which no shot opens; the three post photos were posted (fr) through the real composer by `post-seed.mjs` | not needed unless a shot opens an event |

Done on dev (2026-11-09): the four demo seats were emptied through the product (every old group, DM and tombstone, ids recorded in the run's allowlist), then `chat-seed.mjs` (group), `dm-seed.mjs` (four DMs) and `comm-seed.mjs` (two communities) were run in French. The "Fictif" events and three fixture posts that showed in the demo accounts' lists were set aside by a reversible flag (`rejected`, `hiddenByModeration`), never deleted. The test-environment banner is closed before each capture and `verify` fails a shot that shows it.

### iOS: two lessons from the first sign-in (2026-11-09)

- **Submit the Authentik password with the keyboard's Return**, not by tapping the page's Continuer button: `bun ios-device/ios.mjs type - --submit` (the password on stdin) replaces the focused field, reads it back (24 characters for the bench accounts) and presses Return. The keyboard scrolls the sheet, so a tap at the button's pre-scroll position hits nothing and posts nothing; the keyboard's Passwords key sits just below it and opens an AutoFill sheet. Plain `type` replaces the field; `--keys` appends and left stale characters.
- **The display name reverts to the identity provider's at every sign-in**, so `bun seed.mjs apply --lang fr` runs AFTER the sign-in, never before it.

### State of the native captures (2026-11-09, night)

- **Android fr**: verified clean. **iOS fr**: shots 1, 3, 4, 5, 6 verify; shot 2 does not - see below.
- `verify` reads the VISIBLE text only (a text node counts when its element is in the viewport) and reports `[MEDIA]` lines for initials avatars and images that did not load.
- `allowedInitials` (scenario.json) lists the initials of ASSOCIATION and GROUP badges (BD, CP, CR, CD, LF, SD, ...): they are organisation marks drawn as a circle with no logo, not people. This weakens the initials guard for those two-letter strings only; a person's avatar is still refused.
- iOS navigation notes: `scrollAnchor` swipes in the right margin at 0.25 s (a slow drag on a bubble or post text starts a selection or opens the message menu); a `retry` tap step taps once more when the label is still on screen (a tap thrown at a page still settling does nothing); `waitFor` polls for the page content instead of a fixed delay; `native.mjs --shot <id-prefix>` runs one shot.
- **Open on iOS shot 2 (messaging)**: the group history ends with a system row "<name> a ajoute un appareil" that carries a rig account's identity-provider name, and no scroll position hides both it and the composer. The row sits above the composer at the bottom of the history; scrolling up shows the three "added to the group" rows at the top instead. Options: (a) send about seven short messages after the row from the bench account so it scrolls out of the last screen, (b) allow the string for that shot (weakens the guard), (c) crop the bottom of that capture. Decision owed.
