# Lives in production - the gates, the order, the cap, the policy text (plan, 2026-10-21)

The owner wants lives in production as early as possible: moderation (WP-L8) first, the audience
cap lifted later. **This page is the only copy of the blocker list, the order of the switch, the
viewer-cap ladder and the owner's points on the lives terms and privacy text.** The design stays on [live](live.md), the server
on [lives](../../services/lives.md), the store mapping on [store-ugc-answers](../../store-ugc-answers.md),
the register rows C19/C20 on [register-of-processing](../../compliance/register-of-processing.md).
Read against `main` at `0413bdeff` (2026-10-21). **Nothing here flips a switch.** It mirrors what
[calls](calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21) did for audio calls.

## 1. Every lock between a production member and a working live - and the flip (2026-10-30)

The owner asked on 2026-10-30 for lives in production in `1.5.2`, after finding that production
`1.5.1` drew no "En direct" chip although `platform_config.lives_mode` had been set `on`: the two
deploy-time locks below were still closed. **The flip pull request (`feat/lives-production`) opens
both in one commit**; `lives_mode` is from then on the only switch that closes lives.

| # | Lock | Where | State after the flip |
| --- | --- | --- | --- |
| 1 | **Client build constant** `LIVE_ENABLED` - was `deployEnvironment() === 'development'`, so a production binary drew no card, chip or viewer and asked `/api/lives` nothing | `frontend/src/lib/features.ts`, read only through `livesAvailable` (`utils/livesAvailability.ts`) | `true` in every build (`features.test.ts`). Reaches the web on the stable's deploy, the phones through the store binaries of that stable |
| 2 | **Server env** `LIVE_ENABLED` - ONE variable read by social-service (`LiveEnabledGuard` on both live controllers: lives, chat, staff routes; the follower push in `LiveAnnouncer`) and media-service (`isLiveEnabled`: the internal segment ingest and the public segment `GET`). Not exactly `true` -> a bare `404`, kept 10 s by nginx's `live_segments` cache | `infrastructure/deploy/env-manifest.tsv` (`literal:true` on both estates; was computed `false` on production by `compute_live_enabled`, now deleted), rendered into the estate's `.env` by `render-env.sh`, passed by both composes (default `false`) | `true` on both estates (`deploy-env.test.sh` on the rendered files). Applied by the stable's production deploy - no secret, no host change |
| 3 | **Runtime kill switch** `platform_config.lives_mode` (core-service migration 015), read on every request by social-service's guard and, through `GET /api/internal/lives/mode`, by media-service; published by `/api/version` so the client hides what would be refused | `/admin/platform` (a global admin) | **`on` in production, and it STAYS on (owner, 2026-10-30)** - so **lives open the moment the `1.5.2` stable deploys**, discreetly (section 3, step 8). `off` is the rollback, never a gate held before the deploy |
| 4 | **The two secrets** `LIVE_KEY_ENCRYPTION_SECRET` (a live's key sealed at rest; unset -> every start `503`) and `LIVE_REPORT_SIGNING_KEY` (a reported chat line; unset -> `503`) | GitHub secrets, `required` in the manifest | present: the render refuses a production deploy without them or under 32 characters, and production `1.5.1` deployed. Nothing to set |
| 5 | **nginx** - the `/api/lives/` location (`client_max_body_size 5m`, the `lives_ingest` rate) and the `^~ /api/media/public/live/` segment cache | `infrastructure/local/Dockerfile.frontend`, the same image on both estates | no switch of its own; read P5 below |
| 6 | **The media store** - segments under `live/<liveId>/` in Garage, deleted at the end | media-service | no switch of its own |
| 7 | **The viewer cap** - 24 seats for the whole host (`LIVE_VIEWER_CAP`) | `live.constants.ts` | a refusal ("Live complet"), never a failure; section 6 |

**What runs whatever the switches say, on purpose:** the live sweep, the media purge and the hourly
`[LIVE_REPORT_AGE]` alarm - a live or a report from while lives were open is still ended, deleted and
answered.

**Rollback is no longer a release.** One live: the staff cut (`POST /api/lives/:id/cut`). Every live:
`lives_mode` `off` at `/admin/platform` - the next request is refused everywhere, an on-air live ends
through the 60 s sweep, and the client hides the surfaces on its next `/api/version` read
([lives](../../services/lives.md#the-two-switches-live_enabled-and-lives_mode)). G13 is closed by it.

**Moderation as built on 2026-10-30, read from the code** (the `features.ts` prose that called it
"not built" was stale): a member reports a live and one chat line; staff cut a live from the viewer
and from the `/admin/moderation` queue's live row, and withdraw a broadcaster's right there; the
first-live rules gate a first start; a suspended or withdrawn broadcaster's start is refused with its
own screen (`LIVE_BROADCAST_SUSPENDED` with its date, `LIVE_BROADCAST_WITHDRAWN`); the three
broadcaster pushes and bell rows exist. **Not built, client side:** the LIFT of a withdrawal in
`/admin/moderation` (`DELETE /api/lives/broadcasters/:userId/withdrawal` has no button); the pre-live
screen reading `GET /api/lives/standing` (a suspended member learns it only at Start). **A reported
chat line was always LISTED** in `/admin/moderation`, with its text as the preview when the server
verified it; what it lacked - its type label, a sentence saying why an `altered`, `key-rotated` or
`unverifiable` line shows no text, and the live it was written in - came with the flip pull request
(`ModerationChatLineBlock`; the live is a copyable id, since no route opens one live) (G6 (f)).

## 2. The gates, each with its evidence

`built` = merged on `main`; `open` = an open pull request; `read` = observed on hardware or on an
estate; `owed` = not done. A gate closes only when its last column is true.

| # | Gate | State (2026-10-21) | Closed by |
| --- | --- | --- | --- |
| G1 | **WP-L8 server**: report a live (`content_reports`, `contentType: 'live'`), the staff cut (410 `endReason: 'cut'`), the first-live rules (L11) | **built** ([lives](../../services/lives.md#moderation-wp-l8-server-half)) | done |
| G2 | **WP-L8b server**: the strike ladder (warning, 30-day suspension, withdrawal from the 3rd cut), cuts kept 90 days, a reported chat line kept signed until handled (90 days max), five reaction kinds, `LIVE_RULES_VERSION` 2 | **built** (#2172) | done |
| G3 | **The signing secrets** `LIVE_REPORT_SIGNING_KEY` and `DEV_LIVE_REPORT_SIGNING_KEY` (REQUIRED in both estates: a deploy without them is refused by `render-env.sh`) | **set** - both names listed by `gh secret list`, 2026-10-21 05:56 UTC (names only; the values were not read, and their length is checked by the deploy) | done; the first production deploy carrying #2172 proves it |
| G4 | **The 24 h commitment, measured** (`[LIVE_REPORT_AGE]`, hourly, `error` past 24 working hours) | **built** (#2189); one reading of the line on dev **owed** | the line read in dev's social-service log |
| G5 | **WP-L8 client**: the viewer's report control, the cut screens, the `live_cut` bell row, the admin queue's live row with its cut button, the rules sheet | **built** (dev builds) | G9's readings |
| G6 | **WP-L8b client**: (a) the three pushes and two bell rows - **built** (#2192); (b) the admin standing on a live report and the withdraw button - **built** (#2190); (c) the five reaction kinds, the posts' rules on the sheet, reporting ONE chat line - **built** (`LiveChatReportDialog`, read 2026-10-30); (d) the two start refusals (`LIVE_BROADCAST_SUSPENDED` with its date, `LIVE_BROADCAST_WITHDRAWN`) - **built** (`LiveBroadcaster`); `GET /api/lives/standing` on the pre-live screen - **owed**; (e) the LIFT of a withdrawal in `/admin/moderation` (the endpoint exists, no control) - **owed**; (f) the `live_chat` report row showing its integrity (`altered` / `key-rotated` / `unverifiable` with one weight) - **built** in the flip pull request (`ModerationChatLineBlock.svelte.test.ts`) | mostly built | (d)(e) built, each with its test |
| G7 | **Crypto reviews**: the segment seal v1 and the chat seal C12, each "owed an adversarial crypto review" ([live](live.md#the-segment-seal-format-v1), [lives](../../services/lives.md#live-chat-and-floating-reactions-wp-l6)) | **owed** (no review is on record on either page) | one adversarial review each, its verdict written where the format is |
| G8 | **WP-L6 load**: several dev viewers chatting while a broadcaster sends segments (the chat shares the live's row lock with the ingest; nothing measured that contention) | **owed** | one dev reading, numbers on [lives](../../services/lives.md#the-row-lock-extended) |
| G9 | **Phone readings**: check Y (watching) and LIVE-B1 (broadcasting) of [device-verification](../../device-verification.md#live-b1-the-broadcaster-on-both-bench-phones---owed-on-both) on the Mi 9T and the iPhone 12; the moderation screens; the chat panel and the floating reactions; the three pushes once a store build carries their strings | **owed as rows** - read 2026-10-29/30 short of them: the iPhone broadcast flow on TestFlight `1.5.1-alpha.8`/`.9`, and the web rig's LIVE-WEB-2 and LIVE-STALL-1 `PASS` on `1.5.1-alpha.9` (#2705); check Y and LIVE-B1 stay owed row by row on both phones | the board rows `PASS`, never `PASS-DIRTY` |
| G10 | **The owner's texts**: (a) the terms' (`/legal/cgu#directs`) section 6 paragraph on lives - the cut, the ladder, the first-live rules, no replay; (b) the filtering statement for the stores (R1: post-hoc moderation, no automatic filter) | (a) **merged (#2698)** ([section 5](#5-the-privacy-policy-and-the-terms---written-2026-10-29-owed-the-owners-reread)); (b) **owed - the owner's** | both texts approved, the terms merged with G11 |
| G11 | **The privacy policy and the register, together** (CLAUDE.md: the policy is the register's public face) - `/legal/privacy` gains its lives paragraphs and C19/C20 point at them | **merged with G10 (a) (#2698)**; C19/C20 dropped "switched OFF on production" in the flip pull request | the owner's yes on the wording; the pull request merged before or with the flip |
| G12 | **The stores (WP-L9)**: the review notes ([draft](../../store-ugc-answers.md#what-to-write-in-the-review-notes-draft-english)) re-read against Apple 1.2 and Play UGC as published that day; **the review VIDEO** showing a report and a staff cut on a running live (L7); the App Privacy labels and Play Data safety re-read for live video and chat; the camera and microphone purpose strings (name lives since the flip pull request, asserted by `livePurposeStrings.test.ts`) | **owed**, the purpose strings done | the video recorded FROM a pre-release run (never staged after), the notes and labels the owner approved |
| G13 | **A global stop that is not a release** (see section 1): a runtime switch read by the live guard, as calls got `platform_config.calls_mode` (B12 of [calls](calls.md#the-blockers-each-with-its-evidence)) | **built** - `platform_config.lives_mode` (2026-10-21) | done |
| G14 | **Two questions to the school IT department, asked before the first public live** (asking is a question, not a change): whether the host's CrowdSec reads a lecture hall behind one campus address (~10-20 requests a second) as a crawl; and the link's real speed and Canari's share (Q3), which sets the cap | **CrowdSec: measured read-only 2026-10-30** - a request from a server inside the school network and one from the student-residence server both reach Canari from addresses the host's CrowdSec whitelists cover (the school's network ranges and the private ranges), so a lecture hall on the school network cannot get the campus address banned. **Not measured:** whether student Wi-Fi leaves by another path than those servers. **The link speed (Q3): owed** | their written answers, recorded in the private operations notes, the cap figure on this page |
| G15 | **The production preflight** (section 4), read-only | **written below; owed** | every line read |
| G16 | P3 met by the server review: a seat taken AFTER an end's release outlives the end by up to its 30 s lease ([backlog](../../backlog.d/p1-live-moderation-wp-l8-merged-the-client-s-standing-refusals-the-vie.md)) | **owed**, NOT a blocker (it costs a refusal for 30 s, never a byte or a key) | its fix, whenever |

## 3. The order

1. **Code, all dev-only, none flips anything** - G6 (c)(d)(e)(f); G13 if the owner says yes; the
   purpose strings of G12 can ride the flip itself.
2. **Reviews and dev readings** - G7, G8, G4.
3. **Pre-releases and phone readings** - each piece reaches the bench through an ordinary
   `vX.Y.Z-alpha.N` (dev + testers); G9 is read there. **The App Review video is recorded from
   these runs.**
4. **The owner's texts** - G10, G11's yes, G12's labels; G14: CrowdSec measured 2026-10-30, the link-speed question still to send.
5. **The production preflight** (section 4), read-only.
6. **THE FLIP, ONE COMMIT, ONE PR**, carrying G11's policy and register change (or after it).
   **Written 2026-10-30 on `feat/lives-production`** at the owner's request (production in `1.5.2`),
   with G7, G8, G9, G12 and G6 (d)(e)(f) still open - the owner's call; the variable is a manifest
   literal rather than `compute_live_enabled`, which went, and the purpose strings are asserted by
   `lib/mobile/livePurposeStrings.test.ts`:

   | Moves | File | Asserted by |
   | --- | --- | --- |
   | `compute_live_enabled` prints `true` on production (or the function and the variable go, if G13's runtime switch replaces them) | `infrastructure/deploy/render-env.sh` | `deploy-env.test.sh` (its prod/dev expectation inverted) |
   | `LIVE_ENABLED = true` (or the runtime switch's read) | `frontend/src/lib/features.ts` | its test |
   | the camera and microphone purpose strings name lives | `canari_iOS/Info.plist`, `fr.lproj` and `en.lproj` `InfoPlist.strings` | a test to add, as `callsCompiled.test.ts` does for calls |
   | the `features.ts` and `lives.md` "switched off on production" prose, C19/C20's status | docs | `wiki-links` |

7. **`vX.Y.Z-alpha.1` with the flip** -> dev and the store testers. Whether a TESTER build talks to
   production or dev (and so whether testers see production lives) is _(unverified here: read the
   pre-release build's `VITE_DEPLOY_ENVIRONMENT` before relying on it)_. The submission goes out with
   G12's notes and video.
8. **The stable** -> production, once both stores took it. **Lives open DISCREETLY with the
   `1.5.2` stable (owner, 2026-10-30)**: no announced first live and no moderator on duty for it.
   The owner is the moderator; reports reach the `/admin/moderation` queue and the hourly
   `[LIVE_REPORT_AGE]` report. The readings of the first production lives, whenever they come:
   `X-Canari-Cache: HIT` from the second viewer, the seat count against the cap, the host's egress
   during a live (read-only), and the sweep deleting a live's rows and segments after its end.
9. **Afterwards**: `minClientVersion` is NOT raised for lives - an old build simply never draws
   them - unless the owner decides otherwise.

**Rollback**: one live, the staff cut (built). Everything, `lives_mode` `off` (G13, built) - no
release.

## 4. The production preflight (read-only)

Run from a signed-in production session and the host, **by the access routes of the private
operations notes** (never written here: this repository is public). Every line reads; none writes.

| # | Read | Expected |
| --- | --- | --- |
| P1 | `GET /api/lives/limits` on production, from outside | `404` (the lock holds) - **read 2026-10-21** |
| P2 | the applied migrations in social-service's database: `091_lives`, `094_live_announced_at`, `097_live_moderation`, `098_live_chat`, `099_live_strikes_and_reported_chat_lines` | all applied - expected, since the switch gates routes and not migrations _(not read)_ |
| P3 | `SELECT count(*)` on `lives`, `live_segments`, `live_chat_messages`, `live_cuts`, `live_chat_reported_lines` on production | `0` - nothing was ever started there |
| P4 | the rendered production env holds `LIVE_ENABLED=false` before the flip's stable, `true` after it, and a non-empty `LIVE_REPORT_SIGNING_KEY` and `LIVE_KEY_ENCRYPTION_SECRET` (presence and length only; never print a value) | as said |
| P10 | the API host the store binaries bake (`BASE_URL`, read as a name, never printed here) and whether its path to the host still crosses the relay whose nginx default refuses a body over 1 MiB ([cloudflare-edge](../../infrastructure/cloudflare-edge.md#a-request-body-over-1-mib-is-refused-with-a-413-on-the-legacy-names---it-is-the-relays-nginx-not-cloudflare-measured-2026-10-07-cause-found-2026-10-09)) | not the relay, or the relay raised to 5 MiB: a segment is ~0.5 MB at 2 Mb/s and up to 4 MiB, and a `413` on a segment `PUT` would end an app's live |
| P5 | the production frontend image's `/etc/nginx/conf.d/default.conf` holds the `live_segments` cache zone and the `^~ /api/media/public/live/` location ending in `\z` | as [lives](../../services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4) |
| P6 | social-service's log: one `[LIVE_REPORT_AGE] pending=0` line an hour | present (the alarm runs whatever the switch says) |
| P7 | the media store has no `live/` prefix on production | empty |
| P8 | Redis has no `live:seats` key on production | absent |
| P9 | the host proxy's connections in use at a busy hour (`ss`, read only) against its host-wide budget | the headroom recorded, as the cap's fourth figure ([lives](../../services/lives.md#the-viewer-cap-wp-l4)) |

## 5. The privacy policy and the terms - written 2026-10-29, owed the owner's reread

**Written, not merged on its own authority.** The owner asked on 2026-10-29 for the terms and the
privacy text, "in the same spirit as the rest, without lying", and rereads them. They are no longer
drafted here: the ONLY copy is the pages themselves - `/legal/cgu#directs` (section 6, "Directs") and
`/legal/privacy` (section 2 "Directs" and "Signalements", the section 3 row, the FCM/APNs paragraph
of section 4, the section 6 rows and the "Sauvegardes" note, section 8's end-to-end paragraph,
section 10's account deletion), with rows C19 and C20 of the
[register](../../compliance/register-of-processing.md) changed in the same pull request. Both carry
the heading "quand la fonction est ouverte", as calls did. Every claim was read against
[lives](../../services/lives.md) and `apps/social-service/src/lives/` at `68435dfea`.

**What the owner decides before it merges** - facts the code cannot give, or rules that are his:

- **When it takes effect.** Merged before the flip, the pages describe a feature production does not
  run, as the calls text did by the owner's decision of 2026-10-22 (register, under section 2).
  Whether this change is "substantial" under section 12 of the policy and section 14 of the terms
  (15 days' in-app notice) is his call.
- **Rules that are new, and his to keep or strike**: "filmer une personne qui n'a pas accepté d'y
  apparaître" is forbidden in a live; each chat author is responsible for their message; the
  24-hour target for a live report (weekends not counted) is now PUBLIC, worded as an effort
  ("s'efforce"), not a commitment. The first-live rules sheet shows section 5 only, and the terms say
  exactly that ("Vous acceptez les règles de la section 5 avant votre premier direct");
  `LIVE_RULES_VERSION` is NOT raised (review of #2698).
- **Art. 22**: the suspension at every cut from the 2nd within 90 days is applied by a rule; every cut is a person's. Section 2
  of the policy says so plainly (section 3 keeps its "aucune décision automatisée" sentence) - whether that is enough is a
  legal reading, not a code one.
- **"pourrait les déchiffrer"**: the text says the server holds the key (sealed at rest under a
  server secret since migration 110) and decrypts live content only to check a reported chat line,
  which is what the code does; it does not promise the host's administrators cannot.
- **Facts left OUT because nothing documents them**: the viewer cap's figure (the text says "limité"
  only, since it is meant to move, section 6); any R2 or Cloudflare edge for segments (not built - if
  it is, section 4 of the policy and C19 change with it); the transfer safeguards already open for
  Google and Apple (section 5 of the policy) now also cover the live push.

## 6. The viewer cap - from 24 to none, in measured steps

> **The owner, 2026-10-21: no VISIBLE ceiling.** The bounds with their arithmetic, the five options, the staged path and the decisions O-1..O-7 (O-3 revisits D-4 below) are on [live-scaling](live-scaling.md); S5 there moves from a Cache Rule to an R2 bucket, Cloudflare's terms being read.

**Today: 24 seats for the whole host, every live together** (`LIVE_VIEWER_CAP` in
`apps/social-service/src/lives/live.constants.ts`, served as `viewerCap` by `/limits`):

```
floor(LIVE_HOST_EGRESS_BPS x LIVE_EGRESS_SHARE / LIVE_VIEWER_BITRATE_BPS)
= floor(90 Mb/s x 0.8 / 3 Mb/s) = 24
```

What bounds it, from the measurements on record:

| Bound | Figure | Source | Binds at |
| --- | --- | --- | --- |
| The host's uplink | ~90-107 Mb/s out on 443, from ONE outside client, two hours; campus viewers unmeasured | [realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md) 2a, 4 | **24 today** |
| A viewer's copy | 3.08 Mb/s mean from the Mi 9T **app WebView** at a 2.5 Mb/s ask (iPhone Safari 2.32); the encoder floors at ~2.6 Mb/s on Android even at 480p | WP-L1 through the dev ingest, draft #2109; `frontend/src/lib/live/constants.ts` | **3.08 > the 3.0 the cap divides by**: 24 x 3.08 = 73.9 Mb/s, 2.7 % over the 72 Mb/s share. The client now asks 2.0 Mb/s; what the app WebView produces at that ask is not on record |
| The host proxy's connections | a host-wide budget set by the school IT department for every site on the host, 4 per seated viewer | [lives](../../services/lives.md#the-viewer-cap-wp-l4); `live-segments-route.test.mjs` fails past a quarter of it | **cap 93** (four connections each, inside that quarter) without the school IT department |
| nginx per address | `limit_conn 24` = the cap (a full audience behind ONE campus address); `limit_rate` 6 Mb/s per fetch | `Dockerfile.frontend`, asserted equal to the cap | moves WITH the cap; above ~93 it becomes a rate (the cap in disguise, [live](live.md#abuse-limits-that-are-not-a-viewer-cap)) |
| The manifest poll | one request a second per viewer into social-service, Postgres pool 10 (4 for ingest) | [live](live.md#the-manifest-poll-grows-with-the-audience-too) | unmeasured; invisible at 24, the next wall at several hundred |
| An edge in front of segments | the tunnel ~19 Mb/s on a MISS, so ~6 lives fully missed; Cloudflare's terms on video through the cache UNREAD | [live](live.md#the-delivery-sealed-segments-from-a-cloudflare-cache) | only once the cache exists |

**The steps, each a pull request that ends on its measurement.** No step moves before the one above
it is read; every number goes into `live.constants.ts` (the one copy) and `live-segments-route.test.mjs`
follows it.

| Step | What changes | Measured first | Cap after (illustrative) |
| --- | --- | --- | --- |
| S0 | Nothing: production opens with 24 | the first production lives (section 3, step 8): seats in use, `LIVE_FULL` refusals, the host's egress during a live | 24 |
| S1 | `LIVE_VIEWER_BITRATE_BPS` set to the in-app measurement at the 2.0 Mb/s ask, both phones | WP-L1 run again from the APP WebView on both phones at 2.0 Mb/s (the iPhone app's WKWebView was never measured) | 23 at 3.1 Mb/s, 27-28 at 2.6 - it can go DOWN |
| S2 | `LIVE_HOST_EGRESS_BPS` and `LIVE_EGRESS_SHARE` from the school IT department's answer (G14), or a campus-side measurement they agree to | their written figure; a load test on the shared host is not ours to run unasked | e.g. a 1 Gb/s link with a 300 Mb/s share at 3 Mb/s is 100 -> held at **93** by the connection budget |
| S3 | The manifest's gate/tail split: the watch rule checked once per seat lease, the tail answered from a per-live one-second snapshot; a server-told `pollAfterMs` | items 5 and 6 of [the plan's measurements](live.md#measurements-before-anything-is-activated) on the LOCAL estate with headless viewers: requests a second, social-service CPU, Postgres pool wait, Redis scripts a second, at 24 and 100 | unchanged - it makes S4 possible |
| S4 | Past ~93: the host proxy's connection budget raised by the school IT department (their file, their decision), and `limit_conn` per address replaced by a rate measured against the campus NAT | their agreement in writing; `ss` on the host at a busy hour (P9) | uplink / bitrate, up to their budget |
| S5 | Past the uplink: sealed segments from an edge cache on the `canari-emse.fr` zone (ours), the host named per estate in the manifest (`segmentBase`), `Cache-Control: public` on a 200 only, no `Vary: Origin` | items 1-4, 7, 9 of [the plan](live.md#measurements-before-anything-is-activated) - **Cloudflare's current terms FIRST** (an account action would take the whole zone); edge hit ratio; tunnel bytes per live-hour; 2-6 lives at once | bounded by the manifest and the tunnel (~6 lives fully missed), no longer by the audience |
| S6 | The cap becomes a COUNT: the seat set counts, never refuses; `LIVE_FULL` retired; Redis down no longer stops playback; the admission rate per live (the follower push is a thundering herd) and the per-account poll and key-read rates in place | item 8 (the admission spike) | none - "no cap" as the owner asked, with the abuse limits of [live](live.md#abuse-limits-that-are-not-a-viewer-cap) |

**Even at S6 the honest figure is "several hundred viewers", not unbounded**, until the manifest too
stops reaching the host - stated on [live](live.md#the-manifest-poll-grows-with-the-audience-too), said
to the owner as it is.

## 7. The decisions owed by the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D-1 | **A runtime global stop (G13)** before the flip, or accept that turning lives off is a stable through both stores | **Built** (`lives_mode`, 2026-10-21); the compile-time client lock went with the flip of 2026-10-30 |
| D-2 | **The privacy and terms text of section 5** (now on the pages, draft pull request) | approve, correct or strike each point of section 5's list |
| D-3 | **The terms' lives paragraph and the filtering statement** (G10) | the statement as drafted in [store-ugc-answers](../../store-ugc-answers.md#what-to-write-in-the-review-notes-draft-english); the paragraph is written (section 5), the owner rereads it |
| D-4 | **Open production at 24 viewers** (S0) rather than wait for any step of section 6 | **Yes** - the cap is a refusal with a clear screen, never a failure, and every later step needs production readings anyway |
| D-5 | **Ask the school IT department the two G14 questions now** | **Half answered**: CrowdSec measured read-only 2026-10-30 (G14); the link speed still gates S2, not the opening (lives open with `1.5.2`, owner 2026-10-30) |
| D-6 | **Whether viewers see a viewer count**, and whether the policy says the broadcaster gets no viewer list | **decided 2026-10-21: the exact count to everyone watching**; the policy says no feature shows the list (section 5) |
| D-7 | **`minClientVersion` for lives** | **No raise** - an old build never draws a live |

## See also

- [live](live.md) - the plan, the decisions, the uncapped-audience design
- [lives](../../services/lives.md) - the server as built, its switch and its numbers
- [store-ugc-answers](../../store-ugc-answers.md) - what each store asks, mapped
- [register-of-processing](../../compliance/register-of-processing.md) - rows C19, C20
- [calls](calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21) - the same exercise for audio calls
