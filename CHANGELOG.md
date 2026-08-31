# Changelog

All notable changes to Canari are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries here are condensed. The full account behind each one - what a user saw, what caused
it, and what was decided - is in [`docs/changelog-archive.md`](docs/changelog-archive.md),
which is also where every release up to and including v0.13.1 now lives.

## [Unreleased]

### Changed

- **NestJS 11 -> 12 on the two services that could take it, and a measured hold on the two that
  could not.** `media-service` and `core-service` now run `@nestjs/common`, `@nestjs/core` and
  `@nestjs/platform-express` at 12. `chat-delivery-service` and `social-service` are held at 11 by
  exactly one thing: `@nestjs/throttler` has published no release declaring NestJS 12 support, and
  both of them rate-limit a route. With 12 installed, 307 of chat-delivery's 308 tests passed and
  the one failure was `framework-boot.spec.ts` reading throttler's own manifest - the test written
  after the 2026-08-31 `platform-express` incident, doing exactly what it was written for. The hold
  needs no reminder and no `dependabot.yml` ignore: the pull requests stay open and red, and go
  green by themselves the day throttler ships. Four satellites moved anyway, because their peer
  ranges accept an 11 core despite the renumbering: `@nestjs/config` 4 -> 12, `@nestjs/schedule`
  6 -> 12, `@nestjs/axios` 4 -> 12, `@nestjs/typeorm` 11 -> 12. All 1112 tests green.
  ([nestjs-framework](docs/wiki/services/nestjs-framework.md))

### Removed

- **The Nest scaffold that read as end-to-end coverage and had never run.**
  `apps/core-service/test/app.e2e-spec.ts` was the untouched generator output: it asserted
  `Hello World!` on `/` against a service whose global prefix is `api`, and its `testRegex` lived in
  a `test:e2e` script no workflow and no `Makefile` target ever called. Deleted with its
  `jest-e2e.json`, the two dead `test:e2e` scripts in core-service and social-service, and
  `supertest` plus `@types/supertest`, which nothing else imported. Two `format` scripts also still
  globbed a `test/` directory that no longer exists in either service.

### Added

- **A third family off the auto-merge ceiling: bare `typeorm`.** The boot job proved the schema
  BUILDS - `forRootAsync` resolves, every entity's metadata is constructed, `synchronize` runs - and
  stopped there; every unit suite mocks its repositories, so no test in this repository had ever
  watched the ORM return a row, and a major changing how a query is BUILT would have passed all 1105
  of them and failed on the first production request. `app-module.boot-spec.ts` now issues a real
  `find({ take: 1 })` through EVERY entity the app registered, chosen by metadata rather than by a
  named list, because a gate that picks its subject by name does not cover the entity nobody added
  to it. Green on core, social and chat-delivery in CD run `33403833044`; media-service, which has
  no ORM, carries a tripwire that fails the day someone gives it one. The clause is out of
  `dependabot-auto-merge.sh` - a refusal names a missing gate, and it leaves when the gate arrives.

- **A real query, through every entity, in the boot job.** The boot test proved the schema BUILDS -
  `forRootAsync` resolves, metadata is constructed, `synchronize` runs - and stopped there: all 1105
  unit tests mock their repositories, so nothing in this repository had ever watched TypeORM return
  a row, and an ORM major that changed how a query is BUILT would have passed every gate and failed
  on the first production request. `app-module.boot-spec.ts` now issues a `find({ take: 1 })`
  through every entity the app registered, enumerated from the DataSource's own metadata rather than
  from a list somebody has to remember to update. media-service carries no such test and asserts
  why - it declares no `typeorm`, and that assertion fails the day someone gives it a database.

- **The gate that lets a crypto dependency be upgraded without a human.** Every test in `mls-core`
  built its input with the same code it then exercised, so a change to a wire format, an encoding or
  a key derivation moved both halves together and the suite stayed green - the exact hole the
  auto-merge ceiling refused eight crates for. `tests/cross_version_state.rs` reads four artefacts
  committed as BYTES under `tests/fixtures/`, written by v0.14.14 and never regenerated: a member's
  MLS state, an application frame that member has not yet seen, and the at-rest envelope sealed
  twice - once under a fixed key, which moves only with the AEAD, and once behind the PIN, which
  moves with the derivation as well. Four rather than one so a failure names WHICH crate moved.
  `examples/freeze_cross_version_fixtures.rs` mints a generation and REFUSES to overwrite one, since
  regenerating in place turns the suite into a round-trip that passes by construction. Verified by
  corrupting one byte of each fixture: all four tests go red, and green again on restore.
  **`chacha20poly1305`, `argon2` and `ciborium` came off the ceiling on it** - an at-rest envelope is
  read by the device that sealed it, so the backward direction is the whole question, measured by
  enumerating every `encrypt_blob` call site rather than assumed. The protocol crates stay: a wire
  format is read by other devices on other versions, and only an old binary can answer that half.

### Fixed

- **Every jest suite in the four services would have died at import under NestJS 12, and the
  workaround that hid `uuid` became the thing that broke it.** NestJS 12 is ESM-only - `"type":
  "module"`, no CommonJS build - and while Node 24 and bun both `require()` it without complaint,
  jest's own module registry only gains `require(esm)` when `vm.SourceTextModule` exists, which
  needs `--experimental-vm-modules`. The flag is now on every jest invocation **in the command
  rather than the environment**, because CI runs `node --run test`, which opens no shell and would
  have silently ignored a `NODE_OPTIONS=` prefix. With the flag, the `transformIgnorePatterns`
  exemption that let ts-jest rewrite the ESM-only `uuid` into CommonJS stopped being unnecessary and
  started being wrong - jest evaluated the rewritten file as a module and it failed with
  `ReferenceError: exports is not defined`. Removed from all four services.
- **A peer-dependency violation now names its own remedy.** `framework-boot.spec.ts` listed
  mismatches and left the reader to work out which side had to move; the only reader it ever gets is
  somebody scrolling a red CI log on a Dependabot pull request, and a list with no instruction is
  the queue nobody drains.

- **Claiming a partnership code answered 500 for every user, on every card, since the feature
  shipped.** Migration 047 declared `partnership_codes."claimedByUserId"` as `uuid`. A user id in
  this estate is the 64-character hex digest carried in `x-user-id`, so the FIRST statement
  `claimPoolCode` runs - the "does this student already hold a code" lookup - died in Postgres with
  SQLSTATE 22P02, `invalid input syntax for type uuid`, and the route returned
  `{"statusCode":500}`. Not a race and not load-dependent: no claim could ever have succeeded, and
  prod confirmed it, holding zero claimed rows against a live card. `shared_code` and `text` cards
  never touch that column, which is why the tab looked healthy. Migration 056 widens the column to
  `varchar(255)`, matching every other user-id column in the service; the partial unique index the
  idempotence guarantee relies on is rebuilt by `ALTER TYPE` and keeps its predicate. Nothing caught
  it because every service spec mocks its repositories, so no column type is ever exercised - the
  same blind spot the `typeorm` boot probe above was written for. `user-id-column.spec.ts` now reads
  the DECLARED metadata and fails on any user-id-shaped column typed `uuid`, across the service
  rather than at the one column that broke.

- **Every partnership and product icon was missing in the mobile builds.** The backend stores a
  card icon as the app-relative `/api/media/public/<mediaId>?v=...`. In a Tauri build the page is
  served from `tauri://localhost` (iOS) or `http://tauri.localhost` (Android), where that path
  resolves against the SHELL rather than the proxy: the asset server answers `index.html`, the image
  fails to decode, `onerror` fires and the fallback glyph shows forever. Nothing throws and nothing
  is logged. `apiAssetUrl` existed for exactly this and `CardTile` never called it, so all five card
  lists - shop, association detail, partnerships, boutique and their two manage tabs - were affected
  on mobile only. `CardIconEditor` had the identical bug, found by the new test rather than by
  reading, and left a president re-uploading an icon that had uploaded fine. The two literal-path
  checks in `apiUrl.absolute.test.ts` could not see either, because the offending string never
  appears in the source - it arrives at runtime in a field. A third check now guards the field NAMES
  the backend stores such a path under.

- **A boot probe that failed for the wrong reason.** `framework-boot.spec.ts` compiles a module and
  binds a socket, and it runs beside three other services' suites in the pre-push hook: it took
  25.9 s on a loaded machine against jest's 5 s default and failed the push. It now carries an
  explicit 60 s ceiling in all four services - a bound on non-termination, never an assertion about
  how long a boot takes.

- **A benchmark that stopped compiling on `criterion` 0.8.** `criterion::black_box` is a deprecated
  re-export, and CI runs `clippy -D warnings`, so the bump died with nine errors in `mls_perf`.
  Naming `std::hint::black_box` directly - stable since Rust 1.66, and this repository requires
  1.97 - compiles on either version.

- **An auto-merge that would have walked past the gate written to stop it.** A check-run's
  conclusion is evidence about the workflow that produced it, and PR #272 - `@nestjs/platform-express`
  11 -> 12 in media-service alone, the exact framework split this whole day started from - was
  `CLEAN`, mergeable, every check green, with no `Boot the real AppModule` run in its suite at all
  because that job was written after its CI last ran. An absent check and an inapplicable one look
  identical, so "nothing failed" cannot be the merge condition. The script now refuses any head not
  built on current `main` and marks it stale; the workflow updates at most three such branches per
  pass, re-running their CI under today's definitions. Found by running the shipped script against
  real pull requests - which also caught an unescaped backtick pair silently deleting a filename
  from a refusal comment, bash having run it as a command substitution.

- **An auto-merge that could only act on an event it happened to catch.** `dependabot-auto-merge.yml`
  was triggered by `workflow_run` and nothing else, so it could evaluate a pull request only in the
  seconds after one of its CI runs finished. A pull request whose checks had completed earlier -
  before the workflow existed, while it was disabled, during a runner outage - would never be named
  by another event, and would sit open forever however green and however mergeable. The measurement:
  minutes after the workflow was re-enabled and had merged its first pull request unaided, seven
  more sat `CLEAN` and untouched, and no future event would ever reach them. The workflow now also
  runs **hourly and on demand**, sweeping every open Dependabot pull request through the same
  decision, so the correct state is reached from any starting state rather than only from the event
  that arrived. The clock is not load-bearing: it sets how fast the queue drains, never whether the
  outcome is right, and termination is durable state on GitHub - merged, or carrying the comment
  that names its missing test. The decision itself moved to `.github/scripts/dependabot-auto-merge.sh`
  so both entry points run ONE implementation, and it was verified by running that exact script
  against five real pull requests behind a `gh` shim that intercepts every mutating call.

- **The auto-merge ceiling's first entry retired, on evidence.** `boot-nest-apps` went green on all
  four services, so the `@nestjs/*` case is deleted from `dependabot-auto-merge.yml`. Re-measured
  the same way it was written - the workflow's own loop body against every open pull request's real
  commit message - the ceiling went from 5 merge / 28 refuse to **26 merge / 6 refuse**. What is
  left is two gates: a cross-version MLS state test (5 pull requests) and one relay-path call (1).
  Bare `typeorm` stays refused with a narrower and more honest reason than before: the boot proves
  the schema builds, but every unit suite mocks its repositories, so nothing here has ever watched
  this ORM return a row.

- **chat-delivery-service never closed its Redis connection on shutdown.** `RedisProvider` returns a
  raw `ioredis` client, and a raw client cannot carry a Nest lifecycle hook, so nothing ever called
  `quit()` and `app.close()` left the socket open. A killed container hides that completely; it
  stopped being invisible the first time a test booted the real `AppModule` and jest reported
  `Jest did not exit one second after the test run has completed` - the boot itself had PASSED. A
  one-purpose `RedisShutdown` provider now quits the client on destroy, chosen over wrapping the
  client in a service class because that would change the injection type at every call site in order
  to fix a shutdown. The `boot-nest-apps` job also gained `timeout-minutes: 15`, so the next hang is
  a red job in minutes rather than a runner held for six hours.

- **The auto-merge ceiling refused by semver, and a queue formed behind it.** Written that morning,
  it turned away every major and every minor whose new version's major was 0. Measured against all
  33 open pull requests the same afternoon, it refused 28 - which is the failure, not the feature.
  The ceiling now refuses only dependencies whose failure mode nothing here can OBSERVE, each entry
  naming the test that retires it, and posts that reason as a comment on the pull request instead of
  sitting silent. Testing it against real Dependabot commit messages rather than imagined ones found
  two defects in the first draft: Dependabot YAML-quotes a dependency name beginning with `@`, so
  the `@nestjs/*` case matched nothing and would have merged the very major it was written to refuse;
  and a "update the requirement to permit the latest version" pull request carries no `update-type`
  trailer at all, which is how `openmls` 0.9.0 arrives.
- **social-service and media-service compiled their test files into their production images.**
  Neither had a `tsconfig.build.json`, so `nest build` fell back to `tsconfig.json`, which excludes
  nothing: 111 compiled spec artefacts in one `dist/` and 9 in the other. Both now carry the same
  build config as the other two services, and all four `dist/` trees hold zero.

- **The pre-commit hook failed any commit that DELETES a file.** Its `restage` helper re-adds each
  path the auto-fixers may have rewritten, and a comment asserted that `git add -A -- <path>`
  carried a staged deletion through. It does not: after `git rm`, the path is in neither the index
  nor the worktree, so the pathspec matches nothing and git exits 128 - taking the whole commit
  with it. It now skips a path that is not on disk, which needs no re-staging anyway: no formatter
  rewrites a file that is not there, and the deletion is already staged as its author left it.

- **Two copies of `openmls_traits` in the MLS dependency graph, and two lockfiles that described a
  tree the manifests did not.** `frontend/mls-core/Cargo.toml` declared
  `openmls_memory_storage = "0.6.0"` next to `openmls_traits = "0.5.0"` and `openmls = "0.8.1"`;
  the 0.6 storage crate pulls `openmls_traits` 0.6, so the committed lock carried BOTH versions of
  the trait crate that defines `StorageProvider` and `OpenMlsProvider`. The dependency was never
  used - `openmls_rust_crypto` owns the memory storage internally, as the comment at
  `state.rs:114` already said - so nothing failed to compile and nothing turned red. It arrived
  through Dependabot PR #292, a `0.5 -> 0.6` bump the auto-merge had no ceiling to refuse. Removed
  the unused dependency; one copy of the traits crate remains in all three locks.
- **Nothing in this repository ever read a `Cargo.lock`.** The bun side has installed with
  `--frozen-lockfile` since day one; no cargo invocation in CI, in `cd.yml` or in the `Makefile`
  passed `--locked`, so cargo regenerated the lock in place on every run and every gate was green
  about a graph the repository does not describe. Measured at `main` on 2026-08-31: two of the five
  locks (`frontend/mls-wasm`, `frontend/src-tauri`) no longer satisfied their manifests, one of them
  since PR #293 bumped `base64` to 0.23 without either of them following. Added one step to the Rust
  matrix in `ci.yml` - `cargo metadata --locked` - which resolves the graph and refuses to write.
  It is stated once for every component rather than appended to five `cmd` strings, and it covers
  the Tauri crate, which is deliberately outside the `fmt`/`clippy` gate. The change-detection
  filter already fans a `mls-core` change out to `mls-wasm` and `src-tauri`, so both drifted PRs
  would have gone red on themselves.

- **Every Stripe webhook was rejected, and one member paid 130,00 EUR the app never recorded.**
  `PaymentWebhookController` verified signatures with `stripe.webhooks.constructEvent`, the
  SYNCHRONOUS form. The runtime is `bun dist/main.js`; bun matches the `worker` export condition;
  stripe-node maps that to its web build, whose crypto provider is `SubtleCryptoProvider` - and
  WebCrypto has no synchronous digest, so that call throws by construction. Every delivery since at
  least 2026-08-27 was answered 400: 24 in the running container's log, 38 events still undelivered
  at Stripe, 12 of them `checkout.session.completed` on a LIVE key. Eleven were rescued by the
  browser-return path, which is how a total failure of the authoritative path stayed invisible for
  four days - a fallback carrying production is a signal, never a path. The twelfth buyer never came
  back to the site, so nothing marked their submission paid. Fixed by `constructEventAsync`, which
  is the same verification on either provider rather than a branch on which build got resolved.
  Three tests now cover the seam, and the first of them pins the provider-dependent fact itself:
  jest runs on node, where the SAME sdk resolves the NODE build and the synchronous call would have
  passed, so a test that only signs and verifies cannot catch this class.
- **A dependency auto-merge split NestJS across two services, and its merges deployed nothing.**
  `dependabot-auto-merge.yml` squash-merged any Dependabot PR whose checks were green, with no
  ceiling on the update type at all. It landed `@nestjs/platform-express` 12 into `core-service` and
  into `chat-delivery-service` while `@nestjs/common` and `@nestjs/core` stayed at 11 - a framework
  split that CI cannot see, because a peer mismatch is a warning to bun, `tsc` only checks the
  surface the code uses, and NO test anywhere calls `NestFactory`, so the adapter `platform-express`
  exists to provide is never instantiated. Behind it queued about thirty more, including `openmls`
  0.5 -> 0.6 and `webrtc` 0.17 -> 0.20. The five majors are reverted, all four services are coherent
  on NestJS 11 again, and the workflow now merges only a `semver-patch`, or a `semver-minor` whose
  new version's major is not 0 - the second clause because cargo calls a 0.x bump a minor and that is
  exactly where a 0.x breaks. Read from Dependabot's own `update-type` trailer, never from a title.
- **CD had not run on a single one of those merges.** A squash merge made with `GITHUB_TOKEN`
  produces a push that triggers nothing, so `main` and production drifted apart with nothing saying
  so - five merges between 11:24 and 11:31 against a last deploy of 11:08. The same trap had already
  bitten every release up to v0.10.4 and had been closed for the version bump alone. The auto-merge
  now dispatches CD explicitly after a merge that actually happened, `workflow_dispatch` being the
  documented exception to the anti-recursion rule.

### Added

- **`src/app-module.boot-spec.ts` and the `boot-nest-apps` CI job - the real application, booted.**
  `NestFactory.create(AppModule)` against a real Postgres, a real Redis and a real S3 endpoint, a
  request to the health route, then a clean shutdown. Nothing in this repository had ever
  constructed the actual application module: `NestFactory` appeared in four files and all four were
  a `main.ts`. The infrastructure list was measured rather than guessed - booting media-service
  failed on `connect ECONNREFUSED 127.0.0.1:3900` because `StorageService.onModuleInit` calls
  `bucketExists`, so the job starts MinIO too. The file sits in `src/` because `rootDir` is `./src`,
  is kept out of the ordinary suite by its name alone (`.*\.spec\.ts$` needs a literal dot before
  `spec`, which `.boot-spec.ts` has not) rather than by a skip, and out of `dist/` by the build
  config. It is the gate `dependabot-auto-merge.yml` names when it refuses a framework major.

- **`src/framework-boot.spec.ts` in all four NestJS services - the gate the split walked through.**
  Two tests, no infrastructure. The first reads every installed `@nestjs/*` package's own
  `peerDependencies` and asserts each accepts the `@nestjs/common` and `@nestjs/core` it will
  actually be handed: that is the warning bun prints and nobody sees, turned into a failure that
  names the package and both versions. The second calls the real `NestFactory.create`, listens on
  port 0 and serves a request through the real express adapter, because no amount of type-checking
  substitutes for building the object a version skew lives inside. Verified against the incident by
  reinstalling `@nestjs/platform-express@12` on a core at 11: the declared half printed both
  violations, the boot half died on `No driver (HTTP) has been selected`. The file is duplicated per
  service on purpose - four bun packages, four `node_modules`, and the subject of the test is which
  versions THIS service resolved.

- **`infrastructure/docker-prune/`** - one daily pass that reclaims dangling images and the build
  cache, and REPORTS, never deletes, every dangling volume and exited container. No prune ran on
  `canari` or `mitv` at all. The ledger carries the discriminator a reader would otherwise guess at:
  the compose project label and whether that project still has containers - with the caveat that
  `project_is_live` says the project runs, never that its compose still declares the volume, which
  the three leftover Kafka volumes demonstrate.

- **Marking a conversation read from the notification shade now works when the app has been opened
  since, and REPLYING from the shade marks it read too** (the second is a product decision of
  2026-08-31). Both actions were separate ideas of what reading means and are now one function per
  platform. The frame they send is a `read_watermark` - the instant model the app itself moved to on
  2026-08-12 in `0db47a87`, which touched only `frontend/src/lib/**` and left the native half
  speaking the `read_receipt` it replaced. That mattered because the ids a `read_receipt` names came
  from `fcm_message_cache.ndjson`, a file `consumeFcmCache()` CLEARS at every app boot: with the
  cache empty the action took a `no cached messageId ... no receipt sent` branch, cleared the banner
  locally and marked nothing read anywhere - a silent divergence between this device and every other
  one, with no error. The instant is now stamped into the notification's own action intent
  (`EXTRA_SENT_AT`, `userInfo["sentAt"]`) from the decrypted message's `sentAt`, so nothing is looked
  up; it is the SENDER's clock and never this device's, because watermarks merge by `max` and a fast
  phone would otherwise mark unseen messages read permanently. The id path, the cache lookup and
  `build_read_receipt_app_message` are deleted; the receiving side keeps accepting `read_receipt`
  from older clients.

- **And the badge now clears on the phone whose button was pressed.** The `read_watermark` frame
  reaches peers and our own other devices through the outbox, but MLS does not echo a message back
  to its sender, so nothing ever told the acting device's own conversation row: the user
  acknowledged a conversation from the shade, opened the app, and found it unread - indistinguishable
  from the action having done nothing. `read_watermarks.ndjson` is the missing half, written by the
  action and merged at the next login by `consumeNativeReadWatermarks`, which recomputes
  `unreadCount` FROM the merged watermark rather than writing a count beside it.

- **The branch that destroys a group's local MLS state now names the facts it actually read.** It
  said `conversation row held with no membership left` and reduces no membership at all: its whole
  input is a `dm_groups` row and one local predicate. That sentence is what a reader reaches for
  after a group has been forgotten and nobody knows why - it is the reason string in
  `[SYNC] WASM removed (...)` - and it sent them to `dm_group_members`, which had nothing to say
  about the decision. It also collapsed two different server states into one line; they are now
  `dm_groups row alive, naming no distribution scope, absent from our group list` and
  `dm_groups row tombstoned and naming no distribution scope`. This is the last residue of the
  291 ms defect of 2026-08-30, whose real fix was registering the membership before the local MLS
  group exists; handing this reducer a membership signal is the fix that does NOT work, because
  `getGroupUserMembers` races the very write that was missing and returns an honest empty 200.

- **Search now folds accents, everywhere it folds case.** On a corpus that is French, "reunion"
  could not find the same word spelled with its accent: every matcher and the `<mark>` highlighter
  ran on a plain `String.toLowerCase()`, which folds case and not diacritics. The half-fix - folding
  the query alone - is what makes this kind of defect survive review, since every unaccented query
  still finds every unaccented word; `utils/textFold.ts` folds BOTH sides, at the four matchers, the
  sidebar filter, the admin user filter and the highlighter. The highlighter needed more than a
  fold: an offset found in folded text is wrong in the original by the number of accents before it
  (a precomposed letter folds 1 to 1, the same letter decomposed folds 2 to 1, and one string can
  hold both), so `foldWithIndex` returns a map back to the source and `splitWithHighlight` matches
  in folded space and slices in original space. It walks code points, so an emoji stays one unit.
  Seven hand-rolled copies of "strip the accents" are gone with it, including five slug builders
  that used THREE different character sets - the same association name could slug differently
  depending on which screen created it, and two of them left the trailing separator their own trim
  existed to remove. The campaign's SEARCH-5 was written to RECORD this gap and passed by asserting
  it; its prediction is flipped and its five runs are void.

- **A backgrounded web tab now says how many messages are waiting, without asking for anything.**
  The title reads `(3) Communautes - Canari` and the favicon carries a red dot, from the same unread
  total the sidebar and the bottom bar already show. Until now the web had exactly ONE out-of-page
  unread signal - a browser `Notification` - and it is conditional: `sendSystemNotification` returns
  early unless the permission is already granted, so the first message arriving while the tab is
  away is spent on the prompt instead of delivered, and a user who declines once is permanently
  without any signal at all (the in-app badge has to be looked at to be read, which for a
  backgrounded tab is not a signal). The title and the favicon need no permission, no service worker
  and no decision from anyone. `stores/tabIndicator.ts` is now the ONE writer of `document.title`,
  which is what makes this safe: `useNotifications` used to blink an incoming call's bell by saving
  the current title, overwriting it and restoring the saved copy, so a prefix present when a call
  arrived would have been reinstated after it and one applied during the call erased - the blink is
  behind `setTabRinging` now and the title is a pure render of `(base, unread, bell)` that cannot
  accumulate. The route's own title is adopted from a `MutationObserver` rather than passed in, so a
  navigation needs to know nothing. The reduce computing the unread total, which `AppSidebar` and
  `BottomNav` each carried their own copy of, is `utils/unreadTotal.ts`.

- **Opening an image now pushes a history entry, so the hardware/browser Back button closes the
  lightbox instead of leaving the conversation.** `MediaLightbox` was one of the few full-screen
  overlays in the app that had never been wired into the shared history-overlay stack
  (`historyOverlayStack.ts`) already backing `Modal.svelte` and the PIN modal - so it is the first
  real consumer of the existing-but-unused `bindHistoryOverlay` helper, rather than a new
  reimplementation of the same effect. Every UI-triggered close (X button, backdrop, Escape, and
  the new swipe below) now goes through one `dismiss()` that keeps the history entry in sync,
  instead of calling `onClose` straight from four different places.
- **A vertical swipe up or down now closes the image viewer**, while it is not zoomed in (a
  zoomed image keeps its one-finger drag as pan, unchanged). The gesture classification
  (vertical-enough to count, far-enough-released to dismiss) is pure logic in the new
  `lightboxSwipeDismiss.ts`, tested without a browser - the same split already used for the
  bottom-nav swipe and the per-message reply swipe - so `MediaLightbox.svelte` only does the DOM
  read and the live drag-follow visual feedback.
- **A conversation tile now says whether it is SELECTED, in the markup.** `ConversationTile`
  publishes `data-selected` beside the `data-conversation-tile` / `data-ready` / `data-removed` hooks
  it already carried, and nothing renders differently. It exists because one question had no
  statement to read: HEAL-NEW-15 asks whether a sidebar still answers a click while it is amber - a
  list that does not react is a frozen app - and the only sign a tile gave that a click had landed
  was its SELECTED STYLE, a Tailwind class string. A reader matching that string would report a
  freeze the day the style is restyled, which is the "Sync" badge mistake in different clothes: the
  badge is a Paraglide message, so counting it counts the translation. A fact the component already
  holds is published rather than inferred from how it is painted.

- **An Android vitals watch, because nothing here could see the field** (`tools/play-vitals/`).
  Every Android gate in this repository proves the app compiles and that R8 did not crash; none runs
  the app on a stranger's phone, which is where all three Android defects so far were found. The
  watch reads Play's crash clusters, their stack traces, its own anomaly detection, nine vitals
  metric sets and what each track is serving, over a read-only service account whose key is kept
  OUT of this public repo.

  **Its first run found that Play production was serving a build the biometric fix predates.**
  Play reported `InflateException -> ClassNotFoundException` in `BiometricActivity.onCreate` on
  versionCode 14005 - the `androidx.coordinatorlayout` casualty of excluding
  `com.google.android.material`, diagnosed on a Pixel 6a on 2026-08-28 and fixed by `0cf9c3dd`.
  That commit landed at 14:30, AFTER the 0.14.11 bump, so **14011 - what users actually have - still
  crashes every biometric unlock.** The fix first ships in 14012.

  Acknowledgement lives in `known-issues.json` rather than in Play's archive, and is deliberately
  not a mute list: each entry names the fixing commit and the first good versionCode, so the same
  cluster reappearing at or above it is reported as a REGRESSION instead of being swallowed. The
  Reporting API cannot archive anything anyway - its discovery document defines no write method, and
  no IAM role adds one.

  Two Play measures enforced from Feb 2027 turned out to be readable this way at P50 through P99
  with an `appState` dimension. `mobile.md` called dynamic memory "unmeasured"; it is now merely
  empty, pending users.

- **A form can be shared as a QR code**, next to the copy-link button on both the list and the form
  itself. It encodes the ordinary public URL - no scheme of our own - and downloads as a PNG plate
  carrying the form's title and, when it has one, its association, in the app's own two faces. The
  style is measured rather than decorated: modules are connected strokes with rounded corners, the
  bird sits in a badge over the middle at 22 percent of the side, and the whole thing is decoded back
  in a real decoder, in the test suite and in a browser across seven sizes. Isolated dots were drawn
  first and thrown away on that measurement - they decoded 6 times out of 14 against 12, because a
  scanner thresholds a neighbourhood and a dot leaves it less dark to find.

- **Blocking a person.** Narrow on purpose, and asked for as such: the two accounts stop finding
  each other in the user search and the mention autocomplete, neither can open a 1-to-1 with the
  other, add them to a group, or invite them into a private salon - inside a shared community
  included - and the two follows are severed. Everything that already exists is untouched:
  conversations, groups, community membership, posts. The blocked person is never told, and **no
  moderator sees anything** - by decision, because these are conflicts between two people and a
  dashboard tallying them would turn a private gesture into a record a third party reads. Someone
  who wants a moderator involved files a report, which the profile offers as a separate control.

  The table is core-service's (`user_blocks`), read directly out of `auth_db` by the two services
  that must refuse a mutation. **Hiding somebody from a search enforces nothing** - a known uuid is a
  complete bypass - so the refusals sit at `addGroupMember` (chat-delivery) and the salon invitation
  (social-service), each answering `403 USER_BLOCKED` with a neutral message that never says who
  blocked whom. Without a membership row the target's devices never get a pending membership, so no
  Welcome is ever built: that is the whole mechanism. Both creation paths ask
  `GET /api/users/:id/block-status` BEFORE any MLS work, because meeting the authoritative refusal
  at the commit means the group is already minted and the Welcomes already out.

- **Reporting a person**, from their profile, with the same four reasons every other report uses.
  A moderator sees the account's display name as the preview rather than a bare uuid.

### Removed

- **`libs/shared-rust`, which nothing in this repository read a line of.** It defined three Kafka
  event structs, their topic constants and a `ts-rs` mirror into committed TypeScript bindings.
  `apps/chat-gateway/Cargo.toml` named it as a path dependency while the gateway's source contained
  no `shared_rust` at all, and no TypeScript imported the bindings; the one consumer that ever
  existed - the gateway's Kafka subscriber, deleted the same day - never used the constant, nor even
  its spelling. What a dead crate costs is not its size, it is every mechanism that has to enumerate
  the repo: a CI matrix entry with its own change-propagation flag (chat-gateway was rebuilt whenever
  it changed), two CD path filters, a Dependabot directory, a CODEOWNERS line, a `git add` in the
  version bump, a `LOCAL_CRATES` entry in `bump-app-version.sh`, a Makefile target inside `make
  test`, a branch in both Husky hooks, and a `COPY` in two Dockerfiles. All are gone, the
  chat-gateway lock is 44 lines shorter, and its tests and clippy are clean without it. The stale
  `libs/shared-ts/` build output left on disk by that package's deletion on 2026-08-27 went with it.

- **Kafka, Zookeeper, and the one consumer that kept them alive.** A `confluentinc/cp-kafka` and a
  `cp-zookeeper` ran on production carrying nothing: 42 hours into an uptime, with every service up,
  `kafka-topics --list` answered `__consumer_offsets` and no application topic at all. chat-gateway
  consumed `post.created` under group `chat-gateway-broadcast` and logged `UnknownTopicOrPartition`
  at every boot, because the topic has never existed - no `kafka` symbol appears anywhere in
  social-service. It was broken at three levels, not one: nothing produced the topic; the shared
  crate spelled it `post_created` while the subscription used `post.created`, so a producer written
  against the constant would have published past its only consumer; and `post_created` was routed to
  `handleChannelEvent`, which has no branch for it, so a record that HAD arrived would have reached
  that handler's final `[ERROR] Unhandled channel event type` line on every connected client. The
  broadcast was also unfiltered - a post in a private community would have gone to every socket on
  the server, where the Redis path it should have used delivers to named recipients. Gone with it:
  `spawn_kafka_consumer`, the `rdkafka` dependency and the four apt packages it needed in the image,
  `KAFKA_BROKERS` from three compose files, the `post_created` client route, four now-dead noise
  rules in the campaign classifier (their return is a finding now, not a boot banner), and
  `docs/wiki/infrastructure/kafka.md`. Two containers and 1.09 GiB of resident memory reclaimed,
  against the 6.4 MiB chat-gateway uses to do the real work. `docs/diagrams/message.uml` was
  corrected in the same pass: it drew the gateway producing records for a "Chat History Service"
  that has never existed in this repository.

- **The Cercle test top-up on `/admin/cercle`, and every line that served it.** The button credited
  5 EUR to the pressing admin's own Cercle account through the production path on a synthetic
  `pi_canari_test_` intent. Nothing about it was simulated except the card: it moved a real balance
  on a system Canari does not own, wrote a real `purchase_records` line into the association's
  accounting, and left a `webhook_deliveries` row on the retry ladder - a credit wearing a test's
  name. Gone with it: the endpoint (`POST /associations/:id/products/:productId/simulate-topup`), its
  DTO, the service method, the client call, twenty Paraglide keys, and `resolvePurchase`'s
  `skipPaymentReadiness` option, whose only caller it was - so the two conditions it waived (product
  on sale, Connect account onboarded) are now unconditional. The cost is stated where it will be
  read: proving the webhook now needs a real purchase, which needs Le Cercle's Stripe onboarding
  finished (`docs/PROD-TEST-CERCLE.md`, step V5).

### Changed

- **chat-delivery no longer connects a Kafka transport it never had a handler for.** Every boot
  printed the KafkaJS v2 partitioner warning, and the question it raised - legacy partitioner or
  default? - turned out to have no answer: the service declares no `@MessagePattern` or
  `@EventPattern` at all, so the producer Nest creates for handler replies could never send a
  record, keyed or otherwise. Measured on prod: the broker held only `__consumer_offsets`, and the
  one consumer group was this service's own, subscribed to nothing.
  `KAFKAJS_NO_PARTITIONER_WARNING=1` would have hidden the line and kept the producer; the
  transport is gone instead, with `@nestjs/microservices`, `kafkajs`, and the service's
  `KAFKA_BROKERS` / `depends_on: kafka` in both compose files. **chat-gateway's Kafka consumer is
  untouched** - though the same measurement found that nothing produces the topic it waits on, which
  is now a P2 for the user to decide.

- **A failed in-conversation search now leaves a trace.** `ChatArea.svelte` is 1206 lines, carries
  the whole search UI, and had no logging of any kind. Two of its branches discarded a failure in
  silence, and in both the discarded value collided with a legitimate one: `onSearchAll` throwing
  became `ids = null`, which is also how a channel says "nothing is persisted locally, use the
  loaded window"; and `onRequestOlderFromPeers()` throwing became `'unavailable'`, which is one of
  the three answers that call returns on purpose. So a user reporting "search found nothing" left
  nothing anywhere saying whether the query ran, threw, or ran against a truncated corpus. Both now
  log at a level that accuses, naming the conversation and how much was actually searched. The UI is
  unchanged - it has one thing to say either way - and the third `catch` in the file
  (`searchableText`) is deliberately left silent, because `parseEnvelope` throwing is the ordinary
  case for a plain-text message and logging it would be noise on every search.

- **The MLS client no longer accuses a device of losing a state it was never supposed to have.**
  `WasmMlsClient::new` warned `device_key_b64 provided but no encrypted state - key ignored,
  creating fresh state` whenever a device key arrived without a snapshot beside it. That pair means
  a real loss on a device that has booted before, and is simply the shape of a first enrolment on
  one that has not - and from inside the constructor the two are identical. So it fired on every
  fresh client, three times in a single HEAL-REVOKE-5 run, and the cross-client harness carried a
  needle in `FRESH_CLIENT_NARRATION` forgiving the line per row. The discriminator was never
  missing, only unshared: `resolveDeviceId` either finds this device's id or mints one. It is now
  carried down as a required `stateWasExpected` argument - required, so every off-thread client
  (`mlsKeyPackage.worker`, `mlsCrypto.worker`, which takes it across the worker boundary rather
  than inferring it from an absent snapshot) has to state which case it is in. The warning now
  fires only where a state was genuinely expected, the harness needle is gone, and that line
  appearing again is a finding rather than narration.

- **The last sentence a server wrote for a user is now written in that user's language.**
  `APNS_FALLBACK_BODY` was the hard-coded French `'Nouveau message'` on every visible iOS message
  push - what an iPhone shows when the Notification Service Extension does not run or cannot
  decrypt. It could not follow the 2026-08-19 rework that moved composition to the device, because
  in the state it is shown the device has composed nothing. So the language is carried instead:
  `push_token.locale` (migration `020`), written by `POST /mls/push/register` from the app's own
  `getLocale()`, read only by `buildApnsRequest`. A device that never told us reads as the base
  locale, and so does a tag the table does not know - refusing a registration over a language would
  cost that device every notification to spare it one word. **Two predicates had to move with it**:
  the client skipped registration when the FCM token was unchanged, and `changeLocale` reloads the
  document while `sessionStorage` survives a reload, so the one registration that records a language
  change was exactly the one that would have been skipped (the skip key is `<token>|<locale>` now);
  and the inline-ciphertext budget is computed ONCE for devices that may read different languages, so
  it is sized on the longest body in the table, derived rather than typed. An APNs `loc-key` would
  need no column and is a regression today - iOS shows the raw key when it does not resolve, and
  builds between 2026-07-21 and 2026-08-15 have the extension but not the key table. Details on
  [chat-delivery](docs/wiki/services/chat-delivery.md#the-one-sentence-this-server-still-composes-and-the-column-that-tells-it-the-language).

- **The product no longer says "Stripe" anywhere a user can read it, and the payment contract no
  longer depends on Stripe to describe itself.** Stripe is not going to be the only processor
  (`PaymentProvider` already has a Lydia implementation and `GET /api/payments/provider` already
  says which one is live), so the name was removed from every layer where it was not a fact: 61
  Paraglide keys in both locales, five user-visible strings that were never keys at all - an `<h2>`
  reading the raw words `Stripe Connect`, a `title=` attribute and three `'Stripe error'` fallbacks,
  all now localized - the two log tags on the provider-neutral controller, and the contract itself,
  where `PaymentProvider.getConnectAccountStatus` returned a `StripeConnectStatusResponse` imported
  from the Stripe module. That last one is the one that mattered: the shape was already neutral, so
  `LydiaPaymentProvider` was importing Stripe to declare what it returns. The type moved into
  `payment-provider.interface.ts` as `ConnectAccountStatusResponse`, with the frontend mirror
  renamed to match. **What deliberately keeps the name is what Stripe really owns** - the
  per-provider DB columns, the `MANAGE_STRIPE_CONNECT` permission flag, `STRIPE_WEBHOOK_SECRET`, the
  `stripe_return` param an in-flight onboarding still comes back with, and the fee arithmetic, which
  a neutral name would misrepresent. The full map of kept-versus-removed is on
  [payments](docs/wiki/frontend/modules/payments.md#where-a-providers-name-may-appear-and-where-it-may-not).
- **The achats export no longer names a payment processor either.** Its Paiement column wrote
  `Espèces` or `Stripe` - a server-composed sentence in a downloaded file, which is the layer a
  message-catalogue sweep cannot see. It now reads `En ligne`, the app's own label for the same fact
  (`asso_achats_payment_online`), and says HOW the money arrived rather than through whom.

- **A cash grant can no longer be recorded against a Cercle top-up product.** The Achats tab let an
  association manager pick the `balance_topup` product for a manual "paid in cash" sale, next to a
  hint admitting it credited nothing on the Cercle. It could not: the outbound webhook is keyed by
  the Stripe PaymentIntent, a cash sale has none, and `grantProductPurchase` passed
  `dispatchWebhook: false` anyway. So the line read as a recharge, moved no balance, and no retry
  could repair it - there was no key to retry under. **The advantage on the accounting side does not
  outweigh the confusion**, so the type is refused with a 400 in `grantProductPurchase` and filtered
  out of the selector; the selector is a courtesy, the server check is the control. The bar credits a
  member from the Cercle's own till screen, which writes its own ledger line.

- **A conversation tile now says WHICH conversation it is, in the markup.** `ConversationTile` takes
  the MLS groupId and publishes it on the hook it already carried (`data-conversation-tile`), and the
  two call sites - the sidebar and the posts mini-panel - pass it. Nothing about the rendering
  changes and every existing selector still matches, because `[data-conversation-tile]` matches on
  the attribute's presence rather than on a value. **It exists because one question could not be
  asked at all without it**: of the amber rows a freshly enrolled device shows, which are groups
  somebody currently online is actually a member of. The count alone cannot answer that, and the
  answer is what separates a re-admission the app failed to serve from one nobody could have served.

- **A cropped picture is cropped from its MIDDLE again.** The media ceiling shipped hours earlier
  (`--media-max-height`, below) anchored the crop to the top, on the argument that a screenshot or
  an infographic carries its meaning there. Measured against what people actually attach - a
  photograph, whose subject is in the middle - that anchor reads as a bug: a portrait shot loses its
  subject and keeps the ceiling of the room. A post image and a chat image are `object-center`; the
  ceiling itself, the reason for cropping rather than shrinking, and the full frame one tap away in
  the viewer are all unchanged. The three `PdfThumbnail` call sites keep `object-top` deliberately: a
  44px square crop of an A4 page shows its title at the top and one paragraph's midriff at the
  centre, so a document is the one attachment whose top IS its identity.

- **A post could be reported into two stores, and one of them had never once been written to.**
  `POST /api/posts/:postId/report` appended to a `reports` JSONB column on `posts`, read back by
  `GET /api/posts/reported`; the other went to `content_reports`, which is what `/admin/moderation`
  reviews and what the auto-hide threshold counts. Settling "which is the truth" looked like an
  architecture question until it was counted: **neither end of the first had a caller** - the client
  wrappers `reportPost` and `getReportedPosts` existed and nothing invoked them - and production
  held **112 posts, 0 with a row in that column, 0 hidden**. The backlog entry describing the two
  even attributed the auto-hide to the dead one. Both routes, both wrappers, the DTO and the column
  are gone; nothing was migrated because nothing was there.

- **`content_reports` had THREE retention policies and they disagreed.** A lazy 7-day purge fired
  from `listAllReports`, so a moderator opening the queue deleted rows as a side effect of reading
  it; a weekly cron said one year and **had therefore never deleted anything**, the lazy one always
  emptying its population first; and an unrelated docblock claimed the rows were kept indefinitely
  for legal obligation. One policy is left - the cron, at **90 days**, keyed on `reviewedAt` rather
  than `createdAt`, because "90 days after a moderator answered" keyed on filing purges an old
  report the day after it is finally handled.

- **A dismissed report could be re-filed, indefinitely, by the same person.** The duplicate check
  was scoped to `status: 'pending'`, so every rejection re-opened the door. A dismissal is an
  answer, not an invitation to ask again: uniqueness is now per person per subject whatever became
  of the first attempt, and the refusal is a `409` carrying `code: 'ALREADY_REPORTED'` - the client
  read `message.includes('already')` until now, which is a distinction carried in prose.

- **Reporting a comment sent `inappropriate` with no question asked, and swallowed every error.**
  The comment path caught silently "to ignore duplicates" and so reported a moderation outage as a
  successful report. It now offers the same four reasons a post does, through one shared dialog and
  one shared reason list, and a real failure is shown.

- **`contentType: 'message'` is removed** - declared in the DTO, the entity and the client type, and
  produced by nobody. It could not have worked: message bodies are MLS ciphertext, so the server had
  nothing to show a moderator and the preview was hard-coded null. Reporting a message would mean
  the client attaching the decrypted excerpt, which is a decision about what a reporter discloses,
  not a missing endpoint.

- **Three different oxlint binaries linted this one repository, and the manifests said two.**
  `apps/*/package.json` asked for `^1.74.0` and `frontend/package.json` for `^1.80.0`, but a caret
  is a range and the lockfile is the pin: chat-delivery, media and social resolved **1.75.0** while
  core-service and the frontend resolved **1.80.0** - all five running the same repo-level
  `.oxlintrc.nest.json` / `.oxlintrc.json`. A lint verdict here depended on which directory you
  stood in. All five are now `oxlint ^1.80.0` and `oxfmt ^0.65.0`, one version each, and the bump
  is measured: **oxfmt 0.59 -> 0.65 reformatted nothing** - 799 frontend files, 303 service files,
  zero diffs.

- **The lint scope missed `frontend/scripts/` entirely.** `bun run lint` linted `src`, so the four
  scripts that build the protobuf bindings, install the hooks and check bundle consistency were
  read by nothing. Probed rather than assumed: a file in `frontend/scripts/` carrying an unused
  variable, a `debugger` and an `eval` drew **0 diagnostics at scope `src` and 3 at scope `.`**.
  Every package in the repo now lints `.`, the scope le-cercle and Portail-etu already used. The
  formatter keeps its explicit globs, and that is not an oversight: **oxfmt at scope `.` inside a
  NestJS service tries to format `README.md` and dies on `Cannot find module 'svelte/compiler'`**,
  because the markdown formatter reaches for the Svelte parser for embedded code blocks. Installing
  svelte in a NestJS service to format its README is not a trade worth making.

- **`.bun-version` says 1.4.0 and `frontend/package.json` said `bun@1.3.14` - twice.** The CD
  workflow calls `.bun-version` "the one place this repo names a bun"; it was the third. A
  `packageManager` field pinned 1.3.14, and an `engines.bun` of `">=1.3.14 <1.4.0"` actively
  EXCLUDED the version every pipeline installs. Nothing read either field - no workflow, no
  Makefile target - so the contradiction had no symptom and no expiry. Both are deleted;
  `.bun-version` is now true.

- **The frontend carried a dead `.husky/` of its own.** `frontend/.husky/pre-commit` loaded nvm,
  ran `npm run format`, `npm run lint` and `npx svelte-check`, and had not executed once since
  `core.hooksPath` was pointed at the repository root: `frontend/scripts/install-husky.js` installs
  into the ROOT `.husky`, which is the hook that actually runs and which speaks bun. Deleted. The
  installer that pointed at it lost its empty `catch` in the same pass - a hook that fails to
  install is a gate that silently stops running, and that branch left no trace at all. It now says
  so on stderr, in both the missing-binary and the failed-install case, without failing an install
  that legitimately has no dev dependencies.

- **`jsdom` was a devDependency nothing loaded.** `vitest.config.ts` sets
  `environment: 'happy-dom'`; the only three mentions of jsdom in the tree are comments in tests
  describing behaviour they no longer run under. Removed rather than bumped to its new major.

- **The oxvelte shim speaks POSIX `sh` now, in every repository.** `scripts/run-oxvelte.sh` and
  `scripts/install-oxvelte.sh` were bash here and `sh` in le-cercle and Portail-etu, where they had
  been corrected for two problems bash hid: a `rust:*-alpine` image ships no bash, and the
  executable bit is metadata a Windows checkout drops. Both are the corrected file now, invoked as
  `sh`, and `bun run lint` no longer needs a bash to run.

- **Dependencies taken to their in-range latest** across the frontend and the four services -
  `happy-dom`, `protobufjs`, `protobufjs-cli`, `firebase-admin`, `pg`, `undici`, `body-parser`,
  `jest`, `ts-jest`, `sharp`, `uuid`, `axios`, `@types/node` (all five packages now on 26.4.0) -
  plus `@tauri-apps/plugin-log` 2.8.0 -> 2.9.0, whose Rust side is `tauri-plugin-log = "2"` and
  needed no move. **NestJS 11 -> 12 is available and deliberately not taken here**: four services,
  ten packages and a framework major is a work package, not a bump ([backlog](docs/wiki/backlog.md)).

- **The four services' lockfiles are at `configVersion: 1` like the frontend's, after a first pass
  recorded that as impossible.** The reasoning was: moving the field needs the file regenerated, and
  bun 1.4.0 regenerating from nothing writes `lockfileVersion: 2`, which Dependabot cannot read and
  which `Guard the bun lockfile version` rejects. Both halves are true; the conclusion was not. An
  in-place install and a 1.4.0 regeneration are two writers, not every writer - and the third was
  already documented in a sibling repository: **`bunx --bun bun@1.3.14 install` regenerates at
  `lockfileVersion: 1` with `configVersion: 1`**, 1.3.14 being the bun Dependabot itself bundles.
  bun 1.4.0 then reads all five files under `--frozen-lockfile` with no changes. What it costs is
  a full re-resolution, so it was measured: the services mostly DEDUPLICATED, one copy surviving
  where two stood - `ajv@8.20.0`, `picomatch@4.0.7`, and in chat-delivery `gaxios@7.1.3`,
  `gcp-metadata@8.1.4`, `google-logging-utils@1.2.0` - with `prettier@3.9.6` leaving core-service
  outright. Lint, format, `nest build` and 157 / 6 / 563 / 271 jest tests under node, all green.

### Fixed

- **Seven control events were one non-silent push away from being shown to the user as
  `evenement de groupe (history_digest)`.** `format_system_event_text` (`proto_fields.rs`) silences
  control frames by NAME and renders everything else with its raw event name, and its list had never
  been reconciled with what the app actually sends: `read_watermark`, `channel_invitation` and the
  six `history_*` sync frames were all missing. Nothing had fired, because control frames are sent
  `silent` and the silent branch returns before the preview is reached - but that is a property of a
  different layer, and the classifier is now complete and pinned by a test that enumerates the
  vocabulary.

- **A conversation flashed read / unread / read for the whole of a history reconciliation.** The
  unread badge is meant to be derived from this user's own read watermark - `countUnreadForUser` -
  and two of the four sites that write it already were. Both add paths were not: they inferred
  "unseen" from "arrived just now", which is the same thing only for live traffic. A replay delivers
  frames that are new to THIS device yet were read long ago on another one, interleaved with the read
  receipts that zero the count, so applying each in arrival order replayed the conversation's entire
  read history in fast-forward.

  The watermark is persisted on the conversation and already loaded before any frame arrives, so
  nothing had to be fetched: the count was ignoring a fact it held. Deriving it makes the answer
  independent of the order frames arrive in, which is the property the blinking violated and the one
  the new tests pin - including that they fail against the old code.

  It also settled a disagreement between the two paths: the batch one had always excluded system
  messages from the count and the single one had not, so a "X joined" notice raised a badge for
  something nobody reads, on one path only.

- **A mention showed the mentioned person's raw id before their name, and kept showing it if the
  name never resolved.** `splitTextWithMentions` passed the user id to `getUserDisplayNameSync` as
  its own fallback, putting back the one value that function is careful never to return - so a cold
  name cache rendered `@3f9a1c2b...` in a chat body, a notification body and a conversation preview
  alike. The parser now returns no id under any circumstance, and the test pins it.

  Most visibly it happened in the COMPOSER, right after picking someone from the @-autocomplete:
  the picked row carries that person's name, `select()` kept only the id, and the editor then
  re-rendered the token through a cache that had never looked them up. The name is seeded at the
  moment it is chosen, so that read is a hit and nothing flashes at all.

  The two mention renderers also stop guessing. `MessageMentionChip` resolves for itself instead of
  freezing whatever the parser guessed on a cold cache - the parser runs once per body and cannot
  re-render when a name arrives - and both it and `PostMentionLink` read `peekUserDisplayName`,
  which answers `null` for "not known yet" rather than offering a word that would be a claim.

- **The encryption-PIN keypad was offered to a client whose credential was already proven dead.**
  `_refreshCredentialProvenDead` in the auth store held the answer at the moment the prompt mounted,
  but nothing exported it, so the decision to show the keypad could not read it: the modal was
  rendered over `/login`, accepted a correct PIN, and closed a second later onto the login gate - a
  secret asked for nothing (measured on W1, 2026-08-28). The latch is now readable through
  `isRefreshCredentialProvenDead()`, and consulted before the prompt rather than discovered by being
  refused. NEVER LEARN BY FAILING WHAT A FACT COULD HAVE TOLD YOU.

  The backlog described "one call site"; there were four. Three go through the gate that already
  asked whether an unlock was allowed - renamed `mayPromptForPin`, because it now answers with two
  independent facts rather than one - and the fourth, the re-prompt after a stored PIN is rejected,
  bypassed it entirely and is guarded directly. The fifth, the keypad shown after a successful
  server-side PIN reset, is deliberately ungated and says so: that POST carried a live access token
  and the local MLS state is already wiped, so declining there would strand the user mid-reset.

- **The login button held its "busy" state until AFTER the check that could take twenty-six
  seconds.** Both `handleLogin` and `handlePasswordLogin` awaited `refreshAppVersionCheck()` first
  and only then set `isLoggingIn = true`. The disabled state and the spinner already existed in
  `LoginForm`; they were simply switched on too late, so for the whole duration of a
  `GET /api/version` - which carries its own retry ladder of 3 x 8 s timeouts plus backoff - the
  button stayed enabled, showed nothing, and did nothing visible. A press looked ignored, and
  pressing again was the only move the screen offered. The flag is now raised before the check and
  lowered on the refusal path, and the preamble both handlers duplicated is one
  `beginLoginAttempt()`. The backlog had blamed a pre-hydration window instead; with
  `export const ssr = false` and no prerender on `/login` that window cannot exist - the button is
  painted by the same JS that wires it.
- **A `try`/`catch` around the OIDC start caught nothing, and could strand the form.**
  `handleLogin` called the async `startOidcLogin(...)` without awaiting it, so a rejection resolved
  outside the `catch` that was written for it: the error was never shown, and `isLoggingIn` stayed
  true with no way back except a reload. Its password-flow twin four lines below had always awaited.
  Both now do, through one `failLoginAttempt()` that logs the cause and returns the form to the
  user - and the message it shows is a Paraglide string wrapping the reason, not a raw technical
  message rendered as if it were a sentence.
- **The version check fell back to cached metadata without a word.** Its `catch` is reached only
  when `/api/version` stayed unreachable through the whole retry ladder, and it then answers with a
  CACHED verdict about minimum version and maintenance as though it had been measured. A fallback is
  a signal, never a path: it now says so at `warn`, with the cause.

- **A log line called a routine, self-healing race "Non-recoverable error", and its own comment two
  lines above said the next cycle retries.** It sits in the `WrongEpoch` / `epoch_mismatch` branch
  of the pending-invitation sweep, where another device committed simultaneously and the missing
  commit arrives through the queue. Every word was wrong about the branch, and a line that
  overstates its severity teaches its reader to discount the tag - which `[PENDING]` cannot afford
  across eighteen lines. It now says what the branch knows: the epoch moved under the Add, the
  invitation is still pending, the next sweep retries. Dropping the raw error text with the name
  also ends a non-determinism in the harness classifier, where this ONE call reached `notable` or
  `unexplained` depending on whether `errStr.slice(0, 100)` cut off the word its generic `epoch`
  rule happened to match; the rule is anchored and exact now, like its fourteen siblings. Both old
  spellings stay pinned in `classify-selftest.mjs` because A1 embeds its frontend and goes on
  emitting the old line until an APK carrying this build is installed.

- **The one fallback in `apiFetch` said that it had been taken and nothing about why.** A token
  fetch that fails for a non-401 reason proceeds unauthenticated on purpose - some routes answer
  without a token and offline startup depends on it - but "a container is restarting mid-deploy",
  which needs nothing, and "refresh is broken", which needs everything, produced the identical
  sentence. The caught error's name and message are now in the line, which is what a fallback owes
  its reader.

- **Every completed payment made social-service answer 500, because the SSR asked it for a form
  whose id was the word `success`.** `serverSeo.ts` picks an enricher by matching the path against
  a regex, and `/^\/forms\/([^/]+)\/?$/` cannot tell a form id from a page: `/forms/success` is
  the post-payment page, and Postgres was handed `success` for a `uuid` column once per payment
  (measured on prod 2026-08-27). Re-measured against the whole route tree rather than the one
  incident, it was **four** pages and not one - `/forms/success`, `/forms/cancel`, `/forms/create`
  and `/associations/new`, the last of which an existing comment had already noticed and shrugged
  off as "the enricher 404s and we fall back". The table now carries SvelteKit's own precedence
  rule, which is that a literal segment beats a parameterised sibling: a path a real page owns is
  never handed to an enricher as an id. The set of those paths is DERIVED from the route tree at
  build time in the new `staticRoutes.ts`, so a new static route joins it by existing and the fix
  cannot rot; it is its own module because `serverSeo.ts` reaches `$env/dynamic/private` and
  therefore cannot be imported by a test, which is why this module had none.

- **A French user met English on two of the three ways a forward can fail.** `forwardMessage`
  handed its one caller a prose `error` string built from inline literals, and the literals were
  not in the same language: `'Conversation introuvable.'` next to `'Nothing to forward.'` and
  `'Conversation not ready.'`, all three rendered verbatim into the same toast. The call site was
  never at fault - it already falls back to a Paraglide message - so the six user-visible strings
  on the notification and forward paths now come from `messages/{fr,en}.json` like everything
  else. The incoming-call title reuses the `call_incoming_label` the call UI already had rather
  than minting a twin, and the blinking-title fallback reuses `SITE.name`, a brand being a proper
  noun and not a translatable string. Nothing types a string as user-visible, so no gate caught
  any of this; what the gate did catch, once the messages namespace was imported, was a local
  `const m = env.media` shadowing it inside the media-forward branch - the shadow is now named
  `media`. Both `catch` branches of that function also swallowed their exception into a toast
  without recording it anywhere, and now log it.

- **Ten push notifications were refused by FCM for size in one run, twice over, because every
  message carried its ciphertext twice.** `MessagingService` sent one `getMessaging().send()` per
  token holding BOTH a `data` map and an `apns` payload that `buildApnsRequest` spreads the same
  fields into - and FCM sizes the MESSAGE, not the half the device will read. Measured on the shape
  that failed: `data` 3 789 B + `apns` 4 005 B = **7 794 B against a 4 096 B limit**, each half
  fitting comfortably on its own. FCM ignores the `apns` block for an Android token and the `data`
  map is redundant for an iOS one, so each token now carries only the half it reads. The platform
  was known at the call site the whole time.
- **The guard that was supposed to prevent it measured the wrong quantity.**
  `Buffer.byteLength(protoB64) <= 3_500` bounded the ciphertext ALONE, under a comment correctly
  stating the 4 KB budget belongs to the payload - nine other entries ride with it, FCM counts key
  names too, `senderId` is 64 hex characters here, and `senderName` / `groupName` are unbounded user
  text nothing upstream caps. `inlineProtoBudget` now builds the payload with an empty proto,
  measures **both** representations and leaves what the tighter one allows (the APNs framing and its
  `aps` block cost ~216 B more than the raw data map, and one payload is built for all of a user's
  devices). A proto that does not fit is not an error - the client fetches it - but it is logged,
  because a budget routinely too small is the fixed fields growing.
- **A size refusal now says what it refused.** FCM's error names no quantity at all, which is why
  ten identical lines said only "too large"; `[PUSH_SIZE]` reports the bytes actually sent, both
  representations and the largest single field. The classification is on the error CODE
  (`messaging/payload-size-limit-exceeded`, or `invalid-argument` narrowed by its message, which is
  what the v1 endpoint returns), never on prose alone.

  **The iOS half is unverified on hardware.** Dropping the redundant `data` map for an iOS token
  follows the APNs payload's own self-contained design and is covered by unit tests, but nothing
  here can prove a real handset still receives the push - that belongs with the lettered device
  checks, as does the Android half.

- **The chat-gateway served `Access-Control-Allow-Origin: *` in production, and the allowlist CD
  had been writing for it since the iOS login incident reached nothing.** `docker-compose.prod.yml`
  set `ALLOW_ORIGIN: "*"` as a **literal** on that service, and a literal there wins over anything
  in `infrastructure/.env` - so `upsert_env_var "ALLOW_ORIGIN" ...` had never once reached the
  container. Measured twice, 2026-08-27 and 2026-08-30: `printenv ALLOW_ORIGIN` answered `*`, and
  `OPTIONS /api/presence` from `https://evil.example` answered `200` with `access-control-allow-origin: *`.
  It stayed a P2 rather than a P1 because that layer sets no `Allow-Credentials`, so nothing
  credentialed could be read back - and it is also why the gateway was never implicated in the iOS
  login failure: it accepted the very origin the four Nest services refused. The service now reads
  `${ALLOW_ORIGIN:?...}`, which **stops the deploy** when the variable is absent instead of picking
  a default, because both available defaults are wrong (a wildcard silently re-opens this; a single
  origin silently cuts every Tauri client off `/api/presence`). The list is enumerated in
  `.env.example`, written by `cd.yml`, and pinned by new tests that drive a real preflight through
  the layer - it carries `https://dev.canari-emse.fr`, a proxied CNAME onto this same tunnel that a
  list built from `FRONTEND_URL` alone would refuse, and `http://127.0.0.1:1420` beside
  `http://localhost:1420` because that is how `tauri.conf.json` spells its `devUrl` and the gateway
  matches exactly where the Nest services accept any loopback.
- **The same variable was feeding three consumers that wanted a single origin, and each held all
  five entries of it as one.** `frontend-ssr`'s `ORIGIN` - adapter-node's public origin - read
  `${ALLOW_ORIGIN:-...}` and was measured on prod holding
  `https://canari-emse.fr,http://localhost:1420,http://tauri.localhost,...`. It now reads
  `FRONTEND_URL`. The nginx `frontend` service's `ORIGIN`, `VITE_GATEWAY_URL` and
  `VITE_DELIVERY_URL` read it too and are **deleted**: that image is `nginx:stable-alpine` serving a
  build with no entrypoint substituting anything, and a `VITE_` variable is baked in at BUILD time
  by the workflows writing `frontend/.env`. Three dead declarations, all wrong, none observable. The
  rule left behind - **a variable read by two consumers with different shapes is one of them being
  wrong** - is in `docs/wiki/durable-rules.md`; the mechanism is on
  [nginx](docs/wiki/infrastructure/nginx.md).

- **An iPad could never get a push token, and three separate reasons kept it from ever saying so.**
  `PUSH_UNAVAILABLE` - the report shipped so that a device with no push token would stop being
  indistinguishable from a device nobody opened - had printed **zero lines for the whole life of the
  chat-delivery container, on either platform**, while prod showed one iPhone on 0.14.14 holding an
  FCM token and a second one on the same build holding none. The route was mapped and the server side
  was fine; the client never called it. Four causes, all in `PushNotificationService.ts`:
  - **The platform came from the user agent.** `/iphone|ipad|ipod/` against a WKWebView that calls
    itself `Macintosh` gives `null`, so `startPushService` returned as "desktop - no FCM" before
    anything was attempted - and that return sits ABOVE the reporting path, so the silence was total.
    This is the same defect the login took on an iPad Air, at a site its fix did not reach; the OS is
    now asked through `detectRuntimeDeviceOs`, which answers with the compile-time target inside a
    Tauri build.
  - **The foreground re-check discarded its outcome.** Once `pushAttempted` had latched - which the
    first launch does - every later call ran one `registerOnce()` and threw the result away, and the
    retry ladder that reports runs once per process. A device could fail for ever without a word. A
    `no-token` there is not a premature verdict: `registerOnce` answers `ok` when the token is merely
    unchanged, so reaching it means the OS still had nothing after the poll.
  - **The report returned in silence when no user id was resolved**, which made a dropped report
    indistinguishable from a report that was never owed - the exact confusion the endpoint exists to
    end. Every swallowed branch logs.
  - **The ladder can take four minutes** (a 30 s token poll, then six retries each with a poll of its
    own) before the first report is attempted, so an app closed inside that window reports nothing.
    The constants are NOT shortened on a hunch - the window is written down where the next reader will
    find it, and shortening it needs a measurement of how long a token really takes on a slow Android.

  Reporting is now guarded by its own once-per-process flag rather than by the accident of which path
  ran, so a device keeps trying on every resume and simply stops repeating itself. Tests: an iPad
  whose user agent says `Macintosh` still registers as `ios`, a later call reports what the first one
  could not, and the missing-user branch is asserted to speak. **The acquisition fix itself is proven
  on hardware** - `push_token` held no `ios` row in the platform's whole life until 2026-08-28
  08:07:54 UTC.

- **Two more places asked the user agent whether it was on iOS, found by sweeping the class instead of
  waiting for the next report.** The iPad login fix had been applied at its own site only, and nobody
  had enumerated the others:
  - **A Stripe payment made on an iPad returned to the web, not to the app.** `isMobileTauri()` chose
    between the `fr.emse.canari://stripe/...` deep link and a web URL by testing
    `/android|iphone|ipad|ipod/` on the user agent, so an iPad - which says `Macintosh` - was handed
    the web return URL and a user who had just paid landed somewhere the app could never catch.
  - **An iPad got the desktop keyboard threshold.** `keyboardOpenThresholdPx()` returned 160 px
    instead of 100 px, so a shrinking visual viewport had to travel further before it counted as a
    keyboard.

  Both now ask `detectRuntimeDeviceOs`. The remaining `navigator.userAgent` reads were checked and
  left alone deliberately: the Firefox test in `CallService` and the Linux test in `useNotifications`
  are not iOS decisions, `mlsPlatform` is the helper itself (its web fallback recognises iPadOS by
  touch points), and `authSessions` / `DeviceManagementPanel` describe a REMOTE session's stored
  string rather than detecting the runtime - a session opened on an iPad is still listed as a Mac
  there, which is a display fault and not this one.

- **Signing in from an iPad was refused by Authentik with "Redirect URI Error", on every build the
  App Store has ever had.** App Review found it on an iPad Air (M3) on 2026-08-30 and rejected the
  submission under guideline 2.1(a); Authentik's own access log carries the single failed request,
  `status 400` on `/application/o/authorize/` with `redirect_uri=tauri://localhost/auth/callback`
  and `user_agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15`. **The iPad
  named itself a Macintosh, and the app believed it.** `isIosTauriRuntime()` tested
  `navigator.userAgent` against `/iphone|ipad|ipod/`, but desktop-class browsing is WKWebView's
  DEFAULT content mode (`preferredContentMode: .recommended`) for any view wider than 375 px, so on
  an iPad that test is false and the app took the WEB side of every iOS decision it makes.
  `oidcRedirectUri()` then returned `${location.origin}/auth/callback` - `tauri://localhost/...` on
  iOS - which is not, and must not be, in the provider's allowlist; and `startOidcLogin()` navigated
  the main WebView to Authentik instead of presenting the `ASWebAuthenticationSession` that carries
  the callback back through the `fr.emse.canari://callback` deep link. The same blindness filed
  every iPad as `deviceOs: macos`, sent it down the browser notification path beside the native one,
  and offered it an APK it cannot install.

  Fixed where the fact lives rather than at the six call sites reading it: `tauri-plugin-os`
  publishes the COMPILE-TIME target OS into the WebView, and `platform()` - synchronous, so it is a
  drop-in - is now what `isAndroidTauriRuntime`, `isIosTauriRuntime` and `detectRuntimeDeviceOs`
  answer from. In a Tauri runtime where the plugin is missing it THROWS instead of quietly reporting
  "not mobile". The web path still has only the user agent to go on, and it is lied to the same way,
  so an iPad browser is separated from the Mac it claims to be by `maxTouchPoints`.

- **A reply typed in the notification shade was refused by the server (`HTTP 403`) whenever the app
  was merely BACKGROUNDED instead of killed - and the shade then showed a "sending" spinner that
  never ended.** The push secret has two homes: `pending_push_secret.txt`, written by the WebView
  the moment `POST /mls/push/register` answers, and the platform Keystore/Keychain, which is where
  the background sender reads it. The only thing that ever moved the file into the Keystore was
  `CanariApplication.processPendingPushSecret`, at `onCreate` and at `MainActivity.onResume` - i.e.
  strictly BEFORE the registration that writes the file - while `retrievePushSecret` preferred the
  Keystore unconditionally. Since `/register` mints a fresh secret on EVERY call and invalidates the
  previous one server-side, the Keystore held a dead secret from the unlock that minted the new one
  until the next resume, and every background send in that window was rejected. **A killed app hid
  it perfectly**: FCM starts a fresh process, `onCreate` migrates the file, and the Keystore is
  valid again - which is why the killed measurement of 2026-08-30 passed at `HTTP 201` while the
  backgrounded one 90 seconds later failed at `HTTP 403` on the same build, the same device and the
  same conversation. The file now WINS whenever it exists, because it is newer by construction. The
  identical inversion in the iOS twin (`CanariRetrievePushSecret`, Keychain-first) is corrected the
  same way and is UNPROVEN on hardware.
- **A quick reply that failed to send left a notification that said "sending" for ever and offered
  no way to retry.** Android consumes the `RemoteInput` the instant the action fires: it swaps the
  action row for an indeterminate spinner and never resolves it on its own. The failure branch
  called the untouched notification "the immediate retry affordance", which it had stopped being -
  it stayed up with a running spinner and no actions at all. It is now RE-POSTED under the same id,
  which ends the spinner, restores `Repondre` and `Marquer comme lu`, and shows the typed text as a
  pending message of the thread. The send is not cancelled - the reply is still in
  `outbox_pending.ndjson` and still adopted at the next login - only the spinner is.
- **A quick reply that failed to send scheduled no retry at all, and waited for the next LOGIN.**
  `OutboxRetryWorker.enqueueIfHealthy` backs the FCM drain's own failure path with a 30s/60s/120s
  backoff and was never called from the notification receiver. It is now.
- **A device its owner had REVOKED kept its message store, because two readers held it open and the
  wipe could only close one.** Measured on prod on 2026-08-30 by the HEAL-REVOKE-9 campaign row,
  which severed a device, revoked it, and then signed back in on it: the wipe logged
  `[RESET] CanariDB_<userId> is still open elsewhere - delete deferred`, then
  `[RESET] 1 store(s) SURVIVED the wipe`, and the store was gone only later, when the tab happened
  to navigate. `indexedDB.deleteDatabase` does not fail on an open connection - it BLOCKS - so a
  destructive security control finished at a moment nobody controls, on a device declared lost or
  stolen.

  The cause is that `getStorage()` is a FACTORY, not a singleton: every reader constructs its own
  `IndexedDbStorage` and opens its own connection, and exactly one of them - the session's - is
  reachable afterwards through the session context. Loading `/posts` was measured holding two, the
  second being `ConversationsMiniPanel`, which states in its own comment that it deliberately never
  closes (it cannot: on Tauri `close()` tears down a pool shared with the live session). The wipe
  meanwhile took a `closeStorage` callback that **no production call site ever passed**, and which
  by construction could only ever have closed the one connection the caller happened to hold.

  Fixed where the connections are CREATED, not where they are deleted: `db/indexeddb.ts` now keeps a
  registry of the connections it has open and exports `closeOpenIndexedDbStores()`, which the wipe
  calls before it deletes anything - the same answer `closeMlsDb` already gives for
  `CanariDBMls_<userId>`, and for the same reason, that no caller can see the others. The dead
  parameter is gone with it. The row now also asserts `noStoreSurvivedTheWipe` on its own, because
  the product's own accusation was buried inside a compound that said only "the wipe did not
  finish".

- **A newly created group could be DESTROYED by a sweep milliseconds after it was created, leaving
  a conversation nobody - not even its creator - could ever open.** Measured on 2026-08-30 by the
  HEAL-REVOKE-7 campaign row, on one clock: `create_group` at 44.572, `add_members_bulk` at 44.830,
  and at 44.863 the connection sweep called `forget_group` on that very id, logging
  `[SYNC] WASM removed (conversation row held with no membership left)`. 31 ms later the creator
  could no longer find its own group and answered every `welcome_request` with `Group not found`
  for twenty minutes, to two different devices; the group is alive on the server with its creator
  `active` and every other device stuck `pending`. Two independent causes, both closed. **The
  sweep read the local group set AFTER awaiting the server list**, so a group born during that
  fetch was compared against a list that could not possibly name it - the local set is now captured
  BEFORE the fetch, which can only ever spare a group. **And group creation registered the local
  MLS group before the membership that makes it visible**, opening the window in the first place -
  the membership is now registered first, in both the group and the direct-conversation paths, so
  "held locally" implies "named by the server" with no interval to get right. Additionally,
  creation no longer reports success when the local MLS state has vanished: the catch that
  tolerates a single device's failed Welcome was also swallowing the group's own disappearance and
  walking on to `[OK] Group created.`, presenting a conversation that could never work.

- **A conversation created while the app was refreshing its group list could be destroyed by its own
  creator, seconds old, leaving every member unable to ever open it.** The discovery sweep purges the
  MLS state of any local group the server did not list, and it read the local set AFTER fetching that
  list - so a group born during the fetch was absent from the snapshot by construction and deleted on
  that basis. The creating device held the only copy of the tree, so nothing was left for anyone to
  join from: the server still counted every member, `getGroupMeta` still answered that the group was
  there, and re-entry was refused with `no_base_published` because the base to join had just been
  erased. The local set is now captured BEFORE the server is asked, which is what the sibling sweep in
  `initializeConnection` has done since WP-GRAINE-1. Capturing early can only spare a group - one that
  really did go away during the fetch is swept on the next pass - so nothing that was correctly purged
  before is kept now. Measured on prod: a group created at 22:31:31.905 and forgotten inside the same
  second, with its row still present and `deletedAt` null.

- **One tab election was logged twenty times on a device coming up with twenty-two conversations.**
  Measured on production 2026-08-29 in HEAL-REVOKE-5's wipe window: a single
  `[OUTBOX] Flush deferred - tab leadership undecided` followed by TWENTY
  `[OUTBOX] Leadership decided as leader after N ms` lines inside one second, each carrying its own
  start offset - 6017 ms down to 3871 ms - so nothing deduplicated them. Boot asks for a flush per
  recovering conversation, per enqueue and per wake-up; every one of them that landed in the
  election gap awaited the decision on its own. The flush already coalesces through
  `flushing`/`rerun`, but only AFTER that gate, so the coalescing could never reach the waiting. No
  message was ever lost and every waiter resumed - **what the twenty lines cost is the reader**, and
  a line its reader learns to skip is the one that hides the next defect. The wait is now shared:
  one election, one promise, one pair of lines.

- **A device revoked while it was RUNNING wiped itself and then sat on a dead `/chat`.** Measured on
  production 2026-08-29 by HEAL-REVOKE-5, on the build that had just fixed the wipe itself: the
  `device_revoked` frame arrived, the wipe ran to completion and left nothing of the account - and
  the client stayed exactly where it was, on `/chat`, with no session, no sidebar and no navigation.
  It was still there fifteen seconds later. **The wipe was right and the handover was wrong.** The
  push handler announced the revocation through `onLoginFailed`, which is the correct seam at the two
  login-path call sites beside it - a person is at the gate, the modal is where the answer belongs -
  and the wrong one here, where the background service binds that callback to the saved-PIN handler.
  So a revocation REOPENED THE PIN PROMPT on a device the previous line had returned to a fresh
  install: no PIN to enter, no device id, no session for it to act on. What finally moved the page
  was the prompt's own attempt drawing a `401` from `/api/auth/refresh`, several seconds later,
  through the session-expired path - the right destination reached by accident, by way of a failure.
  The handler now calls `onSessionExpired`, the seam written for an authentication loss rather than a
  retryable error and the one callback the background service wires unconditionally: it clears the
  auth and goes to `/login`. Nothing is lost, because the message it replaces lived in a modal the
  app abandoned two seconds later anyway.

- **Two real conversations were stuck for good because the recovery ladder could only be entered
  from the read side.** Found on production 2026-08-29 while HEAL-REVOKE-5's fresh reference device
  sat at eleven groups of thirteen for eight minutes: the two it never got were being refused
  `epoch_mismatch` by the server, 191 and 172 times in twenty-four hours, from the one web device
  that held them. That device was a single epoch behind and could not commit; being the only member
  online, it was also the only one that could re-admit anybody, so every peer asking to be re-added
  was stranded behind it and their outboxes stayed frozen - which is what the "vous avez peut-etre
  des messages en attente" nudge had been reporting to them. **The refusal was documented as
  retryable and the retry was never going to work.** It is retryable in the case it was written for,
  two devices committing at once: the loser rolls back, the winner's commit arrives through the
  fan-out, the retry lands. On a quiet conversation the refused commits are the ONLY traffic, so
  nothing arrives, and the premise the retry rests on is one nothing establishes. Both rungs of the
  ladder - `attemptCommitReplay`, then the watchdog's forget + re-Welcome - hung off an incoming
  frame this device could not decrypt, and a device that is behind but hears nothing never reaches
  them. **The fix is the entrance, not a rung.** `runCommitTransaction` now calls
  `catchUpOnRefusedCommit` before throwing the refusal: the EPOCHS decide, not the reason string (a
  refusal reporting no server epoch ahead of ours is not a gap and touches nothing), rung 1 replays
  the missed commits under the same MLS lock the read side holds, and a gap it cannot close is left
  in the epoch-gap registry whose owner - the sync watchdog - already owns rung 2 and the whole
  re-add cadence. No rung, no timer, no escalation and no fallback was added, and the refusal is
  still thrown, because catching up is not succeeding.
  **Both conversations healed within two minutes of the deploy, and by RUNG 2 - which the fix did not
  predict and the run measured.** Rung 1 fetched the one commit each device was missing and OpenMLS
  refused to re-apply it (`same-epoch refusal`), because that commit was the device's OWN: the server
  had accepted it and the local merge never happened, which is the crash-before-merge gap
  `runCommitTransaction` documents. So this shape of fork is always rung 2, never rung 1, and rung 1
  runs first anyway because nothing at the refusal can tell the two apart. Last refusal 18:24:00,
  first accepted commit 18:24:44, the two epochs moved 196 -> 201 and 216 -> 218, and the device
  immediately sent the two Welcomes it had owed for hours.

- **A revoked device kept the user's message database, because the wipe was racing a login it had
  itself started.** Found by HEAL-REVOKE-5 on production 2026-08-29, on the build that had just made
  the survivor visible. `wipeRevokedDevice` opens by tearing the live session down, which sets
  `isLoggedIn` false - and that is one of the three flags `loginImpl` reads to decide nobody owns
  the flow. So the wipe's own first act was the event that let a login start: 3 ms after the
  `device_revoked` frame, one did. It asked the server whether this device was revoked, the question
  could not be answered because the wipe had already cleared the credentials, and `isDeviceRevoked`
  answers `false` when it cannot reach the server - correct for the question it was written for
  (*should I erase myself?*, where a transport failure must never be a verdict) and exactly wrong for
  the one the login was asking (*may I proceed?*). The login proceeded, reopened
  `CanariDB_<userId>` 24 ms before the delete, and `deleteDatabase` does not fail on an open
  connection - it BLOCKS. The store survived on a device its owner had declared lost, and every line
  except one said the wipe had worked. **The fix excludes the wipe's whole DURATION, not a device
  identity**: between clearing `mls_device_id_<userId>` and deleting the stores there is a window in
  which no identity exists to recognise, and a login slipping into it reopens the database just the
  same. A latch is raised before the first step and released in a `finally`, so it is causal rather
  than timed, costs one boolean read on every login, and cannot leave a real user locked out. The
  refusal names itself in the log beside the three flags that were already named.

- **A revoked device kept both of its databases, and every log said the wipe had worked.** Found by
  HEAL-REVOKE-5 on production, 2026-08-29, on a build carrying all three of August's earlier wipe
  fixes: the `device_revoked` frame arrived, the server confirmed it, the reset ran, no step reported
  a failure - and the survey named `CanariDBMls_<userId>` and `CanariDB_<userId>` as survivors.
  `indexedDB.deleteDatabase` does not fail on an open connection, it BLOCKS, and the connection was
  this application's own: `hex.ts` caches its handle on the MLS database in a module-level promise
  that is opened on first use, never released, and REOPENED by `removeMlsState` one step before the
  wipe. So the last thing a revoked device did was guarantee the block.

  `closeMlsDb()` closes it, from inside `wipeDeviceToFactory` rather than through its `closeStorage`
  parameter: that parameter is for the message store, which the session owns and can hand over,
  while a module singleton in a util is something no caller can see - and both production callers
  passed nothing, so a parameter documented as necessary had only ever been supplied by a unit test.
  A delete that ERRORS is also logged now; it used to resolve silently, which made a failed delete
  and a successful one the same event.

- **The HEAL-REVOKE runner reported two product defects it had invented, and both were blind spots
  in the instrument.** `classifyWipe` was handed `report(...).lines`, a field the report object has
  never carried - so it classified an empty array on every call and concluded a revoked device had
  stayed silent, when nothing had read a line of its console. The server logs said the frame had
  been routed to that device's live socket. Separately, the settle predicate was the default
  `rows > 0 && syncing === 0`, which a sidebar holding three of eleven groups satisfies, so the
  returning device was compared against its reference 2.3 s after its sidebar appeared and the row
  reported an eight-group loss that had not happened.

  Fixing the field was not enough: `report()` DRAINS, and the wipe is waited for in a poll, so each
  call ate the window the previous one had filled and the run kept the last four seconds of a
  two-minute wait. The classifier now reads `consoleLines(cx)` - the cumulative archive `report`
  fills as it drains - and returns `linesRead`, plus five fields naming WHERE the `device_revoked`
  chain stopped: frame arrived, check refused, server disagreed, server confirmed, wipe ran. The predicate is anchored to the server's own active-group count for that user, less the
  groups dismissed while still a member. Two expectations, `theWipeWindowWasActuallyRead` and
  `theSettlePredicateKnewWhatToWaitFor`, make a rig that could not measure FAIL instead of guessing:
  a zero meaning "silent" and a zero meaning "unread" must never produce the same row. There is no
  fallback to the weaker predicate, deliberately.


- **The harness recorded a `415` as dirt and nothing in the record could say which request it was.**
  HEAL-NEW-15's gate on `038c7e8d` demoted the row partly on `Failed to load resource: the server
  responded with a status of 415`, and no `badHttp` or `knownBadHttp` entry named it - so the method,
  the path and the caller were all undetermined. A dirt line whose subject cannot be recovered can be
  neither explained nor fixed, and it would have demoted every future run of the row for as long as
  it went unnamed; adding it to an ignore list would have been weakening the test rather than
  explaining a line. **None of this was missing evidence.** `Log.entryAdded` has always carried the
  resource's `url`, and its `networkRequestId` joins the line to the request the classifier already
  held - so the METHOD was there too. Both were dropped at render time, one line below the comment
  saying why `url` was kept. Every console bucket and the timeline now render a network line as
  `<sentence> <- METHOD /path`; classification is untouched, because every rule and every
  `ignoringExpectedLog` needle still matches the sentence alone.

  **The same key was silently forgiving the wrong request.** Chrome writes one sentence for every
  failing resource, and the de-duplication that collapses `Log.entryAdded` against
  `Runtime.consoleAPICalled` keyed on that sentence - so ten different failures became one line
  carrying the FIRST url, and `isBenignUrl` judged all ten on it. A benign avatar `404` arriving
  first forgave a `404` from anywhere else on the page. The url is now part of the identity, and the
  new cases in `classify-selftest.mjs` were validated against the unfixed classifier first.

  **And a `url` is not proof that a line is a request.** A worker's own `console.log` reaches
  `Log.entryAdded` as well, carrying the WORKER FILE as its `url` - so the first cut of the renderer
  dressed four `[RUST::WARN] Past-epoch application frame` lines as `<- ??? /_app/immutable/workers/
  mlsCrypto.worker-*.js`, and the `???` where a method belongs is what gave it away. `entry.source`
  is what separates the two, and both the renderer and the de-duplication key now require
  `source === 'network'`: a worker line renders as itself and keys on its sentence, exactly as
  before. The negative control is the fourth self-test case.

- **A device that had just joined reported 8259 losses, and the one that mattered was inside them.**
  A frame from before this device joined can never be read - joining at epoch N means epoch N-1 is
  gone - and the replay printed a `warn` for each one. On a device enrolling into eleven groups with
  history that was 8259 of 8976 console lines, 92 percent of the journal saying one thing, with a
  `GET /api/users/me/blocks -> 500` three lines inside it that no reader would have found. The three
  decrypt kinds that end "unreadable for good" are now told apart: `past-epoch-application` is
  arithmetic and is carried to the replay's own summary as a COUNT with five fingerprints named,
  while `secret-reuse` and `same-epoch-refusal` - a frame this device SHOULD have read - keep the
  line that accuses, per frame. Measured 0 of 8298 for those two across HEAL-NEW-3 and -11, so the
  line that accuses now fires on an accusation. The reconciliation was already once per replay; the
  file's own comment ("a page can hold forty such frames and they are all one difference") had said
  so since it was written, and only the log disagreed.


- **Blocking a person did nothing at all on the server, and it took opening a conversation down with
  it.** `UsersModule` declared `TypeOrmModule.forFeature([User, UserBlock])`, and the root DataSource
  in `app.module.ts` listed five entities without `UserBlock`. Those two lists read like one
  statement and are not: `forFeature` publishes the repository provider, so injection resolves and
  the service constructs, while the metadata comes from the root array - so the first query threw
  `EntityMetadataNotFoundError: No metadata for "UserBlock" was found`. Nothing upstream could catch
  it. It compiles, the container boots, Nest maps all three `me/blocks` routes, the CD deploy is
  green, and the symptom is a 500 on whoever opens the blocked-people section.

  **What it actually broke is wider than the feature.** Both conversation-creation paths ask
  `isBlockedWith` before minting anything, on purpose, because the authoritative refusal lands only
  after the Welcomes have gone out; and both are written to stop rather than guess, since a failure
  to ask is not an answer. So the 500 made opening a 1-to-1 return silently and dropped every target
  of a group invitation. The design failed CLOSED - no block was ever bypassed, and the two
  authoritative refusals read `user_blocks` with plain SQL and were unaffected - which is why the
  gesture simply did nothing rather than reporting anything. The table itself was fine: migration
  `007_user_blocks.sql` had been applied on prod all along.

  The fix is the one missing registration. What keeps it fixed is `entities-registered.spec.ts`,
  which reads both lists out of the source and asserts every `forFeature` name is registered - the
  defect is a disagreement between two lists and no compiler compares them, so a test pinning
  `UserBlock` alone would pass for ever while the next entity repeated it.

- **Seven of the nine iOS/Android graphical and software asymmetries found by the parity audit are
  closed** (`docs/wiki/frontend/android-ios-parity.md`, written 2026-08-28 with no device in hand).
  iOS now shows its status bar instead of hiding it, matching Android's edge-to-edge-but-visible
  decision, and `UIStatusBarStyle` is a real value (`UIStatusBarStyleDefault`, auto light/dark)
  instead of a dead empty string that only looked handled. The launch screen paints the product's
  own colour (`AppBackground`, light `#FFF9FBFF` / dark `#FF070B12`, matching Android's
  `app_background`) instead of Apple's `systemBackgroundColor`, which was hardcoded to white with
  no dark variant. The WKWebView is made transparent on first activation - there is no iOS peer of
  `onWebViewCreate`, so this is applied lazily like the keyboard media bridge already does -
  closing the second candidate for the reported black bands. The keyboard-media pasteboard poll
  (0.5 s `NSTimer`) is replaced by `UIPasteboardChangedNotification`: a real, edge-triggered event
  a third-party keyboard's pasteboard write already produces, removing both the clock the standing
  architecture directive forbids and the "already-there vs just-committed" bookkeeping a poll
  needed and an event does not. The two 6 s semaphore waits bridging `NSURLSession` into the
  synchronous FFI path now log distinctly when the safety ceiling itself fires (completion handler
  never ran), instead of returning nil indistinguishably from an ordinary empty response. The
  iOS `g_mlsStateLock` (`NSLock`, necessarily process-local) now carries the proof next to the
  declaration that no cross-process peer is needed - the NSE's decrypt path is read-only and the
  App Group mirror write is already atomic (temp file + rename) - so the audit's open question
  ("assertion, not measurement") is answered rather than left standing. Seven French dev-facing
  `NSLog` lines in `canari_push.mm` are now English (the audit's own sample undercounted them:
  three `occupe` lock-contention lines and a second `enregistre` line existed beyond the two named).
  **Two items are NOT fixed on purpose**: the reboot/app-update re-registration gap has no possible
  iOS counterpart (the OS offers no boot-wake hook at all, already correctly documented at both
  `CanariBootReceiver.kt` and the `BGTaskSchedulerPermittedIdentifiers` comment), and the safe-area
  single-contract refactor (item 1.5) and the four notification-channels-vs-one-category difference
  (item 2.5, platform-inherent) are deliberately left to their own items.
- **A PIN prompt no correct PIN could ever answer, and a watchdog that invented the reason.** Found
  on a real client on 2026-08-28. Once a 401 has proven the refresh cookie dead, `refresh()` latches
  that verdict and throws `SessionExpiredError` - deliberately, so a dead cookie is not asked about
  119 times. `loginImpl` routes that to `onSessionExpired`, which is neither `onMlsReady` nor
  `onLoginFailed`, and `handleSessionExpired` began with `if (_sessionExpiredHandled) return;`. That
  flag exists to deduplicate the LOGOUT between the several observers that reach the verdict at once,
  and it was also gating the lines that release whoever is waiting. So on any client whose session had
  already expired once, submitting the PIN reached the handler, returned at the guard, and left the
  modal up with its spinner running; ten seconds later `handlePinSubmit`'s watchdog - a last-resort
  net that clears on `onMlsReady` and `onLoginFailed` only - unblocked it with "Le deverrouillage
  prend plus de temps que prevu. Veuillez reessayer.". The advice can never work: the latch is
  permanent by design and only a fresh credential clears it. The user's own console said
  `refresh latched (cookie already proven dead - not asking again)`; the modal said something else.
  The release is now unconditional and runs FIRST, only the logout stays deduplicated, and the
  repeat path LOGS instead of returning silently. The order is pinned by a source guard, because what
  broke is an order between two statements and every other test stayed green through it.

- **The two-half wipe verdict was correct on the command line and wrong in every runner.** A phone
  keeps its messages in native SQLite, so `footprint.mjs`'s web-only criterion reads 0 on an enrolled
  device and 0 on a wiped one; the fix for that computed the AND of the WebView and the native half -
  inside the module's `import.meta.url` guard. `node footprint.mjs --device A1` was therefore right
  while `healrevoke.mjs`, the runner that records the row, imported `nothingOfTheAccountRemains` and
  asserted the web half alone. A human reading a terminal was served and every future row was not,
  which is the worse half: a row's verdict is believed later, by someone who was not there. The
  verdict is now `deviceResidue(label, cx)`, exported and the runner's only assertion, with the pure
  combiner `residueVerdict` beside `classifyNativePaths` in `native-residue.mjs` so
  `residue-selftest.mjs` pins it with no device - nine cases, including the exact reading that had
  been quoted three times, and an unreadable native half voiding the verdict rather than passing it.
  Found while writing the HEAL-REVOKE row for A1; nothing would have reported it.

- **The test rig read a settings page as a locked client.** The encryption gate was detected three
  times over, in `pin.mjs`, `pingate.mjs` and `state.mjs`, and each copy asked partly whether the
  page CONTAINED "PIN de chiffrement" - which `/settings` does, in its own security section. So a
  client parked there reported `LOCKED` while being perfectly unlocked, `pin.mjs` burnt its 25 s
  deadline on a modal that was not there, and `pingate.settle()` - whose gate branch is read before
  the mounted branch - would have handed `LOCKED` to four runners that produce no verdict at all when
  the gate cannot be passed. A gate is a MODAL, not a phrase: `PinModal` renders through
  `shared/Modal.svelte`, which carries `role="dialog"` and `aria-label={title}`, so it is now named
  exactly. The three copies and `pin.mjs`'s separate "the modal is gone" check are one `GATE_EXPR` in
  `gate-probe.mjs`, and its self-test classifies eleven pages - four of them pages that merely talk
  about the PIN.
- **`login.mjs` could never log a phone in, for two independent reasons.** Its "we are back on the
  app" predicate accepted only `canari-emse.fr`, and a Tauri client serves its embedded frontend
  from `tauri.localhost` - so every landing A1 ever made read as a failure. And the mobile OIDC hop
  runs in a Chrome **Custom Tab**, a different browser on a different devtools endpoint, so a script
  attached to the app's WebView polled an unchanging `/login` while the credential form sat in
  Chrome; worse, Android may kill the Tauri process while that tab is in front, leaving the pre-hop
  connection naming nothing. The wait now ends on either client, one copy of the fill serves both,
  and the landing is read by re-resolving the target.
- **A freshly enrolled device is offered biometrics, and the rig now declines it.** "Connexion
  rapide" covers the app after an enrolment and its own text says the PIN will be erased from the
  device - which would destroy the only credential the harness can present, since nothing here can
  offer a fingerprint. `clearOverlays` answers "Plus tard" before its Escape logic and reports it as
  debris; Escape alone postpones a question rather than answering it.

- **And it kept them a THIRD time, on the half no wipe had ever looked at: the native one.** With
  the crash fixed, the same Pixel 6a was revoked on 2026-08-28 and its WebView came back
  genuinely empty - `canariDatabases: 0`, 261 localStorage keys down to 0. Reading the disk with
  `adb` instead of the log found `mls.bin`, `canari_<userId>.db`, `graine_seeds.json`,
  `channel_keys.json`, `push_context.json`, `pending_push_secret.txt`, `fcm_token.txt`,
  `session-meta.json`, the `keystore_aliases` index and **six cached avatars of real people** all
  still there. Twenty-nine paths.

  **The cause is one line: `clear_app_data` deleted a file only when
  `path.extension() == Some("db")`.** Every one of those files was added to the app data directory
  AFTER that filter was written, and not one of them carries the extension it could see - a wipe
  whose default is SURVIVE is wrong the day the next file lands, and nothing anywhere says so. The
  same filter also never matched `mls_pending.db-wal` or `-shm`, a gap a comment three functions
  away had already recorded as "worth knowing about but not fixing here".

  `wipe_app_data` now deletes every entry in the app data directory **except** a named list of
  what belongs to a framework, so a file added tomorrow is erased by default. `app_webview` and
  `no_backup` are on that list for a reason that is the previous defect: the WebView and
  WorkManager are reading out of them, and deleting a store from under its own engine is what
  killed the process. `files` and `shared_prefs` are shared with Firebase, so those two are
  emptied by prefix - and a first draft that omitted them from the list deleted Firebase's
  installation id and left both prefix lists dead code, which is what the third test caught.

  Failures are now isolated and counted per entry rather than abandoning the sweep at the first
  one, and logged at a level that accuses. Four Rust tests, against a real directory: the old body
  removed 2 of the 14 files the first one creates.

- **`footprint.mjs` answered "nothing of the account remains" about a phone displaying eleven
  conversations.** Its whole criterion was `canariDatabases === 0`, and on a Tauri client the
  message store is native SQLite - so the count reads 0 whether the account is there or not, and
  the predicate could not fail on the one device class it was being used to judge. It now also
  counts `mls_device_id_<userId>` and `canari_device_key_vault`, which nothing but an enrolment
  writes and which an empty app does not rewrite when it is merely looked at. For a Tauri origin
  the verdict is the AND of both halves, the native one from a new `nativeResidue()` that **names**
  what survived: a byte total read 19 MB with the account gone and 31 MB with it present, so a
  difference in it proves nothing in either direction.

- **And it kept them a second time, for a reason the first fix could not reach: the wipe CRASHED the
  app 55 ms in.** With the WebView cleanup made unconditional, a Pixel 6a was revoked from its
  owner's panel on 2026-08-28 and still held its `CanariDB` and 5.9 MB. The logcat named the cause in
  three lines: `[RESET] wiping this device back to a fresh install`, then
  `Tauri plugin: pluginId: biometric, command: authenticate`, then `FATAL EXCEPTION: main` -
  `ClassNotFoundException: androidx.coordinatorlayout.widget.CoordinatorLayout` while inflating
  `app.tauri.biometric`'s `auth_activity.xml`. The process took `SIG: 9`, and every step after the
  biometric one never ran. Three independent defects, all fixed:

  **The class was absent from the APK - zero occurrences of `coordinatorlayout` in all twelve dex
  files - because `build.gradle.kts` excludes `com.google.android.material:material`.** That
  exclusion is right and stays: nothing here uses the library. But excluding a module also drops
  whatever only that module contributed, and `material:1.7.0` was the single path to
  `androidx.coordinatorlayout`. Its own justification - that not one Kotlin file names a class from
  the graph - was true, and blind by construction: the reference is in a LAYOUT, inside a dependency.
  `androidx.coordinatorlayout` is now declared explicitly, so the class is back without the library.
  **Every biometric call on Android was killing the app**, so biometric unlock was broken too, for as
  long as the exclusion has been in.

  **The wipe asked the holder for a fingerprint before it would delete the key.** It called
  `BiometricService.disable()`, whose contract is a prompt that can be cancelled - correct for the
  Settings toggle, backwards for a revocation: the person at the sensor may be whoever took the
  phone, and a veto over one's own lockout is not a feature. `forget()` is that work with no prompt,
  and `disable()` is now `authenticate()` followed by it.

  **And the step named "the biometric key" deleted no key**, because it passed no alias and
  `deleteKeyBytes` is never called without one. The aliases are now rebuilt from the
  `mls_device_id_<userId>` records the device itself keeps, which is why the login page's reset
  button sweeps them too - it has no session to ask.

  The one step that can raise a native activity now runs LAST, after every step that cannot: `step()`
  catches a rejected promise, and a process killed by a failed inflate is not one. Four tests pin it,
  and a fifth refuses the `material` exclusion unless the declaration that repairs it is in the same
  file - nothing in CI compiles the Android app, so that pair is checkable nowhere else.

- **A revoked PHONE kept its conversations, because the wipe's platform branch replaced the step it
  should have added to.** `wipeDeviceToFactory` cleared either the native stores or the WebView's,
  never both: inside Tauri it deleted `mls.bin` and every `.db` in the app data directory and left
  IndexedDB untouched. Measured on a Pixel 6a on 2026-08-28, that WebView held a 5.9 MB
  `CanariDB_<userId>` - a store nothing on that platform should ever have created, since the phone's
  message backend is SQLite. **The database was there because a reader named its backend by hand:**
  the posts mini panel built an `IndexedDbStorage` directly instead of asking `getStorage`, so on a
  phone it read a store nothing writes - answering the posts sidebar from an unrelated database while
  the chat answered from SQLite - and CREATED that database by opening it. Both halves are fixed: the
  WebView cleanup is now unconditional, and the panel asks the runtime which store this device has.
  A guard test refuses any call site outside `db.ts` naming a backend, because naming one does not
  pick a slower path, it picks a different DEVICE - the MLS state persister writes `mls.bin` to the
  filesystem without consulting that choice. The panel's silent `catch` now says what it could not
  read, instead of rendering "no conversations" as if it knew.
- **A revoked device wiped itself and then put its own state back, 1.25 s later.** Measured on
  production to the millisecond: the server recorded the revocation at 08:40:39.773, the client
  received the frame and ran the full factory wipe - every `CanariDB*` database deleted,
  `localStorage.clear()` - and at 08:40:41.02 the **SYNC_WATCHDOG** ticked. It found ten
  conversations still in memory and an empty WASM, so it drove `requestReAdd` for all ten,
  re-marking every group not-ready and **rebuilding the MLS database** through `ensureMls()`, which
  creates a client whenever it finds none. A device asked to return to a fresh install kept ten
  `mls_not_ready_since` keys, its per-user MLS database and 8.2 MB of storage - and printed
  `[RESET] done - nothing of this device remains` while doing it.

  The cause was one seam existing twice. `logoutImpl` had always performed a complete teardown -
  four timers, the outbox, the offline-promotion and peer-return listeners, the history probe
  sender, the conversation map - and the revocation path performed **none** of it: it set its flags
  and erased the disk with everything still running. The code even claimed otherwise ("tear the
  session down first ... so nothing left running can write a key back"), because `resetMls()` nulls
  the client and stops nothing. Extracted as `tearDownLiveSession(ctx, cb, reason)`, called first by
  both exits, so they cannot drift again; `reason` is the only discriminator and both differences
  follow from it - a revoked device does not FLUSH its MLS state on the way out (that write is what
  the wipe exists to remove) and does not deregister a push token the server already deleted.

  `wipeDeviceToFactory` also no longer claims an empty device without looking: it reads the stores
  back and **names** the survivors. A second, delayed audit was deliberately not added - the login
  page's "reset" button is the other caller, and a user who signs back in writes keys within
  seconds, so a late check would accuse an ordinary new session of being a zombie.

- **A full account got a client that reported a deferral forever and never healed.** The per-user
  device cap (15 within the 90-day retention window) is refused with a `400` that no retry can
  lift - the account has to lose a device first - and it fired *before* the
  `[REGISTER_DEVICE] START` line, so it left **no server trace at all**. The client logged every
  KeyPackage failure identically, as `welcome_request deferred to next connection`, which is true of
  a 502 and false of this. A device in that state holds a session, has no KeyPackage, is answered
  `[MEMBERSHIP_ACTIVE] REFUSED reason=no_key_package` in every group, and cannot recover. Measured
  on production 2026-08-28, where it cost a whole test rung a night and was written up as a product
  defect that did not exist.

  The distinction is now carried as a TYPE from the seam that reads the status, never as prose: the
  server answers `DEVICE_LIMIT_REACHED` with its `max` and logs the count it read
  (`spent=15/15`), `registerDeviceKeyPackage` throws `DeviceLimitReachedError`, and the call site
  logs an accusation and tells the **user** - the only actor who can lift it - which device list to
  open.

- **A paid form's submit bar sat visibly to the right of the form content, then, once that was
  fixed, disappeared entirely mid-scroll on a real phone.** First measured on desktop/tablet:
  `.page-scroll-wrap` (the scrollable ancestor every routed page renders inside) has
  `will-change: transform` for the swipe-nav-between-tabs feature, which per spec makes it the
  **containing block** for `position: fixed` descendants - its own box already starts after the
  sidebar, since it fills `<main>` inside the `md:pl-[4.5rem]`-padded column (`+layout.svelte`).
  The bar's own `md:left-[4.5rem]` then applied that same sidebar offset a second time, on a
  containing block already shifted once - a deterministic double-offset, not a scrollbar or
  browser quirk. Removing the redundant class fixed the alignment, but on-device testing then
  found the SAME `will-change: transform` ancestor has a second, worse consequence for a `fixed`
  descendant on real mobile browsers: it can lose its own compositing layer mid-scroll and vanish
  entirely until the next reflow - measured live, it scrolled away and never came back on its own.

  **The fix was architectural, not a patch: the bar is `position: sticky`, never `fixed`, and only
  once the submitter has actually earned it.** `sticky` is not redirected by a transformed
  ancestor the way `fixed` is, so it does not carry that disappearing failure mode - and unlike
  `fixed`, it never leaves the document flow, so the browser reserves its own space for free; nothing
  needs to manually measure or reserve height for it. By default the bar just sits inline at the
  end of the form (no floating panel over content still being filled in); a one-way latch
  (`reachedEnd`) flips permanently true once an end-of-content sentinel - placed AFTER the bar, so
  scrolling must clear the WHOLE bar plus `BottomNav`'s own real measured height, not merely
  brush its edge - has been seen with every required question already answered. From that point
  the bar stays pinned to the bottom of the screen for good, including once scrolled back down to
  its own natural position, where `sticky`'s native behavior settles it back in place with zero
  extra code. The card's own look never changes between the two states, so detaching from the
  flow reads as the same bar continuing to float, never a swap to a different-looking element.

  **A third, unrelated bug surfaced from the same on-device session: a mobile BROWSER tab opened a
  dead gap above its own on-screen navigation buttons.** `BottomNav` and fifteen other call sites
  padded themselves with `env(safe-area-inset-bottom)` to clear the phone's OS-level gesture/button
  area - correct in the native Tauri WebView, which draws edge-to-edge behind that area, but a
  plain browser tab already excludes it from its own viewport, and `env()` still answered non-zero
  there on at least one device - double-reserving space nothing was drawn behind. Centralized into
  one `--safe-area-inset-bottom` CSS variable (`app.css`), decided once in `app.html`'s inline
  script before first paint (same pattern already used there to avoid a theme flash): defaults to
  `env(safe-area-inset-bottom, 0px)` for Tauri, overridden to `0px` when `window.__TAURI_INTERNALS__`
  is absent. Every consumer now reads `var(--safe-area-inset-bottom, 0px)` instead of calling
  `env()` itself, so the platform distinction is made in exactly one place.

  **Getting `reachedEnd` itself right took three more rounds, each one an on-device finding, not a
  guess.** A `showIf`-conditional question can appear the exact instant the answer that satisfies
  it also completes every required field, and the first two designs (tracking `visibleItems`'
  count through an `IntersectionObserver`-backed `$state` flag, then requiring that flag to be
  observed leaving the viewport before counting again) each traded one failure for another: the
  first could still re-latch one animation frame later if the new content happened to fit inside
  existing scroll slack, and the second could stall forever if it never did, permanently blocking
  a short form's only completion path. The mechanism that actually holds: a `scroll` listener
  reads live DOM geometry directly - `sentinelReached()`, never cached - and answering a question
  is a click, never a `scroll` event, so it cannot run the check by itself regardless of what that
  answer causes to appear; a reactive fallback, gated on the visible item count matching its value
  as of the last real scroll, covers a form short enough to need only one scroll to see everything,
  where the last required answer can land as a click while already parked at the bottom.

  **Even that geometry comparison had one more bug, caught only by inspecting the real WebView live
  over the Chrome DevTools Protocol:** at the actual maximum scroll position on a real device, the
  sentinel's measured `top` sat 0.05px past the computed threshold - `.page-scroll-wrap`'s own
  reserved end-of-content padding (a CSS `calc()`) and `BottomNav`'s measured `clientHeight` name
  the same `4rem + safe-area`, but two independently computed values are never guaranteed to land
  bit-for-bit identical after browser sub-pixel rounding. An exact comparison could never be
  satisfied at all, even scrolled as far as the page physically allows - a few pixels of tolerance
  fixed it, confirmed live by scripting the same WebView to select an answer, scroll to the bottom,
  and back, and reading the bar's own class list before and after.

  **One unrelated bug surfaced along the way and was fixed on sight:** `+layout.ts`'s redirect to
  `/login` read `event.url.hash` inside a `load` function, which SvelteKit refuses outright (hash
  changes never re-run `load`, so it will not let one depend on it) - throwing before `goto()` was
  even called, on every redirect, for every signed-out visit. `window.location.hash` reads the same
  value without that restriction and is safe in this already browser-only branch.
- **An iPhone could never obtain a push token, and nothing anywhere reported it.** Measured on
  production: `SELECT platform, count(*) FROM push_token GROUP BY platform` answered `android | 49`
  and nothing else - not one row had ever carried `platform = 'ios'`, and `voipToken` was null on all
  49, so no PushKit token existed either. No message alert, no mention and no CallKit ring had ever
  been deliverable to an iPhone, and had not been since the platform shipped. The question was only
  asked because the CORS defect below had put an iPhone in front of a log for the first time.

  **The cause was an ORDER inherited from the platform that has no such constraint.** `canari_push.mm`
  fetched the FCM token at the bottom of `canari_ios_bootstrap()`, written as the declared mirror of
  Android's `FirebaseMessaging.getInstance().token` - which at launch has no precondition. On iOS it
  has one: FIRMessaging cannot mint a token before an APNs token exists, and that arrives only after
  `registerForRemoteNotifications`, which the same bootstrap schedules for `DidFinishLaunching`, i.e.
  strictly later. That call could only ever fail. `CanariSyncFcmTokenIfApnsReady()` now checks
  `APNSToken` and is called from `CanariOnDidBecomeActive`, which fires after launch completes and on
  every foreground; nothing is on a timer.

  **The defect underneath was the silence, and it is the half that cost a platform's whole life.** A
  client that could not get a token warned to a WebView console nobody can open on iOS from a Windows
  machine, the server was never told, and **the absence of a row is indistinguishable from a device
  nobody opened** - so 49 healthy Android rows stood in for both platforms. `PushNotificationService`
  now returns a typed outcome instead of a boolean and, when its retry ladder is exhausted, POSTs
  `/api/mls/push/unavailable`; the server stores nothing (`push_token` already owns that state) and
  logs `[PUSH_UNAVAILABLE] user=… device=… platform=… reason=…`, so one `GROUP BY` answers next time.
  The reason is the client's classification and the server never rewrites it. Reported ONCE, at the
  end of the ladder, because an early failure the next attempt fixes would accuse a device that goes
  on to work.

  **Measured on hardware the same night.** A fresh 0.14.8 install on an iPhone produced
  `[PUSH_UNAVAILABLE] ... platform=ios reason=no-token` - the report works, and it is the first thing
  the platform has ever said about its push chain. The token itself was still not obtained, so the
  ordering was necessary and not sufficient.

  **THE REST OF THE CAUSE, found by reading the order rather than shipping another build.** An FCM
  token needs `FIRMessaging.APNSToken`, and the only thing that sets it is
  `application:didRegisterForRemoteNotificationsWithDeviceToken:` - a method on the
  `UIApplicationDelegate`, **which this app does not own**: wry installs one inside `ffi::start_app()`
  and `main.mm` deliberately declares none. Firebase's answer to exactly that is its App Delegate
  Proxy, enabled explicitly in `Info.plist` and named in `main.mm` as the bridge. It installs itself
  ONCE, reading `sharedApplication.delegate` when Firebase is configured - and `[FIRApp configure]`
  runs from `main()` **before** `start_app()`, when there is no application object at all. It found
  nil, gave up, and never looked again. So every launch since the platform shipped: the OS produced an
  APNs token, handed it to a delegate with no such method, and it was dropped; `APNSToken` stayed nil;
  FCM refused on its precondition. **The evidence was already in the file** - the neighbouring code
  swizzles wry's delegate by hand for remote notifications and calls `appDidReceiveMessage:` by hand,
  both jobs the proxy does when it is installed. The absence had been recorded for months without
  being read as a statement about the token. `CanariInstallApnsTokenHook` now puts the two APNs
  callbacks on wry's delegate class on `DidFinishLaunching` - the first moment that delegate exists -
  sets `APNSToken` itself and asks FCM on the spot; `class_replaceMethod` adds the method today and
  would chain to a real one tomorrow.

  **And the report now names the cause instead of the symptom.** `no-token` covered faults whose fixes
  are opposite, so the native layer writes the branch it actually took to `push_diagnostic.txt`,
  `get_push_diagnostic` reads it and the client sends it verbatim: `no-apns-token`,
  `fcm-token-fetch-failed`, `apns-registration-refused` (the OS refusing registration outright, which
  had no observer at all) or `app-delegate-absent`. The file is deleted the moment a token arrives, so
  a reason cannot outlive its cause. **The hardware proof is owed**: everything native here is verified
  by compiling, which proves nothing about running.

- **A placeholder identity was stored as an active member of a real conversation, and the peer lost
  both directions of it for 134 minutes.** `BaseMlsService` holds `userId = 'unknown'` and
  `deviceId = 'pending'` until a session resolves them, and `updateInvitationStatus` - the only
  client call that can create an `active` membership row from nothing - was reached with the raw
  fields by a Welcome processed before that happened. The server stored the pair, 0.84 s before the
  conversation's two real members joined, and it then held the peer's place: their own two devices
  sat `pending`, `No active membership` was logged twenty-one times, no commit was ever made for the
  group, and nothing self-corrected - what ended it was the user reinstalling the app by hand, which
  minted a new device id and took the group's only commit.

  The existing ghost gate could not catch it. It asks whether a device is addressable - not
  denylisted, and holding a KeyPackage - and the placeholder had registered one under the same pair.
  Both literals also pass the query-value regex perfectly: **a shape allowlist is not an identity
  allowlist.**

  Guarded at both ends, deliberately, because a client of any version reaches that endpoint. The
  client names the two sentinels as constants, reads its three existing comparisons from them, and
  throws a typed `UnresolvedIdentityError` rather than publishing one - every call site is
  fire-and-forget and re-driven, so a refusal costs one cycle where a stored placeholder costs a
  conversation. The server refuses the same two values on the paths that WRITE an identity,
  `REGISTER_DEVICE` and `invitations/status`; `kick-stale-device` keeps the generic sanitizer on
  purpose, since it only demotes an existing row and demoting a placeholder is how one gets cleaned
  up.

  Ten stranded memberships were found on production while measuring this, the oldest carrying a
  Welcome from 2026-08-03. Nine are `web-`, on Chrome: this is not a mobile defect.

- **The iOS keyboard opened a large empty zone under the interface, and pushed the composer out of
  reach.** WKWebView is never resized for the keyboard: it keeps its full height while only the visual
  viewport shrinks. The web layer saw that and pinned the app shell to the visible height - correctly,
  for what it could see - but the document was still full height, so a keyboard-tall empty band opened
  below the shell, and WebKit, auto-scrolling to reveal the focused field, scrolled the page onto it.
  One cause wearing two faces, exactly as on Android.

  Fixed the way Android already had been: by moving the LAYOUT viewport, never with a margin.
  `CanariApplyKeyboardLayout`, on `UIKeyboardWillChangeFrame`, shrinks the WebView's frame by the
  keyboard's overlap with its superview, so `window.innerHeight` itself moves and shell and document
  agree again. **No web change was needed** - `computeSnapshot` already stood its `layoutInsetBottom`
  down for a natively-resized window; that branch had been written for a native resize iOS never
  performed. It also settles the safe area for free, which on Android took a second mechanism: a
  WebView whose bottom edge no longer reaches the home indicator is given `safeAreaInsets.bottom == 0`
  by UIKit, so `env(safe-area-inset-bottom)` stops reserving a strip that is behind the keyboard.
  Stateless by construction - the target is recomputed from the superview's bounds every time, so
  there is no remembered frame to restore, and one notification serves both directions because the
  end frame on the way out is off-screen and the overlap is zero.

- **A refresh refusal named no client version**, so every `Refresh refused for the NATIVE app` line
  from an iPhone was ambiguous until the user stated by hand which build the device ran.
  `POST /auth/refresh` now takes `?clientVersion=` (the precedent `announcement.controller.ts` set,
  and a query parameter rather than a header so no CORS allowance changes on four services) and the
  log prints `client=0.14.7` or `client=unstated`. The same line's header field had one label for two
  different states and now has three: `absent`, `empty`, and `ignored` - a header that was present
  and valid but not consulted, because the origin uses the cookie transport.

- **A dependency bump killed three release builds, and nothing before the release could have seen
  it.** Android Release and AppImage Release for v0.14.6 both died about thirty seconds in, on the
  Tauri CLI's own preflight: `tauri-plugin-log (v2.8.0) : @tauri-apps/plugin-log (v2.9.0)`. A Tauri
  plugin is two artefacts that must agree on major.minor - a JS package in `package.json` calling
  commands a Rust crate in `src-tauri/Cargo.lock` registers - and `bun install` re-resolves the JS
  half while touching no Cargo lockfile, so the two drift by default. The second sweep of the
  ecosystem convergence (`ba6e4bf7`) carried the JS side to 2.9.0 and left the crate at 2.8.0.

  **The refusal is correct; where it happens is the defect.** `bun run check`, `lint`, `format` and
  the whole CI pipeline read the JS side only - nothing in this repository compiles the Tauri app -
  so the first thing that ever runs `tauri build` is a release workflow. The skew therefore lands
  minutes after a tag rather than on the pull request that introduced it, and **iOS Release passed
  the whole way**, because its path never runs that check: one bump, three platforms, two failures
  and no uniformity to notice. `Cargo.lock` is now at 2.9.0 (`cargo check` clean), and the cheap
  half of that build moved into CI as `frontend/scripts/check-tauri-plugin-versions.mjs`, wired into
  `code-analysis.yml`: it compares every `@tauri-apps/*` package against its crate in two committed
  files, needs no toolchain and no network, takes seconds, and fails with the CLI's own message. It
  was verified to FAIL on the exact defect that shipped before being trusted to pass.

- **A refused refresh could not say WHICH build was refused, so its two causes read alike.** The
  warning added earlier that day names the cookie jar, the origin and the user agent, and after the
  header transport shipped that stopped being enough: a client too old to carry its own credential
  and a client whose store write FAILED both arrive with no cookie and no header, because a
  body-transport client with an empty store correctly sends none. One is expected and owes nothing,
  the other is a defect, and the line read identically for both. The refresh request now states its
  own version the way `users/me/announcement` already does - a query parameter, since nothing in a
  request carries it, and a query parameter needs no CORS allowance on four services where a second
  custom header would - and the refusal logs it as `client=`, or `client=unstated` for a build older
  than the parameter, which is the same answer stated rather than missing. Confirmed against prod
  the same evening: every iOS device was on 0.14.5, one build before the transport existed, so every
  one of those lines was expected. The header's own state is reported in three values rather than
  two: `absent`, `empty`, and `ignored` for an origin whose policy is to keep its cookie - the first
  version of the field called that last case `empty` and accused a perfectly healthy request, which
  a test now pins.

- **Signing in on iOS was impossible, and the reason was a server's CORS allowlist.** On an iPhone the
  login ran the whole way - Authentik accepted the credentials, the deep link brought the app back, the
  authorization code and the CSRF state both arrived - and then the token exchange died with
  "Echec de la connexion / Load failed". The four NestJS services each spelt their allowed origins
  inline, and each named `http://tauri.localhost`: the ANDROID WebView origin. iOS sends
  `tauri://localhost`, which matched nothing. (The Rust chat-gateway named no Tauri origin either,
  but it was never the blocker: `docker-compose.prod.yml` hands it a literal `ALLOW_ORIGIN: "*"`,
  which wins over the value CD writes to `.env`, so it accepts every origin. Measured on prod, and
  now a P2 of its own.) Two things then hid the cause. A `cors.origin` callback answering `false` omits
  the headers but does not answer the `OPTIONS`, so the preflight fell through to a router with no
  handler and prod logged `"OPTIONS /api/auth/oidc/callback" 404` - a 404 on a path that exists,
  attributed to no origin. And WebKit reports every such refusal to JavaScript as a bare
  `TypeError: Load failed`, which is why it was reported as a broken deep link. The list, the predicate
  and the delegate now live in one tested `cors-origins.ts` per service, naming all three platform
  origins with the platform written beside each; a refusal logs the origin it refused, once per
  distinct value. A denial stays `callback(null, false)` and never an `Error`, which would turn a
  refused preflight into a 500 on the request - an incident this repo has already had.

- **An iOS session now survives a restart, because the credential stopped being a cookie there.** The
  CORS fix above let iOS log IN; it could not make iOS stay logged in. The refresh cookie is
  first-party on the web and third-party in every native shell - the document is `tauri://localhost`,
  the cookie is `canari-emse.fr` - and the two platforms answer that differently, measured on the same
  server in the same minute: an iPhone presented `cookies=[]` on 120 consecutive refreshes, while A1
  came back from `am force-stop` with a single `refresh 200` in 218 ms and auto-unlocked. Android
  blocks third-party cookies by default and opts back in with one line
  (`setAcceptThirdPartyCookies`); WKWebView blocks them too and publishes no equivalent API, so there
  was nothing to add.

  On `tauri://localhost` the credential is therefore carried explicitly: sent in `X-Canari-Refresh`,
  returned in the response body, kept between launches in a store file whose `save()` is AWAITED -
  because rotation makes durability part of the protocol, and a debounced write hands the next cold
  start a spent token that reads as a replay 60 s later and deletes the session row. Both sides pick
  the transport from ONE fact and never by being refused: the request's `Origin` on the server, the
  document's scheme on the client. `http(s)://tauri.localhost` is deliberately excluded - Android's
  cookie works, its durability is proven on hardware, and moving it would unprove that.

  The cookie is still set for every client, and still read when no header arrives, because
  `tauri://localhost` is also macOS and the Linux AppImage and nobody has measured whether their
  engines keep it - dropping it would log those installs out on a deploy. That read is a shim over an
  unknown population, registered with its removal condition in `docs/wiki/legacy-compatibility.md`.
  The trade is stated rather than buried: on those platforms the credential is readable by the app's
  own JavaScript instead of being `httpOnly`, which is the trade Android already makes in substance;
  moving both platforms into the platform keychain is filed as an improvement.

- **A dead session was re-proven 120 times instead of once.** `refresh()` had a single-flight guard
  for callers that overlap in TIME and a notify-once guard for the ANNOUNCEMENT, but nothing recorded
  the fact itself - so every caller arriving after the previous request settled sent the same dead
  cookie for the same answer. Measured on prod 2026-08-27: 120 `POST /api/auth/refresh` from one
  iPhone in 45 minutes, in bursts of eleven inside a single second, all 401. A 401 there is a proof
  about a credential, not a transient failure, so it is now latched and answered from the known fact
  with no request at all; only a new credential (a successful rotation, the OIDC callback, or
  `setToken`) lifts it. The latch is in memory, so a cold start still begins with the one refresh the
  rest of the module uses as its connectivity probe.

- **A refresh with no cookie said nothing at all.** `POST /api/auth/refresh` cleared the cookie and
  threw a 401 without logging, and that 401 has two causes it cannot distinguish: a person who really
  is signed out, and a WebView jar that refused to STORE a third-party `Set-Cookie` - which is what
  the refresh cookie is in a native build, the document being `tauri://localhost` and the cookie
  `canari-emse.fr`. Android opts back in explicitly (`setAcceptThirdPartyCookies`); WKWebView blocks it
  too and exposes no equivalent API, so iOS is the platform where that branch is expected to lie about
  why. The branch now prints the cookie names it did receive, the origin and the user agent, at `warn`
  when the origin is one of the native shells and `debug` otherwise, because every anonymous first page
  load legitimately reaches it once.

- **The test rig's device-purge tool could have deleted the phone.** `purge-devices.mjs` took a
  `--keep` DENYLIST - a substring of the row text that had to survive - and it identified a row by
  walking up to `/Appareil\s*\d/`, a string the product has never rendered. Every row therefore read
  as the empty string, `--keep` matched nothing, and the tool fell through to clicking the first
  deletable button in DOM order. Nothing in it made that button the right one: one reorder and it
  removed A1, the single armed Android device, at the cost of a re-enrolment plus the campaign's one
  irreducibly manual step. It was found by being unable to RUN - its settled-panel wait tested
  `/APPAREIL(S) CONNECT/i` against a panel rendering `appareil(s) enregistre(s)`, so it timed out on a
  panel that had been loaded the whole time - and it was never run against production.

  It now takes `--only <deviceId>[,...]`, an allowlist, and deletes nothing that was not named;
  entries shorter than eight characters are refused, so `web-` cannot sweep a family. `--expect N`
  refuses outright when the panel no longer holds the number of deletable rows the caller decided
  against. **Row identity is the FULL device id read from the row's `div[title]`** - the same key
  `DELETE /api/mls/devices/:userId/:deviceId` deletes by - not the rendered short id, which is
  `deviceId.slice(0, 8)` and identical across every web device of one account. And a panel that
  FAILED to load is now a third outcome: `chat_devices_load_error` satisfied no branch of the wait, so
  a fleet that could not be read spent 45 s and reported a timeout; it is now classified and refused,
  because a question that could not be asked is not the answer "no".

- **A member with no photo exported as the word "img".** On the Carte de la Vie Asso PDF - and on the
  trombinoscope, which the report guessed correctly - the grey box beside a member's initials was the
  rasteriser's own doing: snapdom substitutes every `<img>` it cannot inline with a placeholder
  `<div>` whose text is the literal string `img`, and it does so for a `display:none` image too. The
  substitute keeps none of the original's inline style, so the `position:absolute` overlay came back
  as an in-flow sibling, shouldering the initials off centre. The screen was always right; only the
  export was wrong. Both call sites now **remove** the element on `error` instead of hiding it - a
  node that is gone cannot be substituted - and `rasterizeElementToCanvas` passes
  `placeholders: false`, so a cross-origin favicon or a dead logo URL in any of the three exports
  becomes an invisible spacer rather than printed prose. What that swallows is named once per export
  (`pdfRaster:missingImages`), and only for an image still in the tree: a member with no photo is a
  known absence, not a missing asset.

- **The trombinoscope's initials fallback could not fire at all.** Found while fixing the above, and
  never seen because the placeholder box hid it: the shared rasteriser waited for images by assigning
  `img.onload` / `img.onerror`, and that property has one slot. The trombinoscope builds its cards
  microseconds before exporting, so its avatars are always still loading when the wait begins - the
  assignment therefore deleted the inline handler that reveals the initials, and a member with no
  photo got a blank disc. The wait uses `addEventListener(..., { once: true })` now, so a call site's
  own handler survives it.

- **Every photo and every logo on the Carte de la Vie Asso was missing on mobile, and nothing said
  so.** Both `<img>` sources on the poster are app-relative - `/api/users/:id/avatar` for the bureau
  photos, and the association `logoUrl`, stored as `/api/media/public/:id`. In a Tauri build the page
  is served from `tauri://localhost` (iOS) or `http://tauri.localhost` (Android), so those paths
  resolve against the shell and the asset server answers them with `index.html`. The image fails to
  decode, `onerror` fires, and the initials placeholder that exists for absent users shows through:
  no exception, no console line, no request that looks wrong in any log. Both now go through a new
  `apiAssetUrl()`, which prefixes `coreUrl()` and leaves anything already carrying a scheme
  (`data:`, `blob:`, absolute) untouched.

  **The guard that should have caught it existed and matched one spelling.**
  `apiUrl.absolute.test.ts` has scanned for `fetch('/api/…')` since 2026-08-11 - the same defect,
  where it fails loudly enough to be noticed - and never looked at `src=`. Extended, it found **two
  more live call sites** beyond the poster: the trombinoscope PDF export (logo + every member photo)
  and the community-invite preview image on `/c/join/[token]`. All three are fixed. `Avatar.svelte`
  also lost its private copy of `coreUrl()` while its neighbourhood was open.

- **Nobody could edit a post published in an association's name - not its author, not the
  association's officers, not the BDE - and the app said nothing, because the missing thing was a
  button.** Reported from production: an association officer holding that association's posting
  rights - and a BDE bureau member besides - had no pencil on an announcement they had written
  themselves; granting them platform administrator made it appear, which is what pointed at rights
  and away from the actual cause. There was no permission failure at all. Every association post is
  served with its `authorId` DELETED - the association is the byline, and that anonymity is
  deliberate - while the card decided the control with `authorId === currentUserId`, a comparison
  against a field that is never there on exactly those posts. So the answer was `false` for every
  reader of every association post since the feature shipped, and it failed in the one way nothing
  reports: no request was made, so no refusal was logged. The server now answers the question
  itself. Every post carries `canManage`, resolved per reader and per request (`viewerContext` +
  `mayActOnAny`, one membership query for a whole page), and the `PATCH`/`DELETE` guards use the
  same predicate, so a shown control and an accepted write cannot disagree. `GET /api/posts/search`
  carries the viewer for the same reason the feed does. **A post published in an association's name
  now answers to `POST_AS_ASSO` alone**: any officer holding it may correct what the association
  said, an officer who lost it may not, and authorship grants nothing extra - publishing already
  required that flag, so this takes nothing from anyone. A BDE super-admin stays excluded from that
  flag, unchanged: administering an association is not speaking for it.

- **A group deleted with the radios off came back, and the mechanism built to stop that had been
  measuring an empty store for three days.** An exit is owed to the server and written down before
  it is attempted - one durable row per group, cleared only by an ANSWER, replayed by the reconnect.
  `exitGroupAndCleanup` classifies what the server call throws: a status is an answer, a transport
  failure is not. But it does not make the call itself, and step 2 of both helpers it delegates to -
  `deleteGroupAndBroadcast`, `leaveGroupAndBroadcast` - caught the failure first, one logging and
  moving on, the other with a bare `catch`. So nothing ever reached the classifier, the happy path
  cleared the row three lines after it was written, and every property of the mechanism held over a
  store that was empty by the time anything read it. DEL-10 on prod: one DELETE left the device,
  none was answered, both reconnects announced themselves and replayed nothing, and the group was
  still live in `dm_groups`. The one line that did fire was invisible for its own reason - it
  carries `Failed to fetch`, forgiven as the noise of the cut the check performs on purpose. Both
  helpers now hold the failure, finish every local step - the purge must never depend on the
  network - and rethrow it last, where the only caller that can see the durable row decides what it
  means.

- **Two devices could both be told they had won the first-publish race, so one of them sealed a
  salon's only key into a tree nobody else holds.** A Graine distribution group's id is assigned by
  the server, but its MLS tree is built by whichever device finds the scope uninitialised first -
  and two devices of the same user routinely find it uninitialised together, because creating a
  private salon fires a `channel.member.joined` event that makes EVERY one of that user's devices
  load the workspace and walk its private channels. Both create a tree under the same id and both
  publish a base at epoch 0. `putGroupInfo` settled that with an `ON CONFLICT DO NOTHING` election
  and reported the loser honestly - but only when the two INSERTs actually collided. Serialized, and
  a second apart is serialized, the later publisher found a row, and the update guard's `<=` let
  epoch 0 REPLACE epoch 0 and answered `stored: true`. Both creators believed they owned the group.
  Measured on production 2026-08-27 (COMM-8, salon `0a47eb27`, group `19d12785`): two `epoch=0
  stored=true` publishes one second apart, then the group's only epoch-0 commit built on the
  survivor's tree by an undriven third device of the same account. The replaced creator never
  learned it: it refused that commit as `ValidationError(InvalidSignature)` at `group_epoch=0`, sat
  at epoch 0 while the group ran to 4 (`epoch gap [msg_epoch=4, group_epoch=0]`, 514 times), and
  minted the salon's only Graine session against the orphan - so the seed for the salon's first
  message existed nowhere any member could reach. The repair path did everything right and could do
  nothing: the joining member asked, every roster device answered `absorbed 0/0`, and it concluded
  `has no reachable holder`. The message is unreadable for good. The rule is now strict on both
  halves of the same function - an epoch already published is OWNED, and a base for it loses - and
  the update reports what its own guard matched instead of assuming it landed. An equal epoch was
  never a legitimate refresh: every republisher carries a strictly newer one by construction, since
  `validateCommit` writes the base for `baseEpoch + 1` inside the transaction that advances to it and
  `republishStaleBase` fires only when the stored base is BEHIND the group. The client already knew
  what to do with a lost race; it had simply never been told it lost. This is what left COMM-8
  failing after the external-join checkpoint below fixed the defect it was mistaken for, and the same
  missing seed is what COMM-9/10 and COMM-21 could not arm on.

- **An external join was durable on the server and volatile on the client, so a reload in the gap
  joined a second time and forked the group.** When a device joins a key-distribution group by
  external commit, the epoch advance is written server-side and visible to every other member the
  instant the commit gate accepts it - while the secrets that make the new epoch usable exist only
  in that device's WASM memory. Nothing wrote them to disk: `mlsStatePersister` defers routine
  checkpoints for a reason it documents in full - inbound state replays from the server, and
  outbound ratchet state is checkpointed on the send path - and an external join is NEITHER, so it
  fell through both. A navigation, a tab close or a crash before the next unrelated checkpoint
  restored a device that was IN the published tree, could not read a word of it, found no local
  group, and joined AGAIN from the new base. The second join forks the group: measured on prod
  2026-08-27, where one client joined the same salon at base 0 and again at base 1 two seconds
  apart across a navigation, leaving the salon at epoch 2, the granting device stranded at 0
  refusing frames it had no tree for, and the seed that device held undeliverable - a member
  granted access to a private salon who could read nothing in it. FOUR groups were joined twice in
  that single rung. The fix is the checkpoint the join always owed: `persistMlsStructuralCheckpoint`
  is now awaited after the merge and before the join is reported, which is the guarantee the send
  path has had since 2026-08-06 for the identical reason. The registry call returns whether a
  checkpoint was actually taken instead of `void`, because the one branch that cannot log for
  itself - no persister registered - is the one that has to report; the join still stands when the
  write fails, since refusing a membership the rest of the group can already see is strictly worse
  than one that does not survive a reload, and the line accuses rather than informs.

- **A frame no rule recognised was refused an acknowledgement for ever, so one bad frame dirtied
  every later row.** `mlsDecryptError.ts` names nine kinds of decryption failure; five are permanent
  and get acknowledged, and everything else - `unknown` included - was held to be recoverable, so the
  server handed the same bytes back on every connection for the life of the account. That is what
  turned the salon race above from one defect into sixteen cells of a campaign rung: one
  `ValidationError(InvalidSignature)` at epoch 0 matched no rule, so it was never ACKed, so it came
  back on every row after it. The repair the backlog asked for was a PROOF of permanence, and the
  proof turned out to cover far more than the `InvalidSignature` that prompted it: by the time the
  decrypt path reaches its fall-through, `mls-core` has already returned for a frame from an epoch
  ahead (the gap fast-fail), for one from an epoch behind (the past-epoch arm), for an eviction and
  for our own frame - so anything left was processed against EXACTLY the epoch it names. An epoch's
  ratchet tree is fixed once the epoch exists and a later attempt reads the same past-epoch secrets,
  so the same bytes are refused identically whatever arrives in between. That fact is knowable only
  at the Rust throw site, where the epoch pair was compared, and it is now carried as a type -
  `SameEpochRefusal` - across both FFI boundaries instead of being left to each consumer to
  re-derive from prose. Each consumer then keeps its own policy: the distribution router ACKs it, the
  history replay counts it as a real message lost rather than letting it fall off the bottom
  uncounted, the native layer stops writing a `pending_mls_messages` row that three retries and a
  sweeper would only discard, and the realtime pipeline deliberately keeps its re-add - a frame
  refused against our own copy of its epoch means our copy disagrees with the sender's, which is the
  one case where a re-Welcome is the cure rather than collateral damage. The line it logs stays an
  ERROR carrying both epochs: the redelivery loop is closed, the divergence it was the visible end of
  is still accused.

- **A salon message its own author could not read, from a race the code said could not cost
  anything.** When two devices of one account both find a salon's distribution group
  uninitialised, both create an MLS group under the same id at epoch 0 and the server's
  first-publish INSERT decides between them; the loser discards its group and external-joins the
  winner's base. That much worked, and was measured working. What the comment on
  `ensureDistributionGroup` asserted - "nothing was built on the discarded group, this runs before
  any seed is sent" - was true only of that call: it does not run before any seed is sent AT ALL.
  Between `createGroup` and the server's verdict the doomed group sits in `getLocalGroups()`, so
  `distributionEpochFor` answered epoch 0 for it, and a concurrent salon message minted an outbound
  Graine session against it and distributed the seed into it. `forgetGroup` then took the session
  with the group - `session ... has no reachable holder` - and the message stayed sealed under a
  session nobody, its author included, could ever open. The frame classifies as `unknown`, which is
  treated as recoverable, so it was never acknowledged and came back on every later row: on the COMM
  rung of 2026-08-27 one race made two rows vacuous and fifteen more dirty. Held and settled are now
  two questions rather than one - the group is marked unsettled for exactly the width of that window
  and `distributionEpochFor` returns null while it is, which is the same answer, and the same
  refusal, a caller already gets for a group it does not hold.

- **A comment that promised a bun bump was free, and the deploy it skipped.** `098ac7d2` moved
  every backend image to `oven/bun:1.4.0-alpine` on the strength of a comment in all four
  Dockerfiles: a bun >= 1.4.0 "only writes `lockfileVersion: 2` into a lockfile it CREATES, and
  reads an existing v1 one unchanged". Both halves are false. It writes v3, and it REFUSES a v1
  lockfile whose `overrides` are nested, because bun 1.3.14 had saved only the flat ones into it -
  so `bun install --frozen-lockfile` failed with "overrides in package.json changed since bun.lock
  was saved". Exactly one service has nested overrides (`gaxios`, `teeny-request`,
  `@types/request`), so exactly one image failed to build, and because the deploy is gated on
  every image it was SKIPPED - three CD runs in a row shipped nothing while reporting only a red
  build. The other three locks come back byte-identical under 1.4.0, measured, so this is one
  service's problem and not an estate-wide churn - but **regenerating that lock is NOT the fix**,
  and it was very nearly shipped as one. A clean re-resolve writes `lockfileVersion: 3`, exactly
  what Dependabot cannot read, and it drops a security pin those nested blocks were holding; the
  entry below is what the fix actually is. The comment now states what was falsified and requires
  every lock to be checked against the new tag before that tag moves.

- **A reconnect that replayed nothing looked exactly like a reconnect that never happened.**
  `drainPendingGroupExits` returned a bare `[]` when there was no storage and when a drain was
  already running, and an empty array is what a trigger that never fired returns too - so DEL-10
  recorded `sentOnFirstReconnect: 0` on `2a4297cb` and the entry named two causes while settling
  neither. Both refusals now accuse. The third early return, `owed.length === 0`, deliberately stays
  silent: it runs on every reconnect of every session that owes nothing, and a line there is the
  noise that teaches a reader to skip `[EXIT]` - and then to skip the one that matters. Which
  silence is kept is the whole judgement, and the tests now pin both directions, the silence
  included. `del.mjs --only 10` was instrumented alongside it: it snapshots the deleter's console
  around each of the two reconnects, so the row will name the cause rather than the symptom.
  `ConnectivityStore` logs before it emits, which makes that line the listener actually running -
  the discriminator was there all along and nothing was collecting it.

### Changed

- **The Carte de la Vie Asso editor is offered to a mouse only.** Asked for on 2026-08-27:
  *"j'aimerais rendre l'edition impossible sur mobile, trop complexe, il faut ne la rendre possible
  que sur le PC."* Arranging bubbles means dragging and resizing objects a finger covers while it
  moves them, on a poster wider than any phone. **What decides is the POINTER, not the viewport**
  (`isCoarsePointerDevice`, `(pointer: coarse)`): a narrow desktop window still has a mouse and a
  large tablet still does not, while a touchscreen laptop reports `fine` and keeps the editor. It is
  watched, not sampled once.

  Viewing, PDF export and publish/unpublish stay available everywhere - none of them is editing.
  What goes: the canvas's `editable` flag, the settings and per-bubble property column (every
  control in it writes the layout, so it is absent rather than disabled), the rename control, the
  Save button - nothing to save - and, on the project list, the create form, which otherwise led
  straight into an editor that could not be used. A banner says where to go instead.

- **The moderation screen now opens to the tier that was already allowed to use it.**
  `/admin/moderation` asked `isGlobalAdmin()` in three places at once - the nav item, the home card
  and the page's own redirect - while the server had accepted `MODERATE` on the reports, mutes and
  comment endpoints all along. A BDE member holding the flag reached none of it: the tier existed on
  both sides and had no door. The client now mirrors the server's `isContentModerator` through
  `ensureContentModerator()`, and the four post endpoints the screen needs - `reported`, `hidden`,
  `hide`, `unhide` - moved off global-admin-only onto the same predicate. The way in already existed
  and still does: the dashboard's Administration tile, shown to anyone holding an association flag.

  Two things fell out of doing it. The three non-admin tiers now resolve from **one** membership
  request (`ensureMyAssociations`) instead of two overlapping caches, and it is AWAITED wherever it
  decides a redirect - probed in the background, it bounced the very user it was meant to admit
  whenever it lost the race. And `AdminCard.globalOnly` went: a field set on eight cards that no
  template ever read.

  `docs/wiki/frontend/modules/admin.md` now carries the route-by-route table of who reaches what; it
  previously claimed every admin route checks `isGlobalAdmin()`, which four of the eleven never did.

- **The BDE can now moderate a post, not just the comments under it.** `MODERATE` is documented as
  "delete posts, mute users and review content reports" and did the last two: every post-level
  control - edit, delete, pin, hide - asked `isGlobalAdmin` and nothing else, so a BDE member
  holding the flag could delete a reported COMMENT and not touch the post around it. The tier is now
  one predicate, `AssociationsService.isContentModerator` (platform admin, or `MODERATE` in a BDE),
  called by the moderation endpoints and by the post controls alike; the pin/unpin routes moved onto
  it. Asked for on 2026-08-27: *"En tant qu'admin BDE, Justine devrait pouvoir modifier, supprimer,
  epingler en plus de signaler ou copier le lien."*

  A post therefore carries THREE served capabilities rather than one, because the controls do not
  share a rule: `canManage` (pencil and bin - publisher, moderator or admin), `canPin` (moderator or
  admin) and `canReport` (any logged-in reader who is not the publisher). Folding them together is
  what put a report button on a post the reader had just published, and left the pin on
  `isGlobalAdmin`. **Still global-admin-only, deliberately: hide/unhide and the reported/hidden
  queues** - those are the `/admin/moderation` screen, and a right no screen exposes is reachable
  only by someone who already knows the URL.

- **A tall picture no longer owns the whole feed.** The only bound on a post's media box was the
  aspect clamp - `MIN_ASPECT = 0.25`, so four times the card's width, roughly two phone screens of
  one image - and past it the picture was cropped from its CENTRE, which on an infographic or a
  screenshot is the half that says nothing. Every box that reserves a ratio now also carries a
  ceiling, `--media-max-height` (80svh), and the crop anchors to the TOP. The unit is `svh` and not
  `dvh` so a collapsing mobile URL bar does not re-lay-out the feed, and deliberately not
  `--app-viewport-height`, which tracks the soft keyboard: a picture must not resize because
  someone started typing. It rides on `mediaAspectStyle`, so the feed, the gallery cells, a comment
  and a chat bubble are bounded by the same decision rather than by four local patches. The whole
  frame stays one tap away in the viewer, which is what makes cropping the right answer here rather
  than shrinking.

### Added

- **A price grid cell can say the combination DOES NOT EXIST.** Some configurations are not sold:
  "non-cotisant, formule week-end" is a case an association never offers, and the grid had no way to
  say so. A price cannot - 0 means free - and `submitCondition` cannot either, since it is an AND of
  criteria about a PERSON while this excludes a COMBINATION. So a cell now holds `number | null`,
  and the three states are kept strictly apart by one predicate, `hasCell`: a number is a price (`0`
  included, meaning free), `null` is the manager's decision that nobody in that situation may
  answer, and an ABSENT key remains a broken invariant that throws. The completeness invariant is
  untouched - the grid is still a cross product, exactly one cell still applies to anybody, no
  priority rule exists - but the cell a person lands in may now refuse them.

  Honoured end to end: `resolveCellPrice` returns `null` instead of throwing, and `submit` refuses
  right after resolving the price rather than in `assertMaySubmit`, because only the VISIBLE answers
  decide which cell applies; `hasSubmission` reports `maySubmit: false` when a submitter's whole row
  is closed, the same outcome as an audience refusal, because a form with no reachable price would
  otherwise show them a total of zero and a working button. The fill page greys the options that
  lead to a closed cell rather than hiding them - an option that vanishes reads as a bug, and the
  person needs to see the choice exists and is closed to them - and its `cells[key] ?? baseCents`
  read is gone: that was exactly the fallback that would have charged a plausible number for a
  combination the server refuses. A grid with EVERY cell closed is refused on both sides, since that
  is a form nobody may answer, and saying so once at save time beats every submitter meeting the
  same refusal with nobody able to explain it.
- **The iOS release pipeline now writes the App Store Connect export compliance code into `Info.plist` at build time.** v0.14.3's TestFlight upload failed with "Invalid Export Compliance Code": `ITSAppUsesNonExemptEncryption=true` was already correctly committed, but Apple also requires `ITSEncryptionExportComplianceCode` - the code generated once in App Store Connect's own compliance documentation for this app - and the plist had no such key at all. `ios-release.yml` now patches it in from a new `APP_STORE_CONNECT_EXPORT_COMPLIANCE_CODE` GitHub secret, right before the archive build, rather than committing the value: this is a public repo, and while the code isn't a credential that grants access to anything, it's still an Apple-account-specific value with no reason to be baked into a public file when every other Apple-account value here already isn't. The step skips harmlessly when the secret is unset, so it didn't regress the pipeline while the secret was still owed - and on 2026-08-24 the secret was created and v0.14.4 cut: the step took its set branch and **the TestFlight upload succeeded**, which is the first time an iOS build of this app has reached App Store Connect. What that proves is the pipeline, not the audience: TestFlight is the beta channel, so `minClientVersion` still may not be raised past a release before that release has actually reached the users it would lock out

- **Form pricing is a MATRIX, and the same predicate now says who may answer and who sees a
  question.** A price was one number plus an optional "cotisants pay less" second number, which
  cannot express what managers actually price on: the BDE cotisation depends on the promo, the
  formation AND the answer to a menu question. Ticking the "Filtrer par..." boxes now declares
  DIMENSIONS, and the grid is their cross product - so exactly one cell applies to anybody and no
  priority rule exists to get wrong. Each dimension is a partition rather than a filter (an
  undeletable generated `others` bucket), so nobody is unpriced and the cross product stays small.
  A question used as a dimension contributes no additive supplement, server-enforced, because its
  cell already carries the choice.

  The same `AudienceCondition` gates the form (`submitCondition`, "Qui peut repondre") and each
  question (`showIf`), judged by one server predicate and built by one editor - so a form reserved
  to one promo and a price for that promo cannot disagree. `memberPriceEnabled`,
  `memberPriceVariantKey` and `basePriceMember` are dropped (migration `051`); production held one
  form and it used none of them.

  **A promo is an ENTRY year** - la promo 2024 entered the school in 2024 - and this shipped, before
  release, reading it as a graduation year. On that reading a bucket needed a second relative mode,
  `yearsToGraduation` = `promo - academicEndYear`, so that "1A" would not go stale each September.
  It matched NOBODY it was ever set for: for the promo 2025 evaluated in 2026 the expression yields
  -1, and the editor only offered 0..4. The absolute mode was no better, offering a six-year window
  that contained no cohort on prod and omitted the three largest that do. A relative mode cannot be
  repaired either - it needs a cursus length, and nothing here records one (ICM and ISMIN run three
  years, Master two). So there is one reading and no mode: a group names its years, the manager
  names the group. Promos go in one at a time through a box that is both a list and a free entry -
  pick a recent one, type an old one - and a `+`. The domain is bounded at both ends (1816, the
  school's founding year, to the current year) on the client AND the server, because `2O24` typed
  for `2024` would price a whole cohort as "everyone else" in silence.

- **The forms admin screens, rebuilt around one set of components, and a "Parametres avances"
  category.** `forms/create` and `forms/[id]/edit` were two 700-to-900-line copies of each other,
  and the copies had drifted in eight ways a user could see: two toggle geometries on the same
  screen, a select that had lost its focus ring, two different placeholders on the same picker, and
  a cash-expiry field that was a bare input on one page and a labelled component on the other. One
  `FormSection` card primitive, one `controlClasses.ts` every input and select wears, one `Select`
  and one `Toggle`, and the payment, questions, save-bar and cotisation blocks each extracted once.
  The euro/cent conversion and the questions payload had a copy inside each page's `handleSave`;
  they are now `forms/itemsPayload.ts`.

  The cotisation grant - the setting the whole change started from, wired server-side and reachable
  from no screen - lives in the collapsed advanced section, which is what it deserves.

- **`/forms` lists the forms a caller manages through an association, not only their own, and says
  whose each one is.** `assertFormManager` has always accepted `MANAGE_FORMS` on the linked
  association, so those forms were editable and exportable by API while appearing in no list on any
  screen - reachable only by someone who already knew the URL. Three sources now merge by id
  (owned, co-owned, managed-via-association) and each row carries the association's NAME. That line
  used to print the raw form id, which told a person nothing. `EditFormsTab` gained edit and delete
  for the same set, from the association's own space.

  A form's association is chosen once and `update` refuses to change it: moving a form between
  personal and association ownership asks who owns it afterwards, and no answer avoids surprising
  someone. The edit screen shows it as read-only text, not a disabled picker - a disabled control
  suggests someone with more rights could change it, and there is no such someone.

- **A ceiling on `minClientVersion`, the one control that can lock out every client at once.** The
  DTO already refused anything that was not `major.minor.patch`, and nothing checked that the
  well-formed value was *possible*: `1.14.0` for `0.14.0` is one keystroke and demands a client newer
  than any that has ever been built, which no user can satisfy by updating. A raise above the
  server's own deployed version is now refused, naming both versions. A raise is also logged at
  `warn` with its before and after - it shared a `debug` line with the payment provider, on a value
  every client's access turns on.

  Deliberately partial, and the code says so: at or below the deployed version is accepted, which
  does not make it safe. The real hazard is a raise above what the app stores have actually shipped,
  and no server can see App Store review state - v0.14.0's raise locked out every iOS user the store
  had not reached. This is a typo guard, not a substitute for the shipping order in
  `docs/wiki/legacy-compatibility.md`.

  The version reader moved to `platform/deployed-version.ts` and now returns `null` on failure
  instead of `'0.0.0'`. The old default is a real version and a legitimate answer, so a caller could
  not tell "this build is 0.0.0" from "I could not find out" - harmless while the value was only
  reported, and not harmless the moment a bound decides on it, where it would have turned a failed
  file read into a refusal of every legitimate raise. Callers that report keep the default; the one
  that decides handles `null` and logs that the guard did not run.

### Removed

- **`libs/shared-ts`, a package NOTHING imported, and the eight places that kept it alive.** It
  exported three Kafka topic names, one Redis envelope builder and re-exports of three `ts-rs` types.
  Not one `src/` file in any of the four NestJS services imported it; neither did the frontend. Its
  only mention outside its own directory was a Jest `moduleNameMapper` in `chat-delivery-service`
  pointing at the library's SOURCE - which no test ever resolved - and a build stage in that
  service's Dockerfile that compiled it and copied the result nowhere. Its only commits in its last
  year were version bumps.

  What it cost while doing nothing: an entry in the CI TypeScript matrix, a `bun install` + `bun run
  build` step run before EVERY backend test job as "a build dependency for all TS backends", a
  `shared_ts=true` flag that forced all four services AND the frontend to re-run on any change to
  it, path filters in `cd.yml` and `cd-dev.yml`, a Dependabot directory, a Makefile target, two
  Husky branches and a committed lockfile. All of it is gone. `ci.yml` also tested for a
  `libs/event-contracts` that has never existed in this repository.

  Two things it really did hold have new homes. The `ts-rs` mirrors of the shared Rust event structs
  now generate into `libs/shared-rust/bindings/` - next to the definitions they mirror, still
  committed, so a struct change still shows up as a dirty tree in the same commit as the Rust
  change. And the wiki page that described the package was wrong in four separate ways, which is how
  a dead package survives this long: it claimed all four services consumed it, called a hand-written
  JSON envelope builder "protobuf-generated types", documented a `npm run proto:gen` script the
  package did not have, and named an export that did not exist. `docs/wiki/libs.md` now states what
  is measured, including how many of the three "Kafka topics" any code outside the crate actually
  names: one.

  The duplication this package was the obvious cure for stays duplicated, deliberately, and the note
  at the head of each copy now says why in terms that do not depend on a package that is gone -
  `internal/service-urls.ts` and `internal-secret.util.ts` in `core-service` and `social-service`,
  and `compareSemver` between `core-service` and the frontend. A shared package would add a build
  stage and the `--install-links` trap to two more production images to save four lines each. A
  THIRD copy is the signal to reconsider.

- **The "Encaissement (Stripe)" selector on a post, and the column behind it.** The composer asked
  a real question - which association's Stripe account should collect on this post - the answer was
  validated (`isPaymentsReady`, honouring approved parent-payment delegation) and stored, and then
  **nothing ever read it back**: no post has ever rendered a pay or donate control, so the column
  recorded an intention the product had no way to act on. Two dispositions were put to the user -
  finish the missing half, or delete it - and the answer was *"un composant qui ne sert a rien est
  un composant a jeter"*. Gone end to end: both composers, the draft field, three message keys, the
  DTO fields, the entity column and migration `054`, plus `AssociationsService.isPaymentsReady`,
  whose only caller this was. Production held 109 posts and **0** with a payment association, so
  nothing is lost. Money on a post still travels the mechanisms that actually take it - an attached
  paid form, or a boutique product - each resolving its own payment target at the moment it charges.

- **A form's per-form "Co-responsables" list is deleted, because it answered a question that already
  had an answer.** Who may manage a form was settled on two axes that never agreed: `forms.coOwners`,
  a list of user ids the owner typed in on the edit screen, and `MANAGE_FORMS`, the association
  permission every member with the right holds. `assertFormManager` accepted both, so an association
  form manager could edit the form - and the Co-responsables section rendered for them, with every
  add and every remove returning 403, since only the owner could change the list. A section a person
  can see and cannot use is worse than one that is not there, and the fix is not to hide it: two
  places to grant the same thing is one too many, and the association permission is the one that
  scales, survives its grantee leaving, and is auditable from the association's own screen.
  Production held two forms and zero co-owners, so nothing is lost. Migration `053` drops the column,
  the two endpoints and the list branch go with it, and `/forms` now merges two sources instead of
  three. Unrelated to `calendar_event_co_owners`, which names ASSOCIATIONS co-hosting an event.

### Fixed

- **Three jobs went red on a line none of them had touched, and the fix was nearly the deletion of a
  security pin.** `bun install --frozen-lockfile` began failing in CI, in CD and in the Docker build
  at once, on `apps/chat-delivery-service`, with `note: overrides in package.json changed since
  bun.lock was saved`. Nothing had changed the manifest. What changed was bun, from 1.3.14 to 1.4.0,
  in this repository's own `.bun-version`.

  This service was the only one of four whose `overrides` block was NESTED - `@types/request >
  form-data`, `gaxios > uuid`, `teeny-request > uuid`. bun 1.3.x did not support that and SAID so,
  three `warn: Bun currently does not support nested "overrides"` lines on every single install,
  which is exactly how a warning gets learned as noise. bun 1.4.0 supports them - and records them in
  a lockfile format Dependabot cannot read, rewriting `lockfileVersion` from **1 to 3** on the first
  plain `bun install`. So the manifest, unchanged for months, silently became unfrozen against its
  own lockfile.

  **Flattening the block made CI green, and would have shipped a vulnerability.** The committed
  lockfile still pinned `gaxios/uuid@11.1.1` from the npm era, so a frozen install stayed clean and
  `bun audit` stayed green with the manifest's reason for it deleted. Only a resolve from NO lockfile
  asks a manifest to prove itself: done in a scratch copy, it put `uuid@9.0.1` back under both
  consumers and `bun audit` named GHSA-w5hq-g745-h8pq - *missing buffer bounds check in v3/v5/v6*,
  `<11.1.1` - reached through `firebase-admin > google-auth-library > gcp-metadata > gaxios > uuid`.
  The `^11.1.1` was never decoration. `@types/request > form-data` was, and it is gone: the package
  asks for `^2.5.5`, resolves to 2.5.6 unaided, and the audit is clean without it.

  The pin is now flat, `"uuid": "^11.1.1"`, which v1 can express. A flat override reaches direct
  dependencies too, so `uuid` had to stop being one - and it barely was. Two call sites, each a bare
  `uuidv4()`, in a service that already called `crypto.randomUUID()` in nine other places;
  `groups.controller.ts` imported `crypto` on the very line below its `uuid` import and used both.
  Both call sites are now `crypto.randomUUID()`, the direct dependency is deleted, and the tree lost
  a package and a duplicate: one `uuid@11.1.1` where there were three.

  `"uuid": "^14"` was the tidier-looking flat pin and is a trap - 14.0.2 is `"type": "module"` with
  no `require` condition in its exports, and `gaxios` reaches it through `require("uuid")`. The
  reasoning behind all three candidate pins is on
  [ecosystem-convergence](docs/wiki/ecosystem-convergence.md).

### Changed

- **npm is gone from this repository, and node stayed - the two were never the same question.** The
  standing mandate is bun everywhere, and `.github/workflows/ci.yml` still carried one `npm test`.
  It was not laziness: those suites are jest, and jest under the bun runtime fails
  `admin-storage.controller.mls.spec.ts`, which passes 8/8 under node. So the line looked like a
  choice between a broken pipeline and a broken mandate. It was not. A package manager is not needed
  to RUN a script: `node --run test` (node >= 22) reads `package.json` scripts natively, so the
  runtime jest depends on stays and the package manager goes. It is also stricter than npm by
  design - no pre/post scripts, no walking up to a parent directory - so what executes is exactly
  the `test` script of the service being tested.

  The same edit closed a divergence nobody had noticed: `make test-history` ran those very suites
  with `bun run test`, so `make test` and CI were executing the same files on two different
  runtimes, and the service it runs is the one holding the spec that fails under bun. Both now say
  `node --run`. `make install-node` also stopped requiring npm to be present, which would have
  failed a machine perfectly able to build and test this repo.

  What this does NOT do is delete the node runtime. Doing that means porting four NestJS services
  from jest to `bun test`, and that is a dated item in `docs/wiki/backlog.md`, scheduled after the
  campaign - not something to attempt by editing the CI line.

- **bun 1.4.0 is the runtime everywhere, and Dependabot still works - the two were never in
  conflict.** `.bun-version` and the four service images sat at 1.3.14 because "any bun >= 1.4.0
  writes `lockfileVersion: 2`, which Dependabot cannot parse". The qualifier in that sentence was
  doing all the work: bun writes v2 only into a lockfile it CREATES. Against an existing v1 lockfile
  it preserves the version - measured on `bun update` in core-service, `bun install` in another repo
  and `bun install --frozen-lockfile` in media-service, the last byte-identical. The version of bun
  you run and the version of the lockfile you commit are independent, so the repo runs the newest bun
  and Dependabot keeps opening pull requests.

  The pin is replaced by something that actually enforces the invariant. `.bun-version` governs CI
  and `setup-bun`; it does not govern a contributor's own bun, and deleting a `bun.lock` before
  reinstalling produces a v2 lockfile whatever this repo pins - so the pin bought an illusion.
  `code-analysis.yml` now reads every committed `bun.lock` and fails the build on anything but
  version 1, quoting dependabot-core#15896 (merged 2026-08-14, `MAX_SUPPORTED_LOCKFILE_VERSION = 1`)
  for why. That failure mode is the one worth gating on precisely because its symptom is an ABSENCE
  of pull requests, which nobody notices; before that PR it was worse still, as Dependabot silently
  committed a DOWNGRADED lockfile and exited 0.

  This also closes the Renovate question, which had been open and blocking since the package-manager
  work started. It was conditional on "does Renovate read lockfileVersion 2" - unanswerable from its
  documentation, which never says which bun it runs - and the answer stopped mattering, because the
  only reason to want v2 was gone. Renovate stays dropped, now for a measured reason.

- **`Dockerfile.frontend-ssr` moves to `node:24-alpine`, the last `node:22` in the repository.** Its
  comments were French in a repo whose rule is that everything dev-facing is English, and they now
  also record why this one image is NOT on bun: it runs an `adapter-node` build, so bun would mean
  `svelte-adapter-bun`, a different SSR entry point and a different nginx proxy target - a deploy
  change, not a base-image swap, and one nothing has verified against a running site. The rule this
  repo learned on Portail-etu is that a runtime move is proven on its target host.

- **`docker-compose.prod.yml` records why four `node -e` healthchecks still work in images that run
  bun.** They look like leftovers of the migration and are not: `oven/bun:*-alpine` ships a `node`
  shim on PATH that dispatches to bun. Measured inside the image - `node -e` runs, `fetch` resolves,
  and the exit code is honoured in both directions. What the shim does NOT support is a REPL or
  `node --version`, so anyone "checking" it with either will conclude the opposite of the truth.

- **Both Husky hooks run bun, and speak English.** They called `npm run lint:fix` for the four
  NestJS services and `npm run lint` / `npm run format:check` for `chat-delivery-service` - the last
  `npm` left in a developer's path after the backend moved to bun, and the one most likely to
  resolve a dependency tree different from the one CI builds. `npm test` in the pre-push hook stays
  `npm`, for the measured reason `ci.yml` gives at the same seam: jest under the bun runtime fails
  `admin-storage.controller.mls.spec.ts` while it passes 8/8 under node. The comment at that call
  site now says so, so the next person to "finish the migration" reads it before collapsing it.
  Their comments and failure messages were French in a repository whose rule is that everything
  dev-facing is English; they are English now.

- **`frontend/package.json`'s own scripts stop shelling out to npm.** Seven chains inside
  `generate`, `test`, `check`, `check:strict`, `check:watch` and `prepare` ran `npm run
  <other-script>`. Every caller above them - the Makefile, both hooks, CI - invokes them with `bun
  run`, so a single `bun run generate` was silently dropping back into npm halfway through, in a
  repository whose lockfile is `bun.lock`.

- **`vitest.config.ts` uses `import.meta.dirname`.** `__dirname` made Vite print a deprecation
  warning on every single test run, local and CI. A line its reader learns to skip is the line that
  hides the next defect.

- **The four NestJS services install, build and run under bun; their images no longer contain node.**
  `oven/bun:1.3.14-alpine` replaces `node:24-alpine` in all four Dockerfiles, `bun install
  --frozen-lockfile` replaces `npm install`, and `CMD` is `bun dist/main.js`. Each image was built
  AND STARTED locally before this shipped - all four reach `NestFactory` and fail only on the
  environment variables a bare `docker run` cannot supply, which is the intended outcome. That check
  is not ceremony: a green build proved nothing on Portail-etu the day before.

  Two defects surfaced on the way, both older than this change and both invisible because the images
  ran `npm install` and never `npm ci` - so the committed `package-lock.json` was never what an image
  built from, and every build floated to whatever was newest.

  - `core-service` no longer compiled. `stripe` at `^22.2.2` floated to 22.5.0, whose SDK types
    `apiVersion` as the string literal `'2026-07-29.dahlia'`, while three files passed
    `'2026-06-24.dahlia'`. `stripe` is now pinned EXACTLY and the literal lives in one place,
    `STRIPE_API_VERSION`, which documents that the two are coupled and that raising them is a
    decision about payments - webhook payload shapes - rather than about dependencies.
  - `core-service` then no longer STARTED: `@nestjs/core` 11.2.3 against `@nestjs/common` 11.1.19,
    which is the drift `dependabot.yml` already described in a comment. Seven shared packages
    diverged across the four services; all are now on one version each, `@nestjs/*` at `^11.2.3` and
    `typeorm` at `^1.1.0`.

  `media-service`'s build step was `npm run build 2>/dev/null || true` - a build that could not fail,
  with its diagnostic discarded. It never shipped a broken compile, because the missing `dist` then
  failed the COPY; it made a compile error surface two stages later as a confusing COPY failure with
  the explanation already thrown away. It is now a plain `bun run build`.

  `chat-delivery-service`'s image also loses a whole build stage that installed and compiled
  `libs/shared-ts` and copied the result nowhere: nothing in that service's source imports
  `@canari/shared-ts`. Its only mention anywhere is a jest `moduleNameMapper` pointing at the
  library's source.

  **One thing deliberately did NOT move to bun.** These suites are jest, and under the bun runtime
  `admin-storage.controller.mls.spec.ts` fails while passing 8/8 under node. So CI installs, lints
  and builds with bun and runs the tests with node, and both call sites say why. The five
  `package-lock.json` files are replaced by five `bun.lock` at `lockfileVersion: 1`, `dependabot.yml`
  moves those directories from the `npm` ecosystem to `bun`, and `.gitignore` gains the negations its
  own rule requires - a lockfile is committed when its package ships as an artefact, and these four
  ship as images.
- **`make install` no longer resolves a dependency tree unrelated to the one CI builds.** The
  Makefile called `npm install --legacy-peer-deps` in `frontend/`, ignoring the committed `bun.lock`
  entirely, while `install-hooks` a few lines below had a four-branch ladder - `$HOME/.bun/bin/bun`,
  then `bun`, then `npm`, then nvm+npm - each branch resolving something different for the same
  directory, with no way to see which one fired. Every JavaScript install, test, build and lint
  target now runs one installer, `bun install --frozen-lockfile`.


- **One bun version, named in one file, instead of three scattered across the workflows.** Nothing in
  this repo declared which bun it wanted - no `engines`, no `packageManager`, no `.bun-version` - and
  the workflows had drifted to three answers: `1.2.18` in the five release pipelines, `1.4.0` in
  code-analysis, and `ci.yml` with no `with:` block at all, which resolves to *latest*. That last one
  is the path `cd.yml` already warned about in a comment (resolving "latest" goes through
  `api.github.com/.../git/refs/tags` and can 401 with `GITHUB_TOKEN`), and it is also how a
  `lockfileVersion: 2` could have entered the repo from CI. All eight `setup-bun` sites now read
  `.bun-version` through `bun-version-file`, and `frontend/package.json` repeats the number in
  `packageManager` and `engines.bun` so a human and a tool see the same thing.

  The number is `1.3.14`, and it is chosen rather than latest for a measured reason: a *fresh*
  `bun install` on bun >= 1.4.0 writes `lockfileVersion: 2`, Dependabot bundles bun 1.3.14
  (`dependabot-core`, `bun/Dockerfile`), and 1.3.14 answers `UnknownLockfileVersion` on a v2
  lockfile. It does not fail loudly - it stops opening pull requests for that directory, which is
  indistinguishable from having none to open. An existing v1 lockfile is safe, because 1.4.0
  preserves it even when rewriting it; the hazard is deleting `bun.lock` and reinstalling. The
  committed `frontend/bun.lock` is v1 and installs under 1.3.14 unchanged (345 installs, 503
  packages, no changes). The full measurement, and why it also drops the plan to migrate the five
  repos to Renovate, is in
  [ecosystem-convergence](docs/wiki/ecosystem-convergence.md#8-the-package-manager-and-the-version-four-repos-never-declared).


- **The pricing grid reads at any number of columns, and a cell is its own availability control.**
  The columns were sized by whichever header happened to be longest and had no minimum at all, so
  the same price column came out narrow beside "AST" and wide beside a question's option label, and
  a grid of nine got columns of 83px. The sizes now live in `.price-grid` (`app.css`) and the editor
  supplies only the column counts; the table's total width is named, because `table-layout: fixed`
  on a table of width `auto` treats declared column widths as proportions rather than sizes - the
  measured trap this replaces, not a fix for it. Each cell also lost two controls: the native number
  steppers, which cost a fifth of a narrow cell to step a price by one centime, and the permanent
  button beside every price. Availability is carried by the cell instead - an unavailable cell has
  nothing to type in, so clicking it reopens it, and closing an open one is a control that overlays
  the cell and takes no width. The form builder itself went from `max-w-3xl` to `max-w-5xl`, and the
  variant opened from the post composer from `max-w-xl` to `max-w-3xl`. `controlClass` gained a
  `compact` density in the process: three call sites had written `py-2 text-sm` after it and none of
  the three worked, because Tailwind emits competing utilities in scale order and the `py-3` inside
  the shared string was always the later rule.
- **Every association-scoped right now goes through ONE predicate, and the eleven permission flags
  have a measured table instead of a comment.** The user asked what each flag actually permits, and
  for a platform administrator to hold every association right whether or not they are a member. The
  second half was very nearly already true - every guard honours `X-Global-Admin` - so the real
  finding was that the same question, *may this user exercise this flag on this association*, had
  **four** answers that disagreed: the route guard granted a BDE super-admin every flag, `canPostAs`
  and `canManageStripeConnect` forgot that tier existed, the calendar's edit/delete pair escalated
  through `VALIDATE_EVENTS` instead, and `GET :id/cotisation-options` answered `mayGrant: false` to
  a super-admin whom `POST :id/cotisants` - the endpoint that button calls - would have accepted, so
  the UI hid a control the API allowed. `AssociationsService.mayAct(userId, associationId, flag, {
  isGlobalAdmin })` is now the whole policy, mirrored on the client by `mayActOnAssociation`, and the
  two exclusions withheld from the super-admin tier - `MANAGE_STRIPE_CONNECT` and `POST_AS_ASSO`,
  because pointing an association's payouts at a bank account and speaking in its name are not
  administration - are one named set on the entity rather than an omission at each call site.
  `AssociationRoleGuard` was deleted: dead code, and the only guard that had no administrator path at
  all. What is deliberately NOT folded in is named on the page - `isUserBdeAdmin` is a different
  right, the listing queries answer "which associations" rather than "may they here", and existence
  is a 404 from whoever loads the row. Channel permissions remain a separate string-based system and
  are described separately. The measured flag table, the four spellings and the seven findings are on
  [association-permissions](docs/wiki/association-permissions.md), the French user page the audit
  owed is `docs/user-guide/permissions-association.md`, and the roles table in
  `responsable-association.md` - which described the CHANNEL model as if it were this one - is gone.

- **The Android release build shrinks its resources, and an unused UI library is out of the APK.**
  Two more of Google Play's recommendations, and the second one had a trap in it.
  `android.r8.optimizedResourceShrinking=true` had been sitting in `gradle.properties` doing nothing
  at all, because `isShrinkResources` was never set - so R8 kept every resource and therefore every
  class reachable from one, which is how `com.google.android.material` stayed in the DEX and put
  Play's `MaterialDatePicker` finding there. **Dropping our own `implementation` line would not have
  removed it**: eight modules declare that library - six Tauri plugins from the cargo registry, the
  two local patched ones, and this app - all of it plugin-template boilerplate, since NOT ONE Kotlin
  file in any of them names a class from it. Gradle would simply have resolved the plugins' 1.7.0
  and kept it. So the theme parent moved to `Theme.AppCompat.DayNight.NoActionBar` - `WryActivity`
  extends `AppCompatActivity`, which asks for nothing more, and that parent was the library's only
  real use here - and the module is excluded from every configuration. The exclusion is an assertion
  that it is unused, not a workaround for a conflict.

  **Two of Play's four recommendations cannot be cleared, and that is now written down rather than
  rediscovered.** The remaining deprecated-window-API call sites are `androidx.activity`'s own
  backwards-compat path *inside* the `enableEdgeToEdge()` that Play's first recommendation asks for
  - checked against the 1.13.0 sources, where it is unchanged, `@Suppress("DEPRECATION")`-ed, and
  even the new `EdgeToEdgeApi35` sets `statusBarColor = TRANSPARENT`, so no upgrade silences it -
  and play-services-base by way of Firebase. The edge-to-edge recommendation itself was already
  answered by `enableEdgeToEdge()`, `viewport-fit=cover` and 46 `env(safe-area-inset-*)`
  declarations; what was missing was any gate asserting the call, in a file a Tauri upgrade
  regenerates. `androidPlayRecommendations.test.ts` and two new cases in
  `androidWindowLayout.test.ts` hold the actionable half. **What no gate here can hold is whether the
  shrunk APK still works** - the debug build type never minifies - so that is
  `device-verification.md` check R, owed on hardware.
- **Payment is a MODE now: either a public base price or a grid, never both on screen.** The section
  showed the single price and the grid together, the price relabelled "Prix par defaut" and used
  only to seed a new cell - two amounts on screen, one of which charged nobody. One toggle picks
  which of the two the form has. Switching the grid on seeds it from the price that was showing, so
  no total moves; switching it off drops it; and removing the last criterion leaves the grid ON with
  nothing to divide on, because the mode is the manager's to flip and not the editor's to infer.
  That state is a save-time refusal rather than a silent fall back to the single price, which is
  what `matrixPayload` sending `null` would have looked like: accepted, and not what was asked.

- **The form editor has four sections instead of six, and the advanced one says when it is hiding
  something.** A manager writing a plain free form - title, questions, save - scrolled past a
  response cap, a repeat switch, an opening date, an audience restriction and a cotisation grant,
  each wanted by a handful of forms a year. They now sit in "Parametres avances" as three groups
  separated by dividers (Reponses, Qui peut repondre, Cotisation). A folded section holding a live
  restriction is a setting nobody can see, so its header carries a badge: "Acces restreint" when an
  audience condition is set, otherwise a count of the settings actually doing something - the
  audience wins over the count because it is the one deciding whether a person may answer at all.

- **The create and the edit page summarise a form the same way.** They had drifted again, in the one
  line that is on screen while you save: create printed the price, edit printed only the question
  count, so the same form described itself two ways depending on which door you came in by. One
  `formSummary`, used by both, and a grid gets a RANGE rather than one number since it has no single
  price. Two duplicated `_short` error keys went with it - the long sentences are the ones both
  pages already showed.

- **A product/partnership card wears its accent along its top edge, and its logo as a logo.** `CardTile`
  drew the association's colour as a 4px slab down its left edge, printed the badge as a full-bleed
  uppercase band, and placed the icon as a 64px watermark at 40% opacity behind a radial mask,
  absolutely positioned in the top-right corner - which is exactly where the shop grid prints a
  price, so the two drew over each other, and an uploaded brand logo (the one piece of art on the
  card that carries identity) was unreadable anyway. The accent is now a 4px bar along the top edge,
  the badge a pill, and the icon sits framed in a header row of its own, in normal flow, so it
  cannot overlap anything a caller renders. It costs each card the height of that row and no call
  site changed. Cards also gain an elevation that responds to hover, gated on `(hover: hover)` so a
  tap does not leave one card in a grid permanently lit; the accent reaches the bar, the badge and
  the hover outline through one pair of CSS variables rather than three inline copies.

- **A form names a cotisation TIER; the tag is derived when payment lands.** `pricingTagName`,
  `grantedTagName` and `tagExpiresAt` stored a literal tag typed into the admin screen. Three things
  were wrong with a literal, all silent: a dated cotisation's tag carries the academic year, so a
  form configured in June granted `cotisant:bde-2025-2026` to someone submitting in October, for a
  year already over, and nothing could resync it because the form never recorded which tier it
  meant; a multi-tier association got the base tag or a hand-typed guess, which is the "cotisant
  nobody can see" that `grantCotisant` refuses to mint; and granting a raw tag through
  `grantOrRenew` skipped `revokeSiblingTierTags`, so buying one tier in the boutique and another
  through a form left a user holding both. Migration `050` replaces them with
  `grantsCotisation`/`cotisationVariantKey` and `memberPriceEnabled`/`memberPriceVariantKey`, and
  every grant goes through `grantCotisant` - the same call the boutique and the manual roster add
  use. No shim: prod held one form, with no granted tag and no member-price tag (measured
  2026-08-23).

  `memberPriceEnabled` is a column rather than `basePriceMember != null` because it also gates every
  option's `priceModifierMember` - deriving it would have silently dropped the member price of a form
  that discounts only its options.

  The forms module got its first tests with this: 38, over the money and membership paths.

### Security

- **A lockfile entry is not a dependency, and one open P2 rested on forgetting that.**
  `libcrux-chacha20poly1305`'s overlong-ciphertext panic was recorded as the single alert reaching
  attacker-controlled input on a path that matters - "it IS the HPKE half of the MLS crypto
  provider". It is not in the binary at all. The claim came from reading `Cargo.lock`, which lists
  what COULD resolve, optional backends included; `cargo tree -i` finds no path to
  `libcrux-chacha20poly1305`, `libcrux-aead` or `hpke-rs-libcrux` on any target. The HPKE backend
  actually compiled is `hpke-rs-rust-crypto` - RustCrypto's `chacha20poly1305` 0.10.1 and `aes-gcm`
  0.10.3. Two libcrux crates ARE built, `libcrux-sha3` and `libcrux-secrets` through `hpke-rs`, and
  those advisories are the real ones.

  Every advisory with no available fix now has an entry in that crate's `.cargo/audit.toml` naming
  why it cannot be honoured and what lifts it, rather than a red job nobody can act on: `rsa`
  (RUSTSEC-2023-0071) in the two Rust services, where `jsonwebtoken`'s `rust_crypto` feature
  compiles it but only `Algorithm::HS256` over `DecodingKey::from_secret` is ever built, so no RSA
  key exists; the six libcrux IDs, pinned by `openmls_rust_crypto` 0.5.1 or not compiled at all;
  `quick-xml` twice in `src-tauri`, arriving through `plist` and `tauri-winrt-notification`, neither
  ours to move; and `rkyv` plus `rsa` there, which `cargo tree` cannot reach either. An ID that is
  not listed still fails the job.

- **The dependency audit reported one crate out of four, and called the other three clean by never
  opening them.** `Audit Rust dependencies` loops over the four committed `Cargo.lock` files under
  `set -euo pipefail`, so the first failing crate aborted the step - and `apps/call-service` failed,
  which is why `chat-gateway`, `mls-wasm` and `src-tauri` had not been audited at all. Both audit
  loops, Rust and npm, now run every target and collect the failures, reporting which ones failed
  instead of only the first. Opening the three that had been hidden turned six known advisories into
  eighteen.

  What the measurement then fixed, all of it lockfile-only except one minor bump:
  `webrtc` 0.10 -> 0.11 in `call-service`, which drops the whole `rustls` 0.21 stack it was dragging
  along - `ring` 0.16.20 (RUSTSEC-2025-0009) and three `rustls-webpki` 0.101.7 advisories
  (RUSTSEC-2026-0098, -0104, and the wildcard name-constraint one) - and compiles with no source
  change at all; `quinn-proto` 0.11.14 -> 0.11.17 in `call-service` and `chat-gateway`
  (RUSTSEC-2026-0185, 7.5 high, remote memory exhaustion); `h2` 0.4.14 -> 0.4.19 in `chat-gateway`
  (RUSTSEC-2026-0258); `crossbeam-epoch` 0.9.18 -> 0.9.20 in `mls-wasm` and `src-tauri`
  (RUSTSEC-2026-0204). `call-service` goes from six advisories to one, `chat-gateway` from three to
  one. That one, in both, is `rsa` 0.9.10 (RUSTSEC-2023-0071) reached through `jsonwebtoken`'s
  `rust_crypto` feature, which has no fixed version.

  The failing job is why every Dependabot pull request and the CD deploy of `cefc1a0` were red:
  `Check Dependencies Vulnerabilities` gates both, and it had been failing on advisories published
  in April and June, not on anything a pull request changed.

- **Ticking one permission box could grant a member all seven core rights.** `listMembers` returns a
  member's bitmask only to a caller holding `MANAGE_MEMBERS`; when it was absent,
  `AssociationMemberRow` invented `member.isAdmin ? ALL_CORE_FLAGS : 0` - and `toggleFlag` wrote that
  guess back, so a single click on a row whose bitmask had been withheld saved the fabricated mask.
  The fallback is gone rather than corrected: `manage` is only ever set by a caller holding
  `MANAGE_MEMBERS`, which is exactly the caller the server sends the bitmask to, so an absent
  bitmask means the two sides disagree - the editor stays closed and says so in the console. Two
  reachable paths fed it, both also fixed: the super-admin tier was missing from the inline checks
  that decide whether the editor renders at all, and `MANAGE_PARTNERSHIPS` was absent from that
  editor's label list, so a right gating eight endpoints that the admin preset hands out on creation
  could never afterwards be seen or revoked.

- **A form was a side door around `MANAGE_MEMBERS`.** `grantsCotisation` hands out association
  membership, and `UserTagService.grantCotisant` has always required `MANAGE_MEMBERS` - but nothing
  checked the caller when the setting was *saved*. A plain member holding only `MANAGE_FORMS` could
  configure a form that grants a cotisation, and the grant then ran as the payment path, not as
  them. `assertCotisationConfigValid` now takes the caller and refuses the setting, and
  `GET /api/associations/:id/cotisation-options` returns `mayGrant` so the toggle is not offered to
  someone the save would reject. The member price is deliberately not gated: a discount for existing
  cotisants grants nothing.

  Found by asking whether a form's options vary with the caller's rights - a question the audit had
  not asked of forms.

- **Any authenticated user could mark their own form submission paid, and be granted what payment
  buys.** `POST /api/forms/submissions/:id/mark-paid` was guarded by `NginxAuthGuard` and then by
  `assertSubmissionAccess`, whose first line is `if (sub.userId === callerId) return` - so the
  SUBMITTER passed. One request against their own pending submission id, with no body and no Stripe
  call anywhere in the path, set `paymentStatus='paid'`, granted the form's cotisation tag through
  `grantOrRenew`, and wrote a `purchase_record` with `paymentMethod:'stripe'`, `status:'paid'` and
  the full `totalPaid` - free goods, and revenue in an association's books that no money backed. The
  optional `sessionId` was stored without ever being checked against Stripe.

  The endpoint was **deleted**: nothing in our own client had ever called it, and all three
  legitimate routes to `paid` already existed elsewhere. Stripe confirms through
  `POST /api/internal/forms/submissions/:id/mark-paid`, guarded by a timing-safe
  `X-Internal-Secret` and reached only from core-service *after*
  `stripe.webhooks.constructEvent` verifies the signature; a form manager takes cash through the
  form-scoped `validate-cash`; a free submission is written `'free'` at submit time.
  `FormsService.markPaid` lost its `callerId`/`isGlobalAdmin` parameters with it - they gated the
  access check behind `if (callerId)`, so the check silently did not run whenever the argument was
  absent.

  Found by the mechanism audit, which had ranked forms first precisely because they take money and
  nothing - no spec, no frontend test, no board row - watches them.

### Fixed

- **The SFU had not compiled on `main` since two Dependabot majors merged, and every gate was
  green.** `apps/call-service` was in NO CI matrix. The only thing in the repository that ever built
  it was the Docker stage in `cd.yml`, which runs AFTER the merge - so a dependency PR touching the
  crate passed CI without the crate being compiled once, auto-merged, and broke `main` silently. Two
  did: #222 took `webrtc` 0.11 -> 0.17, which deletes `RTCIceServer::credential_type` and the whole
  `ice_credential_type` module; #227 took `axum` 0.7 -> 0.8, whose WebSocket text frames carry
  `Utf8Bytes` rather than `String`. Three compile errors, and the first sign of any of it was a red
  CD with `Deploy to Production Server` skipped.

  Production was never affected - the deploy is gated on every image building, so it did not run and
  the running containers were left alone. What WAS affected is that nothing shipped at all while this
  stood, including the backend bun migration whose images had built and pushed successfully.

  The code is adapted rather than pinned back. webrtc-rs dropped `credential_type` following the W3C
  spec, which removed `RTCIceCredentialType` once `password` became its only value, and the rule it
  encoded now lives inside the crate: `RTCIceServer::urls()` returns `ErrNoTurnCredentials` for a
  `turn:` URL with an empty username or credential. That is a behaviour change, not a rename - the
  same input used to yield an `Unspecified` credential type the crate accepted, and now fails the
  entire ICE configuration - so `build_rtc_ice_server` keeps the test and warns, because it is the
  only place left that can name WHICH server was misconfigured.

  `apps/call-service` is now in the Rust matrix WITH the `check` flag, so `cargo fmt --check`,
  `cargo clippy --all-targets --all-features -D warnings` and `cargo test` all run on it. All four
  were run against the crate by hand first - the entry is not an unverified guess, which is the
  reason the neighbouring Tauri entry deliberately omits the same flag. That leaves no crate in this
  repository that CI does not compile.

- **`core-service` carried three high advisories that its three sibling services did not.**
  `fast-uri` sat at 3.1.2 in `apps/core-service/bun.lock` and at 3.1.6 in the other three, reached
  through `@nestjs/cli` and `@nestjs/schematics` via `ajv`: host confusion through a backslash
  authority introducer, through a literal backslash delimiter, and through failed IDN
  canonicalisation. Four lockfiles for four services is exactly the drift `dependabot.yml` groups
  against, and the grouping does not repair a resolution that was already stale. Bumped within
  range; the audit job passes.

- **A TestFlight build launched to a black screen**, failing every request with Tauri's own
  `Failed to request https://127.0.0.1:1420/: ... did you grant local network permissions?`.
  `ios-release.yml` bypasses `tauri ios build` for its own release archive step (that CLI's export
  step cannot express this project's two-target manual-signing profile map) and instead calls
  `cargo build --lib --release` directly for the static lib - but `tauri ios build` is also what
  normally enables the `tauri` crate's `custom-protocol` Cargo feature, and `tauri-build` derives its
  `dev` cfg from exactly that feature (`dev = !has_feature("custom-protocol")`). Without it, the
  release binary compiled as a dev build regardless of the cargo profile, and pointed the webview at
  the Vite dev server instead of the bundled frontend - unreachable from a real device. The build
  step now passes `--features tauri/custom-protocol` explicitly. Android never carried this risk:
  `android-release.yml` builds through the real `bun tauri android build` CLI, which sets the feature
  itself. [cicd](docs/wiki/cicd.md#a-raw-cargo-build-for-the-static-lib-must-ask-for-custom-protocol-itself)

  That fix immediately surfaced a second, latent bug: with `custom-protocol` enabled, Tauri's
  `generate_context!()` macro embeds `frontendDist` (`../build`) into the binary at compile time and
  **panics if the directory doesn't exist** - it only skips that check in dev mode
  (`dev && dev_url.is_some()`, `tauri-codegen`'s `context.rs`), which this build no longer compiles
  as. "Prebuild Rust static lib" ran *before* "Build iOS archive", the step that actually runs
  `bun run build` to produce `../build` - an ordering that only worked by accident while the build
  was silently compiling as dev. The Vite build now runs in its own step, ahead of the Rust compile.

  Getting the fixed build published for v0.14.5 needed one more detour: `gh run rerun` replays a
  run's workflow definition as it existed at that run's ORIGINAL trigger, never the current file on
  `main`, so the failed automatic run could not be resurrected in place - a fresh `workflow_dispatch`
  was the only way to compile against the corrected file, but `workflow_dispatch` runs deliberately
  skip the publish steps ([cicd](docs/wiki/cicd.md#a-manual-workflow-run-is-the-only-native-compiler-available-off-macos)).
  That gate was widened for one recovery run (reverted immediately after), which then hit a third,
  unrelated snag: `softprops/action-gh-release` 403s on a `refs/heads/main` lookup that only happens
  under `workflow_dispatch` (`github.ref` is the branch there, not the release tag) even after
  already finding the release by `tag_name` - and that failure was blocking the next step,
  TestFlight, from running at all. Made non-blocking for the same recovery run. v0.14.5 reached
  TestFlight on the second recovery attempt.
- **Four backend lock files were out of sync with their `package.json`, and it had silently blocked
  every deploy for two hours.** `npm ci` refuses to install when the two disagree, so
  `Test TS Backend (apps/chat-delivery-service)` and `Check Dependencies Vulnerabilities` both died
  on `Missing: @emnapi/core@1.11.3 from lock file` before running a single test or reading a single
  advisory - and because the CD workflow gates the deploy on CI, the deploy job never appeared at
  all. Two consecutive runs went red that way and production stayed on the bundle from 18:02 while
  two merged fixes waited. The locks of all four services (`chat-delivery-service`, `core-service`,
  `media-service`, `social-service`) now carry the two transitive optional packages a dependency
  bump had introduced without regenerating them, and `npm ci` validates in each.

  What made this expensive is that **the failure named a package, and the consequence was a deploy
  that did not exist.** A missing deploy job reads as "nothing to deploy", not as "the gate refused
  it", and neither red job's name mentions installing dependencies. The lesson is the general one:
  when a pipeline stops producing an artefact, read the JOB LIST for what is ABSENT before reading
  any log for what failed.
- **An external joiner's own commit locked the next joiner out of a Graine distribution group.** A
  member with no MLS state joins a salon's key-distribution group by external commit - which advances
  the group's epoch by one, and so makes the very base it just built on stale. The base for the new
  epoch was minted by a SECOND round-trip issued after the join returned (`refreshGroupInfo`),
  fire-and-forget by design so a successful commit is never reported as failed because a follow-up
  did not land. But an external joiner reloads by construction, and nothing else in the system ever
  mints a base: the published one then trailed `activeEpoch` for good, the strict commit gate
  (`baseEpoch == activeEpoch`, nothing else) refused every later external commit, and a distribution
  group has no peer-Welcome fallback to take instead. On 2026-08-26 the campaign's COMM-22 row
  reproduced it on two builds: the peer read 11 of 12 messages warm AND cold, the twelfth seed simply
  absent because the peer was never in the group at all, and the repair a holder eventually performs
  (`republishStaleBase`) fired 14 seconds after the refused peer had already given up.

  **The window is deleted rather than narrowed.** An external commit is applied to the returned
  instance at once, unlike a staged add or remove, so for one moment the joiner holds the tree for the
  epoch its own commit created and can export a base for it - before merging, which is the only
  moment that base can be handed over in the same call as the commit. It now travels inside
  `POST /api/mls/commit`, and chat-delivery writes it with the epoch advance in ONE transaction. There
  is no follow-up call left to lose, so the reload that used to take it takes nothing; the
  fire-and-forget refresh after an accepted external join is gone rather than kept beside it. A client
  whose instance is not at exactly `base + 1` refuses to publish and abandons the join instead - the
  stored base is monotonic, so one blob under the wrong epoch would strand the group permanently,
  which is worse than the staleness it replaces. Narrowing was considered and rejected in writing: a
  two-member salon whose other member is offline still has nobody to mint the base, and a shorter race
  is still a race. Ordinary staged commits keep the follow-up for now - their commit is unapplied at
  submit time, so there is nothing to export - and what would close that half is recorded in
  `docs/wiki/backlog.md`. Proved by a new `mls-core` integration test in which a fourth device holding
  NOTHING joins on the base the joiner exported and messages converge, by three server specs, and by
  two client specs, one asserting that nothing follows the submission at all
- **A server-log rule that had never seen the line one invitation writes.** COMM-4's window of
- **The app was never actually excluded from an Android device-to-device transfer.** A second
  Google Play mail on 2026-08-26 announced a migration requirement, and looking at ours found the
  refusal had never been wired up. `res/xml/data_extraction_rules.xml` excludes `domain="root"` from
  both `<cloud-backup>` and `<device-transfer>`, and said in its own comment that the manifest
  referenced it - while the manifest's header listed `dataExtractionRules` among the attributes
  never to restore, blaming a merge conflict. Each file read as though the other had it covered, and
  nothing read the rules. **`android:allowBackup="false"` does not close that**: it is deprecated
  from Android 12 and, per Google's own documentation, disables cloud backup on some manufacturers
  without disabling device transfer - and where no `<device-transfer>` section is declared, that
  mode carries everything outside `cache` and `no-backup`. Both are now set, `tools:replace` names
  both, which is all the merge conflict ever required. What a transfer would have moved is not so
  much a leak as a broken install: Keystore material is non-exportable, so the new phone would
  arrive holding this device's MLS state without the key that seals it, when the product's answer
  for a new phone is to enrol as a new MLS client and be re-invited. Found by the resource shrinker
  switched on an hour earlier, which reported `xml:data_extraction_rules is not reachable`; it now
  reports `reachable from AndroidManifest.xml`.

  2026-08-26 held a single `unexplained` line, `[INTERNAL_MLS_DEVICES] user=... count=1` - the
  count social-service asks for before a direct invitation, because it may not call the user route
  that answers the same question behind an Nginx-minted HMAC. Expected and necessary, missing only a
  rule, so the row read `PASS-DIRTY` on noise that was the path working. Classified now, split the
  way its `failed=` neighbour is: `count=[1-9]` is benign, `count=0` is NOTABLE - an invitee with
  no device inside the retention window still gets the membership, and the key DM behind it has
  nowhere to go, which is a finding and not routine. Both halves asserted in
  `srvclassify-selftest.mjs`, on a fixture copied from that window rather than remembered.

- **The four lines a salon going public writes, and the fifth that must stay unexplained.** COMM-24's
  window held five `unexplained` social-service lines, all five of them the transition the row exists
  to drive: a private salon's key group appearing, that group retired `reason=made_public`, and the
  two access lines that opened the salon to everyone. Four are now NOTABLE and never benign - the
  retirement of a key group and a change to who may read or write a salon are the loudest quiet
  events in that service, and `reason=` is pinned so a retirement for a reason this rig has never met
  arrives under its own name. **The fifth was left alone on purpose.**
  `served ... published=false base=none active=0 devices=0` is the ordinary answer one second after a
  salon is created - and also, word for word, what BOTH callers of the concurrent-join race read, a
  race this shape is the only detector for. Nothing in the text separates them, so pinning it to
  clean the row would have traded a detector for a cell. COMM-24 is recorded `PASS-DIRTY` with its
  dirt named, and the selftest now ASSERTS that the shape stays unexplained, so a later pass to
  "finish the job" fails loudly instead of quietly succeeding.


- **A notification avatar is no longer decoded at whatever resolution its owner uploaded.** Google
  Play's release analysis flagged `BitmapFactory` without subsampling in
  `CanariFirebaseMessagingService.fetchAvatar`, and it was right for a reason worth stating: the
  bytes come from MiGallery, through core-service, through `/api/mls/push/avatar`, and **no hop in
  that chain carries a size parameter** - so the decode was sized by an input nobody here bounds.
  Worse, `circleCrop` then allocated a SECOND `ARGB_8888` bitmap at the source's own shortest edge,
  so a 3000x3000 photo cost about 36 MB twice over, inside the FCM service process, for an icon the
  framework draws at `notification_large_icon_width`. Running out of memory there does not soften
  the icon - it loses the notification, which is the whole point of that process. `decodeSampled`
  now reads the header with `inJustDecodeBounds` (no pixels allocated), picks the largest
  `inSampleSize` still at or above that platform dimension, and `circleCrop` takes the remaining
  factor of under two by scaling its draw to a target passed in rather than copied from the source.
  Both call sites route through one helper, so neither carries a copy of the logic, and the initials
  disc keeps its own 96 px - that number is a three-platform contract `initialsFallback.test.ts`
  pins against the two Apple copies, not the avatar branch's business.
- **The Android window background is the app's own colour, and had never been set at all.** The
  WebView is deliberately transparent so the Activity background shows through while SvelteKit
  hydrates - that is the startup-flash fix - but the theme declared no `windowBackground`, so what
  showed through was the parent theme's grey `colorBackground` while `app_background` sat defined in
  `values` and `values-night` and referenced by nothing. It is now the theme's
  `android:windowBackground`, which is also what the Android 12+ system splash paints behind the
  icon. `values-night/themes.xml` is deleted rather than updated: `@color/app_background` already
  resolves per configuration, so a second identical style said nothing.
- **"Donner un statut avec le paiement" says which of its four conditions is missing.** The setting
  appears only on a paid form, with a beneficiary association chosen, that runs at least one
  cotisation tier, and only to someone holding `MANAGE_MEMBERS` on it - four conditions ANDed, of
  which the screen named three and the fourth nothing at all. So a manager holding everything except
  `MANAGE_MEMBERS` read "disponible sur un formulaire payant dont l'association gere une cotisation"
  while looking at exactly that, and had no way to find out that the permission was the answer.
  `cotisationGrantBlocker` returns which condition failed, in the order a manager fixes them, and
  each has its own sentence; the permission one names the association, because it is that
  association's members the right governs.

- **The conversation list could not be scrolled on Android, and its pull-to-refresh spinner stood for
  nothing.** Two defects behind one gesture, and the first was not the gesture. Measured on the
  device: the list ran from y=170 to y=914 in a 914px viewport - the full height - while the bottom
  nav is `fixed inset-x-0 bottom-0`, out of flow, painting over its last 4rem. With nine
  conversations the content fitted (698px in a 744px box), so `scrollHeight === clientHeight` and the
  browser was correct that there was nothing to scroll; the row under the bar was simply unreachable,
  for ever. `.page-scroll-wrap` reserves the nav's height for every ordinary page, and
  `.page-scroll-wrap:has(.app-layout)` zeroes that padding so the chat shell can be exactly one
  viewport tall - cancelling the page scroll cancelled the only reservation that existed for a bar
  that reserves nothing itself. A documented `.mobile-nav-inset` now carries it on the chat shell's
  own scrollers, mirroring the nav's mount conditions so the reserved space never becomes a dead zone
  the bar does not occupy. Second: pulling down showed a spinner whose handler slept 600 ms and
  returned, on the reasoning that the visibility watchdog would reconnect eventually - a timeout
  standing in for work. The list is fed by the WebSocket, so while the socket is up it is already
  current and the gesture now declines outright rather than spin over nothing; while it is down the
  backoff ladder can be up to 30s from its next rung and the pull is the user asking for that rung
  now, so it calls `attemptReconnect` and the spinner lasts exactly as long as the reconnect and its
  sync. The action gained an `enabled` gate asked once per gesture, pinned by seven tests - including
  the one that proves an upward drag is still left to the scroller, which is the half of the report
  this code was NOT responsible for.

- **A device revoked while it was offline logged straight back in and kept everything.** Revocation is
  defined as a wipe, and the wipe was written, thorough and correct - it was simply never asked for on
  two of the three ways into the app. `resetRequired` rides on the server PIN check, and the biometric
  and vault paths skip that check on purpose (the keystore and the encrypted device-key vault ARE the
  authentication factor), so they skipped the revocation question with it. The only remaining trigger
  was a `device_revoked` control frame - sent, by definition, to a device that was not there to
  receive it. Every login path now resolves its real device id and asks the route that already existed
  to answer this, `/api/mls/devices/:userId/:deviceId/revoked`, before `init()`; the read decrypts
  nothing and answers `false` when the server cannot be reached, so an offline login can never be
  wiped by a transport failure. The consequence is now ONE function shared by all three triggers,
  which also gave the control-frame path the MLS teardown it had been skipping - on the one path where
  the service is still live and could write a key back mid-wipe. `isDeviceRevoked` takes its ids as
  arguments for the same reason: a question that decides a wipe must not read fields that are still
  `unknown`/`pending` before init. Found by reading the P1 that reported the symptom, not by a run;
  the two candidate causes of the user's own case that survive this fix are in
  `docs/wiki/backlog.md` and belong to HEAL rung 16.
- **A revoked member's device reported its own revocation as a network problem, then reconciled and
  asked for history on the salon it had just been refused.** `joinDistributionGroup` concluded from
  local state before classifying anything, so EVERY refusal of `getDistributionGroup` reached the
  "a held group survives a failed read" branch first - and 403 on that route is not a failed read,
  it is the server ANSWERING, on membership of the scope, which is the whole reason a distribution
  group's GroupInfo is served by social-service rather than by chat-delivery. A device holding the
  tree therefore logged `keeping the one this device holds`, the sentence written for a lost packet,
  and then spent two more round trips on a scope it had no entitlement to. The status had been
  carried on `ChannelApiError` since that class was introduced and nothing read it - the third time
  in this seam that the discriminator was already present at the throw and flattened one layer up.
  The three answers are now separated BEFORE local state is consulted, and only the refusal that
  says nothing about entitlement is allowed to fall back on what the device holds. The 403 line
  accuses, because reaching it means two server routes disagree: the walk that gets there skips a
  salon whose channel DTO says the viewer has no access, so a refusal here contradicts the DTO that
  selected the salon. It deliberately does NOT drop the tree - dropping key material on one answer
  is a destructive repair owing its own evidence, and the revoke has already deleted the delivery
  rows that would make the tree worth holding. Found by reading WP-REGRANT-2 rather than by a run;
  the test that required `could not read` for a 403 was pinning the defect and now asserts the
  classification.
- **Joining a group by INVITATION LINK evicted the joiner about half the time, because the joiner
  both asked a member for a Welcome and served itself one.** `requestReAdd`'s external-commit join
  was written for a device that had joined once and lost its local state; an invited device, whose
  membership is still `pending` and for whom a member ALREADY owes a Welcome, reached the same code
  path indistinguishably. Both parties then added the same leaf to the same tree: the member's
  `addMember` failed `DuplicateSignature`, its duplicate-leaf repair removed what it read as a stale
  leaf - the joiner's LIVE one - and the Remove evicted the device that had just got in. Measured on
  2026-08-26 as GRP-4 on build `9553c856` - four failures and four passes over eight runs - from three
  independent logs rather than inferred: the joiner's console
  (`externalJoin` at `baseEpoch=1`), the server (a `WELCOME_REQ` FORWARDED to a member in the same
  second, then that member's two commits and its `[KICK] Reset device ... to pending`) and the
  inviter's console, whose SILENCE was itself evidence once we confirmed the repair's own log line
  carries the group id the filter was scoped to. The overlap is deleted rather than reconciled:
  `requestReAdd` now reads the `pending`/`active` discriminator through `getDeviceMemberships`,
  which already carried it end to end, so no server change was needed - and a status it cannot read
  is a THIRD answer that skips the round, never a "not pending" that would send the invited
  population back down the racing path on exactly the conditions where it loses.

  **The re-admission that should have healed it was dropped as a duplicate, and that half is a
  defect on its own.** The Welcome idempotence guard asked whether the group was held locally, which
  stays true for an EVICTED group still sitting in the WASM store - so every Welcome re-admitting a
  device was discarded as a redelivery. This is reached by any legitimate kick-and-re-add, which is
  precisely the outcome the duplicate-leaf repair is designed to produce, so it would have outlived
  the race that exposed it. The guard now separates held from usable via `isGroupActive`, forgets the
  evicted state before processing so the new Welcome installs on nothing, and keeps the idempotent
  path when membership is merely UNREADABLE. `getDeviceMemberships` stopped answering `[]` for an
  unreachable server, since a caller now decides on the difference between "no row" and "I could not
  tell".

- **The server classifier stopped matching the sentence the server writes, and the self-test that
  should have caught it spoke the same dead dialect.** The COMM-8 fix made
  `[DISTRIBUTION_GROUP] read`, `[DISTRIBUTION_GROUP] served` and `[CHANNEL_GRAINE] served` print
  `base=<n> active=<n>` - the whole point being that `published=true` answered "is there a base" and
  never "is that base usable". Four of `srvlog.mjs`'s BENIGN rules and the count-based
  `settleFirstLooks` predicate were anchored on the fields either side of the new pair, so all five
  stopped matching the moment it appeared. Every seed read in the estate then landed in
  `unexplained`, the server window was never clean whatever the checks did, and `--repeat` could not
  reach pass 2 on any phase - which is how a stale classifier stops a campaign rather than a
  product defect. The rules now READ the epochs: `base=(\d+) active=\1` is a backreference, equal
  is the healthy answer and is forgiven, and `base < active` - the stale-base condition itself -
  cannot match and stays visible under its own name, so the rule cannot launder the defect it was
  widened past. `published=false` has no base to be stale and prints `base=none`, so the two
  spellings are disjoint branches rather than one loose pattern.

  `[DISTRIBUTION_GROUP] served` had TWO rules for one line, 140 lines apart. They went stale
  together, and repairing either gave no reason to look for the other - the duplicate is deleted and
  the survivor carries both spellings. The self-test stayed green throughout because its fixtures
  were copied verbatim from production in August and were never refreshed when the server moved: a
  fixture is only evidence for the sentence the server writes TODAY. Refreshed, and the three cases
  the epochs exist for are now pinned - a stale base in `unexplained` for both services and both
  field orders, and a pre-epoch read proving `settleFirstLooks` settles nothing once the dialect
  moves, which is a failure mode a count-based rule has and a per-line rule does not.

- **The external-join base of a private salon was minted by a fire-and-forget call from one device,
  and nothing else ever minted another - so losing that one call locked every other device out of
  the salon for ever.** COMM-8 measured a web client submitting the same external commit to the same
  salon for twenty minutes, refused `epoch_mismatch` every time. The commit gate accepts a base whose
  epoch equals the group's active epoch and nothing else, which is correct; what was wrong is who
  publishes that base. `runCommitTransaction` advanced `dm_groups.activeEpoch` and then fired
  `void this.refreshGroupInfo(...)` from the one participant whose acknowledgement may never arrive -
  a closed tab, an offline moment, a refused refresh - and `mls_group_info.baseEpoch` stayed behind
  permanently. A distribution group is entered ONLY by external commit; it has no peer-Welcome
  fallback by construction. So a member entitled to the salon, holding no local MLS state, was
  refused on every attempt, for ever, with a retry loop making it look like a transient race.
  **Five distinct causes arrived at every caller as one `false`**, which is why the loop written for
  the one that can change was taken for the four that cannot. `externalJoin` now returns a TYPE -
  `no_base_published`, `stale_base` (with both epochs), `build_failed`, `unreachable`, `refused`
  (with the server's own reason) - and each is acted on differently. `readGroupInfo` and the internal
  distribution-group route serve `activeEpoch` beside `baseEpoch`, so the fact travels to the client
  from where it is already known: a joiner reading a base behind its group now declines before
  building anything, instead of learning it by being refused. A commit-gate call that never landed is
  `unreachable` and claims nothing about membership, where it used to be relabelled an epoch race and
  retried against a server it had never reached.
  **The repair is a HOLDER's ordinary read, not a timer and not a sweep.** Every member's normal load
  of a scope it is already in compares the two epochs the server now hands over, and republishes from
  the tree it holds when the base is behind - idempotent because the far side is monotonic, free in
  the common case where the numbers agree, and terminating on a proof the server itself supplies
  rather than on an attempt count. A device whose own tree is behind the group declines and says so
  instead of publishing an equally unusable base. Both new lines accuse: reaching either means
  somebody is currently locked out of a scope they belong to, and their rate is what says whether a
  lost republish is rare
- **The answer to a seed request was thrown away because the device that had just asked for it had
  no socket yet.** A device joining a group after a message was sealed cannot open that message, by
  construction, and asking a peer for the seed is the mechanism that exists for it. COMM-18 measured
  the ask working and the ANSWER being discarded: the reply went out as `DELIVERY.transport`, which
  the server delivers only to recipients Redis presence reports online, and a client that cold-starts
  has authenticated HTTP long before it has a WebSocket. Across sixteen seconds in which the gateway
  logged no connection for the phone, that phone registered for push, landed an accepted commit and
  published a GroupInfo - demonstrably alive, truthfully absent from presence. Both answers were
  dropped, permanently, and nothing asked again.
  **The presence read was not the error; the classification was.** `DELIVERY.transport` is justified
  by circularity - reconciliation traffic only restates state held elsewhere, so replaying it from
  the shared log would be circular. That is true of a REQUEST and false of the seed itself.
  `DELIVERY.keyMaterial` (silent AND durable) already exists for precisely this payload on precisely
  this group, and `seedDistribution` already sends the ordinary distribution of a seed that way -
  only the answer to an ask did not. An answer carrying seeds now travels as key material, so it is
  queued for a recipient regardless of what presence says, while a bundle of pure declines stays
  transport: it holds no key material and restates a fact the requester can derive, and a
  distribution group's capped log is spent on seeds alone. No timer, no retry, no new wire field -
  the reachability of a requester is carried by the request that arrived, and is no longer
  re-derived from a socket at answer time. The answer's log line now names which class it used,
  because a run log that omits it cannot tell a drop from a silence
- **A salon whose access list was edited told nobody, so being let in was a database row and
  nothing else.** `updateChannelAccess` computed who a save DROPS - and cut them off one line later -
  and had no counterpart for the people it ADDS. Every other grant in that file publishes
  `channel.member.joined` immediately after the row changes, and for a precise reason: that event is
  the only one which both puts the salon on the recipient's screen and, when it is private, enters
  their device into its key-distribution group. Without it a re-granted member waited for their next
  full page load, and a private salon they had been let back into delivered nothing until then.

  **Three populations hear about it, for two different reasons, and only one of them is a diff.**
  A private-to-private edit announces the users named now and not before. A public salon turning
  PRIVATE announces its WHOLE roster, because `allowedUsers` is evidence about who could SEE a salon
  and never about who is on its group - that group was minted seconds earlier by the same request and
  holds only the flipper's leaf, so diffing the rosters there answers a question nobody asked.
  Measured on production 2026-08-25 (COMM-23): one delivery row and epoch 0, against two rows and
  epoch 1 on the create path. A private salon turning PUBLIC announces the community members who
  could not see it before: there is no group to enter, but `channel.updated` maps over the rows a
  client already holds and creates none, so the salon simply was not on their screen at all until a
  reload. That mirror image was found by reading the client's handler rather than assumed, and one
  mechanism covers all three.

  The event deliberately carries no `invitedBy`/`joinedBy`: a receiving client writes an "X added Y"
  line into the transcript when both are present, and this is a settings-panel roster edit rather
  than an invitation - carrying them would have written one line per member into the transcript of a
  salon nobody had joined.

- **A device that dropped a stale distribution group and then failed to re-join reloaded straight
  back into it, and never read that salon again** (WP-REGRANT-2). The re-join path forgets the tree
  the server no longer routes to and joins afresh. Neither half was ever written to disk - the walk
  that loads a community does not checkpoint, the MLS layer's join path does not, and the roster
  reconciliation that runs immediately afterwards persists only when it actually removed a leaf,
  while its own comment claimed to be persisting "for the same reason the join is". So the failure
  mode was never the join failing: it was the FORGET not surviving. Measured on production
  2026-08-25, one second after `could not join the distribution group of salon 5b08828d`, the same
  device logged `[SYNC] WASM kept` for the group it had just forgotten - the checkpoint restored
  exactly the belief the forget existed to destroy, and from there the device held a group nothing
  was routed to, took the early return on every later pass, and stayed silent for the rest of the
  session.

  One checkpoint now sits where the tree actually moves, on BOTH outcomes. The failing one is why it
  exists: a forget followed by a failed join is the only state where memory and disk disagree about a
  belief that is WRONG, and a reload resolved that disagreement in favour of the wrong side.
  Persisted, the same failure leaves a device holding nothing for the scope - which is the state
  every existing trigger already repairs, so this is durability rather than a retry, and there is no
  new timer and no heal. It is conditioned on the tree having changed rather than run
  unconditionally, because a load whose salons are all already joined takes the early return above
  and must not pay an Argon2 pass per salon for a tree nothing touched. A converged join was not
  durable either, so every reload had been paying for a fresh external commit and leaving its
  previous leaf standing.

- **A dropped transport frame reported a COUNT and no device, so the two causes it has could not be
  told apart.** The delivery service addresses a transport-only frame to whoever Redis reports
  online and drops it for everyone else, which is right - the rendezvous it belongs to expires in
  60 s. But "that device really was offline" and "the group named a device that is not the live one"
  both arrive as `count=1`, they call for opposite fixes, and separating them meant reading Redis by
  hand against a group the run had already deleted. Measured on 2026-08-25 (COMM-18): a phone's seed
  request was dropped for one offline recipient while the only device it could have meant was
  answering pings throughout. The line now names the device ids it skipped - the same ids the
  presence lookup was keyed on, so they are the evidence it owed.

- **A second device of your own could never obtain a seed your first device had minted, so its
  messages stayed permanently unreadable.** The Graine repair path - the mechanism a device uses
  when it meets a message whose session it holds no seed for - excluded the asking user by name, on
  the reasoning that "a request addressed to us reaches only us, who are asking precisely because we
  do not hold it". That reads a USER as a DEVICE. A request carries an `answererUserId`, the frame
  handler matches it against the reader's user id, and MLS never hands a sender its own message
  back: addressed to ourselves it reaches our OTHER devices and nobody else - which is exactly where
  the seed is when our own laptop minted it. Both halves of the repair had the same hole
  (`resolveAnswerer` for a named session, `requestCommunityHistory` for a joiner's catch-up, whose
  "no other member to ask for history" was reached for any community whose only member is you), so a
  community you are alone in had no candidate answerer at all and a newly installed device read
  nothing in it, for ever.

  Measured on production 2026-08-25 by COMM-18: a phone cold-started into a community its own owner
  had just created, landed in the right salon, and rendered zero messages - the message on the
  server, `seeds: {held: 0, received: 0}` on the phone, `no reachable holder` in its log, and the
  laptop that held the seed online in the same distribution group. Nothing was wrong with the deep
  link, the landing or the rendering; the seed simply had no route, because MLS forward secrecy
  correctly denies a device that joined at a later epoch the frames of an earlier one, and repair is
  the only route there is.

  We are now a candidate answerer whenever another device of ours is on the distribution group -
  FIRST when one of them minted the session, LAST when a named member might hold it, because a
  device that merely happened to be online is a weaker guess than any member. The fact comes from
  the server's `memberDevices`, which answers exactly this question and is the only authority on it;
  the read fails OPEN, like the sibling bandwidth decision it sits next to, since a wasted frame
  costs one transport message and refusing to ask costs a message nobody can ever open. The walk
  still terminates on a proof: a decline is recorded per user id, so our own devices are a finite
  candidate like any other, and the give-up line now says WHICH exhaustion it is.

- **ONE SERVER ROW WAS DECRYPTED TWICE AND THE SECOND DECRYPT SPENT A SECRET ALREADY CONSUMED.** A
  frame reaches the client by two independent channels - the live WebSocket pushes it, and
  `/pending` hands back everything not yet acknowledged - and nothing made them the same event. On
  2026-08-25 COMM-4 measured exactly that: `qId=d4ecf0fe` drained from the socket and absorbed, then
  `[PENDING] Fetched 1 pending messages` returning the identical row, then `SecretReuseError` and the
  heal that acknowledges the frame as unreadable for good. The frame was fine; the second read of it
  was not. MLS ratchet secrets are single-use by design, so a duplicated delivery is not a wasted
  cycle, it is a message the client then declares permanently undecryptable and drops - the user
  loses it and the heal makes the loss look handled.

  Fixed at the seam both channels share rather than by widening any classifier: `enqueueMessage` now
  admits a delivery by its server queue id, which is that row's identity, and a repeat is logged and
  re-acknowledged instead of decrypted. `queued` and `done` are kept apart because they are different
  answers to a repeat - one is "the other channel is mid-flight", the other "it is settled, ack it
  again" - and a delivery the drain deliberately left UNacknowledged (a Welcome that could not be
  processed yet) is forgotten, so `refetchFramesLeftBehind` still brings it back on reconnect. A
  frame the server never persisted carries no id and is always admitted. The memory is bounded at 512
  ids. The raw failure is deliberately still `severe` in the harness if it ever arrives by another
  route.

- **A CLOSED CHANNEL POLL STAYED OPEN FOR EVER ON EVERY SCREEN, because two clocks answered one
  question.** Closing a poll writes `endsAt = new Date()` - the SERVER's now - and the card decided
  "is this over?" with `new Date(endsAt).getTime() <= Date.now()`, its OWN now. Production's clock is
  0.2 to 1.1 s ahead of a client here, so at the one instant the card recomputes, the freshly written
  deadline is still in the client's future and the comparison comes out false. `Date.now()` inside a
  `$derived` is not reactive to time, so nothing ever re-runs it: measured on 2026-08-25 (COMM-15),
  both the author's client and the peer's rendered "0 min restante(s)" indefinitely while the server
  refused every vote into that same poll with a 403. A sub-second skew is enough, which is what makes
  this architecture and not NTP - and no timer would fix it, because a card that re-read the wrong
  clock would merely be wrong later.

  The server already decides closedness, with the clock that wrote the field, in order to refuse
  those votes. It now SAYS so: `ServedChannelPollMeta` adds `closed`, stamped at every hand-out site
  (history, the creation broadcast, the vote and close responses and their broadcasts) and never
  persisted, because it is true of an instant and not of the row. `PostPolls` correspondingly stops
  owning the decision - `isOver` is now an input, since only the caller knows whose clock its
  deadline came from: a channel poll takes the server's statement, a post poll compares an
  author-chosen date that is hours out. Three server tests pin it, including that the statement is
  not written to the row and that an open poll answers `closed: false` (so `closed` is an answer,
  not a marker of the close route). The countdown still does not tick, so a poll whose deadline
  passes while the card is on screen flips only on reload - a rendering item, deferred and recorded
  in [`backlog`](docs/wiki/backlog.md), and no longer able to hide behind this defect.

- **THE CHANNEL NOTIFICATION PANEL ASSERTED AN ANSWER IT DID NOT HAVE, so setting a level could
  silently set nothing.** `notifLevel` was seeded `'all'` and kept its previous value across
  reopens, so a member stored at `mentions` was SHOWN `all` while the read was in flight - and any
  caller that skips a click when the level already looks right therefore skipped it. That is exactly
  what COMM-14 measured on 2026-08-25: `asked=all stored=mentions`, a check unable to arm its own
  case. The same seed made a failed read indistinguishable from a real `all`, because `catch`
  substituted `'all'` for the value it had not obtained - and `notifLevels` is jsonb where an absent
  channel genuinely defaults to `all`, so the invented value was not even implausible. The level is
  now `null` until the server answers, the radiogroup mounts only once it has, and a failed read
  logs and shows nothing rather than choosing on the member's behalf. The harness's
  `openChannelSettings` waits for that group, which makes its presence mean the answer arrived.

- **AN UNPUBLISHED DISTRIBUTION GROUP HAS NO ROSTER TO DISAGREE WITH, and reading its emptiness as
  an eviction handed a race a destructive repair.** `joinDistributionGroup` treated "the roster does
  not list this device" as the server having forgotten it, and rebuilt the group. But `groupInfo` is
  null exactly while no client has initialised the MLS group, which is also before any delivery row
  exists - so the empty roster was the state BEFORE an answer, not a negative one. One COMM run on
  2026-08-25 hit `published=false devices=0` 74 times, on a salon that same run had created minutes
  earlier. The server derives its own `published=` from that very field, so the discriminator was
  already on the wire; the predicate simply did not carry it to the decision. It does now, and the
  branch that used to repair destructively logs instead - a roster that agreed and a roster that
  could not answer yet must not reach a run log looking identical.

- **ONE LOG SITE, FOUR CALLERS, AND THE CLASSIFIER KNEW ONE OF THEM - so a 5-pass run stopped on
  thirteen pushes that all left correctly.** `srvlog.mjs` filed `[PUSH_SEND][...] FCM sent` as
  `notable` through a rule keyed on `send-`, but that line is written at one place
  (`messaging.service.ts:490`) reached by four entry points, each of which labels the trace after
  itself: `send`, its own deferred retry `send-...-def`, a Welcome `welcome-send`, and a reactivation
  catch-up `reactivate`. The same successful push therefore read as a known event from one entry
  point and as `unexplained` from three. GRP's window of 2026-08-25 held eleven `welcome-send-` and
  one `reactivate-`, which is what a group build with an Android member IS, and the run stopped at
  pass 1 of 5 on them - correctly, by its own rule, on an instrument fault rather than a product
  one. This was the THIRD consecutive GRP attempt stopped by the rig and not by the product.

  The rule is now keyed on the site's shape, which is the same repair the BENIGN twin two hundred
  lines above had already been given for exactly this reason - in an edit that missed this one. The
  neighbouring `PUSH_DEFERRED` rule is deliberately NOT widened: `scheduleDeferredPush` has one
  caller, so `send-` really is its site's shape and widening it would forgive an entry point that
  cannot exist. Two lines the same window left unclassified are read and named rather than
  quietened - `[ACTIVATION_REDELIVER][reactivate-...] redelivered=N`, notable because it means a
  device that was `pending` is being re-notified, and `[PUSH_REFRESH]`, benign because it says a
  token was stored and not that a notification was attempted. Seven cases are pinned in
  `srvclassify-selftest.mjs`, including the caller a live window can never show, because a caller
  nobody exercised does not appear as a gap - it appears as nothing at all.

- **A dev-facing log line in the delivery service was in French.** `[ACTIVATION_REDELIVER] ... echec:`
  is now `FAILED:` - the failure twin of the line above, found while classifying it.

- **THE TEST RIG TURNED A FINDING ABOUT THE PRODUCT INTO A HARNESS ERROR WITH NO EVIDENCE BEHIND IT,
  AND KEPT MEASURING AFTER IT.** Two GRP checks established the same precondition - the peer is in the
  roster after an Add - by throwing when they could not find it. The throw skips `recordObserved`,
  which is the only thing that drains the two clients' consoles into the row, so GRP-8's pass 2 of
  2026-08-25 left a **five-line log**: the verdict tail and nothing else, for the one failure whose
  cause could only be in those consoles. It also read as the harness's fault when it is not - the
  panel's `Retirer <id>` controls only exist once the peer is a MEMBER, so "no id outside the owner's"
  means either the Add never landed or it landed and the roster has not rendered it, and both are
  findings. They are now recorded, not raised: `identifyPeer` returns null, prints the roster count,
  and captures `Invitation en cours` while the panel is still open - which is the discriminator
  between the two. GRP-8 `break`s instead of throwing, so `rounds.length === 2` joined its assertion,
  a loop that ended early having satisfied `every()` vacuously until now. The 25 s post-condition
  added to `addPeer` the day before had reduced this failure's rate without closing it, since it ends
  in a swallowed timeout - the claim that it was fixed was too strong.

- **`--repeat` ran every pass after the one that had already answered the question.** The first
  imperfect pass settles the only thing the ladder asks - the phase does not pass, so it will be
  fixed and re-run from pass 1 whatever the rest say - and what the remaining passes buy is negative:
  a check that throws mid-scenario leaves the state it was holding, so `GRP --repeat 5` ran pass 3
  against an estate with a leftover group in it and its verdicts describe a fleet nobody configured.
  It now stops at the first pass that is not clean, prints the cross-pass table over the passes that
  did run, and says `STOPPED AT PASS n/N` - which is neither `CLEAN N/N` nor "not reproducible",
  nothing having been repeated. Cleanliness is deliberately the table's own notion (`PASS` or
  `SKIPPED`) rather than the `bad` counter beside it, which counts `verdict !== 'PASS'` and would
  have aborted every `READ --repeat` at pass 1 on two rows that are skipped by construction.

- **A CONVERSATION DELETED OFFLINE CAME BACK, AND THE GROUP HAD NEVER BEEN DELETED ANYWHERE.**
  `exitGroupAndCleanup` wrapped the whole server half of a delete-or-leave in one `try/catch` and then
  purged the local MLS state unconditionally, so "the server answered 404, it is already gone" and
  "there was no server at all" ended identically: the local state destroyed and nothing remembering
  that a DELETE was ever owed. The group stayed live in `dm_groups`, and the next
  `discoverMissingGroups` did exactly what it exists for - found a server group with no local row and
  handed it back as a placeholder. Measured on `c6eb7b20`: one DELETE attempted with the radios cut,
  zero on the first reconnect, zero on the second, the group still listed server-side.

  The purge stays unconditional, deliberately - a user who deleted a conversation must not see it -
  and what the fix adds is the record that was missing: a durable row per `groupId` in a new
  `pendingGroupExits` store (IndexedDB v8, SQLite schema 10), written BEFORE the call and cleared only
  by an ANSWER. Idempotence comes from the primary key, termination from the server's reply (a
  success, or a 403/404 saying it is already done) and never from an attempt count or a clock, and the
  trigger is `connectivity.onReconnect` plus one startup pass for an app killed while offline that
  will never see an `online` edge - registered at login beside the outbox, unregistered at logout. A
  reachable server that REFUSES keeps the row and logs at a level that accuses, because that is a
  server bug and dropping the row would hide it. One exported `classifyExitFailure` is the only place
  403/404/transport are read, so the drain and the composable cannot come to disagree - that
  disagreement being the same defect with its halves swapped - and discovery now declines to
  re-create a group whose exit this device still owes, logging the skip, because the row alone would
  not have stopped the placeholder.

  **The check that was supposed to catch this could not have.** `del10` counted
  `Network.requestWillBeSent`, which the browser fires with the radios cut - so an offline send read
  as an arrival, and the assertion "nothing was sent while offline" was being made against evidence
  that cannot distinguish the two. It now correlates `Network.responseReceived` by `requestId` and
  records the statuses, and reads `dm_groups."deletedAt"` over `psql` after the run, because whether
  the row is really gone is a question no amount of network evidence answers

- **THE PREFLIGHT READ THE PHONE'S BUILD AND ASSUMED THE BROWSERS'.** A browser left open across a
  deploy keeps executing the old bundle, and its console is indistinguishable from a reloaded one -
  so a phase measured code that was no longer deployed while every row still named the deployed
  build. `clientBuild()` read a client's build with a same-origin `fetch('/_app/version.json')`,
  which is the APK's own asset for the phone and a network round trip to production for W1 and W2:
  one function, two questions, and only the phone's was the one its doc claimed. Caught two minutes
  into `GRP --repeat 5` on 2026-08-24, when GRP-3 reported `PASS-DIRTY` on an `[OUTBOX] … evicted
  from …` line whose spelling had been replaced four commits earlier and appeared in none of the 205
  chunks production was serving.

  `bundle-id.mjs` had detected exactly this since the day it was written and `reload.mjs` had
  repaired it, and the only caller either had in the whole rig was a sentence in a comment inside the
  other - a detector nothing executes, enforcing a rule that lived in prose. Both now share one
  implementation (`bundle.mjs`), and the preflight asks the question before every job, because
  staleness is a per-check property: SvelteKit reloads on the next navigation once `version.json`
  changed, so a client is stale for an unpredictable prefix of a run and correct afterwards. A client
  already current pays one CDP connect; one that will not move is refused rather than measured.

- **ONE SENTENCE COVERED "A READ RECEIPT LOST A RACE" AND "A MESSAGE THE USER WROTE IS GONE FOR
  EVER".** `[OUTBOX] <id>… group deleted server-side - permanent failure` named neither what died nor
  why, so a reader meeting it had to go and find the entry by hand - and the classifier could not
  place it at all, which is why it came back `unexplained` in GRP-4, GRP-6 and GRP-7: three campaign
  rows dirtied by one unclassifiable line. The code already knew the difference. The statement
  immediately after the log exempts a `control` entry from marking the conversation deleted, because
  a reaction or a read receipt dying with its group costs nobody anything; a `text`, `reply` or
  `media` entry dying is a message that will never be sent.

  The line now reads `<kind> entry in <group>…, <cause> - permanent failure`, and the metric carries
  `entryKind` and `cause` - a metric that cannot separate the two cannot be alerted on either. The
  two eviction causes stay apart for the same reason: `evicted` learnt the removal from a FACT
  (`isGroupActive`), `evicted-late` learnt it from a REFUSED SEND, which means the fact-based path
  missed it, so a rate on the second measures that miss. The harness rules split on exactly that
  boundary and the self-test pins all six spellings - including the two that must remain
  unexplained, because a classifier widened to cover them would turn three checks green while a
  user's message quietly disappeared.

- **A GROUP WE HAD LEFT WAS CHASED ONCE A MINUTE, FOR EVER, AND THE SERVER WAS ANSWERING THE QUESTION
  THE WHOLE TIME.** `requestReAdd` runs on the SYNC_WATCHDOG's cadence for any group flagged not-ready,
  and it has exits: the group is absent server-side, the group is gone from local state, the group is
  tombstoned, the join succeeded. For one state - *the group exists and we are not a member of it* -
  it had NONE. `getGroupMeta` answers `ok`, so the absent arm cannot fire; the group is in local state,
  so that arm cannot either; `deletedAt` is empty because nobody deleted anything; and the join is
  refused. So it fell through to the welcome_request fallback, broadcast a request nobody could honour,
  and came back sixty seconds later - a 403 and a broadcast per minute, per left group, per client,
  terminating only if somebody else happened to delete the group. GRP-6 caught it because it watches a
  leaver for thirty seconds.

  The discriminator existed and was thrown away. `GET /api/mls/group-info/:id` is gated on a
  `dm_group_members` row and answers `403` when there is none - the exact question the recovery asks -
  and `externalJoin` was flattening that into the same `null` as *no base published yet*, which is the
  one state whose correct response IS to retry. Both ends of the chain were right; the middle hop
  dropped the distinction. The 403 is now `NotAGroupMemberError` **at the throw** (the type already
  existed, for the twin endpoint), it propagates through `externalJoin` instead of being swallowed by a
  `.catch(() => null)`, and it terminates the recovery through one seam, `stopRecovering`, shared with
  the tombstone branch. Termination is now a PROOF - the conversation is `removed`, so step 1 returns
  immediately, and `clearGroupNotReady` drops the group from what the watchdog enumerates - where
  before the only thing containing the loop was a 60-second throttle. The decisive test says exactly
  that: it clears the cooldown between two calls and asserts the second does nothing at all.

  The narrowing is tested from both sides, because over-reaching here is worse than the bug: 401, 404,
  500, 502 and 503 stay unclassified, a 503 still returns `false` and still reaches the fallback, and a
  `200` carrying `null` still retries. A deploy hiccup read as "not a member" would retire live
  conversations.

- **A RESTORED GROUP NOTICE CAME BACK AS AN ORDINARY MESSAGE BUBBLE FROM "Utilisateur".** `ChatMessage`
  carries `isSystem`, and nothing durable does: `StoredMessage` has no such column and neither does the
  encrypted payload a history bundle is built from. So every read path - a reload out of IndexedDB, a
  bundle copied from a peer - had to DERIVE the flag from the sentinel sender, and the paths that did
  not rendered a "X a rejoint le groupe" notice as a chat bubble whose author no display name resolves,
  which is the unknown-user string. The sentinel is now one exported constant with one predicate
  (`SYSTEM_SENDER_ID` / `isSystemSender`, previously duplicated privately in `displayName.ts`), and
  both read paths derive through it. The test pins the load-bearing half too: the sentinel survives
  into `toMessagePayload`, and no flag does - so a receiver waiting to be TOLD was waiting for
  something the wire never sends.

- **THE FRONTEND TEST SUITE WAS CALLING PRODUCTION.** `promoteOfflineSession.test.ts` mocks everything
  the promotion drives except one: the fire-and-forget `void bindCurrentSessionDevice(...).catch(...)`
  reached the real module, so every run sent five live `PUT /api/auth/sessions/current/device` at
  `canari-emse.fr`, each dragging a token refresh behind it, and a `happy-dom` `AbortError` at teardown
  from the fetch still in flight. The caller swallows the rejection, so nothing failed and nothing was
  asserted - the only trace was console noise in a 215-file run, which is precisely where the next real
  warning would have hidden. The module is mocked, the binding is now ASSERTED (with the device id on
  the success path, and not called at all when the session is dead), and that file went from
  network-bound to 1.9 seconds.

- **WIDENING A CI GATE BROKE IT, BECAUSE WHAT MAKES A TEST ELIGIBLE WAS A PROPERTY NOBODY COULD SEE.**
  `make test-harness` went from three harness self-tests to seven, and two of the four added could not
  run on a fresh checkout: `names.mjs` is gitignored deliberately - it holds real display names and
  this repository is public - so anything importing it, directly or three modules down, dies with
  `ERR_MODULE_NOT_FOUND`. `tabguard-selftest.mjs` imports it for a port, and `debris-selftest.mjs`
  reached it through `results.mjs`. It was invisible locally, where the file exists, and took the CD
  run of `74e9e1ec` red.

  The marker vocabulary (`mark`, `markSeq`, `MARKER_RE`, `markerStamp`) is now `marker.mjs`: pure
  string work must not need a machine to import, and `results.mjs` re-exports it so no runner changed.
  `tabguard-selftest.mjs` drives a real browser and can never be a CI test, so it has its own target,
  `make test-harness-device`. And the property is asserted rather than remembered - `gate-selftest.mjs`
  reads the `test-harness` recipe, walks each script's transitive imports and fails on any file git
  does not track. It found both faults immediately, plus a third: `marker.mjs` itself, still unstaged.

- **THE SAME 403, THROUGH THE OTHER DOOR: FIXING A CALL SITE IS NOT FIXING A SEAM.** The membership
  check stopped asking the members-only endpoint on a removed device (entry below), and GRP-3
  recorded the identical `GET /api/mls/groups/:id/members -> 403` the next day. Both conversation
  selection paths fire `loadGroupMembers` ONE LINE ABOVE that check, and it had no membership guard
  of any kind - so the fix had closed one of two doors onto the same endpoint. The guard is now a
  predicate on the fact rather than a line in a function, `membershipIsDurablyLost`, reading the
  durable `lifecycle` the Remove commit already wrote; a retired conversation has no roster this
  device is entitled to know, so the empty list is the answer and not a fallback. Its test asserts
  agreement with `retireIfEvicted`, the writer of that fact, rather than restating the comparison -
  which would have been one belief written twice, and would still pass the day eviction is recorded
  some other way.

  The re-registration branch in the same function swallowed its error with
  `catch { /* Non-blocking */ }`. It now logs: it is where a repair that never works would sit
  silently for ever.

- **A 403 IN THE CONSOLE OF EVERY REMOVED DEVICE, ASKING A MEMBERS-ONLY ENDPOINT WHETHER IT WAS
  STILL A MEMBER.** `verifyCurrentUserMembership` went straight to
  `GET /api/mls/groups/:id/members`, which is members-only by design (audit S5: the device list
  leaks social graph and device topology). So on the one question worth asking - "am I still in?" -
  the request could only ever be refused, and the refusal was the answer being sought. GRP-3 caught
  it on 2026-08-23.

  The local MLS state is asked FIRST, and on `false` it is the whole answer: a Remove commit is a
  signed, ordered statement by a member entitled to make it, already applied and already durable, so
  a device holding one has nothing left to ask anybody. The server is now asked only about what the
  local state cannot see - server-side drift while we ARE still a member.

  **NOTHING FAILED BEFORE, WHICH IS WHY IT LASTED.** The two paths did not disagree, they
  OVERLAPPED: the eviction was also learnt from the commit and `convo.lifecycle` already carried it.
  The overlap is deleted rather than reconciled. The 403 is additionally typed as
  `NotAGroupMemberError` at the throw, because it is an ANSWER and not a transport failure, and the
  one caller that acts on it retires a conversation on "no" while it must keep operating on "could
  not tell" - a distinction that cannot survive as prose in a message. `readLocalMembership` returns
  THREE answers for the same reason: `null` is "this device does not hold the group", and no caller
  may read it as a "no".

- **TWO RECONCILIATIONS ASKED THE DELIVERY SERVICE WHO WAS IN THE MLS TREE, and the routing table is
  not the tree.** `processPendingInvitations` and `handleWelcomeRequest` both decide "is this leaf
  already in the group?" and both read `getGroupMembers` - `dm_device_group_memberships`, which is
  who the delivery service will ROUTE to. The authority is the local ratchet tree, and
  `member_identities`' own Rustdoc already named this exact misuse: *a reconciliation deciding
  whether a leaf still belongs must read this, never the routing table*.

  The two answers diverge on precisely the case both callers exist to handle. A device fresh-start
  clears its routing rows while the tree stays full, so the routing table reports "not a member" of
  a leaf sitting right there; the Add goes out, OpenMLS declines the duplicate, and the caller learns
  by failing what the tree could have told it for free, over a network round-trip, on a question
  whose answer was already local and loaded. That is the
  `[RUST::WARN] Skipping KeyPackage already a member of the group` the campaign saw on GRP-5
  (2026-08-23) and GRP-3 (2026-08-24), looking like a 1-in-5 flake both times because a stale row
  reconciles ONCE and then never again. At the second site the answer gates a KICK, which is the
  decision the Rustdoc is most explicit about. Both sites now read the tree; an unreadable tree is
  not a "no", so the Add is still attempted exactly as the swallowed `catch` allowed - it just says
  which fact it was missing. The whole identity `userId:deviceId` is compared, never a bare device
  id, because those are client-generated and two users can hold the same one.

- **A KICK THAT REMOVED NOTHING CLAIMED THE REMOVAL ANYWAY.** `kickStaleLeaf` swallowed BOTH of its
  calls - `removeMemberDevice` in a bare `catch {}`, `kickStaleDevice` in a `.catch(() => {})` - and
  then logged `[KICK] ... removed` unconditionally. Neither could throw, so a reader following that
  line had no way to learn the leaf was still in the tree, and the only evidence the branch had
  failed was the `DuplicateSignature` produced later by the caller's Add, under a different tag: one
  symptom standing in for two unrelated causes. Best-effort was doing the work of silent.

  Both failures report, and the success line is emitted only when both halves actually succeeded -
  otherwise the summary names WHICH half survived. They are separate facts: the tree decides who can
  read the group, the routing row decides who the delivery service ships to, they fail
  independently, and a leaf out of the tree with a routing row still shipping to it is a different
  estate from the reverse. Neither is promoted to a throw - the callers' fall-through is deliberate,
  the silence was not. The four spellings are pinned in `classify-selftest.mjs`: `[KICK]` gets no
  classifier rule, because a kick is a REPAIR and reaching one at all is the finding.

- **THE BATCH CATCH-UP HAD BEEN DEAD FOR EVERY CLIENT PAST FIFTY CONVERSATIONS, and the fallback is
  why nobody noticed.** `POST /api/mls/history/batch` exists to turn one login catch-up into one
  round-trip; it refuses more than 50 groups. The client sent its WHOLE conversation list, unchunked,
  so past fifty it sent a request that could only ever be refused - and on the 400 it quietly fetched
  every group sequentially, which is precisely the cost the route removes. Measured on production
  2026-08-24 from a campaign profile: 110 conversations, one 400, 110 requests, and the only report
  was a `console.warn` carrying a bare status - which cannot tell a refusal from an unreachable
  server, and is the reason the message never got read. Found by the cross-client harness, which
  flagged `POST /api/mls/history/batch -> 400` on GRP-4 and GRP-7 in all five passes.

  The client now chunks at `HISTORY_BATCH_MAX_GROUPS`, mirrored from the server's constant of the
  same name and pinned by a test on each side that names the file the other lives in - a limit that
  is on neither the wire nor the client is one the client must be TOLD, never one it discovers by
  being refused. The sequential re-fetch is deleted: a refused chunk leaves its groups unprimed and
  is logged at a level that accuses, carrying the server's own words, and the replay reads those
  first pages itself - the single path every group took before the route existed.

- **THE FOURTH PATH TO AN EVICTED DEVICE, and the one the other three hid.** The receive path was
  typed and classified before the generic arm - but only for a frame at OUR epoch. The epoch-gap
  fast-fail sits above the decryption that reveals the eviction and returns first for anything ahead
  of us, and a group does not stop committing when it loses a member: being ahead is the NORMAL state
  of every frame that still reaches the removed device, so the classified path was the exception and
  "gap" was the answer in practice. Gap reads as out-of-sync, which is `requestReAdd` against a
  deliberate removal plus a commit request that can only 403 - the exact loop the third fix was
  written to end, still reachable by the commonest road. `!group.is_active()` is local state and
  already false, so nothing had to be attempted to know better: it is now read before the gap. Two
  tests pin it, the eviction AND the genuine gap of a member who merely missed a commit, because
  hoisting the check is only correct if a recoverable gap stays recoverable.

- **A form's submit button was a French sentence stored in the database.** `submitLabel` looked like
  a setting and never was one: no screen has ever offered a field for it, both admin pages wrote a
  hard-coded literal computed from `requiresPayment`, and the fill page rendered it raw. So a column
  held two French strings derived from another column, shown to an English viewer in French, and
  invisible to Paraglide because nothing types a stored string as user-visible. Migration `052` drops
  it; the label comes from the message catalogue like every other word on that page.

- **A conditional question had never once been displayed.** The builder bound an option's LABEL into
  `dependsValue`, while an answer holds an option ID, so every condition compared a label against an
  id and matched nothing. Prod held no affected form (`with_depends: 0`), so nothing needed a shim.

- **Conditional questions were a browser-only rule, with two consequences on the server.** `submit`
  enforced `required` on every item, hidden ones included, while the client sends only the visible
  answers - so a required question behind a condition made the form unsubmittable for exactly the
  people the condition excluded. And an answer to a hidden question was accepted with its price
  modifier charged. `pricing/visibility.ts` evaluates visibility server-side (memoised,
  order-independent, a cycle resolving to hidden) and lands WITH the matrix rather than after it,
  because both get much worse once an answer can select a price cell. `normaliseCondition` ANDs the
  legacy `dependsOn` pair with a profile `showIf` instead of choosing between them - the builder
  offers both controls on one question, and returning one would drop the other silently.

- **A mailbox barrier reported a deadlock that could not happen, and skipped the guarantee it exists
  to take.** `waitForMessageQueueIdle(caller, catchUpGroupId)` asks which group's catch-up session
  the caller is INSIDE - the barrier refuses that one, because the drain needs the MLS mutex such a
  session holds for its whole life. Two call sites read the parameter as "the group I am working on"
  instead: `history.ts` named the group whose session it opens on the very NEXT statement, and
  `historyReconcile.ts` named the group it was reconciling, reached from a `finally` that has already
  awaited `session.finish()`. `createDecryptSession` is the only opener of a session and `history.ts`
  its only caller, so NEITHER site can ever be inside one - the group they named could only ever
  match a CONCURRENT session, which the guard then reported at `console.error` as "this can never
  resolve" and SKIPPED.

  The accusation was false in every case it could fire, and the skip was not free. In
  `historyReconcile` it dropped the ordering guarantee the barrier is taken for and sent the state
  key against a mailbox that had never been emptied - reconciliation is meant to be exceptional, and
  an ask raised on a difference the device was about to close by itself is the routine case it must
  not become. In `history.ts` it is worse: the mailbox not being empty when the session opens is
  exactly the window where the archive walk and the delivery queue hand MLS the same ciphertext,
  which is the `Duplicate delivery ... already read by the archive replay` defect the ordering above
  it was written to close.

  Found by GRP-7 on 2026-08-23, with `[HISTORY_STATE] holds something different` sitting in the same
  report as the skipped barrier that caused it. Both sites now pass `null`, and each states the three
  facts a future caller would have to break for that to stop being true.

  The guard's own report was fixed too, and for a reason worth naming: it was one `console.debug`
  written AFTER the wait, so it accounted for the latency perfectly and went completely silent on a
  wait that never ends - which is the single case it is most needed for, and the one a future caller
  reaches by passing `null` from inside a session. It now says what it is about to do before doing
  it, naming the caller, the sessions it is behind, and what to change. A hang's last line is now a
  line that explains it.


- **A member removed from a group asked to be re-added, and its outbox retried an encrypt that could
  never succeed.** The Remove commit NAMES the device it evicts, and applying it produced nothing: the
  merge answered "no application payload", exactly as every other structural commit does, so the only
  thing left that could tell an eviction from an ordinary membership change was the next send being
  refused. That refusal then crossed the FFI boundary as `OpenMls("Encrypt error: ...
  UseAfterEviction")`, indistinguishable from a transient encrypt failure - so the outbox backed off
  and retried it up its whole ladder against a group that would refuse every attempt, and the
  pipeline meanwhile ran `requestReAdd`, asking the server to undo a moderation action, and learnt
  from a 403 what the commit it had just applied already stated.

  Found by GRP-3 and GRP-8 on 2026-08-23, on the phase's first armed runs - which is why something
  this reproducible had never been seen. One entry (`375cc054`) was observed still retrying across a
  check boundary, stopping only when the next check's teardown deleted the group.

  Fixed where the fact is KNOWN rather than where the failure surfaced. `is_group_active` reads
  OpenMLS's own membership after a commit merges, the pipeline retires the conversation on the spot
  (`[EVICT]`, the `removed` lifecycle the product already draws for a peer-side deletion), and the
  outbox asks the same question BEFORE encrypting. `requestReAdd` is left for what it was written
  for: a group this device believes it is in but cannot use. Nothing mirrors the membership into a
  flag of our own - the group state is already durable, and a second copy could only ever be wrong in
  the direction that matters.

  The send-path refusal still exists, as the accusation it should be: it is reachable only by a device
  that never received the commit at all, it is typed (`MlsError::Evicted`, classified on the OpenMLS
  variant rather than by matching prose downstream), and both halves of it say so in the log. The
  three lines that must keep breaking `clean` - membership unreadable after a commit, and OpenMLS
  disagreeing with our own query in either direction - are pinned in `classify-selftest.mjs` beside
  the four that must not, because a single `[EVICT]`-shaped rule would have forgiven all seven.

  `outbox.ts` had grown three copies of the same permanent-failure block; they are now one
  `failPermanently`, whose `reason` is the only thing separating the two causes in the log.

  **THREE PATHS REACH AN EVICTED DEVICE, and the first fix only closed two.** The third is the
  RECEIVE path, and it is where the 403 actually came from: a frame still arrives - in flight when
  the commit landed, or routed by the registry the removal cleans best-effort - `process_message`
  refuses it because the group is inactive, and that refusal was a bare `Process error:`. Every
  classifier reads that as a sender-ratchet gap, so the pipeline answered with its out-of-sync
  policy. Now typed like the other two, and classified BEFORE the generic arm for the reason the
  four arms above it exist: reached later it reads as retryable, and native writes a
  `pending_mls_messages` row per frame for something that can never decrypt.

  The consequences are spelled out per consumer rather than shared, because the right policy differs:
  the pipeline ACKs and retires; `history.ts` marks the row seen and explicitly does NOT count it a
  loss - we are not entitled to the plaintext, so there is nothing to reconcile and asking a peer for
  it would be asking for a group's traffic after being removed from that group; `BaseMlsService` adds
  it to the permanent set for distribution frames. The replay counts what it skipped instead of
  logging per frame (an evicted group's whole backlog arrives one frame at a time), and a replay that
  added nothing BECAUSE we are no longer a member says so - an empty group and a group that is no
  longer ours are different answers, and it used to give the same one for both.

- **Opening search in a channel put the client in a loop that hammered our own server.** One query
  in a 1052-message channel issued **4956 requests to `/api/channels/:id/messages`**, was still going
  ten minutes later, and never showed a result - the counter sat at `0/0` throughout, with no error
  anywhere and nothing on screen to suggest anything was wrong. Measured by the cross-client
  campaign's SEARCH-4; a full-history channel search should be at most ten paged requests.

  Two mechanisms overlapped and either one alone would have been harmless. `ChatArea`'s effect called
  `refreshSearchMatches()` bare, so every reactive value that function reads synchronously became a
  dependency of the effect - including `chatView`, and therefore the conversation. The channel branch
  of the search then merged the history it had just fetched back into that same conversation with an
  unconditional `conversations.set`, which mints a new object whether or not its contents changed. So
  the search was its own trigger: search, merge, conversation changes, effect re-runs, search again,
  for ever. It could not converge, because the write happened even when the merge added nothing.

  Both halves are closed rather than one: the merge writes only when it actually adds a message, and
  the effect declares what should re-run a search - the query, and the conversation's identity. The
  conversation's MESSAGES are deliberately not a dependency, so an inbound frame no longer re-fetches
  and re-decrypts the whole channel. The overlap is deleted rather than guarded, per the standing rule
  that a race which heals cleanly is still a defect.

- **Typing a contact's name into the sidebar filter made that conversation disappear.** The filter
  matched `convo.name`, which for a DM is the persisted key (`userId::peerId`) and not a human name -
  the label on the row comes from `resolveConversationListPresentation`. So the one thing a user would
  obviously type was the one thing that could never match, and a DM could only be found by the text of
  its last message. Caught by the campaign's SEARCH-6.

  The presentation is now resolved once, in the same `$derived` the filter reads, and the row renders
  that same value - so the filter and the label agree by construction instead of by coincidence, and
  the duplicate resolve the template was doing per row is gone. The predicate is extracted as
  `conversationMatchesQuery` and pinned by tests, including the regression itself.

- **Two devices of one account edited the same message and settled on DIFFERENT bodies, permanently.**
  W1 ended on A1's text, A1 ended on W1's, the peer agreed with W1, and nothing ever moved again -
  both edits had succeeded, there was no error, and nothing on screen said the two devices disagreed.
  Found by the cross-client campaign's MUT-18, which exists for exactly this and only reached it once
  its own race was removed (see `docs/wiki/testing-methodology.md` 32).

  `edit_message` was applied on arrival, unconditionally, by all three paths that apply one: the live
  handler, the history replay, and the sending device's own optimistic write. "Whatever arrived last"
  is not a convergence rule - each device applied its own edit and then the other's frame overwrote
  it, so the two ended on opposite bodies BECAUSE they received in opposite orders. The pin register
  had solved the same problem one file away and written the argument down in `pinStore.supersedes`:
  two devices must reach the same answer from the same pair, and "keep what I had" depends on arrival
  order.

  `editSupersedes` (`utils/chat/editPrecedence.ts`) is that rule for edits - strictly later wins, tie
  broken on the content - and all three paths consult it. Convergence does not need the RIGHT winner
  between two concurrent edits, because there is not one; it needs the SAME winner everywhere, which
  is what makes a sender-stamped `editedAt` sufficient: two skewed clocks change which edit survives
  and cannot make two devices disagree, since every device decides from the same pair of values.

  **And the sending device dated one act twice.** `editMessage` read the clock for the broadcast while
  `handleEditMessage` read it again for the local apply, so a device stored a timestamp milliseconds
  off the one it told everyone else - `handleTogglePin`, twenty lines below, has always taken the
  instant once and says why. Harmless while the value was only displayed, and not harmless once it
  decides the winner: a device disagreeing with its own broadcast can lose to itself. `editMessage`
  now takes `editedAt` from its caller.

  **And auditing the branch next door found a third: an edit could put a DELETED message's text back
  on screen.** `edit_message` never checked `isDeleted`. The tombstone is carried in `content`, so an
  edit landing on a deleted row does not merely reorder two bodies - it restores the text the user
  deleted, italic and faded, which is the one outcome a delete exists to prevent. Reachable exactly
  as the ordering defect was: two devices of one account, one deleting while the other edits. A
  delete is now absorbing in the live path and the replay - the tombstone wins whatever the order -
  which is the rule the archive's own post-save pass (`history.ts`) has always had, and the campaign
  asserts for merges in MUT-7. It existed in one of the three places that needed it.

- **Nobody could be made an association admin: the server refused the preset its own client sends.**
  `POST /associations/:id/members` and `PATCH .../members/:userId` answered
  `{"message":["permissions must not be greater than 1023"],"statusCode":400}` for every attempt.
  `AssociationPermissionFlag` has eleven flags, so the widest legal mask is 2047, but both DTOs
  carried a hand-written `@Max(1023)`: `MANAGE_PARTNERSHIPS` (bit 10 = 1024) landed in `53b826f3`
  and the bound stayed where `MANAGE_STRIPE_CONNECT` had left it. The frontend's "Admin" option
  sends `ASSOCIATION_ADMIN_PRESET` = 1823, and `ALL_CORE_FLAGS` alone is 1311 - both over the cap,
  so the role was unreachable rather than intermittently broken. Any mask carrying bit 10 failed
  too, including ticking *Partenariats* on a plain member. Existing admins sat at 799 and loaded
  fine, breaking only on their next save, which is why this read as new.

  This was the bound's **second** drift - `79e7e913` had already raised it 511 -> 1023 by hand - so
  the fix is not 2048. `ALL_PERMISSION_FLAGS` is now folded from the enum's own values and is the
  only bound either DTO may name; a new flag moves it with no second edit.
  `association-permissions.dto.spec.ts` locks the two together, asserting the mask covers every
  declared flag and that the preset the frontend actually sends validates.

- **The v0.14.1 iOS release never built: a header declared `uint32_t` without `<stdint.h>`.**
  `canari_mls_ffi.h` includes `<stddef.h>` for `size_t`, and `canari_native_decrypt_graine_message`
  arrived later carrying a `uint32_t message_index` that nothing declared. Only the Notification
  Service Extension parses that header - it is the NSE's bridging header, precompiled with nothing
  else in scope - while the app target links the same `libapp.a` without ever reading it, so the
  break was invisible everywhere except the one target that ships push decryption.
- **The v0.14.1 AppImage release died on a lint policy that escaped its step.**
  `actions-rust-lang/setup-rust-toolchain` writes its `rustflags` input into `$GITHUB_ENV`, so its
  default `-D warnings` applied to every later step of the job - including `bun tauri build` six
  steps down, which compiles our vendored `tao` patch. A path dependency is the one kind Cargo does
  not `--cap-lints allow`, so three upstream `glib::MainContext::channel` deprecations became our
  errors. It was intermittent on top: the whole setup is gated on a WASM cache miss, so whether the
  release built depended on whether a cache entry had expired. `-D warnings` is now set on the
  `wasm-pack build` step alone, where it was always meant to apply.

- **The dismissal endpoints reported requests rather than events.** `[DISMISS]` and `[UNDISMISS]`
  printed the same sentence whether a marker moved or nothing did. Both are deliberately idempotent -
  `POST dismissed-groups` upserts, `DELETE` means "ensure this is not dismissed" and every Welcome
  calls it - and a dismissal is per USER while the call is per DEVICE. A READ-10 window on production
  showed two `[UNDISMISS]` lines one second apart for a group nobody had ever dismissed: two events
  reported, zero occurred, and the harness promoted both to `notable` for a human to read. Both lines
  now carry `recorded=` / `lifted=`, and the server-log classifier splits on the count instead of the
  endpoint - a marker that moved is notable, a no-op is not.
- **A container's boot banner failed a phase that had passed every check.** A redeploy landing inside
  an observation window put 106 unexplained lines into the READ phase - 90 `RouterExplorer Mapped`,
  14 `RoutesResolver`, the microservice start, the kafka consumer join - and the phase exited non-zero
  with 9 PASS and 1 SKIPPED behind it. The route table is now benign, because the boot is already
  announced once by `Nest application successfully started`; `[FIREBASE] Admin SDK initialized` and
  `[CRON] initial sweep` are promoted to notable instead, being the only two boot lines that carry
  information - a capability whose absence nothing else would reveal, and a deletion pass crossing
  whatever window it lands in.

### Added
- **Product and partnership cards now carry the owning association's own color, and an admin can add a short badge like "Nouveau" or "-20%".** Every card in a shared grid used to be visually identical regardless of which association it belonged to; the card shell now takes a colored left edge from the association's own `color` (the same one the calendar already uses), falling back to a name-derived color when the association hasn't set one, so every card is distinguishable without any admin having to configure anything. A short free-text badge is a separate, optional per-card field, shown as a ribbon across the top in the same accent color. Getting the ribbon to actually sit flush with the card's rounded top corners took three attempts: a plain CSS `border` makes `overflow-hidden` clip children at the padding box - a smaller, differently-curved rectangle than the border-box the card itself is rounded to - so a full-bleed ribbon's corners kept coming up a hair short no matter what radius or negative margin it was given, revealed as a sliver of the card's own background peeking through (confirmed with `elementFromPoint`, not by eye - two rounds of "looks fine" screenshots turned out not to be). The border is now painted as an inset `box-shadow` instead, which consumes no box-model space at all, so there is no padding-box/border-box gap left to fall into
- **The logo/icon upload editor is now a real crop tool: drag the photo, resize the selection, zoom - instead of a mode switch nobody could make sense of.** The previous editor offered a choice between "Square" and "Margins," where margins meant letterboxing the whole photo on a white background - a real feature, but nothing about the label said so, and the only thing that visibly did anything was zoom. It's now one view: the full photo, a square selection that stays centered and can be resized by dragging its handle, a zoom slider, and you reposition the photo itself by dragging it under the selection - what shows inside the white square is exactly what gets exported, with no separate preview to keep in sync. Same component behind both association logos and the partnership/product card icons above, so fixing it once fixes it everywhere it's used. Three defects surfaced once the tool was actually used: the viewport's solid black background made a transparent photo's cleared areas indistinguishable from an opaque black background while editing (the export itself was already correct - only the editing view lied), replaced with a checkerboard, the industry-standard way of showing "nothing is here" rather than "black is here"; the minimum zoom scaled every photo to COVER the full 440x300 viewport, which forced an already-square photo bigger than it needed to be and left no way to zoom back out to see the whole thing at once, fixed by scaling to CONTAIN the photo instead, so the entire photo is visible at zoom 1 and the crop square's maximum size follows the photo's own displayed size rather than the viewport's; and picking a second photo after already having picked one silently broke the editor to a blank, zero-size view, because the code that reset internal state on a new pick was nulling out the bound `<img>` element reference even though the element itself never actually unmounted - Svelte only re-establishes that binding on a real mount, so cleanup and re-pick collapsing into the same render tick left it null forever after the first swap
- **Boutique products and partnership cards now share one card design, and either kind of card can carry a custom icon.** Products were drawn three different ways depending on where they appeared (the shop grid, an association's own page, the admin management list); partnerships had their own fourth look. All four now render through the same card shell, and an association admin can upload a small image per card - a partner's own logo on a partnership, say - shown low-opacity and fading toward the card's center as a background touch rather than a badge. A card with no custom icon falls back to a generic one (by product type, or a handshake for partnerships). Reuses the upload pipeline already serving association logos and form banners rather than adding a new one
- **Associations can now offer partner discounts, with a code handed out per student instead of one code everybody shares.** A new "Partenariats" tab on the association's management page lets an admin create a card - title, description, a link to the partner - and pick exactly one way for a student to prove eligibility: a pool of individual codes handed out one per student, a single code shared by everyone, or a plain instruction such as "on presentation of the student card". A card can also be reserved to the association's cotisants, reusing the same membership check the boutique already gates purchases on. Students find these cards both in a new tab on `/shop` and in a new tab on the association's own page. The one real piece of new mechanism is how a code-pool card hands out its codes under concurrent requests: a student who revisits a card always gets back the SAME code rather than consuming a second one, and two students racing for the last code never receive the same one - enforced by a database constraint (at most one claimed code per student per card), not by application logic alone, with `SELECT ... FOR UPDATE SKIP LOCKED` picking the next free code without one claimant blocking another's request
- **Changing someone's role now reaches them straight away, instead of the next time they reload.** A promotion or a demotion was written correctly and immediately, and the person it was about learned nothing about it: their app went on showing whatever their old role allowed for as long as they left it open. The direction that mattered was the demotion - somebody who had just stopped being an administrator kept being offered every control they had lost, and every one of them failed when clicked, with no explanation, because the server was refusing them correctly all along. The new role is now sent to that person the moment it changes, addressed to them and to nobody else - a role is not public business - and it carries what the role actually grants rather than just its name, so their app applies it without having to ask the server anything. If that message cannot be sent, the role change still stands: the person is simply where they were before, correct again the next time they open the app. Found by a test run against the live server, not by a report
- **A call now leaves a record on the server saying which half of it failed.** A call that does not work is seen in halves: the person calling knows their end sent an invitation, the person being called knows their phone never rang, and neither side can see the other - so both logs describe half an event and neither can say which half broke. The one part that sees both is the server the audio and video pass through, and it kept almost nothing. It now writes a single line when a participant leaves, saying how long they were in the call, whether a media connection was ever established at all - which is what separates a call that was short from a call that never happened - how many of each kind of negotiation message crossed in each direction, and why the connection ended, chosen from a fixed list: hung up, replaced by the same person's other device, the network went away, the client died without saying goodbye, the server could not write to it, the room was swept away. Hanging up and being replaced are the two endings the design intends; every other one is written at a level that says something went wrong, and the reason recorded is the FIRST one - a device that is replaced sends a goodbye a moment later, and keeping the last event would have reported the consequence and hidden the cause. The room a call happens in and the identifier its invitation was sent with are the same value, which is what lets the two servers' accounts of one call be read as one story. Deliberately absent: a line for each of the dozens of network addresses a call tries - the count at the end of negotiation is the figure that answers a question, and the rest would bury the handful of lines that matter
- **The administrator storage panel now shows what the encrypted-messaging half is actually made of, instead of two totals.** The database and the key-value store were single numbers, which cannot answer the only question worth asking of them: a total that grows says nothing about WHICH part grew, and each part has a different remedy. The panel now lists the messaging tables by size with their row counts, and reports the undelivered-message queue as four figures rather than one - how much is waiting, for how many devices, the age of the oldest, and the deepest single device's queue. That last one is the one a total cannot show: forty devices waiting on twenty messages each and one dead device hoarding eight hundred look identical until it is separated out, and only the second is a fault. It also counts, continuously, the device shape that once nearly filled the server's disk and was found by hand - a device that holds group memberships but has published no key of its own - and shows the count even when it is zero, because a counter that only ever appears when something is wrong is a counter nobody trusts the first time it does. Weekly bars give each of these a slope, which is what makes reading the panel worthwhile without any alert attached to it
- **Administrators can now publish a message that everyone sees once, the next time they open the app.** It is written from the platform panel in both French and English - both are required, because the server is the only part of Canari that does not know which language you read in, so it stores both and your app picks. It appears as a centred window closed by a single button, rather than a banner: a banner is a line its reader learns to skip, which would make "seen" stop meaning seen. Seen ONCE PER ACCOUNT, not once per device - whichever of your devices opens the app first shows it, and it never appears again anywhere, including after a reinstall, because that record lives on the server rather than on the device. An announcement can optionally be aimed at a range of app versions, so "what changed in 0.15" reaches only the people who actually have it - and an app outside that range is never told an announcement exists and withheld, it simply has none. Publishing takes effect immediately, with no deployment, exactly as the minimum-version setting already did
- **A treasurer can now unlink an association's Stripe Connect account from the edit page.** There was previously no way back once onboarding had started with the wrong account or details: the only fields Canari holds - `stripeAccountId` and `stripeOnboardingComplete` - could be set but never cleared. The new button clears them so onboarding can restart; the Stripe account itself, its dashboard and any balance are left untouched
- **Stripe and Lydia onboarding now coexist instead of overwriting each other.** Both providers wrote through the same `stripeAccountId`/`stripeOnboardingComplete` pair, so an association that had onboarded with one and then tried the other lost the first one's link outright, silently. Lydia now has its own `lydiaAccountId`/`lydiaOnboardingComplete` columns, `/api/payments/onboarding` persists to whichever pair matches the provider that actually issued the account, and both the Stripe Connect panel and the Lydia form on the association edit page can be linked, and unlinked, independently
- **Checkout now routes to whichever payment provider is actually active, and a Lydia payment gets confirmed even if the buyer never returns to the app.** Boutique and form checkout resolved their destination account by reading a single column that both providers wrote through - correct only by accident, since a Lydia payment would have paid into a Stripe account id or nothing at all the moment the platform-wide provider switch pointed anywhere but the one that happened to be there. The resolver now reads whichever pair of columns matches the active provider, refusing rather than guessing when it cannot ask. Separately, Lydia's payment confirmation is app-driven and has no equivalent of a hosted checkout page reliably redirecting back, so a new signed callback now confirms server-side the moment Lydia itself reports the outcome, instead of depending on the buyer's browser making it back to a success page. Still blocking an actual switch to Lydia, and tracked rather than silently left: nothing yet resolves the payer's email/phone that a Lydia payment requires, and the webhook that would auto-confirm a Lydia account's onboarding was deliberately left unbuilt - it has no documented signature and its identifier is public, so building it as specified would let anyone forge or break another association's readiness
- **A private salon's messages are now sealed with a key the rest of the community never receives.** Until now a community had exactly one key-distribution group: every member's device was handed the key to every salon in it, including the private ones they had no place in, and what kept a private salon private was the server declining to send them its contents. That is a real guarantee, but it is the server's, not the mathematics'. Each private salon now has its own group, whose members are exactly the people who may open it - so the key to a private salon is never even sent to anyone else, and a public salon keeps riding the community's group because its readers ARE the community. Two consequences follow, and both were deliberate choices rather than side effects. An administrator no longer reaches every private salon simply by being an administrator: they see that a private salon exists and can enter it in one click, and doing so puts their name in its member list, where the people in the salon can see it - the old arrangement gave them the contents of every private salon and showed their presence to nobody. No message is written in the salon when they join, because a permanent line in a conversation recording that it is being read is a different thing from letting its members see who reads it. And losing access now really removes the key: leaving a community, being removed from it, being taken out of a salon, or having a salon turned public each stop that person's devices being sent anything further, and the group is rebuilt without them the next time a remaining member opens it. There was nothing to migrate - the production server held no private salon at all when this was measured

### Fixed
- **A Markdown heading in an association's or list's description could render larger than the name it was describing.** `ProfileBioMarkdown`'s `h1`/`h2`/`h3` were fixed absolute sizes (`1.45rem` etc.), so a one-line `# Title` rendered at that size no matter how small a caller had shrunk the surrounding preview text - a description shown in `text-xs` next to an association's name on the shop page, or clamped to two lines in the associations/lists grid, still gave a bare heading its full, unrelated size. Switched to `em` so headings scale with whatever size the caller sets, and added a `compact` mode (used by every "description shown as a short preview next to the entity's own name" call site - shop, the associations grid, the lists grid) that caps headings to body size entirely, keeping only the bold weight for distinction. The two full "A propos" displays (`AssociationDetailView`) are untouched - that's exactly where a real heading hierarchy belongs. Verified by measuring actual rendered `font-size` in all four call-site shapes, not by eye
- **A silently swallowed rejection could leave a conversation opened from a notification with no history at all, and a long-press action row could overflow the screen on your own messages.** Reported together from a real phone. `loadHistoryForConversation`'s full replay path had no `catch` anywhere in it - only a `finally` resetting the loading flag - and every caller fires it with `void`, never awaited, never `.catch()`-ed. A throw from the replay (a network hiccup, a decrypt error, IndexedDB contention - all realistic among a cold start's many concurrent init steps) became an unhandled rejection: the conversation's messages never grew, and nothing was logged anywhere - the skeleton still disappeared on schedule, which is exactly what made a silently-failed load indistinguishable from a conversation that genuinely had no history. Now caught and logged, mirroring the sibling channel-history path's own catch a few hundred lines up. Separately, the mobile long-press action sheet's button row had no width cap, and an own message shows one more button (Edit) than a received one - just enough to overflow a narrow phone screen on your own messages specifically; it now wraps to a second line instead of spilling off both edges. **Investigated and found already correct, not touched:** whether the hardware/gesture Back button returns to the conversation list after opening from a notification - `ensureMobileConvoHistory`/`goBackToMenu` (`useConversations.svelte.ts`) already push and pop a `historyOverlayStack` entry through the exact same `selectConversation` call the notification-tap path uses. An initial read of the report suspected that mechanism was entirely absent; it is not - worth re-verifying against the actual failure a second time, on hardware, rather than adding a second, parallel mechanism on a wrong premise
- **Tapping a chat notification could land on the wrong messages, not scrolled to the bottom.** The pane's render window (`windowStart`) is only ever re-pinned to the true tail in one place - when the conversation KEY changes - and every later change to the message count is treated as an ordinary live message, which never moves it. That holds on a warm, already-open app, but a notification tap can cold-start the app: `ChatBackgroundService` opens the target conversation as soon as it's known, which can still be near-empty at that instant, pinning the window to a tiny slice near the top. The real page of messages then arrives moments later through the ordinary async merge, growing the list without ever changing its key - so the window stays stuck on the stale slice from before the real content showed up, and "scroll to bottom" lands at the bottom of THAT, not the conversation's actual tail. The entry logic now re-pins to the tail whenever the message count grows while the conversation is still settling in (entering, or mid-catch-up), not only when its key first changes - a genuinely new live message arriving once the reader is already settled in still behaves as before. Diagnosed from a report on a real phone rather than reproduced in an automated harness - this is a cold-start timing race a synthetic test can't force deterministically, so it stays flagged for confirmation on real hardware
- **A partnership's plain-text instructions were hidden behind a "Claim" button, and a badge ribbon made the card's content overflow past its bottom edge.** Both surfaced immediately after the card accent/badge feature above shipped. A `text`-mode partnership isn't handing out anything - the instruction itself (e.g. "show your student card") is the whole point - so gating it behind a claim click added a step that did nothing except delay information the student already qualified to see; it's now shown directly from the card's own listing data (already sent to students - only the `shared_code` mode's code is ever stripped). Separately, any card with a badge ribbon overflowed its own bottom edge by almost exactly the ribbon's height: the content area below the ribbon was sized with `height: 100%`, which computes against the WHOLE card including the ribbon, so the ribbon's real, normal-flow height was being counted twice - confirmed by measuring actual bounding rects (an early "looks fine" screenshot had missed it entirely, same as the ribbon-alignment bugs above). Replaced with a `flex-1` column layout, which fills only the space actually left after the ribbon regardless of how tall it renders
- **The calendar subscribe buttons handed out `webcal://`, which reported "no calendar found" in Thunderbird even though the exact same URL worked as `https://`.** `webcal:` is historically defined as equivalent to plain `http:`, not `https:` - Thunderbird takes that literally, requests `http://canari-emse.fr/...`, meets Cloudflare's 301 to `https://`, and refuses to follow a cross-scheme redirect for a calendar subscription rather than silently accepting whatever the redirect points to. Confirmed directly: `curl -I http://canari-emse.fr/api/associations/calendar/feed.ics` returns the 301; the same path over `https://` returns the feed. The fix isn't the redirect - forcing HTTPS site-wide is correct - it's that we were handing out the scheme that resolves to the wrong protocol for an HTTPS-only server. `webcals:`, the far less common but equally real secure counterpart of `webcal:` (equivalent to `https:`), is what both subscribe modals now generate whenever the underlying feed URL is HTTPS, which in production it always is
- **The global calendar's "Subscribe" button did nothing on any platform without a registered `webcal://` handler - which is most of them.** It built a bare `webcal://` link by hand and nothing else; Apple platforms (and some manually-configured desktops) know what to do with that scheme, but a browser with no handler for it just... does nothing - no error, no dialog, no download, nothing a user could act on. The per-association calendar already had the right answer to this, in a modal offering three ways to subscribe: a Google Calendar button (works in any browser, no protocol handler needed), copy-the-link-and-paste-it-into-your-calendar-app with step-by-step instructions, and the `webcal://` button clearly labelled "Apple / Other" rather than presented as universal. That modal is now a shared component, and the global calendar page uses it instead of its own dead-end link. The bare link was also the exact URL shape that could still hit the ICS 500 above before that fix landed - one hand-rolled shortcut, two separate ways for the same button to fail
- **A malformed association id anywhere behind `AssociationsService.findById` crashed with a raw database error instead of a clean 404.** `id` is a `uuid` column, so a value that is not shaped like one - `?associationId=does-not-exist`, say - reached Postgres as a syntax error rather than a plain miss, and TypeORM let it escape as an uncaught 500. Found live on prod while verifying the ICS feed fix below, through the exact same `associationId` filter. `findById` now rejects anything that is not a UUID with the same "not found" it already gives a well-formed id nothing matches - the two are the same fact to every caller, and there are several beyond just this feed
- **The association calendar's ICS subscription feed threw a 500 on every request from a real calendar app.** `GET /api/associations/calendar/feed.ics` is a "subscribe by URL" endpoint - the whole point is a fixed link, saved once in Apple/Google Calendar, that gets re-fetched forever with no way for the caller to ever add anything to it. The endpoint nonetheless required `from`/`to` query parameters with no defaults, so the very first re-poll - and, it turned out, the very first click, since the main `/calendar` page's own "Subscribe" button built that URL by hand and never included them - called `.trim()` on `undefined` and crashed. The service now falls back to a rolling 3-months-back/12-months-forward window (matching what the association page's own subscribe link already computed) whenever `from` or `to` is missing or blank, and the two frontend places that build this URL - the association page and the global calendar page - now share the one helper that computes that window, instead of the global calendar page hand-rolling a second, param-less version. Caught from the live server's error logs, not from a report; there was no test on this path at all, so both the missing-params default and the still-required validation on genuinely malformed explicit dates are now covered
- **Creating a private salon built its encryption group twice, then threw one of them away.** Nothing was visibly wrong and nothing was lost - the salon worked, and the person who made it could send in it straight away. But one click reached the same piece of work twice: making the salon prepares its encryption group, and refreshing the community so the new salon appears in the sidebar walks every private salon and prepares its group too. Both ran at once, both built the group from scratch, and the second then looked at what it had in front of it - a group this device holds, which the server lists nobody for - and drew the only conclusion that state normally allows: that this device had been removed while it was away. So it did what that situation calls for, threw its own group away and rejoined, which moved the salon's encryption forward a step for no reason and left a dead branch behind. The repair was right about what it saw; what it saw was the other half of one click. The two now share a single piece of work per salon rather than racing - whoever arrives second waits for the first one's answer instead of starting again - and once it has finished, nothing is remembered, so the rejoin that a genuine removal DOES require still happens. Found in the dirt of a passing test, not in a report
- **Deleting a community left the server sending its devices messages they could never read, on every reconnection, for ever.** The community was gone from the rail, the salons were gone, and nothing on screen said anything was wrong - but the server kept handing each device a handful of messages addressed to the community's own key group, which no longer exists. A device cannot read such a message and cannot confirm it either, so it asks for the keys, is told nothing, keeps the message, and receives it again the next time it connects. Nothing in that circle ever ends it. Two separate causes, both fixed. The route that ends a community's key group wrote the deletion mark and deleted **nothing else** - not the memberships, not the messages waiting, not the stored keys - and because the deletion mark is deliberately kept (it is how a device learns the group is gone), the background job that collects leftovers can never see them: it only looks for groups whose row is gone entirely. Two other deletion routes had the same shape with shorter hand-written lists, and all three now go through the one list that says what a group owns, in a single database transaction with the deletion mark. Separately, the server's own test for "may this message be delivered" asked whether the group's row existed, which a deleted group's row still does; it now asks whether the group is still alive, and a message for a dead one is dropped rather than sent - and named in the log, because a message still waiting for a deleted group means a deletion route leaked and the fault is there, not in the delivery. Measured on the live server the day it was fixed: four communities deleted that morning had left 113 rows behind between them, and one device had been receiving the same seven unreadable messages since 01:54
- **A conversation you had asked to be gone from all your devices could come back as a "deleted" banner instead of staying gone.** Asking for a conversation to be gone is a fact about YOU, not about the conversation - it is what tells your app, on every device and every reinstall, that this one was dismissed on purpose and may disappear without a word. It is deliberately built to outlive the conversation itself, because the app still needs it afterwards: with the note, a conversation that has since been deleted stays quietly gone; without it, the app can only conclude that somebody else deleted it and shows you a "deleted" banner for something you had already chosen to be rid of. Unifying the three deletion routes onto one shared list of what a conversation owns (above) put that note on the list - correct for the case where the conversation is erased outright, since nothing will ever ask again, and wrong for all three of those routes, which keep the deletion mark precisely so the app can still ask. The shared list now knows the difference and the three routes say which case they are. **The mistake had already reached the live server** through a by-hand cleanup of leftovers from communities deleted earlier that morning: 25 such notes were removed, so 25 conversations that somebody had dismissed will show them a "deleted" banner once. Nothing else was lost and nothing is broken; the note cannot be reconstructed, because only the person who dismissed the conversation ever knew
- **A community you left or deleted kept its key group on your device for ever, and your app went on trying to repair it every time you opened the app.** Nothing was visibly wrong, which is why this survived: the community was gone from the rail, its salons were gone from the list, its keys were gone from storage - and the encryption group those keys used to travel on stayed behind, held by your device, belonging to nothing. Every load then found a group the server no longer listed, decided it was out of step with it, and asked to be re-admitted to a group that no longer exists. Worse before the debris was swept by hand: the server had frames queued for that group, kept redelivering them because a device that cannot read a frame does not acknowledge it, and your app could not read them because the keys were correctly deleted - a loop with no end, on both sides, for a community nobody could name any more. Two separate causes, and each one alone was enough. The reconciliation that decides whether to drop a group the server has stopped listing asked a local question - "have I already recognised this as a key-carrying group?" - and stopped there, without ever reading the server's row. That question answers what a group *is*, which is what it was written for and is genuinely needed (mistaking a key group for a conversation and deleting it once left nobody able to send in any community at all); it is not, and never was, evidence that the group still exists, and the two facts have different lifetimes - the answer stays true for the rest of the session while the group can stop existing at any point inside it. Nothing else could ever collect what that shortcut spared, either: the purge that owns forgetting a community's key groups enumerates the communities it knows keys for, and a group the server identified while the app could not yet say which community it belonged to is recorded as a key group belonging to nobody - reachable from neither side. It now reads the server's row every time, and believes it: a row that is confirmed gone, or that has stopped naming any community, means the group goes. A row that cannot be read at all still changes nothing, and a live community's key group is still spared exactly as before. Separately, dropping such a group used to erase the group and leave the note saying "this one carries keys" behind, so the note outlived the group it described and the next sweep spared the note for ever; both halves now go together, everywhere a group is dropped. Found on the live server during the community test campaign, on a group tombstoned three hours earlier and still being re-requested on every reload
- **A member you removed from a private salon and then let back in never received anything in it again.** Nothing on screen said so: the salon was back in their list, they could open it, they could type in it - and every message anyone sent, including their own on their other devices, stayed unreadable for them, for ever. Only a reinstall recovered it. Removing someone from a private salon does two things at two different moments: their delivery entries are torn down at once, so nothing is routed to them from that instant, and their removal from the salon's key group is committed later by whichever remaining member next opens it. The second step is published *to* the group they are no longer routed from - so the removed member is never told. Their app keeps a live copy of the key group and goes on believing it is a member. Letting them back in then changed nothing, because their app skipped re-entering a group it thought it was already in, and re-entering is the only thing that puts their delivery entries back. Two beliefs about the same fact, and the app trusted the one that could not be corrected. It now asks the server, on every load, which of this device's entries the group actually holds, and when the answer is none it drops the stale copy and re-enters properly. A server that does not answer the question changes nothing, and a network failure is not read as a removal. The repair is logged as the fault it is, so the rate at which the two sides drift apart is measurable rather than guessed at. Found on the live server by an automated check of the community phase, and reproduced exactly: three minutes after being let back in, the re-granted member's key group had not moved and the server was still routing them nothing **The first attempt at this fix changed nothing on the live server**, and was caught because the repair it added logs when it fires and nothing was logged: it asked a second bookkeeping layer - the app's own note of which key group belongs to which salon - which can lag behind the key group the device is actually holding, so the check was skipped exactly where the two had drifted apart, which is the only place it was needed. Both halves of the comparison now come from the server's own answer, and the case where the server does not answer at all says so out loud rather than passing for agreement.
- **Two 404s per avatar, on every post whose author is gone.** A post whose author no longer exists, and a parrainage entry with nobody attached, hand the avatar and the name components an empty user id on purpose - that is the code saying "there is no user here". Both components passed it straight to the server anyway, asking `GET /api/users/` for a profile and `GET /api/users//avatar` for a picture, once per appearance on screen, each answered 404 because neither could ever have answered anything else. Nothing was visibly wrong - the initials placeholder is what both fall back to - so this only ever showed up as noise in the network log and as load on the server. Both now draw the placeholder without asking, the same way the chat's own `system` sender was already exempted; a name lookup for a blank id returns nothing rather than an "unknown user" label, so a caller that brought its own label keeps it
- **The three notification buttons in a salon's settings did not tell a screen reader which one was selected.** "All messages", "Mentions only" and "Nothing" are one choice with one answer, but the chosen one was marked only by its colour - so assistive technology announced three identical buttons and no way to know the salon's current setting, and anything reading the page other than a human eye had to recognise a styling class to find it. They are now a proper radio group announcing which level is in force The same `aria-checked` is now what the test harness reads to know which level is in force - it used to recognise the selected one by its Tailwind class, which would have survived no restyling at all.
- **A partnership's association header showed raw Markdown instead of rendering it, and two cards claimed in the same row could reveal their code at different heights.** The shop page's "grouped by association" header printed `asso.description` as plain text - the same field the association's own "About" tab and the associations list already render through `ProfileBioMarkdown`, so writing `**DNS**` there showed the literal asterisks instead of bold text. Both group headers (products and partnerships) now go through the same renderer, with the same compact single-line clamp the associations list already uses. Separately, a card's revealed code sat at whatever height its own description happened to push it to, so two cards claimed in the same grid row could show their code boxes at two different heights - a card's content only reaches its full stretched height if every element between the grid cell and the content actually propagates that height, and one wrapper inside the shared card shell was missing `h-full`, silently capping every card to its own natural content height regardless of its row. Confirmed by placing a long-description card next to a short one, both revealed: their code boxes now land at the same y-coordinate. Also: the decorative icon's opacity was raised again, to 40%, after the previous tuning pass undershot it
- **A card's decorative icon did not show at all, an uploaded logo with a transparent background turned solid black, a real logo could visually run into the card's own right edge, and claiming a partnership code could resize the card.** All four shipped in the same night as the card unification above, and each was tuned against a running dev server with a real screenshot, not guessed from the diff. The icon was first invisible - its corner sat at a negative offset outside the card's own box, and the card clips anything past its edge, cutting off exactly the part of the masked, low-opacity icon that was not already faded out. Fixing that made it visible, but a high-contrast real logo (unlike the pale default icons) then read as touching, almost overflowing, the card's own edge: it now sits inset with real margin from both edges (not flush, not bleeding past them), smaller (96px to 64px), and with a gentler fade so it stays legible without dominating the corner. The black background came from the upload cropper, shared with association logos, always flattening to JPEG - a format with no transparency, so a canvas pixel nobody drew on (transparent by default) has its color read as black once the alpha channel is discarded; card icons now export as PNG instead, which keeps those pixels transparent (verified directly against the browser's own Canvas API, alpha 0 preserved through PNG, turned into opaque black through JPEG). Separately, revealing a claimed code replaced a one-line button with a taller bordered box, and a grid row sizes to its tallest card - so one card's own claim made its whole row, including its neighbor, visibly grow. The button/result area now reserves the height of its tallest state up front, so claiming never resizes anything around it
- **A salon you have just created now appears straight away on your other devices, and on everyone else's.** Creating a channel told nobody it existed. Every other way of gaining access to one - accepting an invite, an administrator entering a private salon, being added by someone - sends a message to the people concerned the moment access is granted; creating it was the only one that stayed silent. For a public salon the effect was that it simply did not show up for any member of the community until they next reloaded the app. For a private one it was worse and invisible: the key to a private salon travels on that salon's own group, a device enters that group either when it is told the salon exists or during a full reload, and neither happens on its own - so the phone in your pocket, already open, never learned about the salon you had just made on your laptop and could not read a word of it until it was restarted. Found by a test run against the live server: the phone had joined the group of all three private salons that existed when it started up, and never heard about the fourth, created nine seconds later
- **A build asset that failed to exist for one instant could stay 404 for a year, for everyone, everywhere.** `/_app/immutable/*` (and `.mjs` build assets) are hashed filenames that never change once built, so nginx tells Cloudflare's edge to cache them forever - `Cache-Control: public, max-age=31536000, immutable`, with `always`, which applies that header to EVERY response nginx sends for that path, including its own `404` fallback. A request landing in the few-second gap where a container is being replaced during deploy - or, in principle, any transient miss - got that same "cache this forever" instruction attached to an error page, and Cloudflare obeyed it literally: the next visitor to that exact file, for up to a year, got back the cached 404 instead of the file that has been sitting there correctly since moments after the deploy finished. No client-side reload can fix this, since the lie is upstream of the browser. `always` is now removed from both rules, so nginx's default behavior applies: the long-lived cache header is sent only on an actual successful response, never on the 404 it falls back to
- **A community you had just created disappeared from your sidebar a second and a half later, and the app moved you into a different one.** Creating a community opens it and puts you in its first salon. Between one and four seconds afterwards it vanished from the rail, the salon closed, and you were silently placed in whichever community happens to sit at the top of your list - so a salon you then created, or a setting you then changed, went to that other community instead, with nothing on screen saying so. Reloading the page brought the community back, which is what kept this hidden. The cause is a question asked before the answer could exist: the app periodically re-reads the whole list of your communities from the server, and finishes by deleting anything the server did not mention, on the reasonable ground that it must have been deleted elsewhere. But that re-read takes seconds - it joins a key group and lists the salons of every community you are in before it gets to the deleting - and a community created while it was still running is missing from an answer that was already on its way. It was then deleted for it, along with the salon you had just made inside it. The re-read now knows which communities and salons this device made after the question went out, and refuses to draw any conclusion about them: they were not absent, they were not yet born. Anything that really was deleted elsewhere is still removed, and the two are now told apart by a count of what this device has created rather than by any clock. Found by an automated check of the community phase, which had been failing for two days in a different place every time
- **You could create a community and then not be able to write in it.** Making a community drops you straight into its first salon with the cursor in the message box - and the very first message you sent there was refused, with a failure notice and nothing you could do about it. Everything a salon's messages are locked with belongs to the community, and that lock was only ever prepared in two places: when the app loads your communities at startup, and when you create a *private* salon. Creating the community itself prepared nothing, so for as long as you were the only member and had not reloaded the page, your own new community was one you could not post in. It repaired itself out of sight, which is why it survived this long: reloading fixed it, and so did the first person joining, because their app prepares the lock and yours then picks it up. What was left was the exact minute after you pressed the button. The lock is now prepared as part of creating the community, before its salons are even listed, and if that preparation fails the community still appears - the salons then refuse to send with a reason, rather than the community disappearing. Found by the first automated check of the campaign's community phase, on its first complete run
- **Four kinds of live update a community sends were being thrown away by every app that received them.** When a community is renamed, when its rule about what newcomers may read changes, when somebody's role changes, when a community is deleted, and when a role's permissions change, the server tells everyone concerned immediately - and every one of those messages was delivered to the app and dropped without a word. The apps decide where an incoming message goes by looking at the start of its name, and that decision had been written when only one family of them existed; the second family, added later on the server, matched nothing and fell through to a line whose own comment said it was being silently ignored. So the features that depend on being told still worked, but only the slow way: you saw the change the next time you reloaded, or opened the community again. Both apps now ask one shared list of what belongs to that handler, the list is checked against what the server actually sends by a test that fails if the two drift apart, and a message arriving with a name no part of the app recognises now says so out loud instead of vanishing. Found on the live server by an automated check whose remaining failure had no other explanation left
- **A notification for a salon stayed on your phone after you had read the message on your computer.** Canari already knows how to clear it: reading a salon tells your other devices, and each of them drops that salon's banner. What decided whether to say anything was the wrong thing - the unread badge on the device doing the reading. So it worked when you came back to a salon you had left, and never worked in the commonest case there is: the salon already open in front of you when the message arrives, read the instant it lands, no badge ever raised, nothing said, and the phone in your pocket left showing a message you read minutes ago. What is asked now is whether something you did not write, and had not already acknowledged, has just been read here - which is what a banner on another device is actually made of. Each thing there was to read is signalled once and never again, so an idle click back into a salon still costs nothing. And a signal that fails to go out now says so, at a level that accuses: the only symptom of losing one is a stale notification on a device nobody is looking at, and nothing else in the system would ever report it. Reported from a real phone, off a test run that had left a banner behind
- **Two administrators changing the same role at the same moment lost one of the two changes, silently.** Ticking a box in a community's permission table sent the role's ENTIRE set of permissions, worked out from what that browser happened to be showing. So two administrators editing the same role at once did not really collide - the second one's message simply carried a list written before the first one's change existed, and put it back. Nothing said so. Worse, the one whose change was discarded was left looking at a table that was wrong in both directions: a permission the server had just removed still showed as granted, and the one they had just granted showed as granted too, though it had never been stored - and it stayed that way for as long as they left the window open. Ticking a box is one decision about one permission, so that is now exactly what is sent, and the server applies it to the row as it stands. Two administrators changing two different permissions of one role now both get what they asked for; there is nothing left to lose. Every change is also announced to the community, so a table somebody else has open stops showing what the role used to grant. Older phone apps still send the whole list - they cannot be updated remotely - and keep the old behaviour until they are replaced. Found on the live server by an automated check written that afternoon - which then failed a second time, against its own fix, and was right again: sending one permission instead of the whole list moved the problem rather than removing it. The server was still reading the row into memory, changing it there and writing the whole thing back, so two requests arriving together each worked from the same reading and the second still erased the first - the same loss, one layer further down, now invisible from the browser because the message on the wire looked correct. The change is now made where the row lives, with the row held for the moment it takes, so the two edits queue instead of racing
- **A salon reserved for administrators still offered everyone a place to type.** A community can restrict who may post in a salon, and the server has always enforced it correctly: a member's message is refused. What nobody had told the app is that the rule exists. So the person opened the salon, was shown the ordinary message box, wrote, sent - and got a red error, which reads as the app being broken rather than as a rule they are subject to. The salon now says so instead of offering the box, in the same place a deleted conversation says it is gone; the sentence replaces the box rather than greying it out, because a greyed-out field says "try again later" and this is not later. Whether you may write is decided by the server and sent with the salon, not worked out again by each app - an app holds none of what the decision needs, and a second copy of a permission rule is a second copy that will disagree. Fixing that also turned up a role that was a moderator everywhere in the app except in this one decision, which had its own private list of what counts as one. And a rule everyone already in the salon learns about only when they next reload is barely better than no rule at all, which is what the second run of the same check found: the app that changes the setting is never the app holding the stale one. Everyone the salon is visible to is now told the moment it changes - each person told what THEY may do, since the answer differs per person and nobody's app holds what it would take to work it out. Found on the live server by an automated check that asserted both halves separately - the server's refusal, which was right, and what the screen offered, which was not - and then found the first fix incomplete by failing again in exactly the same place
- **Inviting someone into a community by name failed every time, saying the key service was not answering.** There are two ways into a community - a link the newcomer follows, and an administrator naming them directly - and only the first one worked. Before creating the invitation the server checks that the person has Canari installed somewhere, because the key that lets them read anything is delivered to a device and there would be nowhere to send it; that check asks the part of the server that keeps devices. It was asking through the door reserved for people using the app, which only opens for a request carrying proof that a browser signed in - proof a server talking to another server does not have and must not manufacture. So the door refused it, every single time, and the refusal was reported honestly as "we could not check right now", which is exactly what it was. Until the day before, the same check had quietly answered "yes, they have a device" whenever it failed, which is why nothing had noticed: closing that hole is what made the wrong door visible. There is now a door meant for one server to ask another, it answers a count and nothing else - the question is only ever compared to zero, and handing over a person's keys to answer it was never necessary - and it ignores devices too old to be added to a group, so an invitation is never accepted for someone no group would ever deliver to. Found on the live server by an automated check written that morning for something else entirely; every unit test was green throughout, because they all answered whatever address they were asked
- **Joining a private salon as an administrator worked everywhere except on the screen of the person who joined.** An administrator sees a private salon they are not in, with a "Rejoindre" button, and one click puts them inside it: their name appears in the salon's member list, the server starts serving them its contents and its key, and nothing is written into the conversation. All of that happened correctly. What did not happen is the button going away - the row went on offering to join a salon already joined, for the rest of the session, and only a full reload of the app fixed it. The join deliberately re-reads everything from the server rather than flipping a local flag, precisely so the sidebar, the conversation and the key all come from one state; the part of the sidebar that receives that re-read was skipping any salon it already had on screen, treating a refresh as a duplicate. It now updates what it already has, keeping the counts the refresh does not carry - unread badges are not part of a re-read and were never meant to be cleared by one. Found on the live server by an automated check whose four other assertions all passed, which is what made it readable: the join was complete in the database, in the key service and in the member list, and absent only from the screen
- **A community set to hide its past from newcomers handed that past over anyway, one key at a time.** A community can choose what someone joining it may read of what was already said, and choosing "a partir de l'arrivee - rien de plus ancien" promises, in the app's own words, that older messages stay unreadable for that person definitively. It was refused correctly in the one place everybody looks: when a newcomer's app asks the community for its history, the member answering says no and says why. But there is a second, quieter way a key leaves a device. A newcomer opens a salon, meets messages it cannot read, and asks for exactly those keys by name - which is the ordinary repair that exists so a key lost in transit can be recovered - and that path consulted nothing at all. So the app said no to the request for the past and then answered every individual piece of it, and the setting achieved nothing. The same thing happened to someone removed from a community and invited back: they arrive holding nothing, ask, and are given everything again. The rule now lives in one place that both paths read, so they cannot drift apart a second time, and the line it draws is the person's own arrival - which is exact rather than approximate, because any change to who is in a community already forces every key to be renewed, so no key ever spans someone's arrival. A key withheld this way is not reported as missing either: saying "I do not have it" would send the asker round the whole community to be told the same thing by everyone. And the asking side now applies the same rule before it speaks, so a newcomer to such a community no longer spends a message to the entire community, for every key it cannot have, every time the app starts. Where the line falls is decided by the server rather than by any of the apps involved: a key can cover messages from both sides of someone's arrival, because keys are renewed by whoever is writing, at the moment they next write, and a new arrival is something a writer learns about a moment later - so a handful of messages can be sealed with the old key after the person is already there. Withholding that key would cost them messages sent after they arrived; handing it over would give them messages sent before. It is therefore handed over from a starting point, and the starting point is computed by the server from the two things only it holds honestly: when that person joined, and when each message was posted. No device's own clock takes part in the decision, so every member's app arrives at the same answer. Found on the live server by driving one community through join, removal and re-invitation with the setting on - nothing in the repository could have found it, since the two paths were each correct in isolation, and the first attempt at fixing it was itself corrected by the same test
- **Deleting a salon hid it instead of deleting it, after destroying the key that opened it.** The control says "Supprimer le canal", the confirmation says "Supprimer definitivement", and both have said so since the first version of the app that had them - but the server only marked the salon hidden. In the same breath it destroyed the group that distributes the salon's key, which is correct for something being deleted and ruinous for something being kept: a private salon's messages stayed in the database as sealed text that no device on earth holds a key for. Nothing could show them, nothing could open them, and nothing could remove them either - there is no un-hiding anywhere in Canari, so the only way to be rid of them was to delete the whole community they were in. That is exactly the reasoning that made deleting a community a real deletion two days earlier, and it was left behind one level down. A salon is now really deleted, with its messages, and its key group is destroyed FIRST - if that fails, nothing is deleted at all and the salon is still there to try again, because a key group that outlives the only thing naming it is a leftover nobody can ever find. Unlike a community, there is no name to type: a community is destroyed for everyone at once, and this asymmetry is the difference between the two. The hidden flag is gone from the database along with the community's own, which had been left behind by the same change and which nothing had been able to set since
- **The field asking you to type a community's name before deleting it was never focused.** The browser refuses to focus a field automatically when something else already holds focus - which is always the case here, since the window is opened by a button you just clicked - and said so in the log every time. So the most deliberate confirmation in the app made you click into the box first. The window already focuses its own first field when it opens, which works; the attribute that was being refused has been removed
- **Every device was asking the whole community to compare a conversation that does not exist, once per private channel, on every connection.** Canari keeps a separate, invisible group per community - and now per private channel - whose only job is to carry the keys that open messages. It holds no conversation and never has. The routine that repairs a conversation which has fallen behind was pointed at every group a device holds, so on each connection it broadcast to every member, on each of those key-carrying groups, a request to compare transcripts. Nobody could answer, because there was nothing to compare; the receiving apps logged the request as something they did not understand and moved on. Nothing broke as a result - both sides agreed there was nothing to compare and fell silent - but each request was still stored, delivered to every member, and left waiting for anyone who was offline, once per key-carrying group per connection, which for a phone means every time the network changes. The reason it is worth fixing is not the waste: this repair routine is the part of the app allowed to decide a group is damaged and act on it, and pointing it at groups it fundamentally misunderstands is how two earlier faults began. It now recognises a key-carrying group and leaves it alone, decided in the single place every trigger passes through. Found by reading one unexplained line in a production log, which also turned out to be blaming the wrong thing - it accused the two apps of running different versions, and they were running the same one
- **A private channel's key group could stop being recognised as one for a whole session.** The app answered "is this a key-carrying group?" and "which channel's keys does it carry?" from a single record, although only the second question needs to know the channel's community - and the server's own description of such a group names the channel without naming the community, deliberately, because the part of the server that stores it does not know about communities at all. So for a private channel whose community the app had not yet loaded, the answer to the first question was thrown away along with the unanswerable second, and everything downstream then treated that group as an ordinary conversation for the rest of the session - the very confusion the record exists to prevent. The two answers are now kept apart
- **A private salon with two people in it did not work at all: whoever created it received nothing back.** A salon's key group tells the server which devices to deliver on, and that list is only ever written when a device announces a CHANGE to the group. The device that creates a group announces no change - there is nothing to change yet - so it was never written down anywhere, and the server had no one to deliver to it. Everything followed from that. The second person joining the salon was an announcement the creator never received, so the creator's app went on believing the salon still contained only itself and sealed every subsequent message with a key the second person could not have; the second person, seeing a message it could not open, asked the creator for the missing key, and that request was addressed to a list the creator was not on either, so nothing ever answered it. The salon looked entirely healthy from both ends: created, joined, messages sent, messages received - and unreadable, permanently. Announcing a salon's key now also registers the device doing the announcing, which is the only moment the server learns which device made the group; an announcement that does not say which device it came from is refused rather than accepted, because accepting it recreates exactly this, silently. Found on the live server by putting a real second person into a private salon and watching both apps at once - no test could have found it, since every test arranges the delivery list it then checks
- **A channel that already existed could not be made private, and one that had been private could not be made private again.** Two separate faults on the same switch, both found by flipping a real channel on the live server. Turning an existing public channel private failed outright: the key group a private channel needs is created before the channel is recorded as private - deliberately, so that a channel whose key group cannot be created simply stays public rather than becoming a private channel with nowhere to put its keys - and the check guarding that step asked the record, which still said public. It therefore refused the only two ways of reaching it. Separately, turning a channel private, then public, then private again gave it back the very key group it had just retired: a retired group was still registered as that channel's, and a retired group is one the server is counting down to erase, holding the membership the channel had before. Retiring a key group now releases the channel's claim on it in the same step, so the next one is genuinely new, and the channels already in that state on the server were corrected
- **A private channel's key group could have shown up in the conversation list.** There is exactly one place in the server that decides which groups a device is told about, and it is where key groups - which carry keys, never messages - are kept out of it. That exclusion recognised a community's key group and had never been taught about the per-channel ones, so the day anything gave a device a membership record on one, it would have appeared as a conversation. Nothing did, and the same code reports loudly when it happens, which is why this is a gap closed rather than a symptom seen
- **The channel access panel told everyone that administrators can read every private channel, which had just stopped being true.** That sentence described exactly the arrangement replaced by giving each private channel its own key: an administrator now joins a private channel explicitly and appears in its member list. The panel says that instead. Its "Access" tab was also the one label in that window written straight into the code in French, so it stayed French in the English app
- **Private salons on the live server could not be encrypted at all: the address their key was fetched from did not exist.** Every salon's key is fetched from one address on the server, and the three addresses added for private salons were each written with the word "channels" one time too many - the part of the server they belong to already supplies it. So the server published them one level deeper than anyone asks, and a private salon's app requested its key, was told there was no such address, and reported the salon as having no key - while the key itself sat on the server, correctly created, addressed by nothing. Nothing in the project could have caught it: the address is assembled at start-up from two halves written in different places, so it is neither a spelling mistake nor a type error, and every test of the code behind it passed because that code was right. It was found by creating a private salon on the live server and watching a real app ask for its key. The three addresses are corrected, and the composed addresses are now checked directly - including that no other one repeats the same word, which is the mistake itself rather than one instance of it
- **A leftover key-distribution group could be destroyed by the tidy-up sweep it was supposed to be exempt from.** The sweep that clears cryptographic state a device should no longer hold asks the server what each unknown group actually is, precisely so it can spare the ones that carry keys rather than conversations. The server answers correctly and always has; the part of the app that reads the answer dropped that field on the floor before anyone could look at it. So the only thing that ever protected such a group was having been recognised earlier in the same session - and on a start where the sweep ran first, the group was deleted and keys stopped arriving until the next launch put it back. Found while giving private salons their own groups, which would have made the same sweep delete one group per private salon
- **A community message could stay blank for several seconds when it arrived before its key.** A salon message and the key that opens it travel separately, so the message can land first - which is the ordinary case for the first message after a key is renewed. When that happened while the salon was OPEN, the app logged an error and asked nobody for the key; it only recovered because reloading the salon's history later took a different code path that does ask. That other path had been right all along: it says which of the three reasons a message is unreadable, and asks a member for the key only in the one case a member can help. Both now take the same decision, so a message opens as soon as its key arrives instead of waiting for a reload
- **Someone who left a community could still read everything said in it afterwards.** A community's messages are sealed with a key handed to its members through a shared cryptographic group, and that key is meant to be renewed the moment the membership changes - the app decides to renew it by noticing that the group has moved on. Nothing ever moved it. Leaving a community removed the person from the member list and from the sidebar, and left both halves of their access intact: their copy of the current key went on opening every message sent afterwards, and the server went on delivering every new key to their devices, because delivery is decided by its own records and those were never touched either. Both are now closed, and they close differently on purpose. The server cuts delivery the instant someone stops being a member - their devices are dropped from the group's distribution list, anything already queued for them is discarded, and if that cannot be done the departure itself is refused rather than half-completed, because a departure that half-completes leaves nothing behind that anything would ever come back for. The cryptographic half can only be done by a remaining member, since a change to the group has to be signed from inside it, so it happens the next time any member opens the community: their app compares who is in the group with who is in the community and removes the difference in one step, however many people and devices that covers. From that moment the key is renewed and the person who left cannot open what follows. The comparison is deliberately a comparison and not a reaction to the departure itself - a notice only reaches whoever is online, while a comparison gives the same answer whoever makes it and whenever, and stops on its own once there is nothing left to correct. A member list the app could not fetch removes nobody
- **Removing a person from an encrypted group did not name anyone to remove.** The instruction that takes someone out of a group's encryption - meant to cover every device they are signed in on - looked them up by their account alone, while the group records each device as the account and the device together. It therefore matched nothing at all and could only ever answer that no such member existed, for as long as the feature had existed, with no test anywhere covering it. It now matches every device belonging to that person, and cannot confuse one account name with another that merely starts the same way

- **Everything written in a private salon was being delivered, live, to community members who were not in it.** A private salon is one only the people added to it may open, and every request to read one is checked against that list. What was never checked is who each salon's live updates were SENT to. A message, someone typing, a pin, a poll result, a deletion, even the salon's name when it was renamed - all of it was addressed to the whole community rather than to the people who may see the salon, and delivered to their apps as it happened. The messages themselves were sealed, and the apps receiving them showed nothing, because an app ignores a salon it has no place in. But the key that opens a community's messages is shared with the whole community by design, so those apps held the key as well: the only thing between an excluded member and the contents of a private salon was their own app choosing not to look. Notifications were the one part that had it right, which is why nothing looked wrong. Every update a salon sends is now addressed to the people who may read that salon, decided by one rule shared with the read check and the notifications rather than three separate copies of it - and, since who may read is now what decides who is told, two moments had to be put in the right order: someone invited is given access before the invitation goes out, or the invitation would reach everyone except them, and someone removed is named explicitly, because losing access is the one thing its subject must still be told. This does not make a private salon end-to-end private: everyone in the community still holds the key, and that is a design decision written down in the protocol rather than a defect - what changed is that the server has stopped handing over the contents

- **The member list of a private salon could be read by anyone in the community.** The screen that shows a salon's access settings - whether it is private, and exactly who was added to it - checked only that you belonged to the community, not that you could open the salon. So the composition of a private salon was readable by the people it was private from. The neighbouring screen that lists a salon's members had always asked the right question; this one had never been given it.

- **Leaving a community left this device still receiving its keys.** Leaving erased the keys held, the local bookkeeping and the phone's copy - everything the device had - but never left the cryptographic group the community distributes new keys through. Nothing noticed, because a separate routine was deleting that group on every connection by accident, for an unrelated and wrong reason. With that routine corrected, leaving now really leaves
- **Nobody could send a message in a community, on any device.** Sending in a salon needs the community's key-distribution group - the one thing that carries a salon's keys to every member with a single sealed frame, whatever the community's size. Your device joined it correctly on every start, and roughly two seconds later a routine that tidies up leftover cryptographic state deleted it again, permanently. That routine decides what is stale by comparing what your device holds against the server's list of your CONVERSATIONS - and a community's key-distribution group is deliberately absent from that list, because it is not a conversation and carries no messages. So it looked like a leftover on every single connection, was deleted, and the deletion was saved to disk. Everything the user saw followed from that: whether a message could be sent at all depended on which of the join and the tidy-up finished last, and each rejoin left the group one step further ahead of the keys already handed out, so keys distributed earlier became unreadable for everyone. Two routines made the same assumption in two places, written separately; there is now one decision they both use, and absence from that list has stopped being a reason to delete anything - it is only a reason to ask the server what the thing actually is, which it knows. The routine that used to destroy the group is now how a device discovers it, so nothing depends on which part of the app finishes first. Separately, a key your device can NEVER read - one from an epoch that has passed, or one your own device sent - was being requested from the server over and over, every connection, for ever; those are now acknowledged once, because what recovers a missing key is asking another member for it, never receiving the same unreadable bytes again
- **The window that creates a channel spoke French to English readers.** Its "Visibility" heading, its two choices and the sentence explaining each of them were written straight into the code rather than taken from the translated set, so the English app rendered that half of the window in French - the only part of it that did. The wording seen in French is unchanged; what changed is that there is now an English one at all

- **The button that creates a community had no name a screen reader could read, and two of its neighbours were the same.** All three drew their icon by hand instead of using the shared set - the "add a community" button reproduced, stroke for stroke, a plus sign the file was already importing - and two of them carried their label only as a tooltip, which is the weakest way to name a control and the one that disappears on a touch screen. The third had its label written directly in French in the code, so it would have stayed French in the English app. All three now take their name from the same translated text as their tooltip, and draw the shared icon
- **A call that ended normally left its relay connection running on the server.** Canari's calls are relayed through a paid third-party service with a monthly allowance, and the server is careful to refuse new calls once that allowance is spent. It was not careful about giving back what it had taken: only one of the three ways a participant leaves actually closed the relay connection - the one that fires when the same person joins from a second device. An ordinary hangup, and the sweep that clears rooms nobody has touched in half an hour, both simply forgot the participant while the reservation stayed open against the same allowance. All three now close it, which is also what makes the new call record honest: a line saying a call ended while its relay was still running states an end that has not happened
- **A ring that reached nobody could not be told from a ring nobody answered.** When the server cannot talk to the notification service at all, no Android phone is rung - and the summary it wrote said only how many devices had been reached, which for that fault reads as "everyone was unreachable" rather than "this server never asked". Worse, on the signal that STOPS a ring, the check sat inside the loop over the devices and abandoned the rest of them, then reported a number that looked like a partial delivery. The cause is now named once per call, before any device is tried, and the count that follows means what it says. An iPhone rung through Apple directly was never affected by it. Two neighbouring silences went with it: a group whose name could not be read, and the missing configuration that stops the person being called from joining - the person calling was already told about that one, so a call dying on the answering side looked like a fault in the app
- **A phone with no space left could open Canari and show a history that did not match its own encryption state.** When the local database refused to open on mobile, the app quietly used the browser-style store instead - but only for conversations and messages, because the encryption state is kept somewhere else and did not move with them. The result was an app that started, looked healthy, and disagreed with itself. It now refuses to open and says why, which is also the only honest answer: the replacement store was on the same full disk. Separately, on the web, opening the local database while another tab held an older version of it open would hang the start-up forever with nothing said - it now stops and tells you to close the other tabs
- **Canari's public, read-only API was unusable from a development machine, and answered a server error to anyone else.** Two faults in the same place, found while giving the student portal a real `<head>`. The public routes are open to every site by design, and that permission was being granted twice - once by the entry point, once by the service behind it - which produces a response every browser rejects outright as malformed. It only ever happened for addresses on a developer's own machine, which is exactly the population it was meant to serve, so the portal's pages failed locally and worked in production, the least helpful way round. The permission is now granted in one place. Separately, three of the four services answered an address they did not recognise by raising an error rather than simply declining, and an error there is a server failure for the whole request - including requests that need no permission at all, such as fetching an association's logo, which returned a server error to any caller that identified itself and was not on the list. Declining now declines. Nothing about who may read what has changed, in either direction
- **An invalid entry-point configuration can no longer be deployed.** The routing rules are assembled as text while the image is built, so nothing checked them: a misplaced character produced an image that built green, deployed green, and then refused to start - which is the entire site, discovered by a person looking at a 502. The build now validates them and fails there instead, where production keeps serving the previous image
- **Restoring a backup now tells you whether it worked.** Importing a `.canari` file that Canari refused looked exactly like importing one that worked: the button greyed out for a moment, came back, and said nothing either way - so a file made with a different PIN, a file damaged in transit, a file that was never a backup at all, and a backup fully restored were all the same event from the screen. Eighteen distinct reasons an import can be refused existed already; none of them reached you. Each is now named in a sentence you can act on - this is not a Canari backup, it was made with a different PIN, it was made by too old a version so export a new one, it is damaged, it is too large - and a restore that worked says how many conversations and messages came back. A backup restored onto a DIFFERENT device says so too, because those conversations arrive read-only until the original device invites you back into them, and being told only "restored" makes the silence that follows look like a bug. Exporting reports itself the same way. The reasons are now chosen by a code rather than written as a sentence where the failure happens, which is what lets them be translated at all: the part of the app that refuses a file has no way of knowing which language you read in
- **Notifications about posts, comments and forms now speak your language instead of one picked for everybody.** A comment, a reply, a mention or a reaction arrived in French whoever you were; the two form reminders arrived in English whoever you were - the same service, wrong in both directions at once. It was never a translation that had been forgotten: the part of Canari that sends these is the only part that cannot know which language you read in, since nothing in the request carries it and nothing stores it. So it no longer writes the sentence at all. It now sends WHAT happened - who acted, and the one piece that is not translatable, like the emoji someone reacted with - and your phone writes the sentence itself, in the language you chose inside Canari, exactly as notifications about message reactions already did. The wording of everything else is unchanged
- **A conversation that had been deleted left most of itself on the server, for ever.** When a group ends - the last member leaves, or ninety days pass on a deleted one - the server was told to remove two of the seven kinds of record it keeps about that group. The other five stayed: the group's cryptographic bookkeeping, its undelivered messages, its invitation links. One of those five had no expiry of any kind anywhere in the system, so those entries were permanent. Two thirds of one such table on the server, and nearly a third of another, belonged to groups that no longer existed. There was a routine meant to catch exactly this, and it found nothing every time it ran - because it looked for leftovers by starting from the two kinds of record that ARE deleted, so it was searching the only two places where nothing can ever be left. Both ends are now the same single list of what a group owns, used by every path that ends one, and the records go in the same indivisible step as the group itself, so there is no moment where the group is gone and its data is not. The entries already stranded have been removed. A device could previously receive undelivered messages for a group that no longer exists, which sends it looking for a key nobody can give it
- **The phone and the desktop app were shipping an older copy of the encryption core than the website, and nothing said so.** Everything Canari encrypts runs through one piece of compiled code, and that compiled code was stored alongside the source it is built from rather than being rebuilt each time. The website's pipeline rebuilt it before every deployment, so the site always ran the current one; the three pipelines that produce the Android, iOS and desktop releases did not, so those apps carried whatever copy had last been saved by hand - at least one correction behind, for weeks, with no error, no warning, and nothing anywhere comparing the two. A fix could therefore be live on the site and absent from the phone with no visible difference between them, which is also why the tests would have measured two different pieces of software while appearing to measure one. Rebuilding it from untouched sources produced a different result, which is how this was confirmed rather than suspected. Every pipeline that ships a client now compiles it itself, from a single shared definition with a single pinned compiler version - two pipelines with two versions would recreate the same problem - and the saved copy has been removed so there is nothing left to go out of date
- **A community message your device had no key for could stay unreadable until you restarted the app.** When a message arrives sealed with a key your device was never given, it asks one particular member for that key - one, rather than everybody, so a salon of three hundred does not send back three hundred replies. Who to ask is decided by a rule every device works out identically, which is what makes it safe and was also what made it a dead end: if that person did not have the key either, they said nothing at all, every device went on choosing that same person, and the message stayed blank for the rest of the session. They now say which keys they do not have, and your device asks the next member instead, working down the list until somebody answers or there is nobody left to ask - and "nobody left" is now written down rather than left as a blank message with no explanation anywhere. Two quieter versions of the same gap went with it: a key that arrived while your device was reconnecting could land just after the salon had given up on those messages, and nothing went back for them until you left the salon and returned; and a key that did arrive left its request standing, which would have silenced the next one
- **The server's shared copy of a conversation now really stops after ninety days, which it did not.** Ninety days is the promise the whole app is built on - it is the window your device uses to decide whether the server could still be holding something for it - but nothing in the server actually enforced it. The shared log was capped by the NUMBER of entries it held, not by their age, and the deletion timer on it was pushed back every single time anything was written, so any conversation below the cap kept everything it had ever held, indefinitely. Four of five conversations measured on the server were still carrying entries older than the change that was supposed to have retired them. The log is now trimmed by date on every write, in the same single round trip that adds the entry - so it costs one instruction fewer than before rather than one more - and each of the three steps reports its own failure instead of the batch failing as a whole
- **The Safe Browsing warning on a suspicious link never actually showed on the phone or desktop app - only on the web.** Tapping a flagged link took you straight to the site, on every platform except a browser tab. The check itself was correct and always ran on the server; what failed is that the app's own link components asked for a warning from inside a click handler that a different, older piece of code - installed to route in-app links and already routing every other external link straight to the system browser on the app - had already intercepted and stopped before it could run. Nothing crashed and nothing logged, which is why it went unnoticed since the warning shipped. The check now lives in the one function that actually opens a link, on every platform and for every caller, including a link opened from a conversation's shared-links list, which had never been checked on any platform at all
- **The same person no longer keeps a different face on each of your devices.** A photo, once drawn, was kept by that device for ever: avatars were stored in a place that has no notion of expiry at all, so the server's instruction to refresh them daily governed a copy that was never consulted again. Whichever photo a device happened to see first was the one it kept - which is why the same person could appear three different ways on a computer, a phone and MiGallery, and why anyone who had only ever seen them once could not reproduce it. Avatars are now left to the browser's own cache, which does honour the daily refresh the server asks for, and the old store is deleted the next time the app opens, giving back the space it was holding. Nothing else moved: an association logo gets a new address whenever it changes, so keeping it indefinitely is still correct, and the notifications on Android and iOS already refreshed their copy every day. A face appearing many times on one screen also now costs a single request instead of one per appearance
- **Attaching a GIF to a comment now works, and a media that cannot be attached now says so.** Picking a GIF for a comment did nothing at all: no GIF, no error, no trace. The picker's own grid loaded normally, which is what made it look like a dead button rather than a refusal - the page is allowed to DISPLAY any image on the web, but it is only allowed to READ bytes from a short list of sites, and the site the GIFs themselves come from was missing from that list. It had to read them because a comment's media is encrypted on your device before it is uploaded, so the file has to be in hand first. The site is now on the list, which is checked by a test against the code that calls it, and stated in one place instead of three copies that could drift apart. A GIF sent in a **conversation** was never affected - it travels as a link - and neither was one committed from the phone keyboard, which hands over the bytes directly. Separately, all three ways of attaching a media to a comment now report a failure instead of failing silently
- **Leaving a channel no longer throws you out of the whole community, silently.** A community's public channels are readable by everyone who belongs to it, so belonging is recorded once, for the community - a public channel keeps no separate record of who is in it. "Quitter le salon" deleted the community record anyway, which put you outside a community your app was still showing: it stayed in the sidebar with its channels, and everything you could do with it then failed, "quitter la communaute" included - so the only way out was the one thing that no longer worked. It read as a bug about the last channel because that is when the community visibly empties, but any public channel did it. Leaving is now offered only where there is something to leave - a private channel - and the server refuses the rest instead of removing something else. Six memberships had already been lost this way and have to be granted again by hand; nothing recorded that they were lost by accident rather than on purpose
- **Catching up on messages received while you were away no longer gives up on a slow connection that is working perfectly well.** The app fetched that backlog a page at a time and gave each page ten seconds to arrive in full - which measures how long a page took, and cannot tell a page arriving slowly from one that has stopped arriving at all. On a slow link a page that was on its way was abandoned anyway, and the app then asked for a smaller one, repeatedly, on a connection that was fine. It now watches whether anything is still arriving instead of how long it has taken: it waits as long as the data keeps coming, and only gives up on ten seconds of complete silence. The log also now says which of the two actually happened, because a server that never answered and a transfer that stopped mid-way need opposite responses

- **Adding Canari to an iPhone's home screen now puts the bird there, not a photograph of the page.** The app never declared a home-screen icon, so Safari went looking for one at the two conventional addresses, found nothing at either, and fell back to a screenshot of whatever page you happened to be on. A third address, the one browsers and feed readers ask for before reading anything else, was equally empty. Both files exist now, are declared rather than left to be guessed at, and are generated from the same drawing the Android launcher icon comes from - so the app cannot end up wearing two different faces. The home-screen icon is painted onto its navy background on purpose: iOS puts a transparent icon on black, which would have turned it into a black square
- **A long press on a phone no longer selects the page furniture.** Trying to copy part of a message could just as easily select a navigation label, a section heading or the explanatory line under a setting - none of which anyone wants a copy of. Selection is now off by default on touch screens and switched back on for the things worth copying: message text, media captions, and every text field. A mouse is unaffected, because dragging across a label with one is deliberate where a long press with a thumb is usually not

- **On Android, the message box no longer hides under the keyboard, and the conversation no longer scrolls onto an empty white band.** One cause, two faces. The app asks Android to shrink its window when the keyboard opens, and since Android 15 that request is ignored outright for any app drawing under the status and navigation bars - which this one does, deliberately. Nothing shrank, so the box stayed where it was, behind the keyboard, and the browser's own attempt to bring the focused field into view scrolled the page past the end of its content onto the background behind it. The app now measures the keyboard itself and shrinks its contents by exactly that height. The strip reserved for the navigation bar is also given back while the keyboard is up: the bar is behind the keyboard at that point, so the strip was an empty band you could drag the whole page by, which is what made the top of the conversation slide away under your thumb
- **A connection you abandoned no longer stays usable for a week.** Signing in again did not replace your previous session, it added one: the browser kept only the newest cookie, so the older line was already unreachable from your machine - and stayed valid on the server for seven idle days regardless. Whatever else claims a device you have just unlocked is now destroyed at that moment, which is the first instant the server can tell your devices apart; doing it at sign-in was not an option, because at that point the only thing it knows is WHO is signing in, and acting on that would have signed your phone and your computer out too. Measured beforehand: of forty-seven people with a live connection, thirteen were carrying several

- **A community can no longer be left with nobody able to run it.** Nothing counted the administrators on the way down: the only one could walk out, be removed by anybody holding "exclure des membres", or demote themselves in two clicks - and once they were gone, no one could ever rename the community, invite into it, or delete it again, because every one of those needs an administrator who is still a member. It was not a rare shape: of the twenty-nine communities on the server, fifteen had exactly one. The last administrator is now refused, in all three cases, until they have given the role to somebody else. The same absence had a fifth face nothing would have caught by looking at the buttons - deleting your account removes your memberships directly, and there is nothing to refuse there since the account is going regardless. That one repairs instead: if the community still has members, the longest-standing one is made administrator and the promotion is written to the log; if it has none, it goes
- **A community nobody belongs to no longer survives as an unreachable row.** Members could leave until there were none left, and what remained was invisible to every screen - all of them list only communities you are in - impossible to delete, since deleting needs a member, and still holding its name. The last person leaving now takes the community with them, along with its channels, its messages and its invitations. And an invitation link that outlives its community is refused rather than repopulating it with members and no administrator at all, which is the one state nothing could have recovered from
- **A community's invitation link is now a single link, and one you can bound.** "Générer le lien" minted a brand-new one on every click while leaving all the previous ones working - one member produced three valid links for the same community in fifty-nine seconds - so revoking the link you had shared revoked nothing, and there was no way to know the others existed. There is now one link at a time: opening the panel shows the one already in circulation, and regenerating revokes it in the same breath. It can also be given an expiry and a maximum number of uses, up to now impossible: all ten links live on the server were eternal and unlimited, because the form offered neither field. Both are shown next to the link, since a URL cannot tell you on its own whether it still works tomorrow

- **The storage panel invited a wrong conclusion about message sizes, and the number that would have prevented it was one it never showed.** The list of messaging tables gave one size per table, taken from what the table occupies on disk. Read next to a row count - which is the only way it can be read - that says how big a message is, and for the undelivered-message queue it said ninety kilobytes each. They average under one. The gap is not data: an abandoned device once accumulated twenty-eight thousand undelivered messages in five hours, and although those were removed long ago, a database frees such space for its own reuse rather than handing it back to the system, so the file still wears the size of its worst hour while holding a thousandth of it. That is correct behaviour and worth seeing, but not worth mistaking for content. Each table now shows both figures - what it costs and what is in it - with the second drawn inside the first, so a table that is mostly empty space looks like one at a glance. The second figure is an estimate and says so; it is taken from statistics the database already keeps, so the panel costs no more to open than before
- **Insurance written for the messaging queue's disk usage was applied to the two percent of it that never needed it.** After the incident above, the queue table was given a tighter cleanup setting on the grounds that a queue can grow thirty-fold in an hour and the default setting waits longest exactly when a table is largest. The reasoning was right and it landed on the wrong half: message payloads are too large to sit in the main table and live in a companion the database manages separately, which inherits none of its parent's settings and had none of its own. Ninety-six percent of the table was therefore still on the default the change was written to replace. It now carries the same setting. Nothing was going wrong - the cleanup is comfortably keeping up on both halves, which is when insurance is worth writing rather than after
- **The one pre-encryption sending path left in the server now says so when something takes it.** A column on the queue table holds the message payload of a design that predates end-to-end encryption; every client since sends the encrypted form instead, and the column is empty on all eight hundred and seventeen messages currently waiting, going back three weeks. But the queue only records what was not yet delivered, so that is strong evidence and not proof, and the path was being served silently on both the writing and the reading side - which is how a column outlives its writer without anyone noticing. Both sides now record it plainly when it happens, so the decision to delete the path is made by reading whether it ever fired rather than by arguing about it, and a date has been set for that
- **The line reporting a departing member's revocation named one of the three things it cuts and printed the count of another.** When someone stops being a member of a community, the server immediately cuts them off the key distribution in three separate places: the rows a reconnecting device reads, the live fan-out list, and anything already sealed and waiting for a device that was offline. Each is counted and none can stand in for the others. The summary line printed the row count under the fan-out list's name, and dropped the fan-out count entirely - because the piece in between carried only two of the three figures across. For as long as the two happened to agree, which for anyone signed in on a single device is always, it read as correct; the first departure it was ever measured on logged them equal. All three are now carried and each is named. Separately, a community that has no key distribution at all - one created before the mechanism existed - reported three zeros, which is exactly what a clean cut with nothing to remove also reports; it now says which of the two happened, and says it at a level that asks to be looked at, because on a recent community it would mean the group is missing.
- **Two of the eight rows in a community's permission table decided nothing, and the table had to be dragged sideways to be read.** "See and read the channel" and "Send messages and files" were drawn in the grid, saved when toggled, and consulted by no part of the server. They have been removed rather than made to work, because making them work would have been the mistake: who can read a salon already follows from whether it is public - visible to the whole community - or private, in which case it is visible to the people added to it; and who can post is already set per salon, which can express "announcements are admin-only, everything else is open" in a way one community-wide switch never could. A control that cannot change an outcome is worse than a missing one, because it reads as a control. The same clean-out drops a field on every salon recording which roles may open it, which has been empty since the day it was added and read by nothing - a private salon is opened by the people invited to it, and an invitation names a person. With six rows instead of eight the table is also given the room it needed: the settings window widens on that tab, so the grid is read in one piece instead of through its own horizontal scrollbar. An older app still showing the two removed rows keeps working - the server applies what remains of what it asks for, and records that it asked.
- **The check that stops you inviting someone who has never installed Canari answered "they have" whenever it could not find out.** Before an invitation goes out, the server asks the messaging service whether that person has ever set Canari up on a device - if they have not, no key can reach them and the invitation would be silently useless. The question was asked, and every way of failing to get an answer was read as yes: the service unreachable, an error reply, a missing configuration. That is how it went unnoticed for months that the address being asked was wrong - the check was not degraded, it did not exist, and it reported success. It now answers only what a real reply said, and the two situations reach you as two different sentences, because they call for different things: "this person has not installed Canari yet, they need to open the app once" is about them, and "cannot check right now, try again in a moment" is about us. Neither of them adds the person to anything. The invitation screen also stopped printing the server's raw English reply when it failed.

### Removed
- **The half-built ability to invent your own roles, which no screen ever offered.** A community has three roles - member, moderator, administrator - and the app has never had a way to add a fourth. The code that would have sent such a request to the server was written, shipped, and called by nothing, in any version. It is gone. The server can still create one for anyone who asks it directly, and the permission grid shows and edits whatever roles a community has, so nothing that exists stops working; what is removed is a path no button ever led to
- **A duplicate set of backup buttons that no screen had ever shown.** A second component carrying the same import and export controls existed alongside the one in the settings, imported by nothing and reachable from nowhere. It has been deleted rather than given the same repairs as the real one

### Changed
- **Community messages now expire after a year, and the keys that open them leave with them.** A salon message used to be kept for ever: nothing on the server ever removed one, so a living community's history grew without any bound at all, and every device kept the key to every message it had ever been able to read - for ever too, since the only thing that had ever dropped one of those keys was leaving the community. A message older than a year is now deleted nightly. **A pinned message is never deleted**, whatever its age: pinning is somebody deliberately saying this one outlives the scroll, and silently destroying it at a year would be destroying the one kind of message a person explicitly marked as worth keeping. The keys follow the same boundary, and follow it rather than repeating it: your device asks the server which of the salon sessions it holds still have messages, and forgets the others. That is what makes the exception for pinned messages safe - a pinned message keeps its own key alive by still being there, where a second, separate one-year timer on your device would have deleted that key and turned the message you chose to keep into something nobody can open. Your device also refuses to forget a key too recent to have lost anything, and forgets nothing at all if the question went unanswered, since "the server named nothing" and "the server did not answer" look identical and only one of them means the messages are gone
- **A database nobody used is no longer started, backed up, or waited for.** The deployment ran a MongoDB container, and the documentation said it held every post, comment and reaction. None of that was true: those have always lived in the same PostgreSQL database as everything else, nothing in the code has ever carried a MongoDB address, and the database the container declared was never even created - it held the three housekeeping databases MongoDB makes for itself and nothing else, measured twice a week apart. Meanwhile the service that delivers messages waited for it to report healthy before it would start, so every restart of the platform was delayed by a container it never spoke to. The nightly backup dumped it too, producing a 116-byte file listed in the manifest beside the real ones - and on the one day that manifest gets read, the day someone is restoring, a line that names a source reads as a backup of it. The container, its 479 MB of storage, the wait and the backup step are all gone, and the pages that described it now say what actually holds the data
- **Nothing in the deployment says MinIO any more, four days after MinIO stopped running.** Media storage moved to Garage on 2026-08-14, but every setting that configures it kept its old name, on the stated reasoning that the S3 client library is still called `minio` - which is a fact about somebody else's package, and was never a reason our own settings had to carry it. A name that lies about what it configures is read by the next person as evidence about what is running, which is how a variable defining a port nothing reads survived unnoticed: it named a host port under the old name while the deployment had been reading the new one since the migration. Everything is `GARAGE_*` now, in the deployment files, the service and the documentation. One credential also existed under two names at once, which is a duplicate that can drift apart, and drifting there refuses every media request - the two were confirmed identical on the live server before being collapsed into one. Two secrets left over from MinIO, which the dev deployment still demanded for a service it had already stopped running, are gone. Measurements taken before the migration keep their MinIO wording deliberately: rewriting them would falsify a record rather than tidy it
- **Deleting a community now deletes it, and you have to type its name to do so.** Until now the button hid the community instead of removing it: every message, every member and the name itself stayed on the server, on the reasoning that a mistake could be undone. That reasoning expired when community messages became readable only with keys held on people's devices - undoing the deletion would have brought back a community whose entire history nobody could open, still holding its name, listed on no screen, and no longer deletable by any route, since deleting one requires being a member of it. What looked like a safety net was a way to strand a community permanently. It is a real deletion now, so it asks for something a reflex cannot supply: the community's name, typed out. The name is also checked by the server rather than only by the dialog, which is what stops an app installed before this change - whose warning still says the deletion can be undone - from destroying anything at all
- **A copy of media people had deleted was still sitting on the server, and it is gone.** When media storage moved to Garage on 2026-08-14, the old store was left in place as a way back if the move had gone wrong, to be discarded two weeks later. It was discarded early, and checking it before deleting it is what showed why it should never have been kept that long: of the two hundred files it held, five were no longer in the new store. They had not been missed by the move - the move was verified file by file at the time - they had been deleted by the people they belonged to, in the days since. So the safety net was not holding a spare copy of anything live; it was holding, readable, five things the platform had already told someone were gone. The store is deleted, along with an empty leftover of the retired database and the two access keys that opened the old one. Backups taken before the move still contain it and expire on their own schedule, which is what a backup is for
- **The server can no longer read a single thing you write in a community.** A community message used to be encrypted with a key the server itself derived and stored, which meant it could open every salon message and every attachment in them, for the whole history, without touching a membership record - that was the design, not an accident, and nothing on the server used it. Messages are now sealed on your device with a key the server has never held: one seed per person per salon, handed out through an encrypted channel of its own, so a community of three hundred costs one delivery rather than three hundred. A seed changes when somebody leaves, after a hundred messages and after a week, and changing it destroys nothing - the older ones keep opening older messages, which is what lets you read what was written before you arrived. A message you have no seed for says so instead of vanishing, and your device asks one named member for it rather than the whole community. Notifications still open on your phone before the app does, on Android and iOS, by deriving the same key the same way. The old key material has now been removed from the database outright rather than left unused: the root secret every community key was derived from, the record of which key each message used, and the ledger tracking keys handed to new members are all gone, so the ability to read a salon is not merely unexercised - it no longer exists anywhere on the server
- **What a newcomer may read of a community's past is now a setting, and the members enforce it.** It was never a question anybody could answer: a new member received the keys to everything, always. A community can now choose between handing over the past and starting a newcomer from the day they arrived. The server stores the choice and broadcasts it, but cannot apply it - it holds no key - so it is applied by the member who answers the newcomer, and a member who has not learned the setting refuses rather than guesses. The trade-off is stated where it is chosen: a shared past means a leaked invitation link grants the past too
- **A reaction in a community is now as unreadable to the server as the message it is on.** The tally used to be stored in plain text: the server could not read "j'arrive" but could see that eight people put a heart on it, which is content by any honest reading. A reaction is now an encrypted message like any other, and it is silent - the community is not notified, only the author of the message, exactly as in a conversation. The only thing the server learns is that a row must not ring a phone, which is also what keeps a burst of reactions from quietly pushing older messages out of the page you are reading

- **The admin storage panel now says WHY the media are that size, not only how much they weigh.** A bucket that grows looks exactly the same whether people are uploading more or the automatic clean-up has quietly stopped removing anything, and those two need opposite responses - a single total could not tell them apart, so nobody could act on it. The panel now shows what was written in each of the last four weeks, so two visits a month apart are the slope; it says whether anything is past its expiry and, if so, whether that is simply the wait until the next sweep or a sweep that ran and skipped it; and it counts separately the objects no sweep can ever reach, which are the ones that stay for ever. Nothing new is stored and no new timer runs: it all comes from one listing of what is actually there, crossed with what the server thinks it has
- **A phone now stays in portrait; a tablet still turns.** Every screen here is drawn for a tall window, and turning a phone sideways left a conversation two lines high above the keyboard. A tablet is used as a computer is, so it keeps its rotation - the threshold is the screen's shorter side, which is a fixed property of the device and therefore does not change when you turn it. Turning a tablet also no longer restarts anything: the window is re-laid-out in place rather than rebuilt, so a message being sent is not interrupted by a movement of the wrist
- **"Connexions actives" and "Gestion des appareils" are now one list.** They described the same physical things - your phone, your computer - from two sides, and nothing joined them, so no row on one could be matched to a row on the other. Each device now appears once, carrying its own last activity, the browser it was used from and a short identifier that is stable enough to recognise. A connection that never identified a device gets a line of its own rather than being hidden under one, because that is precisely the shape a stolen cookie takes. There is a single button per line: removing a device signs it out AND revokes it, since somebody removing a machine they no longer trust means one thing, not two. The group-synchronisation counters are gone, along with the one request per device they cost every time the panel was opened
- **The canari in the app icon no longer runs off the edge.** The drawing filled its square exactly, edge to edge, which looks deliberate right up to the moment something rounds it off - and most things do. A browser tab, a search result, a launcher and a link card all mask an icon into a circle or a rounded square, and none of them can add room the drawing does not leave: they scale the whole square to the shape and cut whatever sticks out. What stuck out was the tail and the beak, which sit on opposite diagonals, so they were the furthest thing from the centre and the first to go - the bird reached a third again past the circle it was being fitted into. It is now drawn at 71 percent of its square, centred, which is measured rather than picked: it is the largest the bird can be and still clear the circle, with a little room to spare. The diagonal is why a smaller trim would not have done - taking a tenth off keeps the tail outside the circle, just less obviously. The home-screen icon on iOS and the launcher icon on Android are unchanged, because both of those pad the bird themselves and their generators were adjusted by the same factor; what changes is every surface that had no padding to give.

### Removed
- **Every community and everything in it has been deleted, once, at this deployment.** Communities were the one part of Canari the server could read: each salon message was encrypted with a key the server itself worked out and kept, and that key has now been removed from the database. Nothing can re-encrypt what was already written - the new system's keys are made by the person sending, and nobody ever made one for a message sent before it existed - so those messages would have stayed on screen as history that no one, not even their author, could ever open. They were deleted instead, along with the communities, salons, memberships, roles and invitation links, on the deployment that removed the old keys. This was announced beforehand outside the app, which is why the app itself says nothing about it. Your conversations and groups are untouched: they were never encrypted this way
- **A community leaving your device now takes its keys with it.** Whether you left it, were removed from it, or it was deleted, the app dropped it from the sidebar and kept every key it had been given for it - on the device, in the background notification store, and in memory - because the erase-it-all step existed but had never been connected to anything. It is now connected, at the single point all four of those paths already went through, and it clears all three places at once
- **A device answering a history request no longer guesses what the asker wanted.** When one device catches another up, the asker states how far back it needs; a request stating nothing used to be answered with everything, because the only senders that could omit it were entitled to the lot. Since the minimum client version was raised, no such sender exists any more - so a request arriving without that range is not an old client, it is a broken message, and it is now declined and logged rather than served. What made this worth doing is that "from the very beginning" and "said nothing" used to be the same value, so a malformed request was indistinguishable from a legitimate one

## [0.14.0] - 2026-08-17

### Added
- **A community message is now unreadable by the server, like a private conversation already was.** Until now every salon message was encrypted with a key the server derived itself from a column it holds, so anybody with the database could read every salon of every community, for the whole history, and open every attachment - the file's own key travels inside the message. That was a deliberate design and not an accident, but it was the requirement that changed. A message is now sealed with a key that grows from a seed its sender generates, which never leaves the members: the seed travels to the whole community in a single encrypted envelope, and the server stores a blob it holds nothing for. Nothing moved on screen. Leaving a community also finally means something - the seed is replaced as soon as anybody joins or leaves, so whoever left keeps what they could already read and gets nothing said afterwards. Notifications keep showing the message itself on Android and iPhone: the phone derives the same key locally, exactly as before, from a seed it keeps for the recent salons. What is not there yet is the part where a device that missed a seed asks a member for it, so a member reading a salon on a brand-new device may find older messages blank for now; the server's own ability to derive keys also still exists, unused, and is removed next
- **You can now scroll back past what your device kept.** A browser keeps only the last ninety days of a conversation, so scrolling far enough up used to stop dead, with nothing to say whether that was the beginning of the conversation or the end of what this device happened to keep. Reaching that point now asks another of the conversation's devices for the page before it, and says what is happening: a loading row while the request is out, and a plain message when nobody was online to answer
- **A device that asks for more history than the one answering it has kept now goes and asks somebody else.** A browser keeps ninety days and a phone five years, so a phone asking a browser to catch it up always got ninety days - which it could not tell apart from "this conversation has no more past", so it either did without years of messages or kept asking the same device. The answering device now says where its own memory begins, and the asker moves on to another member, stopping when the server reports there is nobody left it has not already heard from
- **Deleting your account now deletes the photos and files you uploaded, which it never did.** The account row went, the messages went, the posts went - the media stayed on disk for ever, because nothing on the server knew they were yours: the token proving you were allowed to upload was checked and then thrown away. It is kept now, and account deletion asks the media server to remove everything uploaded under it. Files uploaded before this change carry no owner and are still only reachable by the 30-day expiry.
- **The text of a PDF opened in the app can now be selected and copied.** The reader draws each page as an image, because that is the only renderer Android's WebView has - and turning a page into an image only costs you its text if nothing puts the text back. The real characters are now laid over the image, invisible, each positioned where its glyphs are, so selecting, copying and the browser's own "find in page" work over a document the way they work over any other text
- **A PDF attached to a post or a message can now be read in the app - tap it anywhere, on any platform.** Until now the only thing you could do with a document was download it, and the preview under a post was decoration. The whole card is now the target, and it opens a reader that renders the document page by page - rendering rather than embedding because media is encrypted before upload and Android's WebView ships no PDF renderer at all. Pages rasterise as they scroll into view, so a two-hundred-page document costs one page to open
- **A link in a message or a post now warns you before opening it if Google Safe Browsing has flagged it as malware, phishing or unwanted software.** Until now a link was opened with no safety check at all, so a dangerous one pasted into a conversation read identically to a legitimate one. The check is server-side, since a Safe Browsing key can never ship client-side, and the warning shows only on an actual click on a flagged link rather than decorating every link. It fails open at every layer, and a failure is never remembered - only a real verdict is
- **A message or a post naming `canari-emse.fr`, `gallery.mitv.fr`, or anything under `emse.fr` now becomes a real link even without typing `https://` in front of it.** Chat only ever linkified a URL that already carried its scheme, so the school's own domains typed the way people actually type them were dead text on both surfaces. An exact whitelist of real hosts is used rather than a general "known extension" rule, because French inclusive writing makes TLD shape an unreliable signal - "cher.es" reads exactly like a Spanish domain. Chat and posts share one regex
- **Settings now shows how much of your own device Canari is using, and lets you clear the reclaimable part.** The media, avatar and logo caches, the local message database and the encrypted key state all accumulated quietly over months with no way to see or act on any of it. A new panel breaks the total down and offers a single "clear media cache" action, scoped to exactly the caches that are safe to lose because everything in them is re-fetched on demand - it never touches messages or any device key.
- **iOS gets its own dedicated login browser session, closing the gap left open on that platform.** The earlier fix gave Android a Chrome Custom Tab that the OS closes automatically once the OIDC deep link brings the app back; iOS kept the plain system-browser launch. It now uses the iOS equivalent, a dedicated authentication session, which intercepts its own callback rather than handing it to the app's normal URL path - so the plugin re-opens that callback to route it back through the same shared deep-link pipeline Android already uses. Never run on an iOS device or simulator, only compiled
- **The admin panel now has a Storage page reporting what the SERVER itself is using: disk, database, media objects and cache.** No such measurement previously ran anywhere - every number ever quoted about server storage came from one-off SSH commands. The four are measured independently and whichever succeed are reported even when one fails, rather than letting one unreachable dependency blank the other three. The admin navigation was reworked alongside it: nine flat tabs in a scrolling bar become three dropdown groups plus two direct links, each group rendering only the sub-pages the current admin can open.
- **If the app ever stops receiving messages entirely, it now says so instead of going quiet.** Incoming messages are processed one at a time, so if any single step of that pass never finishes, every message arriving afterwards queues up behind it for as long as the app stays open. That has happened twice for two unrelated reasons, and both times the log said nothing at all. There is now a single way to wait inside that pass, and it reports itself after a minute and every minute after, naming the step, the conversation and the message
- **The server now says, every hour, how much undelivered mail it is holding and which device is holding the most of it.** It deletes nothing - it only looks. One device quietly accumulated 28 124 undelivered messages in five hours, thirty times the rest of the platform put together, and nothing anywhere said so. The report names the five deepest queues and, past a threshold set from what production measures, warns with the date that device last connected - because depth alone cannot tell a live device failing to keep up from debris awaiting collection
- **The photos and files stored on the server are now backed up in a way that does not multiply them.** Every night the server made a fresh full copy of every media file and kept fourteen of them, so each file stored cost fifteen times its size on disk - and because these files are encrypted before they leave your device, they cannot be compressed and never change once written. A second, deduplicating backup now runs alongside the existing one, storing each file once and adding only what is genuinely new. It was verified by restoring it and comparing every file against the original.
- **First step of the Stripe -> Lydia payment migration: a provider abstraction, with Stripe behind it unchanged.** The payment module talked to the Stripe SDK directly, so swapping payment providers would have meant editing the one class every checkout, onboarding and saved-card path called into. A provider interface now sits between them, with the Stripe implementation a pure extraction of what was already there. A Lydia implementation covers the two flows that map cleanly onto it today; everything else throws a clear, documented error instead of faking a result
- **Association onboarding now supports Lydia's `business/create`, which needs the club's legal profile upfront.** Stripe's hosted onboarding link let the club fill in its own name, address and contact details on Stripe's page; Lydia has no such flow, so Canari collects it itself. The association edit page now asks which processor is active and renders either the existing Stripe button, unchanged, or a new form that creates the business directly. The business's own private token is deliberately never stored
- **The Stripe/Lydia switch lives in the platform admin settings, not an environment variable.** Flipping it takes effect immediately, with no deploy or restart, because the platform config is already read straight from Postgres on every call. Both providers are still built once from their env-held secrets - only the choice of which one is active moved to the database
- **Lydia's credentials are wired through the same infra as Stripe's, but core-service only.** The three Lydia environment variables are in the example env file, all three docker-compose files, both CD workflows and the prod post-deploy drift check that fingerprints the value actually inside the running container. Actual token values still have to come from Lydia and be set as GitHub secrets - this only makes the pipeline ready to carry them

### Changed
- **Canari is on the Play Store, so it stops asking people to update - and the one prompt that remains now leads somewhere that works.** A non-dismissible modal opened on every launch as soon as the client was a single patch behind the server; the store updates people by itself, so it is deleted and the installed version moves to a discreet "A propos" block in settings. The blocking gate was also lying: it told every Android user an APK would open in their browser, and the store URLs came from repo variables that were never set. The update target is now resolved at runtime from how this install actually arrived, since the Play binary and the GitHub APK are signed differently and neither can install over the other
- **The status banners no longer say the same thing twice, no longer shift the page under your finger, and are now readable.** Six of them had been written independently and agreed on nothing: two pairs said one thing twice, four were translucent so the text underneath showed through the words meant to be read, and the two above the application were in the layout flow, so each appearance pushed everything down and each disappearance snapped it back under a click aimed at the sidebar. The duplicates are gone, every banner draws on one opaque surface, and the two window-scale banners share a single column
- **Deleting a device now takes effect on that device immediately, and leaves nothing of it behind.** Removing a device from the security page purged everything the server held for it, and the device itself noticed none of that - its session stayed open and everything it held locally stayed on it until it next signed in. The server now tells the device the moment it is deleted, and the device signs out and returns itself to the state of a brand-new install. It checks with the server first, and a failed check means "not revoked", so a connection problem can never wipe anybody
- **Android notifications now speak the language you chose in Canari, everywhere.** Nineteen sentences had never been put in the app's translation table and were written into the program in French - the synchronisation notice, the queued-messages notice, the generic encrypted-message line, "new message in #salon", and the names and descriptions of the five notification categories the Android settings screen lists. All nineteen are now in the table, in both languages. A category keeps the wording it was created with, so switching language does not rename the ones you already have - re-creating them would throw away the sound and importance you picked
- **On iPhone, six things were still written in French whatever language you chose, and the notification buttons now follow that choice.** The earlier work put the notification sentences in a table in both languages and left every label behind: the three buttons on a message notification (Répondre, Envoyer, Marquer comme lu), the word standing in for a salon whose name did not reach the phone, and the two lines announcing an incoming call. All six are now in the table, in both halves of the app. iOS replaces the whole set of buttons each time it is told to, so Canari re-registers them as the app leaves the foreground, the last moment before a notification can appear at all
- **A salon notification now says which community it comes from.** It used to read `#general` and nothing else, which tells you almost nothing when two communities you belong to both have a `#general`. The title is now the community, then the salon: `Campagne de test - #general`. This was not a display change: the notification carried the community's internal identifier, which is a number no part of a phone can turn into a name, so the name itself now travels with the notification and each of the four programs that can post one spells the title out the same way
- **A photo, video or document is now kept for thirty days after somebody last opened it - which is what the rule always claimed, and was not.** The server measured that from the last time it was asked for the file, and the app keeps a copy of everything it has already downloaded, so a photo everybody opened daily left exactly the same trace as one nobody ever opened twice, and both were deleted on the same day. The app now tells the server when it uses a file it already had, at most once a day, and nothing is remembered as sent if that report fails to arrive
- **The image viewer and the PDF reader are now one interface, and a PDF can be dragged around with the mouse.** They always did the same job and were two separate pieces of code doing it, which is how they had drifted apart - the two close buttons were not even labelled the same way for a screen reader, and three labels had been left untranslated in French only. Everything they share is now written once and the three labels are translated. The visible gain is that a PDF zoomed past its window can now be dragged with the mouse, which previously only worked with a finger
- **The back links across the app all use the same icon now.** "Retour aux associations", "Retour aux listes", "Retour a la page publique" and the two calendar ones were split between a lucide arrow icon and a literal arrow character typed into the template - and two of them had the arrow baked into the translated string itself, which makes it a piece of layout no translator should be carrying. Every one of them is now the icon, and the strings are text again
- **The chat interface says out loud what it used to only show.** The status banners, the channel rows and the synchronisation notice carried their meaning in colour, position and icons alone, so a screen reader was told none of it: no announcement of going offline or starting to synchronise, and a channel row that read as "general 3" with nothing to say the 3 was unread messages. Every banner is now a live region, channel rows carry a full name and their unread count in words, and decorative icons are hidden from assistive tech
- **Whether your message was sent or read is now said, not just drawn.** The state of your last message was a single tick for "sent" and two ticks plus the readers' avatars for "read" - a difference of one stroke and one colour, which without sight was no difference at all. Both now carry a spoken label, and the decorative half is hidden from assistive technology so it is not announced as a row of unnamed images ahead of the sentence that says what actually happened
- **"X ecrit..." is now announced by screen readers.** The line telling you the other person is typing was purely visual: it appeared and disappeared with no announcement, so anyone not looking at that corner of the screen never knew. It is now a live region, and the three bouncing dots, which carry no meaning, are hidden from assistive technology rather than read out
- **The people-search dropdown is now announced properly by screen readers.** It gained the standard roles and states for this kind of field, so assistive technology says when suggestions appear, how many there are, and which one the arrow keys are on. Previously it was a plain list with no announcement at all, and the highlighted entry was conveyed by colour alone
- **The two side panels now have names for screen readers.** The icon rail and the conversation list are both side regions and neither was named, so the list of landmarks a screen reader offers contained two entries that read identically with no way to tell which was which. The conversation panel's name also follows what it is showing, since the same panel lists either conversations or communities
- **A message could be sent at an out-of-date encryption epoch because an unrelated conversation happened to be loading its history.** Before sending anything queued, a device waits for everything already received to be applied - the one thing standing between a reconnect and a message encrypted against a state the others have moved past, which nobody can then read. That wait was abandoned whenever any conversation anywhere in the app had a history session open, because the check asked "is a session open" when the only situation it must refuse is "am I inside the session I would be waiting on". The caller now says which session it could be inside, and every other one is waited out
- **A device repairing its history now says how far back it wants, and gets exactly that.** Until now the answering device sent everything it held, however far back, which works only while every device keeps everything - and a browser is not the place to accumulate five years of a phone's history. Every request now carries the point it wants history from and the answering device sends nothing older: a browser asks for the last three months, a phone or the desktop app for five years. Each side states its own point, so a phone answering a browser still asks back for its full five years
- **Two devices of the same account now compare what they hold before one sends its history to the other, instead of shipping the whole conversation blind.** A device asking for history used to get everything the answering device had - a lot of ciphertext for a phone missing three messages, and nothing at all for a phone missing one the answerer had already pruned. The exchange is now a difference: the asker broadcasts a digest of what it holds inside MLS, and the answerer replies with exactly the missing messages, pulling back anything the asker holds that it lacks. Slices are decided by message identifier, never by date, because two devices do not actually agree on dates
- **A conversation that is missing messages now stops asking for them when it actually has them, and asks a different way when asking is not working.** A device recorded as still missing history used to be cleared by the mere arrival of a bundle, so the first chunk of a long history ended the wait while the rest was still coming. Only an empty bundle is now taken as "you are missing nothing". And the repair used when a message cannot be decrypted no longer waits on asking the sender to send again - the difference is requested straight away, alongside it
- **The repair that pools history between your devices now asks once per event instead of on two independent schedules.** Two retry ladders in two different files drove the same request, so the traffic one conversation could generate was their product and no single place could be read to predict it - and one of them left an entry behind that silenced every later attempt for the lifetime of the tab. There is now one request per occasion, ignored while one is already outstanding, re-attempted when something actually changes, and stopped by a proof rather than a budget
- **Revoking a device now lapses after ten years instead of never.** Deleting a device records its identifier so the same physical device cannot come back under it, and that record was kept for ever - a table that only ever grew, holding identifiers retired a decade earlier whose hardware is long gone. It now expires, and the expiry is applied where the question "is this device banned" is asked, so a lapsed record stops banning immediately whether or not the nightly cleanup has run. Revoking again restarts the ten years
- **Media storage moved from MinIO to Garage** (MinIO is no longer maintained upstream). The media service talks to it through the exact same generic S3 client as before, so the storage code did not change and every env var keeps its `MINIO_*` name on purpose. Garage self-provisions its bucket from a dedicated key rather than reusing MinIO's, which were shorter than Garage's minimum key length and crashed the container on its first prod boot. Every existing object was copied across and verified before the service was repointed, and the old volume is kept for a two-week rollback window. Full mechanism on [docker](docs/wiki/infrastructure/docker.md)
- **The nightly backup no longer copies every stored file all over again, and a restore now refuses to finish having quietly skipped them.** Media is encrypted on the device before upload, so the server holds bytes that cannot be compressed and never change once written - and the backup re-archived all of them every night and kept fifteen nights, so every byte anyone stored cost sixteen on a disk projected to fill within weeks. They now go into a deduplicating store, taking the whole set from just over a gigabyte to a hundred and thirty-three megabytes. The restore script stops with an explanation if it can find the files in neither place, instead of reporting a successful restore that was missing most of the data
- **The in-memory cache the server uses for presence and repairs can no longer grow until the machine runs out.** It was running with no ceiling and a policy of refusing new writes once memory ran out - which, for a component every message path touches, turns a slow leak into a service that stops accepting anything. It now has a one-gigabyte ceiling and, on reaching it, drops the oldest entries that were already set to expire on their own. Nothing without an expiry date is ever dropped.
- **When a photo is uploaded without being shrunk, the app now says which of the seven reasons applied - and the plan to shrink them harder was dropped, because measuring it showed there was nothing there.** Every upload path already compresses, and the compressor's average result is 245 KB while the five largest files on the server are 4.15 to 7.86 MB - so no image that went through it can be one of those, and lowering the quality would only shrink the files that were never the problem. What produces a file that size is a video, which is not compressed at all, or one of the compressor's give-up paths - typically HEIC from an iPhone, handed back at full size in complete silence. All of them now log what they did and how big the file was.
- **The media server now reports a retention delete that failed instead of ignoring it.** It was ignored on the grounds that the file might simply be gone already - but this is precisely how a file gets stranded: the entry is marked deleted anyway, the entry itself is eventually cleaned up, and the daily sweep only ever looks at entries, so a file whose deletion failed becomes invisible to it permanently. Seven of the twenty-six files currently on the server have no entry at all, the two largest among them.
- **A salon notification no longer carries three pieces of information nothing has ever read.** Every push for a community message had been sending the community's internal identifier, the message's identifier and the time it was written to every device, for the whole life of the feature, and not one of the three programs that receive them looked at any of it. They are gone, which also leaves a little more room under the size limit these notifications share with the message text itself. The contract between the one program that sends and the three that read is now checked automatically, in both directions
- **A new automatic check refuses any sentence written into the program that a translation table already carries, on both platforms.** The check that shipped a day earlier held the translation files against each other, which cannot see a sentence that never entered a file at all - which is exactly how the six iOS labels survived. This one asks a different question: does this piece of text already exist as something we translate? It compares with accents and escapes ignored, ignores decoration at either end, and compares against the French side only, since every internal name in these programs is English

### Fixed
- **On the phone and the desktop app, three requests to the server never left the device - and one of them destroyed data because of it.** Inside the mobile and desktop app the page is served from the device, so a short-name request asks the device for that page, gets the app's own start page back, and reports complete success. "I forgot my PIN" read that false success: it wiped the encryption state on the device while the account's PIN had never been cleared, leaving the person with their old encrypted history gone and a new PIN the server would keep rejecting. All three now name the server explicitly, and a test refuses any future request written the short way
- **On Android, the app could permanently lose the credential it uses to work in the background - and it happened at a reboot, before you had even unlocked the phone.** After a restart Android creates the app's process before your first unlock, and in that state the encrypted storage is not open: files report themselves as absent and the key store answers "cannot read" for a key that is perfectly intact. The startup code took "cannot read" for "corrupt", deleted the key and made a new one, so everything that key protected became unreadable for good and the app went on serving notifications with a credential the server refuses. It now does none of that work while the phone is locked, and a key it cannot read while locked is never destroyed.
- **On the phone and the desktop app, saving a message to the device could fail outright while several conversations were catching up at once - and a message that fails to save is one you no longer have.** The library underneath keeps several connections to the local database and picks whichever is free for each instruction, so "open transaction" could go to one connection, the writing to a second and "close" to a third. The transaction nobody closed stayed open for the rest of the session and every later write was refused with "database is locked". Batches are now written as a single instruction, which the database treats as a unit on its own
- **A phone silently threw away messages it could not decrypt, and then told other devices their conversation was complete.** The shared Rust core treats "the key for this message was already used" as an ordinary duplicate delivery and reports nothing - which is right when the same message really does arrive twice, and wrong when a sender whose state went backwards encrypts a new message with an already-used key. The web found out anyway by reading the log line the core prints; on a phone that log goes to the system console where nothing reads it, so the phone recorded no gap and was therefore considered a trustworthy witness. The core now reports it and lets the layer that can tell them apart decide
- **A conversation broken by a small rewind lost messages for good, while a badly broken one repaired itself completely.** When a message cannot be decrypted the receiver first asks the sender to send again, and only after three such requests in five minutes does it reach for the exchange that compares saved histories. But that first request asks the sender to encrypt again with the very state that is wrong, so the resend collides exactly as the original did - all it accomplishes is burning through the overlap, which is why a deep break appeared to heal where a shallow one did not. The comparison of saved histories now starts at the first lost message, alongside the resend rather than behind it
- **A message could be lost without leaving a single trace, and the app had no way of noticing.** A message arriving at a device that has re-joined a conversation, holding nothing from before, was being treated as an internal housekeeping frame - those legitimately arrive late, have no content, and must be discarded in silence. So a real message somebody sent was discarded in that same silence: no warning, nothing recorded, no repair attempted, and it was acknowledged to the server, which then had no reason to keep it. The two cases are now told apart by a field the message carries in the clear, and a real message reaching this state is reported as lost and repaired like any other loss
- **Having messages waiting for you could stop the app from ever connecting - and the more it mattered, the more certain it was.** Before reading each conversation back, startup made sure nothing was still waiting on the delivery queue - and that check also collects, fetching the queue if nothing else has. What it collected was handed to the part of the app that opens messages, which is set up later in the same startup, so it fetched into a queue with nothing to empty it and then waited for that queue to empty. Startup stopped there, before any connection was opened, and every subsequent start stopped in the same place. The part that opens messages is now set up first
- **An outage lasting more than a few minutes left every open tab dead until it was reloaded, and said nothing.** After twenty failed attempts the app gave up entirely and set a flag refusing every later attempt - permanently, until the app came back to the foreground or the device changed network, neither of which can happen to a tab already in the foreground on an unchanged network. So a browser tab open during a server outage stayed disconnected for ever after the server came back, with the badge reading "Hors-ligne" and nothing else saying anything. Giving up is now impossible: only being logged out or the server ending the session stops the app retrying
- **On a phone, one failed reconnection could leave the app disconnected for good, showing "En attente de connexion" while nothing was connecting.** Two causes defeated each other. Going into the background stops the timers that watch the connection, correctly, but nothing started them again on the way back - they were armed only once at sign-in - so after one trip to the background a phone had nothing left able to notice a socket that died later. Meanwhile the reconnection latches after twenty failures and nothing could unlatch it, because the timer meant to notice a dead connection asks the very function the latch turns off. Returning to the foreground now resets the latch and restarts both timers before reconnecting
- **A conversation that failed to catch up on its history because nobody was online stopped asking for the rest of the session.** A solicitation registers itself while its attempts are scheduled, and every other trigger skips a group that is already asking - but nothing ever removed that registration when the attempts simply ran out unanswered. So a group whose members were all offline during its three-minute burst was marked "already asking" for the life of the tab, a page reload being the only cure, on precisely the conversations that needed it most. The end of a burst is now read from the burst's own schedule, which is known when it starts
- **A device with a big enough backlog could never collect it, and the backlog only grew.** Batches were counted in messages - five hundred at a time - and a message carrying a photo is thousands of times larger than one carrying a word, so five hundred messages could mean twelve megabytes in a single response. The app gives each batch ten seconds, that one never arrived, and an unconfirmed batch is not removed, so the next attempt asked for the same twelve megabytes. The server now fills a batch up to a size rather than a count, and the app halves what it asks for when a batch fails to arrive rather than giving up
- **Collecting a backlog stopped after the first batch, and a message could be skipped for good.** The app decided it had collected everything when a batch came back smaller than it had asked for - true while batches were counted in messages, false the moment they were measured in size: the server answered a request for five hundred with the fifty-three that fit in a megabyte, and the app stopped with eight hundred and seventy still waiting. Only an empty answer now ends the collection. And because the app resumes from the moment of the last message, two messages queued in the same millisecond could straddle a batch boundary and be skipped permanently, so a batch now always carries a whole group sharing a moment
- **A burst of notifications could get the Android app killed by the system, after which nothing arrived at all.** Each incoming push was handled on a thread of its own, and all of them then competed for the single lock guarding the encryption state: every thread waited up to five seconds, each one that got in re-read the whole state from storage, and each one that gave up tried again. Behind a backlog that meant dozens of threads doing almost nothing but waiting, and Android eventually shut the app down for using too much processor in the background - and a closed app delivers no notifications and sends none of your pending messages. Everything touching the encryption state now runs one after another on a single worker
- **The app froze - sometimes to the point of Android offering to close it - after a Play Store update, and the file holding your identity and your conversations was twice the size it needed to be.** That file is written and read as a series of buffers of raw bytes, but the encoder had never been told they were bytes, so it wrote each one as a list of individual numbers and read it back one number at a time, re-parsing a header for every single byte. What turned a slow read into a freeze was that a phone catching up on a backlog reloaded and rewrote that entire file once per message, all inside the one minute Android allows a background task. A catch-up now loads the file once, encrypts every message against it, and saves once.
- **A message the app could not yet handle made it re-download the whole backlog every fifteen seconds, for the rest of the session.** Some messages cannot be dealt with the moment they arrive - one for a conversation the app has not finished loading, or for a group it has not yet been let into - so they are deliberately left on the server to be fetched again. "Again" was a timer: every fifteen seconds, fetch the backlog, fail on the same messages, and put the sync overlay back up while doing it. Both reasons have an event that actually resolves them, so the app now waits for that event instead of for a clock
- **A conversation could start broadcasting to itself for as long as a tab stayed open, with nobody typing - and the phone sat behind the "Synchronisation des messages" banner while it caught up.** Three clients held one DM at roughly 430 technical messages per minute for thirteen minutes, 4 921 of them queued for a single phone, which then spent eighteen minutes draining them. It starts from a legitimate repair that is meant to die out after five minutes of quiet, and did not: every replay was recorded as though it were a fresh send, which pushed the expiry out indefinitely and stopped the payload being recognised as one already held. A replay is no longer counted as a send.
- **An iPhone had never received a single notification from a community.** Not a salon message, not a post, not a form reminder - nothing from the community side of Canari had ever appeared on an iPhone, while the same message notified Android correctly and the server recorded it as sent. There were two copies of the code that hands a notification to Google's delivery service and only one had been kept up to date: the maintained copy attaches the small block of instructions Apple requires, the forgotten copy attached nothing, and a notification with nothing attached is silently discarded. There is now one copy, and the test looks at the message as it leaves the process rather than at the recipe it was supposed to follow
- **Notifications for community channels had never once been sent, and a check meant to protect invitations was answering "yes" without looking.** Services publish their routes under a common `/api` prefix and the addresses they use to call each other are configured without it, so every caller has to add it - and three calls did not. Two are the ones asking the messaging service to send a push, so writing in a community channel notified nobody, ever, on any device. The third asks whether a user has a device able to receive encrypted messages before inviting them, and is written to answer "yes" when it cannot reach the service - against an address that does not exist, that was the only answer it ever gave. The prefix is no longer any caller's to remember
- **Deleting a message you had written but not yet sent SENT it, and then took it back.** Write a message with no network, change your mind and delete it before the connection returns: the moment it came back, the other person received the text, saw it appear, and only then received the instruction to remove it. Both halves were queued the same way, side by side, so the queue delivered them in order the moment it could. A message still waiting in the queue is now withdrawn from it instead - nothing is sent, and there is nothing to take back
- **Deleting a message you had not yet sent left a "message deleted" line behind on your own device, for ever.** Nobody else ever receives a withdrawn message, but your own conversation still showed the grey placeholder that means "something was here and was deleted", standing for a message that had never existed anywhere but on that one device. Nothing could ever clear it: the other people have no such message to remove, and the server never held one. It is now removed outright, from the screen and from the device's stored copy, while a message that really had been delivered keeps its placeholder
- **A deleted message could come back readable on a device that rebuilt the conversation from another one.** The copy a device sends when another is missing history says which messages were deleted, and the receiving device recorded that fact but kept the original text alongside it and wrote that text back to its own storage. On screen it showed as deleted, so nothing looked wrong; the deleted words were simply still there underneath, and that device would then pass them on to the next one asking for history. The text is now replaced when the deletion is recorded
- **Reacting to a message you had deleted brought it back, and reading an edited one undid the edit.** Everything that can happen to a message was saved to the device the same way: rebuild the whole message from what this particular piece of code happened to know about it, then write it over the stored one. None of them knew everything, so each quietly erased what it did not know about - and only the saved copy was damaged, so nothing was visible until the next time the app was opened. There is now a single way to save a change to a message: say what changed, and everything else is left exactly as it was found
- **Reactions, edits, deletions and read receipts had no copy anywhere except on the devices that happened to be awake when they were sent.** The server keeps a copy of a conversation, as ciphertext it cannot read, so a device coming back after a while can catch up on its own - and that copy was only ever given the messages themselves. Everything that changes a message was left out, and not by a decision: those are sent with a flag meaning "do not notify", and the server was using that same flag to decide what was worth keeping. Whether something notifies you and whether it is worth keeping are now decided independently
- **Messages you had read came back unread after closing the app, and catching up on history could mark old messages unread all over again.** What each person had read was recorded message by message, as a list of names attached to each one - which only works for messages the device holds, and only if the record survives. Your own reading was applied on screen and never written down, and receiving an older message later produced one nobody had read, since the acknowledgement for it had been sent long before it arrived. What is recorded now is one point per person - read up to here - kept with the conversation and travelling in the copy the server keeps
- **Everything you had read came back unread the next time the app was opened - one layer further down than the last fix of the same name.** Where each person had read up to was written to the device correctly and never read back: when the app starts it rebuilds each conversation from what is stored, and that rebuild copied the name, the state and the date of the last message, but not the read marks. So every conversation started the session believing nobody had read anything. The rebuild now carries every field the save writes - a value written but never read back is worse than one never stored at all, because the write succeeds and nothing reports a problem
- **A pinned message did not survive on a new device.** Pin something in a conversation, then sign in on a new phone or a new browser: everything came back except the pin. Pins in a community channel did come back, which is what made this a gap rather than a decision. A conversation's pins now travel with its history, both as the pin and unpin actions themselves and as the finished list, because the action that pinned a message can be older than the window a server keeps. Pinning and unpinning also record when, so two devices that disagree settle it on the later of the two
- **Taking a reaction back often did not reach the other people in the conversation.** Removing a reaction was sent as an instruction to forget it, and forgetting works only if it arrives - so a device that was off, or that later rebuilt the conversation from someone else's copy, ended up with the reaction back, and the repair itself could not correct it either. Reactions are now handled as a record per person and per emoji, each carrying the moment it last changed and whether it currently stands, and the more recent one always wins. The fifteen-emoji limit still applies to what you can place, and no longer to what the app is willing to accept from others
- **Messages restored from another device could come back in a different order each time the app was opened.** Two messages sent in the same millisecond are separated by the moment the server accepted them, which is why that second time is stored alongside each message. When a device rebuilt a conversation from another one's copy, it kept that second time on one of the two routes the copy can take and dropped it on the other - so whether the order was stable depended on how the conversation had been recovered. Both routes now keep it
- **A device that rebuilt a conversation from someone else's copy showed "modifie" with no date, for ever.** That copy said whether each message had been edited but not when, and there is no second source for it: the app never receives an echo of an edit it made itself, and other people's edits arrive only as they happen. So a message restored this way carried the marker permanently without a date, and nothing could ever fill it in. The time now travels with the flag
- **A conversation could open completely empty - the name, the photo and the message box, and not one message - while every message was still safely on the device.** The chat draws a window onto the last screenful and widens it as you scroll up, and the position of that window was worked out when you opened the conversation and then never checked again. Opening a conversation also refreshes it, replacing what is loaded with the most recent sixty messages - so a conversation with a long history loaded ended up with its window pointing past the end of a much shorter list, with nothing to draw. The window is now checked against the conversation as it actually is every time it is drawn.
- **A message that arrived while a conversation was still loading appeared on screen and then vanished.** Opening a conversation starts a catch-up which fetches, decrypts, saves and then re-reads a page from its local store to display. That last step took a few seconds, and anything delivered in the meantime was shown as it arrived and then wiped out when the catch-up finished, because the page had been read before that message existed and the app put it on screen in place of everything rather than alongside what was already there. A freshly read page is now merged with what is on screen instead of replacing it
- **A photo deleted by the 30-day retention showed up as a broken image everywhere except in the conversation itself - and under a post it displayed the internal error code.** The conversation has said "Média expiré (rétention 30 jours)" since June and was the only place that did: under a post the same media printed an internal token in red as an error, in the shared-media grid it was a generic broken-image icon, and opening one from that grid left the viewer spinning for ever on a file the server will never send. "Expired" and "failed" were told apart by searching the error text for a magic word, so only the one place doing the search behaved correctly; the distinction is now carried by the error itself.
- **The rule that keeps a file alive while people are still opening it had never actually been running in production.** The server half shipped on 11 August and its deployment failed - not on its own account, but because the frontend image being built alongside it failed, and one image's failure cancelled every other image in the same batch. Nothing revisited it, because each deployment only rebuilds what its own changes touched: the endpoint answered "no such address" for a day and every report from every app was rejected. Images no longer cancel each other, a deployment now decides what to rebuild by comparing against what is actually running in production, and the health check asks whether the address exists rather than merely whether the service answers the door
- **On the phone, every download button in the app did nothing at all - no file, no error, no trace.** Saving a file on the web is done by handing the browser a link marked "download", and it is the shell around the page that acts on it - Android's WebView hands the request to a listener the host app has to install, and iOS needs a delegate. Tauri installs neither, so the click dispatched, succeeded, and produced nothing. Eleven places did it, and every one is now a single helper that writes through the OS's own save dialog on Tauri and keeps the ordinary link on the web; the write permission it needs is granted and pinned by the capability test
- **Every download on Android and iOS failed with "Le telechargement a echoue", and the in-app PDF reader could not be zoomed with two fingers.** On mobile the app replaces the browser's own fetch with a native HTTP client, and the rule deciding which requests to keep native was written as a list of exceptions - so anything it had not thought of went to a client that answers only `http` and `https`. Saving a decrypted attachment reads its object URL back, so every save handed a `blob:` URL to that client and got a bare rejected promise, indistinguishable from the network being down. The rule is now written the other way round. Separately, the PDF reader gained a pinch gesture, page zoom being disabled in the app
- **"Reessayer" on the news feed fetched the posts and showed nothing; the only thing that worked was leaving the page and coming back.** The initial list is a promise handed over while the page is already rendering, and a promise that has failed stays failed for ever. The template waited on it and drew the posts only inside its success branch, so once it had failed the page was locked on the error screen - the retry did run, did reach the server and did get the posts back, and had nowhere to put them. The refetched list is now read before that promise is consulted, and the retry shows the loading skeletons while it runs
- **Attaching a PDF showed an empty white rectangle instead of a preview, for everyone.** The strip of thumbnails above the message box handed the PDF straight to the browser's built-in document plugin. The site's own security policy forbids that, deliberately and for good reason, so the browser blocked it every time, on every browser: what should have been the first page of the document was a blank tile, and the console carried a security warning on every attachment. It now uses the app's own drawing, the same as every other PDF, and falls back to the file icon and name when a document cannot be drawn at all
- **Pinching a PDF zoomed, but never where you were pointing.** The gesture scaled the page column from its top edge and left the scroll where it was, so on a phone, where the pinch is how you aim, the paragraph you put two fingers on slid away exactly as the zoom took hold. The zoom now happens about the point between your fingers and stays there. Computing the new scroll from the zoom ratio was not enough, because the gaps between pages and the padding around them are fixed sizes that stay put while the pages grow - the viewer now remembers which page you pinched, measures it again after re-rendering, and scrolls by the difference it actually finds
- **On Android, the browser tab opened for login was left behind after signing in, which read as "the login failed" to anyone who saw it.** The flow was launched with a plain system-browser open, which the OS runs in a task that has no relationship to the app's own - so once the deep-link callback brought the app back to the foreground, nothing on either side could dismiss the tab it left sitting on Authentik's last page. It now opens as a Chrome Custom Tab, which shares the launching app's own task and is closed by the OS the moment that task's activity resumes. Verified on device
- **On Android, the space around the composer was wrong in three different ways at once: no gap above the system nav bar, a gap that changed size when the keyboard opened, and a gap of the wrong color appearing above the keyboard.** The nav-bar gap was missing because the app never enabled edge-to-edge, so the WebView reported no bottom safe-area inset at all; the changing gap was the composer's own padding floor differing between keyboard states for no recorded reason; and the message list double-counted that same inset on top of the composer's already-inclusive height. The worst was self-inflicted - an earlier same-day fix subtracting the status-bar inset from a variable an ancestor was already shrunk by, deleted rather than corrected
- **The device-sync QR scanner flashed an ugly gray play icon before the camera feed appeared.** The video element mounted as soon as scanning started, but the camera stream and its attachment only resolve afterwards - so for that gap the video had no source, and the browser's native placeholder showed through. The video area now stays covered by an opaque loading overlay with a spinner until playback has actually started
- **On a narrow window, clicking a reaction on your own message opened another conversation instead.** The bar of hover actions was placed entirely outside the message bubble, to its side, with nothing keeping it inside the conversation pane - it is a fixed width and a message can be any width, so on a window about half a screen wide the bar was laid out over the list of conversations, which then received the clicks aimed at it. The condition was never the size of the window on its own: a long message pushed the bar out where a short one left it alone. The bar is now anchored above the message and aligned to its outer edge, extending inwards
- **On a phone, holding a message down opened two panels at once - and both of them offered to react to a message that had been deleted.** Behind the touch panel, the small bar of actions meant for hovering with a mouse was being shown as well, on a device that has no hover. It has been removed from the phone entirely. The same gesture also worked on messages that had already been deleted, where the panel opens on a placeholder with nothing in it to act on, and reacting to that placeholder then failed - holding a deleted message, or right-clicking one, now does nothing
- **Opening the full list of emoji to react to a message threw an error, every time, because one translation of fourteen was missing.** The panel comes from a shared component we hand a complete set of its own interface texts, and both of our sets defined thirteen of the fourteen it expects - the skin-tone selector's label had never been written, in either language. It failed only when the panel opened rather than when the page loaded, from inside somebody else's code. Both of our sets are now built on top of the component's own English texts and override what we translate, so a text we have not written falls back to a real one instead of to nothing
- **You could invite someone who was already in the conversation, including yourself, and nothing happened.** The people-search in "add a member" offered everyone, whether or not they were already there. Choosing one of them enabled the confirm button and closing the dialog looked exactly like a successful invitation, but the member list did not move and nothing said why. The same was true of adding a user to a private channel they already had access to, of inviting someone to a community they were already in, and of starting a direct conversation with yourself. People who are already there are no longer offered
- **One failed lookup renamed people to "Utilisateur inconnu" on screens that knew perfectly well who they were.** When Canari cannot look up a name it draws "Utilisateur inconnu" and remembers the failure for two minutes - but what it handed back to the twenty-six places that ask was those words, rather than "I could not find out", and every one of them accepted it as the person's actual name and wrote over whatever it already had. Only on the first failure, since for the two minutes that followed the same failure said "I could not find out" and everything kept its name. A failed lookup now says so, and the decision of what to draw instead belongs to the screen doing the drawing
- **A link whose site was briefly unreachable showed no preview for the next ten minutes, to everyone, even after the site came back.** Canari fetches a pasted link from the server and remembers what it found; what it should never have remembered is not finding anything - one connection that timed out was filed as though the page had refused us, and served to every reader for ten minutes while the same log shows the page answering normally six minutes later. It was also reported to the browser as "bad request", which blames the link when it was our side that could not connect. Not being able to reach a site is no longer remembered at all, and the time limit is now one number rather than a stated four seconds and an actual ten
- **Profile pictures were fetched twice for every face on screen, and the faces that have no picture were fetched again on every single scroll.** When the photo service answered "this person has no photo" - the answer for most accounts - nothing remembered it, so the app asked once through one path, was told no, then handed the same address to the image itself, which asked again. Nobody saw anything wrong because initials are drawn either way; what it cost was amplification, one network hiccup turning into a burst of failures. The answer is now remembered, and the two failures are no longer confused: "no photo" is an answer and may be cached, "I could not reach the photo service" never is
- **Reacting to a message sent a piece of that message, in the clear, to our server and to Google and Apple.** When you reacted to someone's message, your device took the first eighty characters of it - decrypted, as displayed on your screen - and sent them to the server so it could compose a notification sentence and hand it to Google's and Apple's delivery services. Nothing recorded it anywhere, so it existed only in transit, but it existed on every reaction. It was never necessary: the person being notified is the author of that message, so their device already has it. The notification now carries the message's identifier, the emoji and who reacted, and each device writes the sentence itself
- **A reaction to your message could never be dismissed, and stacked up for ever.** It arrived down the same pipe as a like on a post, so it inherited none of what a message notification has: no avatar, no grouping, a fresh identifier every time, and no place in the count on the app icon. Nothing could clear one - not opening the conversation, not reading it on another device, not opening the app - so they accumulated one per reaction until dismissed by hand. A reaction is now drawn into the notification of the conversation it belongs to, so it replaces itself rather than piling up and disappears the moment you read that conversation anywhere
- **Reacting in a community channel notified nobody at all.** The tally updated live for everyone with the app open and that was the entire behaviour: no notification was ever sent, so the author of a message never learned someone had reacted unless they happened to be looking. The author - and only the author - is now notified, through the same path as a private conversation, attached to that channel's own notification. Only the author, on purpose: telling a whole channel about every reaction is precisely the kind of noise a busy community cannot carry
- **Being named in a salon rang exactly like anything else, on every phone.** Canari has a separate, louder notification setting for the messages that mention you, and in a direct message or a group it worked; in a community salon it had never once been used. The server worked out, for each person, whether that particular message named them - it has to, since that is how "mentions only" is honoured - then sent that answer to the phone, which read every other part of the notification and not that one. All three now read it, and the phone is told rather than searching the message text for its own name, which it cannot do when the text was left out for size
- **An iPhone kept showing a notification for a salon you had already read on your computer.** Two things were wrong. The message telling the other devices never arrived at all, and once it did, the removal failed: a notification on an iPhone can be posted by the app or by the small helper that runs when the app is fully closed, and the code that removes one only knew the name the app uses. So it looked for a notification that was not there, removed nothing, reported success, and then recounted the badge from a list that still included it. It now removes by the conversation, which both halves agree on, and counts the badge from what is genuinely left
- **On iPhone, notifications were written in French for everyone, whatever language you had chosen in Canari.** Android has had a place to keep its notification texts in both languages since the beginning; iOS never had one at all, so every sentence composed on the phone existed only as French text written into the code. There is now a table of those sentences in both languages, in the app and again in the notification extension, which is a separate program with no access to the app's own resources. The language used is the one you picked inside Canari, not the one your phone is set to. None of this has run on a real iPhone yet
- **A reaction arriving on an iPhone with Canari closed showed a blank icon and left the badge count wrong.** When the app is not running, notifications are prepared by a small separate program, and for a reaction it wrote the sentence and stopped there - no picture of the person who reacted, and no recount of the number on the app icon, so the count stayed one too high until something else corrected it. Both were already done when the app was open, and both are already done on Android. They are now done in all three places
- **A notification from someone with no profile picture showed an empty space on iPhone, where Android draws their initial.** Android has always drawn a coloured disc with the first letter of the name whenever the picture cannot be fetched; iPhone drew nothing at all, so the same event looked like two different products depending on the phone. The disc is now drawn there too, in both halves of the app, and it is the last thing tried, below the photo a message is about, since an iPhone shows only the first picture attached to a notification. In a community salon it draws the salon's letter and not the speaker's, matching Android
- **A message could be treated as coming from a conversation your phone was not in, when the app simply could not check.** Deciding what to do with a notification it could not read first asks whether the conversation exists on this device, and every way of failing to answer that question - the encryption state being busy, unreadable, or not yet unlocked - was reported as "no, it is not on this device", which sent the message down the recovery path meant for a brand-new conversation, competing for the very lock that was busy in the first place. "I could not tell" is now distinct from "no", and the app leaves the message to the background retry rather than guessing. The same confusion existed on iOS and was corrected there too
- **Closing one tab told everyone you had gone offline, while you were still there in another tab.** Canari marks you online per device, so two tabs of the same browser share one mark. When you close a tab the app tells the server on the way out, so people see you leave immediately - and that message deleted the mark without ever asking whether another tab of yours was still connected. The app already had exactly this check in the other place that removes the mark, and it worked: it ran a moment later, saw the surviving tab, correctly decided not to delete anything, and returned - so the guard written to protect the mark was what stopped it being put back. The two paths now ask the same question, in one place that both call
- **A message written in the first seconds after opening Canari could sit in the queue waiting for something else to happen.** When several tabs are open, one of them is chosen to do the sending so that two never encrypt at the same time. Choosing takes a moment, and during that moment the app answered "am I the one who sends?" with no - which is not the same as not yet, and is simply false when there is only one tab. So the message was handed to a tab that did not exist and then waited for the next thing that happened to wake the queue. The app now waits for the answer instead of guessing it, and says in its own log how long it waited
- **A message written while your connection was down could sit unsent long after the connection came back.** "Clear" is two separate facts - your device has a network, and Canari's servers actually answer - and they are restored by two different events, at two different moments. The waiting message was retried on the first event alone, so the retry ran while the second fact was still missing, was refused for the same reason as the original attempt, and then nothing was listening for the moment the servers came back. Measured on production at just over three minutes after the link returned, for a message that could have gone in eleven milliseconds. It is now retried by the event that actually clears the way
- **Reloading the page in the seconds after sending something could make what you sent next arrive as a message the other side called lost.** Every message moves a counter that only goes forward, and the receiver refuses anything arriving on a number already used. The counter moves the instant a message is encrypted and the copy of it on your device is written just afterwards, deliberately not waited for - which leaves a window, a second or two wide, in which what your device has on disk is behind what the other side has already been told. Your device now keeps a small note, outside the copy that goes stale, of how many messages it has actually sent, and on starting up advances the counter to where the other side already believes it is
- **Returning to the app on your phone could make the next thing you sent arrive as a message the other side called lost.** When the app comes back to the foreground it reloads what is in storage, and that reload refused any stored copy belonging to an older round of the conversation - but a message you send does not start a new round, it only moves the counter within the current one, and that was invisible to the check. So a phone whose storage had not caught up went back to a number it had already used. The reload now also refuses a stored copy that is missing something already sent, and the counter is saved by the one piece of code every message passes through rather than by each place that happens to send one
- **On Android the app was saving its encryption state twice, every single time, and the duplicate cost more than the save.** The code asked for the state to be saved and then handed the result back to be stored - correct on a browser, where saving only produces the bytes, and wrong on a phone, where saving has already written the file before it answers. So the same file was written a second time with the same contents, and getting those contents back across to be re-written meant passing the entire state through the boundary one number at a time. Measured at three point seven seconds, of which two full seconds were the duplicate. There is now a single way to write a checkpoint, which each platform answers for itself
- **The first message to arrive just after you opened the app could take eight seconds to appear, with nothing wrong with your connection.** Sealing the stored copy of the encryption state is deliberately slow - a password-hardening step measured at three seconds on a phone and eight on a browser opening cold - and the app was waiting for that write to finish before it would consider itself done taking messages in, so the next message to arrive had to wait for the whole of it before it was even opened. Storing the state is now started and left to finish on its own, which is what the code already did everywhere else. Nothing is at risk: a copy that arrives late can never overwrite a newer one
- **Receiving a large batch of restored history froze the conversation on screen for minutes.** Adding messages asked, for each one arriving, whether the conversation already contained it - by going through the whole list from the start, twice. That is fine for a message or two and quadratic for a catch-up: a thousand restored messages arriving into a conversation of eight thousand meant sixteen million comparisons, on the same thread that draws the screen, measured at about ten minutes with nothing displayed. The list is now indexed once per batch and each lookup is immediate
- **Coming back to the app froze it for four seconds behind a "synchronisation" banner, every single time, however little had happened.** Reconnecting makes the app check each of your conversations against another of its devices - one small message per conversation - and that check was sent for one conversation at a time, each waiting for the previous one to come back: nine conversations, nine round trips, 4.35 seconds. Almost all of it was waiting on the network, and nothing about that waiting had to be done in single file. The checks now go out together, at most six at once so a device in many conversations does not open a burst of requests the instant it reconnects
- **Connecting with many conversations did more work the more conversations you had, twice over.** Before describing a conversation to its other devices, the app works out how far back to ask - and to do that it was reading the entire list of conversations from local storage and picking one out of it, once per conversation. With a handful that is invisible; the work grows with the square of the number of conversations, all of it on the thread that draws the screen, and it happened on every connection even when the description itself needed no work at all. The app now reads the one conversation it is asking about
- **Every reconnection woke every phone in every one of your conversations, for a message none of them could act on.** The per-conversation check is encrypted for the whole conversation, so the server kept a copy for every member device and sent each offline one a silent push to wake it up. Those wake-ups were provably waste: the server picks who answers from the devices online at that moment, and the request expires after a minute, so by the time a phone woke and fetched the message there was nothing left to answer. One person reconnecting with seventeen conversations meant up to seventeen silent wake-ups on every other phone involved. These short-lived messages are now delivered to the devices that are online and to nobody else
- **The app kept announcing a synchronisation, and closing the message box, while nothing was arriving.** The per-conversation checks are messages like any other as far as the receiving side is concerned, and the app decided something was arriving by counting them before opening them, where a check and a real message are indistinguishable. Two were enough: on a conversation between two people, with nothing waiting, the app announced "synchronisation des messages", greyed out the message box and the attachment, poll and GIF buttons, and refused a photo with "réessayez dans un instant". Announcements are now made from what has actually been decrypted, and the message box is never locked
- **The "synchronisation des messages" banner announced work that did not exist.** It was raised from a count taken before anything had been decrypted, so it could not tell an arriving message from one of the internal checks - and a reconnection carrying nine checks and no messages at all still announced a synchronisation for as long as it lasted. It is now raised from what has actually been decrypted, and only once at least five real messages are genuinely being inserted; below that the insertion is quick enough that the banner would say less than it cost to show
- **That check now runs when something could actually be missing, instead of on every connection.** There are only three ways to have a gap: a message that arrived but could not be opened, which already asks for help by itself; a message that never arrived, which the server still holds and re-sends unprompted; and a message the server no longer keeps after ninety days, which nothing on your device can notice. Only the last one needs asking anybody, so it is now the only thing that triggers a full check - that, and a device with no memory of a previous connection
- **A conversation somebody deleted kept telling you its history was on the way, for ever.** When the other person deletes a shared conversation, your copy is deliberately kept and marked as removed - but if that conversation had been waiting on missing history, the notice saying so stayed on screen over a conversation that no longer exists anywhere. It could not resolve itself either, because the only things that ever took that notice down were an answer arriving or a month passing. Three separate pieces of memory were involved, in three different places with three different lifetimes, and not one of them was tied to the lifetime of the conversation it described; they are now forgotten together
- **Two devices that were both waiting on missing history waited on each other for ever.** A device only stops waiting when another one compares its whole store and confirms nothing is missing, and a device that is itself waiting is quite rightly not allowed to give that confirmation. That rule is correct, but it was implemented as saying nothing at all, so once both devices were waiting, each was the other's only possible responder and neither answered. A device in that position now replies with the one thing it did measure - that the two stores are identical - which retires "the other device has messages I lack" and deliberately not "I failed to read a message".
- **A conversation that had ever been short of messages stopped asking for the missing ones the moment it lost another.** A device that knows it is missing history writes that down, and the note survives restarts until the missing messages actually arrive. That note was also being used to answer a different question - "have I already asked?" - and it is the wrong thing to ask: it says a conversation is incomplete, not that a request is in flight. So on any conversation that had ever been broken the note was already there, and the code took it as proof an attempt was already running and stayed quiet. Whether asking again would duplicate an attempt is now decided by whether a request is scheduled or still inside its answer window.
- **The notice for a conversation still waiting on its history said nobody else was online, whether or not that was true.** There is only one message for two situations - the request never left the device because no other device of yours was connected, and the request left and has not been answered - and it described the first. Being told nobody is online while another device is sitting right there, connected and silent, is not a vague answer, it is a wrong one, and it points at the wrong thing to try. The two now read differently, and each says what will happen next.
- **"Aucun appareil n'a repondu" no longer appears when the server is simply unreachable.** If a conversation was waiting on missing history and the app could not reach the server, the notice said that no device had answered the request - but nobody had answered because nobody had been asked: the request never left your device. The app decided this by looking at whether the browser reported being online, which cannot see a server that is down, so the case fell through and a timer thirty seconds later filled in the wrong explanation. The three situations are now told apart and named for what they are. Reported from production
- **One device being sent its missing history made every other device in the conversation stop asking for its own - permanently.** The answer is delivered to the whole conversation, because everything here is encrypted for the group and there is no way to send to one member alone, and each device that received it treated it as the answer to its own question, whether or not it had asked one. The moment a device believes it has been told "you are missing nothing", it forgets it was ever missing anything - and that record is the only thing that ever makes it ask again. Every answer now names the device that asked, and a device only reads one as its own if it is the one named
- **Catching a conversation up used to describe your device to everyone in it, even when there was nobody to answer - and the device that did answer guessed at how long to wait.** The description is a message every member of the conversation receives and decrypts, and it was sent even when the server was about to reply that nobody was online to help. And the device picked to answer could not tell "the description is a second behind" from "this app is too old to send one", so it waited three seconds and then sent its entire history. The request now says whether a description is on its way, and the description is only sent once the server confirms somebody was picked to answer
- **Two devices could agree they were identical when they were not, and neither found out until the next reconnection.** The question goes to the whole conversation and every device keeps a copy of it for a minute, while the asking device is free to ask again after thirty seconds - so with three or more devices online, the one picked to answer the second question could still be holding the first, and compared against a description up to a minute out of date. A device now prefers the description that arrived after it was asked to answer. The durable "still missing" notes are also gone, replaced by one small fingerprint of everything a device holds, cheap enough to send on every connection
- **A conversation could sit waiting for history for days with nothing able to clear it.** Asking another device for what you are missing used to be expensive - the answer was that device's whole copy of the conversation - so the app only asked once it had written down proof something was wrong, and only a device answering "you are missing nothing" took that note away. A device may not say that while itself waiting on something, so in a conversation between two devices both held a note, neither could clear the other's, and neither ever asked again: measured with both notes 1.9 days old on a conversation that had been complete all along. The note is gone, replaced by a fingerprint of everything the device holds - cheap enough to send on every connection, and if the two match nothing more is sent and nothing is displayed
- **A device short of history waited on its own timer even when the answer was already known, and never noticed the peer who could answer it coming back.** The delivery service answers "no peer online" the instant a solicitation finds nobody reachable and the client threw that answer away, so the requester sat out a thirty-second window and burnt a retry on a question that had been settled immediately. Presence was already polled every ten seconds and nothing used it, though a peer coming back online is the one moment such a request has a chance of succeeding - every group still carrying a history marker is now re-solicited on that transition, on the edge and not the level. Concurrent presence checks are also coalesced onto the request already running
- **Devices asked each other for missing messages before opening their own mail - and answered each other the same way.** The question was sent at moments when the device had not yet finished going through what was waiting for it on the server, so it described itself half-way through catching up: it reported a difference it was in the middle of closing on its own, and had messages already on their way sent back to it. The same was true in the other direction, and worse - a device could reply "we already hold the same thing" while the messages that would have changed that answer were still queued. Reading your own mail now comes first, on both sides, at the single point every trigger passes through
- **Conversations already missing messages before the repair above existed are now checked once, on every device.** That fix cannot reach backwards: the repair it holds onto has to be raised by something, and for a conversation damaged earlier there is nothing left to raise it - the message that would have asked was dealt with and discarded at the time, and what remains is simply a gap, which is invisible from one side. Each device therefore now does one comparison per conversation, once, with another of the conversation's devices. It is remembered per conversation and only for the ones actually checked, so one whose other devices were offline is retried on its own next time
- **A conversation that had lost a message could stay broken for good, and asked for help every time without ever getting it.** The one repair is to ask another device for what is missing, and that request was being made at a moment when the machinery that sends it had not been set up yet, which happens on every start, because incoming messages begin arriving before the app finishes wiring itself together. The request was written to the log and thrown away, and in the same breath the app told the server it had dealt with the message - correctly - so the one thing that could have raised the request again was deleted too. A repair that cannot be attempted yet is now held onto and carried out the moment it becomes possible
- **When catching up on a conversation turned up a message that could never be opened, the app asked the other devices to repair it one step too early - and the request went out describing a state it had not settled into.** The request carries a single rule: before asking, finish taking in everything the server is still holding for you. The rule was implemented, in the right place, and could not be honoured - the request was raised from inside the catch-up, which had not yet released the encryption engine, and emptying what is waiting needs that same engine. So the wait was impossible, the app skipped it, and a repair meant to be exceptional was being asked for routinely. The request is now raised once the catch-up has closed
- **Catching up on a conversation and receiving one live still met on the same message, and the code that noticed had been quietly carrying it as normal.** Two guards were meant to keep the routes apart; the order between them was wrong, and the second did not do what it said - it waited for a collection that was already running rather than making sure one had happened at all, so with messages still waiting on the server it declared the mailbox empty on the spot. The stopping point was also chosen after the wait, so anything sent during the wait fell into both halves. The stopping point is now chosen first, and what counts as proof is a collection that finished with the connection still up
- **Catching up on a conversation re-read the messages that were being delivered to you at that moment.** Reading back the shared copy meant "read forward until there is nothing left", and "nothing left" was evaluated on arrival at the end rather than on departure - so everything written while the reading was in progress got read too, which is exactly the set being handed to you live at the same moment. The two routes then opened the same message twice, and opening one consumes the key it was sent with. The read-back is now bounded by where the conversation ended when it started, so messages beyond that point are not fetched at all
- **Opening a conversation while a message was arriving reported that message as lost, every time.** The two routes have to tell each other what they have opened, and only one of them did: receiving a message live left a note the catch-up could recognise, while the catch-up recorded its position in the shared copy, which a message arriving live has no way to look itself up by. So both happened at once, the live copy landed on a key already used, found no note anywhere, and concluded the message was lost. The catch-up now leaves its note in the form the live side can read, and writes the notes for a whole batch the moment the batch is opened
- **Every device was treating its own ordinary traffic as lost messages, and quietly asking another device about it all day.** A message received the normal way was taken from the copy addressed to this device, which left its position in the shared copy exactly where it was - so on the next start the app read forward, arrived at messages it had already received, displayed and still had on screen, and could no longer open them, opening a message having consumed its key. The app is built to treat exactly that as proof of a loss. The real cost was not the traffic: a genuine loss looked exactly like this noise. Receiving a message now marks it read for both copies
- **Catching up on a conversation asked the encryption layer, over and over, to open the messages you had sent yourself - which it is not allowed to do and never will be.** The shared copy has to contain what you sent as well as what you received, and encryption forbids a device from opening its own messages - so every catch-up walked over its own messages and offered each one up to be refused, the refusal being how it found out they were its own. On a conversation of four thousand messages that is thousands per full catch-up. The stored copy recorded which person sent each message, which is not enough; it now records the device, and the catch-up skips its own without asking
- **Your phone kept queueing your own messages for a retry that could never work, and reported each one as an error.** Reading back through the server's shared copy always reaches your own messages and always fails on them, by design. The app knew the name of that refusal but had never given it a meaning: it fell through to the general case, "this arrived too early, keep it and try again", so every message you had sent was stored on the phone, attempted three times and only then swept away, writing an error into the log twice for something that is the protocol behaving exactly as specified. It is now recognised where it happens, on every platform at once
- **Every message sent went down a path the server described in its own logs as an emergency, and the description had been wrong since the day it was written.** The server was written to accept the recipient device list from the sender and to look it up in the database only if the sender had not supplied one - a case it recorded as a cache miss. Nothing has ever supplied that list, so the exceptional branch was the only branch and the server announced a cache miss on every message it ever handled, for a cache the sending code never once consulted. A line that appears on 100% of traffic is a line its reader learns to skip. The lookup is now simply what the code does, described as such
- **The server's copy of a conversation now goes back several days instead of about one.** It holds a fixed number of entries per conversation and that number had never been revisited: the busiest conversation's copy went back 22.6 hours, so a device switched off over a weekend came back to find the server could no longer help it, which is the exact case that copy exists for. Raised eightfold, together with the change that puts reactions and edits into the same copy and would otherwise have shortened it further. The cost is bounded and small
- **The server's copy of conversation history was never written to disk, and was destroyed every time its container was replaced.** That copy is what lets a device that has been away catch up on its own instead of having to ask another of your devices, which only works if one is online at that moment. It was being kept in memory inside the container, with no storage attached, so any deployment that replaced that container took the whole history of every conversation with it. Nothing visible was lost, because each device keeps its own copy and they repair each other - but the repair needs a peer awake, and the server copy exists precisely so that it does not. It is now stored on disk
- **A failed disk write could freeze new messages from appearing for the rest of the session.** Two independent mechanisms are told about every catch-up phase - the one that saves the encryption state, and the one that batches the display - and they were being run one after another with no isolation, so the first to fail stopped the second ever being told the phase had ended. In practice a full disk or a refused storage left the sync banner up indefinitely and, far worse, held incoming messages in a buffer instead of showing them, only to discard them later. The two are now genuinely independent.
- **The browser worked out that a message had been lost by reading its own log output.** A layer of the encryption core used to report "this message could not be read" only by printing a line to the console, so the app installed a hook over the log function and watched for the words going past. That is not a contract, it is a leak - the app could not tell the difference between a message that was lost and a routine one with nothing to display, so it guessed from a string. The core reports the error properly now, which makes the whole hook unreachable, and it is deleted along with the patched global it installed.
- **A rule added at the network edge to loosen the site's security policy was silently tightening it instead, and had removed three capabilities the site itself grants.** A browser applies every policy it is given separately and the page may only do what all of them allow, so a policy added on top can only ever take permissions away. The added policy allowed "any address", which by definition covers addresses on the network and not locally-held data, so against a policy that names that case explicitly it removed it: reading generated files back, and starting a background worker from one, both stopped working on the web, while displaying an image from one kept working - which is why nothing looked broken from the outside. Removed at the source
- **On Android, the app was hijacking a piece of the framework it runs on, and crippling itself for the rest of the session.** The mobile app routes its network calls through a native client, and the rule deciding which calls go that way said "anything that looks like a web address" - which the framework's own internal bridge, the channel the app and its native half talk to each other through, happens to look exactly like. So every start, the very first message across that bridge was posted to the internet instead, to a name that exists nowhere; it failed, and the framework permanently fell back to its slower emergency channel for everything else that start. The rule now recognises a whole family of those internal addresses, not the three that happen to exist today
- **The app cancelled a vibration nobody had started, every time it opened.** A safety step meant to silence the incoming-call buzz ran on every pass of the call-state check, including at startup with no call anywhere. Asking to stop a vibration is still asking to vibrate, and browsers refuse that before you have touched the screen - so two errors were logged on every single launch, for an operation that had nothing to cancel. It now does nothing at all unless something is actually ringing
- **A message helper reached back into the code that had loaded it, and which page you opened first decided whether that worked.** Adding the channel-reaction notification created a loop in the way the code loads itself: the piece that manages community channels asked for the messaging helpers, which - several steps later - asked for the piece that manages community channels. Loops like this do not fail on their own; they fail depending on which end is entered first, which is exactly the kind of behaviour that cannot be reproduced or explained. The notification call is now a small piece of its own, belonging to neither side

- **A message arriving during the few seconds you were being added to a conversation could be lost outright, with nothing anywhere to say so.** Messages landing between the invitation and the moment the device can actually read that conversation are set aside and applied straight after. Three different things emptied that holding area without ever applying what was in it, and none of them logged a line: a second invitation for the same conversation - an ordinary event - replaced what was held with nothing; a failed invitation threw the messages away on the assumption the server would hand them over again, which is untrue of one delivered live; and an unrelated failure released the area early, applying the messages before the invitation that makes them readable. There is now a single way out, which always puts the messages back in the queue and always says what it did, and messages left with no invitation to release them are reported as a fault by name and count
### Security
- **Anybody in a conversation could delete or rewrite anybody else's messages, on every device in it.** Editing and deleting works by sending the others a small instruction naming the message, and each device applied it by identifier alone, without ever asking whether the person sending the instruction was the one who wrote it. The check existed, but on the wrong side of the wire: the app only offers the buttons on your own messages, which decides what an honest device puts on the wire and nothing at all about what a dishonest one can. Each device now refuses an edit or a deletion that does not come from the message's author, compared against the identity the encryption layer itself authenticated. Found by audit, not in use
- **The same hole reopened one layer down, on the copy the server keeps.** Refusing an edit or a deletion that does not come from the message's author was implemented where those instructions arrive live; there is a second way they arrive, a device replaying the conversation's stored copy, and that path had no check at all - it never needed one, because until this release nothing that changes a message was ever stored. Both paths now refuse a mutation from anyone but the author, and the replay path records who claimed it so the check can be made against the real author once the message itself is in place
- **The server let a member write into a conversation's stored copy under another member's name.** Everything a device sends carries who sent it, and the server wrote that name into the copy it keeps without ever comparing it against the account the request was authenticated as - so a modified client could have added anything to a conversation's history in someone else's name, including a deletion of their own messages that every device would honour. The two are now required to match. The background path used when the app is closed was already sound. Found by audit, not in use
- **The site accepted connections over two obsolete versions of TLS.** The minimum version a browser could negotiate with canari-emse.fr was TLS 1.0 - a protocol deprecated for years and with known weaknesses, kept alive only for browsers that no longer exist. Every browser and both mobile runtimes Canari supports have spoken TLS 1.2 for over a decade, so nothing reachable was relying on it. The floor is now 1.2 and the two older versions are refused outright

### Removed
- **The QR code that transferred your conversations to another device is gone, and nothing replaces it because nothing needs to.** It did not work: the server required a field in every manifest upload that the app never sent, so any transfer carrying actual messages was rejected outright, and the two public keys exchanged to set the session up were never read by anything. What made it worth deleting rather than repairing is that the account's devices now pool their history by themselves, comparing what each holds and exchanging only the difference, with no gesture from anyone. The settings section keeps the half that was always sound - exporting to an encrypted `.canari` file and restoring one - and is renamed to say so
- **A conversation that lost a message used to answer by shouting, and it could not stop.** When a device failed to decrypt something it asked every member to re-send everything from the last two minutes - it could not do better, since the message had never been decrypted and a request that cannot name what it wants can only ask for a period of time. Measured on production, three devices in one conversation held about 450 frames a minute for over ten minutes, with nobody typing and nothing being repaired. It is deleted rather than tuned: the devices already compare what they hold and exchange precisely the difference, naming each message

---

Every release up to and including v0.11.7, and the full-length account of everything above, is
in [`docs/changelog-archive.md`](docs/changelog-archive.md).
