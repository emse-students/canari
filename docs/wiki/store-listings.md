# Store listings: texts, screenshots and the pipeline that refreshes them

Status: DESIGN (2026-10-09). Nothing here has been created or uploaded yet; the measured parts
(API reach, current texts, sizes) are facts, the pipeline is a plan. Release notes live in
[store/README.md](../../store/README.md); this page owns the REST of what the two stores show.

## 1. What the credentials can do (measured 2026-10-09, read-only)

**Google Play** - the service account of [play-vitals](../../tools/play-vitals/README.md) (`PLAY_SA_KEY`,
default `../canari-harness/play-console-sa.json`). A draft edit was opened, read, and DELETED (204);
nothing was written.

| Call | Result |
| --- | --- |
| `edits.insert` / `edits.delete` | 200 / 204 |
| `edits.listings.list` | 200, two languages: `fr-FR` (default), `en-US` |
| `edits.images.list` per type | 200 (one transient 503 on en-US `sevenInchScreenshots`, retry) |
| `edits.details.get` | 200 (`contactWebsite` is `https://canari-emse.fr`, the OLD name) |

Writes (`listings.update`, `images.upload`/`deleteall`, `edits.commit`) were deliberately NOT probed;
the scope is `androidpublisher`, so they are expected to work and the first real upload is the proof.
Current image counts: fr-FR 5 phone, 3 seven-inch, 0 ten-inch, 1 feature graphic, 1 icon;
en-US 0 phone, 0 ten-inch, 0 feature graphic, 1 icon (seven-inch unreadable at the time).

**App Store Connect** - NOT READABLE from this box. The key `AuthKey_U7X7X373G5.p8` is in
`~/.appstoreconnect/`, but an ES256 token needs the team ISSUER ID, which exists only as the GitHub
secret `APP_STORE_CONNECT_ISSUER_ID` (unreadable). An individual-key token (no issuer) was refused
401. **Owed (one-off, user):** export `ASC_ISSUER_ID` (App Store Connect > Users and Access >
Integrations, not a secret) plus `ASC_KEY_ID=U7X7X373G5` and `ASC_API_KEY_P8` locally; then the same
read (appInfoLocalizations, appStoreVersionLocalizations, appScreenshotSets) is one script.

## 2. The current Play texts and what is stale (2026-10-09)

| Field | fr-FR | en-US |
| --- | --- | --- |
| title | `Canari - Mines Saint-Etienne` | `Canari` |
| short | `Le reseau des Marteaux` | `The student life and encrypted messaging app developed by Les Rootz.` |
| full | 6 bullets: MLS messaging, associations, events, news and polls, shop (Stripe), calls and media | same six |

Stale against `store/whats-new.txt` (v1.1.2) and `CHANGELOG`:

1. **"Stripe" is false.** Stripe was removed (#1589); payments go through Lydia. The bullet should
   say "integrated payment" and name no provider, so it cannot go stale again.
2. **"audio calls" is false.** Calling is held off (`CALLS_ENABLED = false`).
3. Missing, and shipped: audiences (an agenda scoped to your campus and programme, staff following
   a whole campus), Canareels (short videos, camera tab), communities, institutions created in-app,
   the carte de la vie asso poster generator, nominative read grants.
4. The two languages disagree: the fr title carries the school, the en one does not; the short
   descriptions differ in meaning. Pick one shape (the disclaimer "not published by the school
   administration" stays).
5. `contactWebsite` still names `canari-emse.fr`; the name is `canari.emse.fr` since 2026-09-25.
6. en-US has no screenshots at all, and the fr-FR ones likely predate the Liquid Glass chrome and the
   section navigation (to be confirmed by looking at them, not by date).

The App Store texts (description, keywords, promo text, subtitle) are unread (section 1).

## 3. Required sizes (verified 2026-10-09 on the stores' own pages)

**Google Play:** JPEG or 24-bit PNG, no alpha; each side 320-3840 px for phones, long side at most
2x the short; up to 8 per device type, at least 2 overall; tablets and Chromebooks: at least 4,
sides 1080-7680 px. Content: the real app, no device frames or people holding a phone, text overlay
under 20 % of the image, no "best"/CTA/store badges, notification bar cleaned, alt text <= 140 chars,
overlays localized. Feature graphic 1024x500, required, no alpha. The Mi 9T's native 1080x2340 is
valid as is.

**App Store:** the mandatory iPhone set is the Dynamic Island medium display, **1179x2556 or
1206x2622**. The iPhone 12 is 1170x2532 ("Face ID medium", accepted but NOT the mandatory class), so
a mandatory-class device or simulator is needed for that set. Accepted larger: 1260x2736, 1290x2796,
1320x2868. iPad 13" (2064x2752 or 2048x2732) is mandatory ONLY if the app runs on iPad (check
`TARGETED_DEVICE_FAMILY`; iPhone-only means no iPad shots). 1-10 per size, jpeg/jpg/png, no alpha
channel. The `ios.mjs shot` PNG must be flattened (alpha dropped) and checked against the accepted
list before upload; never resample silently.

## 4. Privacy: the constraint that shapes the pipeline

Dev is a full copy of production ([dev-environment](infrastructure/dev-environment.md)), so every
directory, feed and member list on dev holds REAL people. A fictional account that opens the
directory screenshots real names. Authentik is ONE instance for dev and prod
([backlog](backlog.md)), so creating a fictional user is production-adjacent and is the user's
gesture, never an agent's. Two ways to keep real rows off the screen:

* **A. Scoped demo content on the copy.** Fictional users on a fictional campus plus fictional
  associations and posts; only screens where audiences already scope the data are shot. Cheap, but
  the association directory, search and member lists are not scoped and must be avoided. The risk is
  human: one wrong screen leaks.
* **B. A demo estate with an EMPTY database** (a third compose project, or dev's DB wiped once and
  frozen) holding only fictional rows. Safe by construction; costs infrastructure and an Authentik
  client. **Recommended if more than one refresh is expected; A for a one-off.** DECISION OWED.

Checklist applied to EVERY frame before it leaves the scratchpad (a person looks at each PNG):

1. No real name, photo, e-mail, phone, student number, token, or id in visible text.
2. No real association, institution or event; posts and shop items are invented text.
3. Avatars are generated or initials, never photos of anyone.
4. Status bar clean (section 6), no notification, no other app.
5. The "Environnement de test" banner on dev is hidden or cropped; no URL bar (native app shots only).
6. No Lydia or payment identifier, no QR with a real ticket.
7. Chat frames show only the fictional conversation.
8. EXIF/metadata stripped; file names carry no account name.

## 5. The demo data seed

Each step idempotent and logged:

1. **User (owed):** create N fictional Authentik users the way `canari-test-delta` was, with the
   campus/programme attributes (a mix of saint-etienne and gardanne), credentials into
   `../canari-harness/test-accounts.json`. They sign in through the `password-login` flow
   (`PASSWORD_LOGIN_FLOW_SLUG`), no MFA.
2. Sign in once per account on dev so core-service creates the profile rows.
3. Through the real API with those sessions (harness `login.mjs`/`accounts.mjs`): display names and
   generated avatars, 3-4 fictional associations and an institution, members, posts (one with a
   poll), agenda events inside the audience scope, shop items.
4. **Chat is E2E (MLS)**, so no server-side insert is possible: two live clients must exchange the
   messages. Reuse `tools/cross-client-harness` (`chat.mjs`, `invite.mjs`, two `chrome-w*` profiles)
   to create a DM and a group and send scripted French messages; the phones then join through the
   normal flow and receive history by the seed/welcome path.
5. Teardown: the seed writes a manifest of what it created and a teardown deletes exactly that
   (allowlist, never a pattern), so dev returns to the copy.

## 6. Capture

* **Mi 9T** (`adb exec-out screencap -p`, see `tools/phone-bench/phones.py`): enable system UI demo
  mode (`settings put global sysui_demo_allowed 1`, then `am broadcast -a com.android.systemui.demo
  -e command clock -e hhmm 1200`, plus `battery`, `network`, `notifications -e visible false`) and
  Do Not Disturb. The installed app must be the dev-pointed pre-release build. The bench phones are
  a sandbox; the Pixel 6a is the user's and is never used.
* **iPhone 12** (`bun tools/ios-device/ios.mjs shot <file.png>`): 1170x2532. The status bar cannot be
  forced through WDA: charge the phone, Do Not Disturb on, and check the bar by eye. Cropping is not
  allowed (it changes the size). The mandatory 1179x2556 class needs a newer iPhone or the Xcode
  simulator: owed question.
* Shot list (up to 8 per store, same story in fr and en): conversation list, a conversation, news
  feed with a poll, agenda, association page, shop, Canareels viewer, sections hub. Any text overlay
  is added after capture, under 20 % of the area, localized.

## 7. Upload scripts to add under `tools/store-listings/` (not written yet)

* `play.mjs` reusing `tools/play-vitals/lib.mjs` (`api`, `PUBLISHER`): `read` (dump listings and
  image counts), `texts` (listings.update from `store/listings/<lang>.json`), `images` (insert edit,
  per language and type `images.deleteall` then `images.upload` with `uploadType=media`, validating
  size and ratio locally first, then `edits.commit`). Dry run by default, `--apply` to write; the
  edit is deleted on any failure.
* `asc.mjs` reusing the JWT code of `tools/app-store/submit.mjs`: read and write
  appStoreVersionLocalizations, appInfoLocalizations and appScreenshotSets (reserve, upload parts,
  commit). Texts are editable only on an editable version, so they ride a release.
* Sources of truth in `store/listings/` (texts per language as files) and a screenshot manifest
  (file, store, language, alt text); the PNGs stay OUT of the public repo until reviewed.
* A test failing if a listing text names a removed feature (Stripe, calls) or an image breaks the
  size table above.

## 8. Next steps

1. User: provide `ASC_ISSUER_ID` locally; decide estate A or B; create the fictional Authentik users.
2. Agent: read the ASC listings, write `store/listings/*.json` with corrected texts, user reviews.
3. Agent: build the seed script, run it on dev, script the chat through the harness.
4. Capture on the Mi 9T, then the iPhone; the user views every frame against section 4.
5. Add the upload scripts, dry-run, apply Play; the App Store texts ride the next stable.
