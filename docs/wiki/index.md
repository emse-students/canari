# Canari — Technical Wiki

> Language: English (all technical documentation).
> Audience: developers, LLMs, contributors.

> **Start here: [Durable rules](durable-rules.md)** — every constraint this codebase has paid for,
> indexed by area. `CLAUDE.md` keeps only the rules that apply to every task and points here for the
> rest. Read the section matching what you are about to touch, before you write anything.

## Table of contents

### Architecture

- [Architecture overview](architecture.md) — service topology, Nginx routing, auth flow
- [Shared libraries](libs.md) — proto
- [Glossary](glossary.md) — acronyms and terminology

### Protocols

- [The one-time key-package pool, measured](protocols/key-package-pool.md) - every count, every population, and every rule refuted against the pool nothing reclaims
- [MLS protocol](protocols/mls-protocol.md) — RFC 9420 integration, epochs, forward secrecy, device sync
- [History reconciliation](protocols/history-reconciliation.md) — how a device works out it is missing messages and gets them: the replacement for the non-terminating `history_request` machinery, and the decisions taken
- [Addressing a history answer (design, step A)](protocols/history-answer-addressing.md) — DESIGN ONLY, revised after its opus review: answers addressed to the asking device and accepted only when solicited, bounded and add-only; A protects against honest servers and answerers only; sealing to an ephemeral X25519 key from `mls-core` comes next
- [MLS defects the campaign measured](protocols/campaign-measured-defects.md) — The reasoning, numbers, recurrences and refuted readings behind the open MLS healing and delivery entries of the backlog
- [MLS desync prevention](protocols/mls-desync-prevention.md) — Server + client tactics to avoid state drift
- [MLS recovery ladder](protocols/mls-recovery-ladder.md) — Step-by-step recovery (commit replay → external join → welcome_request)
- [MLS + Graine state machine](protocols/mls-graine-state-machine.md) — **Every path, drawn from the code.** Mermaid diagrams with `file:line` on every transition, the duplicate-path table, the dead ends, and the P1/P2/P3 triage
- [Channel encryption](protocols/channel-encryption.md) — **Graine, PHASES 1-5 ARE IN.** Why a salon is not an MLS group, the per-sender seed the server has never held, and the cut that is still owed
- [Graine rotates on a departure (design)](protocols/graine-removal-tracker.md) — DESIGN ONLY, reviewed before code: a commit summary from `mls-core` on every platform, a per-key-group clean run, the fail-safe argument, reuse across an Add by re-distributing the same seed, `joined` keeps rotate-on-add
- [DMs and communities, compared](protocols/dm-vs-community-encryption.md) — What MLS-carried DMs and Graine-carried communities each do well, re-measured on production 2026-10-21: group sizes, the rotation rate, the bundle, the queue, and where each can improve
- [WebSocket binary protocol](protocols/websocket-protocol.md) — protobuf wire format, AppMessage, MlsFrame
- [API surface](protocols/api-surface.md) — Full endpoint list across all services

### Backend services

