# Store listings: texts, screenshots and the pipeline that refreshes them

Status: DESIGN (2026-10-09), texts redrafted 2026-10-22 (section 8). Nothing here has been uploaded;
the measured parts (API reach, current texts, sizes) are facts, the pipeline is a plan. Release notes live in
[store/README.md](../../store/README.md); this page owns the REST of what the two stores show.

## 1. What the credentials can do (measured 2026-10-09, read-only)

**Google Play** - the service account of [play-vitals](../../tools/play-vitals/README.md) (`PLAY_SA_KEY`,
kept outside the repository). A draft edit was opened, read, and DELETED (204);
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

**App Store Connect** - READABLE since 2026-10-12. The issuer ID is
`b0bcfe88-4988-4f78-a80d-84c17642c7fc` (App Store Connect > Users and Access > Integrations; NOT a
secret - it identifies the team, and the `.p8` is what signs), the key id is in the private notes, and its
`.p8` is kept outside the repository. That is all an ES256 token needs (an
individual-key token, without the issuer, was refused 401). The app id is `6793060521`
(`fr.emse.canari`). On 2026-10-12 only `fr-FR` existed on the version localizations, and the
description named no platform.

## 2. The current Play texts and what is stale (2026-10-09)

| Field | fr-FR | en-US |
| --- | --- | --- |
| title | `Canari - Mines Saint-Etienne` | `Canari` |
| short | `Le reseau des Marteaux` | `The student life and encrypted messaging app developed by Les Rootz.` |
| full | 6 bullets: MLS messaging, associations, events, news and polls, shop (Stripe), calls and media | same six |

Stale against `store/whats-new.txt` (v1.1.2) and `CHANGELOG`:

1. **"Stripe" is false, and so is any payment promise (2026-10-22).** Stripe was removed (#1589)
   and Lydia, the only provider left, is NOT live in production (`payment_provider` is `disabled`,
   [backlog WP-LYDIA-1](backlog.md)). A listing may therefore name no provider AND promise no
   payment, shop or ticketing flow that rests on one: `FORBIDDEN` in `tools/store-listings/listings.mjs`
   now refuses "paiement", "payment", "billetterie" and "ticketing". The shop bullet is OUT of
   both texts until payments are live; it comes back in the same week as that stable.
2. **"audio calls" is false.** Calling is held off (`CALLS_ENABLED = false`). It becomes true with
   the stable that flips `CALLS_COMPILED`, AUDIO 1:1 only (owner, 2026-10-21): the bullet then says
   audio calls and never video, and changes in the same week as that stable, with the store answers
   of [calls, B14](frontend/modules/calls.md#the-store-answers-b14).
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

**Since 2026-10-16 dev holds no production row**: a fictional seed (ten `Fictif` people, six
fictional associations, their posts and events) plus whatever testers create there
([dev-environment](infrastructure/dev-environment.md#3-the-data-a-fictional-seed-and-nothing-from-production-owner-2026-10-16)).
That is option B below, reached for a privacy reason rather than for the screenshots. Two things
still put a real person on screen: a TESTER's own row (testers sign in with their real MiConnect
account, so a directory or member list on dev shows their names), and Authentik being ONE instance
for dev and prod ([backlog](backlog.md)), so creating a fictional sign-in is production-adjacent and
is the user's gesture, never an agent's. Until 2026-10-16 dev was a full copy of production, and the
two options were:

* **A. Scoped demo content on the copy.** Fictional users on a fictional campus plus fictional
  associations and posts; only screens where audiences already scope the data are shot. Cheap, but
  the association directory, search and member lists are not scoped and must be avoided. The risk is
  human: one wrong screen leaks.
* **B. A demo estate with an EMPTY database** holding only fictional rows. **This is what dev is
  now**; shoot right after a `dev-reset`, before testers sign in, and the checklist below still
  applies to every frame.

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

1. **User (owed):** create N fictional Authentik users the way the existing dev test accounts were, with the
   campus/programme attributes (a mix of saint-etienne and gardanne), credentials kept in the
   private harness state, never in the repository.
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

## 8. The redo of the whole listing (decided by the user 2026-10-22: texts AND screenshots)

**Status: DRAFT. Nothing is uploaded and nothing here changes a store data declaration.**

### 8.1 Texts - done as a draft in `store/listings/`

True today, in both languages: encrypted messaging (MLS), communities, associations (directory,
news, the carte de la vie asso for officers), agenda (audiences, ICS subscription, PDF export),
news/polls/forms, Canareels, institutions, encrypted media. **Removed as false or unprovable:** Stripe,
audio calls (come back with the stable that flips `CALLS_COMPILED`), the shop and ticketing bullet and
the word "billetterie" (payments are disabled in production), "adhesions" (a membership flow
the user cannot complete without payment) and "rappels" (no reminder feature is documented in
[calendar](frontend/modules/calendar.md); re-add only after someone reads one on a phone).
Nothing about live features. The disclaimer "not published by the school administration" stays.

### 8.2 Screenshot shot list - to be taken on a BENCH PHONE, real chrome, never browser emulation

Why not emulation: it has no real status bar, no Liquid Glass chrome on iOS, and renders only what
Chromium draws. Devices: the Android bench phone (native 1080x2340, valid for Play as is) and the
iPhone when it is usable (1170x2532 is accepted, the mandatory class is 1179x2556, section 3).
Account: a dev account on FICTIONAL data only (sections 4 and 5); language fr first, en second from
the same data with the app in English. Order, same story on both stores, at most 8:

Where each screen lives in `v1.4.0-alpha.4` (read from `places.ts`, 2026-10-22): the phone's bottom bar has
FOUR icon-only tabs, in order Posts (`/posts`), Communities (`/communities`), Chats (`/chat`) and
Dashboard (`/dashboard`). The agenda (`/calendar`), notifications, forms, bookings and shop are NOT
tabs: they are reached from the dashboard (the sections hub). An association page is
`/associations/<slug>`, and the Canareels camera is the tab LEFT of the feed (swipe right). Shot 4 is
therefore taken from the dashboard, not from a tab, and the entry point of the Canareels viewer and of
the carte de la vie asso is still to be confirmed on the device before shooting. The shop route exists
but no shot or text shows it while payments are disabled.

1. Conversation list, then one open conversation (encrypted messaging, the lock shown).
2. A community with its channels and a few messages.
3. The news feed with a poll that has votes.
4. The agenda, three events across two associations.
5. An association page.
6. A Canareels viewer.
7. The sections hub (shows how much is in one app).
8. The carte de la vie asso (officers' screen) - only if a fictional officer account exists.

**Hidden or absent in every frame:** the "Environnement de test" banner, the URL bar (native app
only), notifications, a real status bar clock/battery (use the demo-mode settings of section 6),
any real name, photo, e-mail, phone, id, association, QR code or payment identifier. A person looks at
every PNG against the checklist of section 4 before it leaves the scratchpad. No device frame, no
"best/CTA/badge" overlays, any text overlay under 20 % of the area and localized.

### 8.3 Only the user can do or decide

* Which screens to show (the list above is a proposal), and the fictional officer account of item 8.
* The fictional accounts on dev: the identity provider is ONE instance for dev and prod, so
  creating a user there is a production-adjacent gesture ([backlog](backlog.md)).
* Any upload to Play Console or App Store Connect (`play.mjs` is dry-run by default; `--apply` is the
  user's), and App Store texts, which ride a release.
* **Any store data declaration** (Data safety, App Privacy, content rating, ads): never changed by an agent.
* Whether the shop and payments return to the listing, and when.

### 8.4 Next steps

1. User reviews the two drafts and answers 8.3.
2. A fictional dev dataset exists (section 5), then capture on the bench phone, user views every frame.
3. `tools/store-listings/play.mjs` dry-run; apply only on the user's word.
