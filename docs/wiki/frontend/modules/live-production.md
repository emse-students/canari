# Lives in production - the gates, the order, the cap, the policy text (plan, 2026-10-21)

The owner wants lives in production as early as possible: moderation (WP-L8) first, the audience
cap lifted later. **This page is the only copy of the blocker list, the order of the switch, the
viewer-cap ladder and the held privacy wording.** The design stays on [live](live.md), the server
on [lives](../../services/lives.md), the store mapping on [store-ugc-answers](../../store-ugc-answers.md),
the register rows C19/C20 on [register-of-processing](../../compliance/register-of-processing.md).
Read against `main` at `0413bdeff` (2026-10-21). **Nothing here flips a switch.** It mirrors what
[calls](calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21) did for audio calls.

## 1. What holds lives off today - two locks, one per side

| Side | The lock | Where | Asserted by |
| --- | --- | --- | --- |
| Server | `LIVE_ENABLED`, **computed** per estate by `compute_live_enabled` (`true` on dev, `false` on production; nothing to set, no secret). Not exactly `true` -> every `/api/lives` route and the two media live routes answer a bare `404`, which nginx's `live_segments` cache keeps 10 s | `infrastructure/deploy/render-env.sh`, `live-enabled.guard.ts` (social-service), `isLiveEnabled` (media-service) | `.github/scripts/tests/deploy-env.test.sh` ("production must be false, dev true"), `live-segments.service.spec.ts` |
| Client | `LIVE_ENABLED = deployEnvironment() === 'development'`: a production binary asks `/api/lives` nothing and draws nothing (no feed card, no composer chip, no viewer) | `frontend/src/lib/features.ts` | the feature's own tests; a bare `404` on `/api/lives` is the `disabled` refusal kind (`lib/live/types.ts`) |

**Read 2026-10-21, from outside:** `GET https://canari.emse.fr/api/lives/limits` answers `404`, as
the server lock says. What runs whatever the switch says, on purpose: the live sweep, the media purge
and the hourly `[LIVE_REPORT_AGE]` alarm - a live or a report from while the switch was on is still
ended, deleted and answered.