- [chat-gateway](services/chat-gateway.md) — Rust/Axum WebSocket gateway, Redis pub/sub
- [call-service](services/call-service.md) — Rust/Axum WebRTC SFU, Cloudflare TURN
- [chat-delivery-service](services/chat-delivery.md) — NestJS MLS API, message queue, sync engine, push
- [core-service](services/core-service.md) — OIDC auth (Authentik), users, Stripe payments
- [media-service](services/media-service.md) — Encrypted blob storage (Garage)
- [media-streaming-upload](services/media-streaming-upload.md) — Design: parts under 8 MiB, bounded-memory upload and download (the host firewall's body limit)
- [social-service](services/social-service.md) — Posts, channels, associations, forms
- [reels](services/reels.md) — CanaReels server half: the `reel` post kind, its 30-day deletion, the API contract
- [lives](services/lives.md) — Live server half (WP-L2, WP-L3): the live row and key, segment ingest, the manifest, deletion at the end; switched off on production
- [Community rework](services/community-rework.md) — the master plan for the community subsystem: what triggered it, the three axes, and the crypto axis still to do
- [NestJS framework](services/nestjs-framework.md) — which major each of the four services runs, why they differ, and what an ESM-only framework did to jest
- [Account erasure](account-erasure.md) — `DELETE /users/me` as a durable, retried, journalled queue; every service's delete set asserted against its schema; what is NOT covered
- [Reporting and blocking](moderation-and-blocking.md) — the one report store, and what a block does and does not close
- [Read receipt privacy](read-receipt-privacy.md) — every path that can move a salon's "Lu par", its evidence, and the closed chantier (2026-10-14)

### Frontend

- [Frontend architecture](frontend/architecture.md) — SvelteKit 5, stores, routing, Paraglide i18n
- [Design reference](frontend/design-reference.md) - Messenger and Facebook MEASURED, Canari's 36 font sizes measured beside them, and the scale that replaces them
- [SEO and link previews](frontend/seo.md) — why a login-gated SPA needs server-rendered heads, the sitemap and robots routes, and what each decision follows from
- [Local-first UI](frontend/local-first-ui.md) - the rule that no interaction servable from local state may await the network, what a shaped link measured on the phone, and the ledger of what is fixed
- [Offline and weak network](frontend/offline-and-weak-network.md) - what each send and load path does offline and on Slow 3G / 2G, measured on the sandbox pair, the root causes with file:line, and the ordered work packages (salon outbox, deadlines, boot chain)
- [Emoji: Noto pictures, replacing the bundled font](frontend/emoji.md) - the SVG set and the svgo plugins measured to damage it, the presentation rule, the gate, and the font until it is deleted
- [Sounds](frontend/sounds.md) - every sound the app emits and its trigger, and the rule that no audio output is held while nothing plays (the stream a frozen Android app kept `started`)
- [MediaFrame](frontend/media-frame.md) - the box a picture, a GIF or a video holds before it arrives: what Discord, WhatsApp, Telegram and Slack carry (sourced), what Canari shifted, and the primitive every renderer uses
- [Video preparation](frontend/video-preparation.md) - every video re-encoded ON the phone to one fragmented MP4 (H.264 + AAC, 720p, ~2.5 Mb/s): the `prepareVideoForUpload` seam, its faults, and the device readings
- [The cold start, measured](frontend/cold-start.md) - every reading behind the under-1 s target, and every hypothesis refuted on the way
- [From a notification tap to a sent reply, measured](frontend/notification-to-conversation-latency.md) - tap to usable conversation, killed and backgrounded, ranked costs and the fix plan
- [UI redesign audit, 2026-10-16](frontend/ui-redesign-audit-2026-10-16.md) - every page against the /admin standard (shell, hub, segmented control, ui controls), the dashboard rebuilt as the app's hub, and the ordered work packages
- [Performance audit under a heavy MLS state, 2026-10-12](frontend/performance-audit-2026-10-12.md) - ranked by cost x frequency: the restore decrypting every message, one whole-state checkpoint per frame (and its WASM seal, measured), the open thread redrawn by every other conversation
- [Web console log audit, 2026-10-12](frontend/web-console-log-audit-2026-10-12.md) - three idle minutes on `/communities`, ranked: a pdf.js worker per refetch, seed bundles that re-read salons for every member, a checkpoint per message
- [Community opening on the Mi 9T, 2026-10-13](frontend/community-open-slowness-mi9t-2026-10-13.md) - a real console and a CPU profile: a sync MLS command freezes the WebView for the rest of a checkpoint (21.8 s of 38.9 s), every bubble resolving its readers' names, and an admin's salon tap landing on a message
- [Opening a community: the budget, 2026-10-14](frontend/community-open-budget.md) - the hub, its salons and a salon's messages timed per condition on the Mi 9T (cold, warm, slow link, 4x/6x CPU, offline): five serial requests on the first-paint path, nothing local, and the 200 ms budget with the fixes that reach it
- [Startup load and send delay, 2026-10-12](frontend/startup-load-audit-2026-10-12.md) - a return after 3 h: 775 already-held seed bundles in the queue, 26 salon re-reads, communities in series, and a salon send with no bubble for 6.1 s
- [A heavy store phone, read, 2026-10-13](frontend/store-phone-reading-2026-10-13.md) - a 15.5 MB state on a Pixel 6a: faces re-mirrored on every salon open, a frozen press, a misleading `[HISTORY]` line, the KeyPackage share of every checkpoint, past-epoch drops, and why logcat holds no JavaScript
- [Mobile architecture](frontend/mobile.md) — Tauri 2, iOS NSE, Android push, native FFI
- [Sharing into and out of Canari](frontend/sharing.md) - the OS share sheet both ways: the Android SEND filter, the native copy and its handoff file, the "Envoyer a..." picker, and the lots left (share out, the iOS extension, suggestions)
- [App icons](frontend/app-icons.md) — one drawing, the bird at half of what is seen, four generators
- [Android / iOS parity audit](frontend/android-ios-parity.md) - where the two native projects DISAGREE, read from source 2026-08-28
- [MLS WASM client](frontend/mls-wasm.md) — openmls compiled to WASM, key management, sync engine
- [Backup and restore](frontend/backup.md) — the `.canari` file, and why a refusal is a code rather than a sentence
- [Auth module](frontend/modules/auth.md) — Login flow, PIN, biometrics, device registration
- [Chat module](frontend/modules/chat.md) — Conversations, groups, channels, communities
- [Calls module](frontend/modules/calls.md) — WebRTC audio/video calls, CallKit, SFU relay
- [Lives in production](frontend/modules/live-production.md) - the gates, the order of the switch, the read-only preflight, the viewer-cap steps from 24 to none, and the HELD privacy wording
- [Live scaling](frontend/modules/live-scaling.md) - no visible audience ceiling: what bounds a live's audience (the host uplink, ~24), the five options, R2 for the segments, the staged path and the owner's decisions
- [Live](frontend/modules/live.md) — Livestream plan (R4/C9): the user's 2026-10-15 decisions, open questions, work packages; not started
- [Associations module](frontend/modules/associations.md) — Club management, members, calendar, shop, documents
- [Forms module](frontend/modules/forms.md) — Form builder, submissions, cash/Stripe payments
- [Calls revival plan](frontend/modules/calls-revival-plan.md) - draft 2026-10-15: decisive tests first, the endpoint x network x call-kind matrix, the App Review video, a server-side switch, WP-C0..C13
- [Calendar module](frontend/modules/calendar.md) — Events, ICS export, global calendar
- [Posts module](frontend/modules/posts.md) — Feed, polls, reactions, comments
- [Sharing out of Canari](frontend/share-out.md) — "Partager" on a message, an attachment, a post: the system share sheet, the decrypted copy and how long it lives
- [CanaReels (client)](frontend/modules/reels.md) — The camera tab, the capture screen, publishing a reel, the vertical viewer, save to gallery
- [CanaReels editor](frontend/modules/reel-editor.md) — The post-capture review, editor (text and emoji overlays, one gesture helper), remove-the-sound, and the work-package split
- [CanaRun](frontend/modules/canarun.md) - an activity card (run, ride, hike, pool swim) in a DM, group or salon: the decisions, the wire format, the reader built in R1 with the writer off until the floor, R2 owed
- [CanaReels in a conversation](frontend/modules/reels-in-chat.md) — Design study (2026-10-09): an ephemeral E2E video message in DMs, groups and salons, its model, retention, weak network, work packages
- [Lydia API reference](lydia-api.md) — every call, state and callback, with the source of each fact; [Payments module](frontend/modules/payments.md) — Lydia, products, shop; [Stripe archive](stripe-archive.md) — what Stripe did and why it left
- [Minesweeper](frontend/modules/minesweeper.md) — No-guess generation, seed + first click, ranked replay, generation cost
- [Admin module](frontend/modules/admin.md) — Dashboard, moderation, platform config

### Infrastructure

- [Docker & services](infrastructure/docker.md) — Docker Compose setup, service dependencies
- [Container logs](infrastructure/logging.md) - the bounded json-file stanza on every service, and the per-deploy archive that keeps a log past the container a deploy recreates, and the privacy policy's 90-day ceiling: what is enforced, what is only reported
- [DSI log retention request](infrastructure/dsi-log-retention-request.md) - what the shared host logs that names a client (journald, nginx and the host's security tooling), the exact setting asked of the DSI for each, and the request in French, drafted 2026-10-16 and not sent
- [Host WAF body limit](infrastructure/host-waf-body-limit.md) - the school-managed firewall refuses large request bodies; why every upload body stays under 8 MiB
- [Nginx routing](infrastructure/nginx.md) — Route table (source of truth), auth_request
- [Authentik (OIDC)](infrastructure/authentik.md) — Identity provider, OIDC flow, deployment
- [CAS callback without state](infrastructure/cas-callback-state.md) — school CAS sign-ins that return with no code: pinned cookie, setting, measurements
- [Mino access](infrastructure/mino-access.md) — Wiki.js and Omeka permissions driven by Authentik groups, the three archive levels
- [MiConnect profiles and access](profiles-and-access.md) — the reform decided 2026-09-29: affiliations, spaces, who reaches which app, and the production state it was measured against
- [Cloudflare edge](infrastructure/cloudflare-edge.md) — the zone configured by hand with no representation in git: what lives there, how to read it, and the tunnel token rotation
- [Databases](infrastructure/databases.md) — PostgreSQL, Redis, Garage
- [Backup system](infrastructure/backup.md) — Daily cron, offsite rsync
- [Host OS updates](infrastructure/host-updates.md) — the four boxes' security updates, the `#clear` without which the policy is decorative, the 30-second `502` this scope does NOT incur, and the daily run that fails on a finding
- [Dev environment](infrastructure/dev-environment.md) — `dev.canari-emse.fr`: what keeps it apart from production, the full copy and its three strips, the declared version gap, and the one kind of evidence that lifts a merge ceiling
- [Store listings](store-listings.md) - what Play and the App Store show: current texts and what is stale, screenshot sizes, the fictional-demo-data pipeline and its privacy checklist
- [Store UGC answers](store-ugc-answers.md) - what Apple 1.2 and Play's UGC policy ask (filter, report, block, contact, terms), mapped to what the app has and what is missing (WP-L9)
- [Store review for lives](store-review-live-checklist.md) - the guideline 1.2 checklist by screen, the review video shot list, the App Review notes, what the owner provides (WP-L9, draft)
- [Production queue and epoch audit, 2026-10-12](infrastructure/prod-queue-and-epoch-audit-2026-10-12.md) - why `queued_message` reached 93 k rows: repair answers sent to every seat of a new community, and seats of devices with no session left; no client stuck, the reaper by age rejected
- [Storage forecast](infrastructure/storage-forecast.md) — Measured unit costs, the model at 400 daily users, and why the backup scheme fails before the data does
- [Storage and retention](infrastructure/storage-and-retention.md) — Draft audit of 2026-10-11: host disk, volumes, logs and backups measured read-only; the unmeasured remainder is listed
- [Real-time media feasibility](infrastructure/realtime-media-feasibility.md) - measured 2026-10-15: what calls and livestreams can do on the production host; inbound is 443 only and is enough, but the host cannot send UDP out, so the SFU cannot reach Cloudflare TURN - the minimal DSI ask is one OUTBOUND rule; segmented live over 443 works, ~90-107 Mb/s measured
- [Estate migration](infrastructure/estate-migration.md) - the three VMs moving onto the Portail-etu host and then onto `emse.fr`: the two phases and why they are separate, the decisions taken 2026-09-23, the bun blocker that is REFUTED, and the certificate renewal nothing would reload

### Features

- [Sessions, in every application](sessions.md) — The session model shared by Canari, Sky, MiGallery and Le Cercle: opaque token, rotation, replay, impersonation
- [Account restore on a new Android phone](account-restore.md) - WP-RESTORE-1: a WebAuthn restore key bound to the session that made it, what it restores (a session, never a key), the threat model, the four routes, the native plugin
- [Association permissions](association-permissions.md) — The eleven flags measured from their call sites, the one predicate answering "may this user act here", and the two tiers above a member
- [Cotisations](cotisations.md) — Membership dues: cotisant tags, boutique products, form member pricing
- [Carte de la Vie Asso](carte-vie-asso.md) — Editable poster generator (drag & drop canvas, PDF export)

### Compliance (GDPR)

- [Register of processing](compliance/register-of-processing.md) - the Art. 30 register: one row per processing across Canari, MiConnect, MiGallery, Sky, Le Cercle and Portail-etu, the processors, and the OPEN gaps
- [DPIA: MiGallery face recognition](compliance/dpia-migallery-faces.md) - the AIPD: description, necessity, risks (non-members' faces first), measures, residual risk
- [Breach procedure](compliance/breach-procedure.md) - Art. 33/34 runbook: detection, the 72 h clock, who decides, the CNIL notification, the French user notice, the breach register template
- [Data-subject requests](compliance/data-subject-requests.md) - the manual procedure for access, export, erasure and objection within 30 days, the request log, the tables to read per service
- [Dossier for the school's DPO](compliance/dso-dossier.md) - French: the three questions only the DPO can answer, the recipients, the points flagged

### Development & operations

- [Durable rules](durable-rules.md) — the constraints, grouped by area, each linked to the page carrying its reasoning
- [Backlog](backlog.md) — the scheduled queue behind `CLAUDE.md`: the substance of every queue item, and the table of what only the user can do
- [Open questions](open-questions.md) — questions parked deliberately, with no code until they are answered; an answer becomes a backlog entry or closes the question
- [Legacy compatibility](legacy-compatibility.md) — every shim kept alive for older clients, and the date or condition at which each may be removed
- [The 2026-09-02 workflow migration](workflow-migration.md) — main-only, deploy at the bump, pull requests, local development, `-alpha.N` pre-releases: the decisions, the measurements, the ordered checklist
- [Ecosystem convergence](ecosystem-convergence.md) — The five projects measured side by side: tolerant search, outbound deadlines, the locale under SSR, the head, typed errors, the gates
- [The search contract](search-contract.md) — What every search box in the ecosystem promises, the tolerance ladder, and the roster measurement that chose its numbers
- [Development workflow](development.md) — Local setup, Makefile, Docker Compose, pre-commit hooks
- [CI/CD pipeline](cicd.md) — GitHub Actions: CI on a pull request and again at merge, deployment at the BUMP and never at a push, which estate a release reaches, mobile builds, the self-hosted runner
- [Device verification runbook](device-verification.md) — The ordered Android + iOS pass: what compiling never proves, and the log line that is the verdict for each check
- [Device readings, 2026-10](device-readings-2026-10.md) — the Mi 9T and iPhone 12 alpha passes of 2026-10-05 to 10-07: what passed, with the evidence, and the bench traps met
- [Bench readings for calls and live, 2026-10-18](device-readings-calls-live-2026-10-18.md) - calls BLOCKED (no tag carries lot 1); the WP-L1 live bench on both phones: 720p fMP4 segments for 36-42 min, a growing MSE source with 0 append errors, bitrate, battery and heat
- [`v1.4.0-alpha.4` read on the Mi 9T, sideloaded, 2026-10-22](device-readings-v1.4.0-alpha.4.md) - version, feed, comments sheet and a CanaReel shot and played; DM and group read, salon and push not read; the log lines left unexplained
- [Testing methodology](testing-methodology.md) — How a result earns belief: the harness faults distilled into rules, plus the environment traps that read as application bugs
- [Test suite reform](test-suite-reform.md) — The whole test estate measured (2026-10-18): where the 16-minute frontend job goes, the gaps found, and the ordered work packages WP-T1..T8, and the generated inventory of every suite with its deletion candidates (`tools/test-inventory`)
- [Mechanism audit](mechanism-audit.md) - What every part of the app is covered by, measured across the board, the unit tests and the hand pass - and the five things nothing watches
- [Cross-client testing](cross-client-testing.md) — The campaign board, state only: the `1.4.1` campaign's rows on dev, each verdict and the commit it ran on
- [The board up to 1.4.0, archived](cross-client-testing-archive-1-4-0.md) — the local-estate ladder from `0.16.3` to `1.4.0`, archived verbatim on 2026-10-24 (Q6): where to look first when a re-run disagrees, worth nothing as a gate
- [Cross-client rig findings](cross-client-harness-findings.md) — Open findings about the instrument itself: debris sweep, the starting-point contract, duplicated helpers, the PIN-verifier strand, the two `canari-harness` directories
- [Cross-client campaign](cross-client-campaign.md) — The campaign's design: the ladder, what it is allowed to contain, the standing rules, the preflight, and what does NOT exist
- [The 1.4.1 campaign on dev](cross-client-campaign-1-4-1.md) - PLANNED: the verdict on the campaign documents, the rig gaps that block a dev run, the MLS core matrix that blocks the `1.4.1` stable (pathological cases included) and what runs after
- [The 1.4.1 campaign - runners](cross-client-campaign-1-4-1-runners.md) - row by row, how each blocking row is run and recorded, the atom covering it, what is missing, who must be present, and the ten table-driven runners
- [The LITHIUM board, archived](cross-client-testing-archive.md) — every verdict taken between 2026-08-14 and 2026-08-30, against production, on a rig whose ledger was lost: where to look first when a re-run disagrees, and worth nothing as a gate
- [The campaign on the iPhone](cross-client-ios.md) — Every board row classified for the iPhone 12 (runs with the adapter / needs a named observable / not an iOS row), the `phone-ios.mjs` adapter and what is still owed
- [Resuming the cross-client campaign](cross-client-campaign-resume.md) — The delta since the 2026-08-30 pause and the ordered restart: what the dev estate and the dependency sweep do to a run, and what they do not
- [Server migration & bootstrap](../../infrastructure/MIGRATION.md) — Bare-metal setup, secrets, data restore, SSH backup

---

## Quick reference

| Concern | Where to look |
|---|---|
| Nginx routing (source of truth) | [`infrastructure/local/Dockerfile.frontend`](../../infrastructure/local/Dockerfile.frontend) |
| Gateway routes | [`apps/chat-gateway/src/main.rs`](../../apps/chat-gateway/src/main.rs) |
| Full MLS API | [`apps/chat-delivery-service/src/app.controller.ts`](../../apps/chat-delivery-service/src/app.controller.ts) |
| i18n messages | [`frontend/messages/fr.json`](../../frontend/messages/fr.json) (source), `en.json` |
| Environment setup | `scripts/setup-env.sh` |
| Available commands | `Makefile` |
| Server bootstrap | [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) |
| Protobuf schema | [`libs/proto/canari.proto`](../../libs/proto/canari.proto) |
| Mi 9T vs iPhone comparison (weight, timings, layout findings) | [`phone-comparison.md`](phone-comparison.md) |