**The consequence the order below is built around.** Production deploys only on a STABLE, and only
once BOTH stores took the version ([cicd](../../cicd.md)). Both locks are compile-time or
render-time facts, so **turning lives OFF again is a new stable through both stores - days, not
minutes.** The per-live control (the staff cut, `POST /api/lives/:id/cut`) exists; a GLOBAL one that
is not a release does not. See G13.

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
| G6 | **WP-L8b client**: (a) the three pushes and two bell rows - **built** (#2192); (b) the admin standing on a live report and the withdraw button - **built** (#2190); (c) the five reaction kinds, the posts' rules on the sheet, reporting ONE chat line - **open, #2170**; (d) the two start refusals (`LIVE_BROADCAST_SUSPENDED` with its date, `LIVE_BROADCAST_WITHDRAWN`) and `GET /api/lives/standing` on the pre-live screen - **owed**; (e) the LIFT of a withdrawal in `/admin/moderation` (the endpoint exists, no control) - **owed**; (f) the `live_chat` report row showing its integrity (`altered` / `key-rotated` / `unverifiable` with one weight) - **owed unless #2170 carries it** | half built | (c) merged, (d)(e)(f) built, each with its test |
| G7 | **Crypto reviews**: the segment seal v1 and the chat seal C12, each "owed an adversarial crypto review" ([live](live.md#the-segment-seal-format-v1), [lives](../../services/lives.md#live-chat-and-floating-reactions-wp-l6)) | **owed** (no review is on record on either page) | one adversarial review each, its verdict written where the format is |
| G8 | **WP-L6 load**: several dev viewers chatting while a broadcaster sends segments (the chat shares the live's row lock with the ingest; nothing measured that contention) | **owed** | one dev reading, numbers on [lives](../../services/lives.md#the-row-lock-extended) |
| G9 | **Phone readings**: check Y (watching) and LIVE-B1 (broadcasting) of [device-verification](../../device-verification.md#live-b1-the-broadcaster-on-both-bench-phones---owed-on-both) on the Mi 9T and the iPhone 12; the moderation screens; the chat panel and the floating reactions; the three pushes once a store build carries their strings | **owed** - the iOS app's WKWebView in particular: WP-L1 broadcast from Safari, not from the app (#2109, draft) | the board rows `PASS`, never `PASS-DIRTY` |
| G10 | **The owner's texts**: (a) the terms' (`/legal/cgu`) section 6 paragraph on lives - the cut, the ladder, the first-live rules, no replay; (b) the filtering statement for the stores (R1: post-hoc moderation, no automatic filter) | **owed - the owner's** | both texts given, the terms merged with G11 |
| G11 | **The privacy policy and the register, together** (CLAUDE.md: the policy is the register's public face) - `/legal/privacy` gains the paragraphs of [section 5](#5-the-privacy-policy-wording---held-for-the-owner), and C19/C20 drop "switched OFF on production" | **drafted below, HELD** for the owner | the owner's yes on the wording; one pull request changing the page AND the two rows, merged before or with the flip |
| G12 | **The stores (WP-L9)**: the review notes ([draft](../../store-ugc-answers.md#what-to-write-in-the-review-notes-draft-english)) re-read against Apple 1.2 and Play UGC as published that day; **the review VIDEO** showing a report and a staff cut on a running live (L7); the App Privacy labels and Play Data safety re-read for live video and chat; the camera and microphone purpose strings (they name posts and CanaReels, not lives - Apple 5.1.1 reads them as the uses) | **owed** | the video recorded FROM a pre-release run (never staged after), the notes and labels the owner approved |
| G13 | **A global stop that is not a release** (see section 1): a runtime switch read by the live guard, as calls got `platform_config.calls_mode` (B12 of [calls](calls.md#the-blockers-each-with-its-evidence)) | **a decision - the owner's** (D-1 below) | decided; if yes, built and its `off` read refusing a start on dev before the first alpha with the flip |
| G14 | **Two questions to the school IT department, asked before the first public live** (asking is a question, not a change): whether the host's CrowdSec reads a lecture hall behind one campus address (~10-20 requests a second) as a crawl; and the link's real speed and Canari's share (Q3), which sets the cap | **owed** | their written answers, recorded in the private operations notes, the cap figure on this page |
| G15 | **The production preflight** (section 4), read-only | **written below; owed** | every line read |
| G16 | P3 met by the server review: a seat taken AFTER an end's release outlives the end by up to its 30 s lease ([backlog](../../backlog.md#p1---live-moderation-wp-l8-the-server-half-is-built-the-client-half-is-built-the-decisions-of-2026-10-20-are-taken-and-their-server-work-is-owed-2026-10-19)) | **owed**, NOT a blocker (it costs a refusal for 30 s, never a byte or a key) | its fix, whenever |

## 3. The order

1. **Code, all dev-only, none flips anything** - G6 (c)(d)(e)(f); G13 if the owner says yes; the
   purpose strings of G12 can ride the flip itself.
2. **Reviews and dev readings** - G7, G8, G4.
3. **Pre-releases and phone readings** - each piece reaches the bench through an ordinary
   `vX.Y.Z-alpha.N` (dev + testers); G9 is read there. **The App Review video is recorded from
   these runs.**
4. **The owner's texts** - G10, G11's yes, G12's labels; the two G14 questions sent.
5. **The production preflight** (section 4), read-only.
6. **THE FLIP, ONE COMMIT, ONE PR**, carrying G11's policy and register change (or after it):

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
8. **The stable** -> production, once both stores took it. **The first production live is an
   announced one, with a moderator on duty**, and its readings are: `X-Canari-Cache: HIT` from the
   second viewer, the seat count against the cap, `[LIVE_REPORT_AGE] pending=0` the next hour, the
   host's egress during the live (read-only), and the sweep deleting the live's rows and segments
   after its end.
9. **Afterwards**: `minClientVersion` is NOT raised for lives - an old build simply never draws
   them - unless the owner decides otherwise.

**Rollback**: one live, the staff cut (built). Everything, a release reverting the flip - or G13's
switch if built.

## 4. The production preflight (read-only)

Run from a signed-in production session and the host, **by the access routes of the private
operations notes** (never written here: this repository is public). Every line reads; none writes.

| # | Read | Expected |
| --- | --- | --- |
| P1 | `GET /api/lives/limits` on production, from outside | `404` (the lock holds) - **read 2026-10-21** |
| P2 | the applied migrations in social-service's database: `091_lives`, `094_live_announced_at`, `097_live_moderation`, `098_live_chat`, `099_live_strikes_and_reported_chat_lines` | all applied - expected, since the switch gates routes and not migrations _(not read)_ |
| P3 | `SELECT count(*)` on `lives`, `live_segments`, `live_chat_messages`, `live_cuts`, `live_chat_reported_lines` on production | `0` - nothing was ever started there |
| P4 | the rendered production env holds `LIVE_ENABLED=false` and a non-empty `LIVE_REPORT_SIGNING_KEY` (presence and length only; never print a value) | as said |
| P5 | the production frontend image's `/etc/nginx/conf.d/default.conf` holds the `live_segments` cache zone and the `^~ /api/media/public/live/` location ending in `\z` | as [lives](../../services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4) |
| P6 | social-service's log: one `[LIVE_REPORT_AGE] pending=0` line an hour | present (the alarm runs whatever the switch says) |
| P7 | the media store has no `live/` prefix on production | empty |
| P8 | Redis has no `live:seats` key on production | absent |
| P9 | the host proxy's connections in use at a busy hour (`ss`, read only) against its ~1 500 | the headroom recorded, as the cap's fourth figure ([lives](../../services/lives.md#the-viewer-cap-wp-l4)) |

## 5. The privacy policy wording - HELD for the owner

**HELD: not applied to `/legal/privacy`.** It is the public face of rows C19 and C20, which already
carry the facts; the page changes in the same pull request as those rows, before or with the flip
(G11), and is re-dated that day. The owner checks every claim, as for #2183 (calls). Each paragraph
names its home in the page.

**Section 2, "Données traitées" - a new entry after "Publications, commentaires, réactions,
sondages, CanaReels":**

> **Directs (lives)** - Quand vous lancez un direct, la vidéo est découpée sur votre appareil en
> courts segments, chiffrés avant l'envoi avec une clé propre au direct. Le serveur conserve cette
> clé et la remet aux membres autorisés à regarder (les mêmes que pour une publication : un espace en
> commun avec vous, ou le public de l'association au nom de laquelle vous diffusez) : ce n'est donc
> pas un chiffrement de bout en bout, mais ni le stockage ni un tiers ne peuvent lire la vidéo. Le
> serveur connaît, en clair : qui diffuse, au nom de quelle association, les heures de début et de
> fin, la taille des segments, les membres que vous retirez du direct, et, pour chaque spectateur,
> qu'il regarde (son compte et l'heure de sa dernière lecture, 30 secondes au plus après son départ).
> Les messages du chat sont chiffrés avec la même clé et portent le nom de leur auteur, visible des
> autres spectateurs ; les réactions (cœur, rire, bravo, feu, poussin) sont comptées par le serveur
> en clair. Un direct n'est pas enregistré : rien n'en reste à sa fin, sauf ce que décrit la ligne
> « Signalements » ci-dessous. Avant votre premier direct, vous acceptez les règles de publication ;
> la version acceptée et sa date sont conservées.

**Section 2, "Signalements, blocages et modération" - appended:**

> Pour un direct : le signalement d'un message du chat transmet son texte, que le serveur vérifie
> contre le message chiffré avant de le garder pour la modération ; une coupure par la modération est
> enregistrée (le direct, la personne, le motif, la date), et les coupures récentes peuvent suspendre
> puis retirer le droit de diffuser.

**Section 3, the table - a new row:**

> | Directs, chat et réactions | Diffuser un direct aux membres autorisés et prévenir vos abonnés | Exécution du service (6.1.b) |

and the "Signalements, blocages, modération" row's purpose gains *", y compris des directs"*
(interest 6.1.f unchanged; the rules acceptance is 6.1.b, a condition of the feature, as C20 says).

**Section 4, the FCM/APNs paragraph - appended:**

> Quand un membre que vous suivez lance un direct, la notification contient en clair le nom de la
> personne ou de l'association qui diffuse, sans autre texte.

**Section 6, the retention table - new rows:**

> | Direct (vidéo chiffrée, chat, réactions, spectateurs) | Supprimé à la fin du direct (par vous, 60 secondes sans vidéo, ou au bout d'une heure) ; les segments mis en cache par notre serveur web, deux minutes au plus après leur dernière lecture |
> | Message du chat d'un direct signalé | Jusqu'au traitement du signalement, 90 jours au plus, y compris si son auteur supprime son compte entre-temps |
> | Coupure d'un direct par la modération | 90 jours ; une deuxième coupure dans ce délai suspend le droit de diffuser 30 jours, et à partir de la troisième la modération peut le retirer jusqu'à ce qu'elle le rende |
> | Acceptation des règles du direct | Tant que le compte existe |

**The "Sauvegardes" note - one sentence appended:**

> Un direct en cours au moment d'une sauvegarde nocturne peut y laisser des segments chiffrés (sans
> leur clé, supprimée avec le direct) et ses lignes de base de données, dans les durées ci-dessus.

**What the owner checks, each a claim to confirm or strike:**

- "ni le stockage ni un tiers ne peuvent lire la vidéo": true of the media store and nginx's cache
  (ciphertext, the key only in social-service's row); the HOST's administrators can read the
  database, which holds the key - as for every post CEK. Is "un tiers" fair, or say "hors Canari"?
- "les réactions ... comptées par le serveur en clair" (C7, C12 of [lives](../../services/lives.md#live-chat-and-floating-reactions-wp-l6)).
- the viewer's seat: the broadcaster gets no list of viewers (no `/api/lives` route returns one, read
  2026-10-21) - worth saying in the policy, or not?
- a backup keeping the KEY: the key is a column of `lives`, so a nightly dump taken DURING a live
  holds it, 14 days. The sentence above says "sans leur clé" of the MEDIA backup only; the database
  dump is covered by the generic 14-day sentence. Confirm the wording is not misleading.
- "rien n'en reste à sa fin": the broadcaster may keep a copy on their OWN device (L3, Q8 of [live](live.md#open-questions-for-the-user-each-with-a-recommendation)); whether that save is built was not read - if it is, the sentence says so
- the edge cache of section 6 (a Cloudflare cache of segments) is NOT in this text: it does not
  exist. If it is ever built, section 4 gains Cloudflare for segments and C19 its retention.

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
| The host proxy's connections | ~1 500 for every site on the host, 4 per seated viewer | [lives](../../services/lives.md#the-viewer-cap-wp-l4); `live-segments-route.test.mjs` fails past a quarter of it | **cap 93** (93 x 4 = 372 <= 375) without the school IT department |
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
| D-1 | **A runtime global stop (G13)** before the flip, or accept that turning lives off is a stable through both stores | **Yes, build it** - the same shape calls got (Q2 of the calls flip), one row in `platform_config`, read by the guard; the compile-time client lock can then go |
| D-2 | **The privacy wording of section 5** | approve, correct or strike each claim of its checklist |
| D-3 | **The terms' lives paragraph and the filtering statement** (G10) | the statement as drafted in [store-ugc-answers](../../store-ugc-answers.md#what-to-write-in-the-review-notes-draft-english); the paragraph is the owner's text |
| D-4 | **Open production at 24 viewers** (S0) rather than wait for any step of section 6 | **Yes** - the cap is a refusal with a clear screen, never a failure, and every later step needs production readings anyway |
| D-5 | **Ask the school IT department the two G14 questions now** | **Yes**, they gate S2 and the first public live, and their answer takes time |
| D-6 | **Whether viewers see a viewer count**, and whether the policy says the broadcaster gets no viewer list | the count to the broadcaster only in v1 |
| D-7 | **`minClientVersion` for lives** | **No raise** - an old build never draws a live |

## See also

- [live](live.md) - the plan, the decisions, the uncapped-audience design
- [lives](../../services/lives.md) - the server as built, its switch and its numbers
- [store-ugc-answers](../../store-ugc-answers.md) - what each store asks, mapped
- [register-of-processing](../../compliance/register-of-processing.md) - rows C19, C20
- [calls](calls.md#turning-calls-on-in-production---audio-11-only-owner-2026-10-21) - the same exercise for audio calls
