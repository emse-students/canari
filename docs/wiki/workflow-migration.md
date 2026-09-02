# The 2026-09-02 workflow migration - decisions, order, and state

**This page is the ONLY copy of this chantier.** It carries the user's mandate, the twelve decisions
taken with them, the measurements already made (so that nobody re-derives them), and the ordered
checklist. **Tick a box here the moment the work lands, and delete a whole section once its durable
part has moved** - the branch model and the release conventions belong in [cicd](cicd.md), the local
estate in [development](development.md), the rules in [durable-rules](durable-rules.md), and the
stories in `CHANGELOG.md`. When every box is ticked and every durable part has moved, **delete this
page**, its row in `CLAUDE.md`'s WHERE THINGS LIVE, its queue item, and its line in
[index](index.md).

The migration REPLACES the two-branch model that landed on 2026-09-02, hours before this. Nothing
about that model is defended below: the user cancelled it the same day, and the parts of
[dev-environment](infrastructure/dev-environment.md) that describe a `dev` BRANCH are wrong from the
moment WP-2 lands. The dev ESTATE survives, with a new job.

---

## 1. The mandate, verbatim (user, 2026-09-02)

> 1) Plus de branche dev. La branche du projet c'est main.
> 2) Le deploiement (production, android, ios...) se fait au bump. Pas au push sur main.
> 3) On va fonctionner par pull request et arreter de se servir de canari-emse.fr ou
>    dev.canari-emse.fr pour le developpement local, le mieux pour la campagne de test notamment est
>    de tout faire localement. Cela evite les hooks tres longs. On peut dump la DB de prod pour
>    nourrir le local.
> 4) On aimerait utiliser les pre-release pour faire des deploiements iOS et Android test (programme
>    de testeurs), avec des numeros comme X.X.X-alpha. Je te laisse prendre les meilleures
>    conventions et te renseigner.
> 5) Dependabot continue de merge sur main si tout va bien.

And, on the campaign rig of the previous machine: *"Lithium est accessible mais pas utile. Reprends
de 0."*

## 2. The twelve decisions - DECIDED, NOT TO BE RELITIGATED

Each was put to the user on 2026-09-02 and answered. A later session that "improves" one of these is
undoing a decision, not finishing the work.

| # | Question | Decision |
| --- | --- | --- |
| 1 | The `dev` branch | **Gone.** `main` is the only branch. |
| 2 | What deploys production | **Only the completion of `Bump version on release`.** Not a push. |
| 3 | The dev ESTATE (`dev.canari-emse.fr`) | **Kept, with a new job: it is the PRE-RELEASE target.** `dev-refresh.yml` keeps feeding it a copy of production every Monday. |
| 4 | How a release starts | **A GitHub Release published on a tag** - the mechanism that already exists, with the push-triggered deploy removed. |
| 5 | Local database | **A full production dump**, PII included, the way `dev-refresh` already copies it to the dev estate. |
| 6 | Hooks | **`pre-commit` minimal (format only), `pre-push` DELETED**, replaced by a CI that also runs at merge on `main`. |
| 7 | `main` protection | **PR required + required checks, with admin bypass** for the emergency path. |
| 8 | Local authentication | **A dedicated `canari-local` OIDC client on the PRODUCTION Authentik**, redirect URIs on `localhost`. No local IdP. |
| 9 | Tester programmes | **alpha -> internal channels only**: Play *internal testing* and a TestFlight INTERNAL group. No Beta App Review in the loop. |
| 10 | Dependabot | **The in-house `dependabot-auto-merge.yml` stays**, ceiling and sweep included. No native auto-merge. |
| 11 | Local TLS | **Plain HTTP with `ALLOW_INSECURE_COOKIES=true`.** The cookie divergence this creates is a documented reservation, not a defect - see section 4. |
| 12 | The campaign board | **Reset to zero, old verdicts archived** as "rig LITHIUM, ledger lost". The rig restarts from nothing. |

Also decided: the phone and the emulator DO target the local stack, over `adb reverse`; an `-alpha`
build points at **`dev.canari-emse.fr`**, and only a stable tag points at production.

## 3. The single emergency path (user asked for exactly one, and for it to be explained)

Production has ONE deploy trigger: the completion of `Bump version on release`. The emergency does
not add a door - it makes the same door faster.

- **The code is wrong.** Hotfix pull request, merged at once through the admin bypass without waiting
  for a review, then publish the patch Release (`0.14.16`). The deploy leaves by the normal path.
  Cost: one CI.
- **The code is right and the estate is broken** (containers lost, box rebooted). That is not a
  deploy, it is an operation: `ssh canari` then `make update-services-prod`. No version moves,
  because nothing changed.

**Consequence, and it is deliberate: `cd.yml` loses its `workflow_dispatch` as well as its `on:
push`.** A manual dispatch would be the second door. Retrying a half-failed deploy is "Re-run failed
jobs" on the run that already exists, not a new trigger.

## 4. What is already MEASURED - do not re-derive any of this

All measured on 2026-09-02 on the current machine (`OXYGEN`) and against the remote.

- **`origin/dev` is identical to `main`**: zero commits ahead, zero files of diff. There is nothing
  to merge; the branch is a pure delete.
- **`main` has no protection and no ruleset** (`gh api .../branches/main/protection` -> 404,
  `.../rulesets` -> `[]`). WP-2 creates the first one.
- **The 20 open Dependabot pull requests all target `main`.** `target-branch` only applies to pull
  requests Dependabot creates AFTER the setting lands, so dropping it retargets nothing.
- **`scripts/bump-app-version.sh` refuses a prerelease**: `normalize_version` asserts
  `^[0-9]+\.[0-9]+\.[0-9]+$`.
- **A prerelease would COLLIDE on Android**: `gen/android/app/build.gradle.kts:25` reads
  `versionCode` from `tauri.android.versionCode`, which Tauri derives from the version and which
  ignores the prerelease suffix - so `0.15.0-alpha.1` and `-alpha.2` would ask Play to accept the
  same `versionCode` twice, and Play refuses. The suffix has to reach an explicit `versionCode`.
- **iOS cannot carry the suffix in its short version**: `gen/apple/canari_iOS/Info.plist` sets
  `CFBundleShortVersionString` and `CFBundleVersion` to the same `0.14.15`, and Apple requires the
  short version to be numeric. The alpha counter belongs in `CFBundleVersion`.
- **`android-release.yml` publishes straight to the `production` track**, and its own comment records
  that a second track needs its own `versionCode`.
- **`dependabot-auto-merge.yml` is wired to CD in two places** that both die with the
  push-triggered deploy: it triggers on `workflow_run` of `CD - Deploy to Production`, and it CALLS
  `workflow_dispatch` on CD after a merge. Both have to become the new CI-on-`main`.
- **The refresh cookie is not the same locally**: `apps/core-service/src/auth/auth.controller.ts:150`
  emits `Secure; SameSite=None` in production but flips to `SameSite=Lax` without `Secure` as soon as
  `ALLOW_INSECURE_COOKIES=true`. Decision 11 accepts this: on a stack where the frontend is
  `localhost:5173` and core is `localhost:3012`, `SameSite=Lax` is enough because a differing PORT is
  still same-site - but **any campaign row that reasons about cross-SITE cookie behaviour measures
  something else locally**, and the board says so per row.
- **The local compose is complete and has NO nginx**: coturn, redis, `postgres:15-alpine` (the same
  major as production, so a dump restores), chat-gateway, call-service, chat-delivery, garage, media,
  core, social - each on its own port, the frontend served by `bun run dev`. Production reaches all of
  them through one nginx, so the single-entry-point behaviour is the one thing local cannot exercise.
- **The handoff bundle's `.env` is a 2026-06-07 snapshot, taken BEFORE the Garage migration.** 27
  variables of today are missing from it (`GARAGE_*` x9, `APNS_VOIP_*` x5, `SKY_/CERCLE_/MIGALLERY_/
  EXTERNAL_API_KEY`, `LYDIA_*`, `GOOGLE_SAFE_BROWSING_API_KEY`, `SERVICE_ACCOUNT_USER_ID`) and 12
  dead `MINIO_*` variables are still in it. **The only usable source is the box.**
- **The bundle was collected without `-WithRig`** (131 KB): no `chrome-w1/w2/w3` profiles, no
  `results.ndjson`, no `apk/`, no `a1-baseline/`. Every campaign verdict on the board has lost the
  ledger that justified it, which is what decision 12 answers.

Measured during WP-0, and each one changes something downstream:

- **A PHONE IS ATTACHED TO THIS MACHINE**, so `CLAUDE.md`'s "campaign PAUSED for want of a phone" and
  its whole BLOCKED-ON-HARDWARE queue item are **false here**. It is a **Xiaomi Mi 9T** (`fa71073b`,
  `davinci`, Android 16, SDK 36), not LITHIUM's Pixel 6a - so a device verdict taken on the Pixel does
  not transfer, and neither does the SDK-37 defect that needed the `android-mcp` patch. WP-5 and the
  device table in [backlog](backlog.md) both have to be re-read against this.
- **The Play tester tracks ALREADY EXIST**: `internal`, `alpha` and `beta` are all serving `0.10.12`
  (code `10012`) while production serves `0.14.15` (code `14015`). Decision 9's Play half needs no
  console work, only a build pointed at the right track.
- **The `versionCode` scheme in use is `major*1000000 + minor*1000 + patch`** (`0.14.15` -> `14015`),
  which is what makes a prerelease impossible to number: `0.15.0` is `15000`, and any alpha of it
  must sort ABOVE production's `14015` and BELOW its own stable release, in a space one unit wide.
  **The scheme has to gain a digit band.** `(major*1000000 + minor*1000 + patch) * 100 + rank`, with
  `rank` 1..32 for `alpha.N`, 34..64 for `beta.N`, 66..97 for `rc.N` and **99 for a stable release**,
  keeps store order identical to semver order and keeps every future value above the `14015` already
  shipped (`0.14.15` stable would be `1401599`). Play's ceiling is 2100000000, so the band costs
  nothing. This is WP-3's numbering, and it wants a unit test rather than a comment.
- **WSL2 and Docker: the container runtime is ALREADY Linux.** `wsl -l -v` lists `Debian` and
  `docker-desktop`, so Docker Desktop runs on the WSL2 backend and moving the CLIENT into WSL would
  change nothing about the services. It was considered and refused as a development environment
  (user asked, 2026-09-02): the repo would have to leave `D:` to gain anything - `/mnt/d` goes
  through 9p and is SLOWER than native NTFS for `node_modules` and `target/` - and everything the
  campaign runs on is Windows-side (Chrome profiles that ARE MLS devices, `adb` over USB, the two MCP
  servers, the Tauri Windows and Android builds, `gh`/`glab` in the Windows keyring, cloudflared from
  winget). The one narrow job Debian keeps is running the shell suites the way `ubuntu-latest` does -
  `make test-ci-scripts` and the deploy-script tests are shell-only and tiny, so 9p costs nothing
  there, and it is a truer mirror of CI than Git Bash. **The complaint about Git Bash is real but
  narrow**, and this repo has already paid it: `jq` writes CRLF under Windows, which is why
  `bump-app-version.sh` carries `strip_cr` and why `lineEndings.test.ts` exists.
- **The Docker daemon was not running** when this started; WP-1 needs it up.

## 5. The checklist, in order

WP-0 and WP-1 come first because nothing can be verified without them. **WP-4 comes before WP-2**: a
lightened hook whose gates are not yet in CI is an open hole for the length of the chantier.

### WP-0 - this machine (DONE, both rotations included; only the handoff zip is left)

- [x] `~/.ssh/config`: `Host miconnect` added. **The `cercle` block needed no repair** - it was
      already complete here, and the diff that suggested otherwise was a re-ordering. What was
      genuinely missing was `10.0.0.7`'s entry in `known_hosts`, imported FROM THE BUNDLE rather
      than accepted blind
- [x] all four routes verified from the PowerShell tool: `canari`, `cercle`, `miconnect`
      (hostname `rootz-emse`), and `mitv` shares `canari`'s working `ProxyCommand`
- [x] the out-of-repo state root is **`d:\Documents\Programmation\EMSE\canari-harness\`**, NOT the
      `canari-secrets\` this checklist first named: that path is the SIBLING of the repo, which is
      exactly where `tools/play-vitals/lib.mjs` already looks, so **no `PLAY_SA_KEY` is needed** and
      the variable stays what it is meant to be - the override. `play-console-sa.json`,
      `google-services.json` and the harness test accounts live there; `google-services.json` is
      also placed at the gitignored `frontend/src-tauri/gen/android/app/` for a local Android build
- [x] verified END TO END, not by the file existing: `node tools/play-vitals/vitals.mjs` reads the
      key, authenticates, and reports production on `0.14.15` / code `14015`
- [x] the handoff memory installed - **11 files, not 12**: the `bunx` shim note was dropped as false
      here (see below)
- [x] **15 stale memory files deleted, and two of them were moved into the repo FIRST.** The Svelte 5
      teardown race and the `svelte:boundary` strategy existed nowhere but that directory, which
      `CLAUDE.md` calls a bug - they are now in
      [frontend/architecture](frontend/architecture.md#a-prop-expression-is-re-evaluated-during-teardown-so-an-if-does-not-protect-it)
      and [durable-rules](durable-rules.md). The other thirteen were already in the repo, or false:
      one still named `prettier` as the formatter
- [x] `chrome-devtools-mcp` (chrome_devtools **1.8.0**, 29 tools) installed and declared by absolute
      path. **Verified over stdio**: it launched Chrome on `https://canari-emse.fr/` and followed the
      redirect to `Connexion - Canari`, so the probe doubles as a production liveness check
- [x] `android-mcp` (Android-MCP **4.0.1**, package 0.2.0, **14 tools**) installed as a
      `uv tool` - the system Python is 3.12 and the package needs >= 3.13, and `uvx` was rejected
      because it re-materialises the package per launch, which would erase exactly the kind of local
      patch LITHIUM depended on. **Verified over stdio against the phone**: `ConnectDevice` then
      `Snapshot` returned the live launcher tree
- [x] **LITHIUM's `service.py` patch is NOT applied, and that is a measurement.** `device.info` -
      the discarded probe that killed the server on a Pixel 6a at SDK 37 - returns a full dict on the
      phone attached here. The patch is device-conditional; applying it blindly would have added an
      unexplainable local modification
- [x] `bunx`: **not needed.** `bun 1.4.0` here comes from the official installer at `~/.bun/bin` and
      ships `bunx.exe`. LITHIUM's shim was a winget artefact
- [x] `glab` 1.115.0 is **already on the PATH and already authenticated** to `gitlab.emse.fr` as
      `jolan.boudin` through the keyring - the memory note claiming otherwise was LITHIUM's.
      `D:\Documents\Programmation\gitlab-pat.txt` deleted. **Deleting the file did not revoke that
      PAT**, so it is a third rotation owed
- [x] **`CF_DNS_TOKEN` rotation - done by the user 2026-09-02**, who issued replacements after the
      original leaked into a transcript on 2026-09-01. The workstation could not have done it: the
      leaked token was `active` with no expiry, and `PUT /user/tokens/{id}/value` on itself answers
      **403** - a Zone-scoped token cannot roll itself - while the broad `CF_API_TOKEN` the handoff
      memory carried answers **401** and is dead. **A NEW TOKEN IS NOT A REVOKED OLD ONE**, so what
      closes this is DELETING the leaked one, not superseding it
- [x] **cloudflared tunnel RUN token rotation - DONE 2026-09-02, and it was NOT the user's click.**
      The line above said it was, which stopped being true the moment they supplied an
      account-scoped token that can read `/cfd_tunnel/{id}/token`. Rotated by `PATCH`ing the
      tunnel secret and rewriting the unit; the token in the unit fingerprinted identically to the
      one the API served, so the leaked value is confirmed dead rather than assumed to be.
      **Three things this taught, all of which outlive the rotation:**
      - **The ORDER is not free.** `PATCH` kills the old secret instantly, so the box must be able
        to receive the new token BEFORE the call is made. Verifying that the credential can *read*
        `/token` came first, precisely because a `PATCH` followed by a refusal would have left a
        healthy-looking tunnel that dies at its next restart - which is exactly what happened for
        one minute when a guard of mine refused a valid token
      - **A guard calibrated on one sample rejects the next one.** The plausibility floor was a
        digit-shaped glob (`1[0-9][0-9]`) derived from the 248-char token then in the unit, and the
        API returned 180. It refused to write, which was right, but for a wrong reason. **A run
        token's length follows the SECRET's length** (32 bytes -> ~180, 64 -> ~250), so the floor is
        now a numeric comparison that says what it means
      - **The leak CLASS is closed, not just the instance.** The unit was `644 root:root`, which is
        why `systemctl cat` as the `canari` user printed the token into a transcript at all. It is
        now `600`, and systemd is root so nothing needed it readable
- [x] **the dead broad token is its own finding**: nothing on this workstation held Cloudflare
      Access, Zero Trust or tunnel-ingress rights between its death and 2026-09-02. Re-issuing was
      the user's call and they did it
- [x] **cloudflared upgraded 2026.6.0 -> 2026.8.3** on the same visit (the user's ask). Checked
      first, because the trap is real: had the package OWNED
      `/etc/systemd/system/cloudflared.service`, or declared it a `conffile`, the upgrade could have
      replaced the file carrying the run token and killed the only door into the box. `dpkg -S`
      finds no owner and the package declares no conffile for it - measured before the upgrade ran,
      and the token fingerprint is compared across it so a silent replacement would be CAUGHT
- [x] **NO IDENTIFIER BELONGS ON THIS PAGE.** An earlier revision of it carried the leaked token's
      id and the tunnel's uuid. Neither authenticates anything, but this repository is PUBLIC and its
      own convention keeps that inventory out of public docs - the admin-hostname map is in the local
      memory for exactly this reason. They were removed the same day, and **they remain in one pushed
      commit**: an edit does not rewrite history. Ids live in
      `~/.claude/projects/<project>/memory/`, and nowhere in `docs/`
- [ ] the handoff zip destroyed - **NOT YET, AND NOT BLINDLY.** The bundle is the only copy in the
      world of `claude-account-manager`; it has been preserved to
      `d:\Documents\Programmation\claude-account-manager\` (with LITHIUM's DPAPI vault beside it, for
      the record - it will not decrypt here). Destroy the zip only after WP-1 has taken what it needs
      from the box

### WP-1 - the local estate (DONE except its last box: a real login)

**Everything but the last box landed 2026-09-02.** The shape differs from what this list planned,
in one way worth keeping: the plan named ONE script, `infrastructure/dev/dump-prod-to-local.sh`. It
became FOUR, because fetching, classifying and restoring fail differently and a single script would
have had one exit code for three unrelated causes.

- [x] `/home/canari/canari/infrastructure/.env` pulled from the box as the source. **Not
      "(PowerShell)" as this line said** - either tool reaches prod since the `ProxyCommand` was
      respelled with forward slashes, and the constraint that DOES bite is the opposite one: a
      binary pipe (`pg_dump | gzip`) must NOT go through PowerShell, which text-encodes stdout and
      corrupts it. So `pull-prod-dump.sh` dumps on the box and `scp`s the file, and never pipes
- [x] `infrastructure/.env` (local) built from it by `infrastructure/local/env-from-prod.sh`:
      third-party secrets KEPT as production's (Stripe, Klipy, FCM/APNs, Authentik, Cloudflare
      TURN, avatar), **and `CHANNELS_ENCRYPTION_SECRET` kept too** - without it the dumped data does
      not decrypt. **All 61 variables are CLASSIFIED and an unclassified one is a hard error**, so a
      variable added to production later cannot be silently carried or silently dropped
- [x] `JWT_SECRET`, `INTERNAL_SECRET`, `INTERNAL_SHARED_SECRET`, `CALL_ROOM_SECRET` REGENERATED for
      local: sharing them would make a token minted on a laptop valid in production, and they carry
      no data at rest. **But regenerating them on EVERY run was a defect**: the second run
      desynchronised the containers already holding the first run's values, and every session died.
      They are now read back from `infrastructure/.env.bak` when it exists, and only minted when
      absent - which is what made that backup file exist, and is why the near-miss below happened
- [x] `ALLOW_INSECURE_COOKIES=true`, `NODE_ENV=development`, `ENABLE_DEV_ROUTES=true`, localhost
      topology (ports, `ALLOW_ORIGIN`, `FRONTEND_URL`)
- [x] `frontend/.env` (local) on the localhost ports
- [x] **four scripts, not one**, plus `make local-env` / `make dump-prod`:
      `local/pull-prod-dump.sh` (read-only, refuses to write inside the work tree, `gunzip -t`
      against truncation, and a `.meta` sidecar recording what prod held AT DUMP TIME),
      `local/env-from-prod.sh`, `local/restore-into-local.sh`, and `lib/copy-strips.sh` -
      **factored out of `dev/copy-prod-to-dev.sh` rather than copied**, so the strip list is one
      list. The caller passes its OWN guarded sql function by name, which keeps the destructive
      allowlist with whoever owns the target
- [x] **362 users restored and VERIFIED against the sidecar**, with `push_token` truncated and 7
      payment-identifier columns cleared. Two things the run taught: the restore printed
      `13 x ERROR: role "canari" does not exist` and still reported success, so it now derives roles
      from the dump, creates them `NOLOGIN`, and FAILS on any `^ERROR:` in psql's stderr; and
      `name: canari-local` in the compose file is load-bearing, a foreign project called `local`
      already existing on this machine
- [x] a `Canari Local` OIDC client on the production Authentik. **Its redirect URIs are on `1420`
      and `1421`, not the `5173` this line used to name** - `vite.config.js` pins
      `port: 1420, strictPort: true` and `frontend/.env` agrees, so the number written here from
      memory would have failed the login it was meant to enable. **It returned `invalid_request` until three fields were copied from the production
      provider** - `grant_types` was EMPTY, `authentication_flow` None, `refresh_token_threshold` 0.
      A field diff against the working provider found it; reading the error text would not have
- [ ] **verified by a real login and a message sent**, not by a file written. **THE ONLY BOX LEFT
      IN WP-1** - the estate answers and the data is in it, which is not the same claim
- [x] **four latent defects fell out of merely RUNNING the stack**, none of which any gate here
      catches, and they are the argument for the local estate on their own: `.dockerignore` was
      missing `**/*.tsbuildinfo`, so three NestJS services shipped a partial `dist` and died with
      `Cannot find module` while the build stayed green; `make run-services` printed a tick over
      dead containers, and now calls `check-services`, which lists what is not running and dumps its
      logs; social-service got no `REDIS_URL` locally though prod gives it one; and its Redis error
      handler logged an empty message, so it now names the target host:port with userinfo stripped
- [x] **a near-miss worth more than the work: `git add -A` staged `infrastructure/.env.bak`** -
      7930 bytes of PRODUCTION credentials - into a commit for a PUBLIC repository. Caught in the
      commit, not on the remote. The root `.gitignore` had `.env` alone while `frontend/.gitignore`
      already had the right rule; it now carries `.env.*` with `!.env.example`. The rule this left
      is in [durable-rules](durable-rules.md)

### WP-4 - hooks (before WP-2)

**Done 2026-09-02, and in that order: the gates were closed BEFORE the hook that was standing in
for them was deleted.** Two of the four were genuinely missing, so deleting `pre-push` first would
have opened a hole for as long as it took to notice.

- [x] each of the four things `pre-push` alone covered confirmed present in `ci.yml` -
      `make test-harness`, the real `wasm32` build, clippy, the frontend suite - **and the two that
      were missing added THERE FIRST**: `src-tauri` was built but never `cargo fmt`-checked (the
      matrix entries now carry `fmt: true` and the step fires on `check` OR `fmt`), and the four
      NestJS apps all declare `format:check` and nothing ran it (the TS job now derives a
      `has_format` output and runs it)
- [x] `.husky/pre-commit` reduced to fixers only - `lint:fix` + `format` across the five bun
      packages, `cargo fmt` across the five crates, with the existing re-staging allowlist. **It
      asserts nothing now**: a hook that fails is a hook that gets bypassed, and CI is where a
      verdict belongs
- [x] `.husky/pre-push` deleted
- [ ] optional, and the ONLY job WSL keeps here: run `make test-ci-scripts` and the deploy-script
      tests from the `Debian` distro, which is what `ubuntu-latest` actually is. They are shell-only
      and tiny, so `/mnt/d` costs nothing, and Git Bash has already let a Windows-shell difference
      through (`jq` and CRLF)

### WP-2 AND WP-3 ARE ONE WORK PACKAGE, not two - found 2026-09-02, before either was written

The checklist below lists them separately and they cannot be committed separately. The coupling is
mechanical, not stylistic:

- production deploying "at the bump" needs no new trigger - `cd.yml` already has
  `workflow_run: ['Bump version on release']`, and deleting `on: push` leaves exactly that. Fine.
- **`deploy-dev` is triggered by a PUSH to a branch today.** Deleting `on: push` leaves it with no
  trigger at all.
- re-wiring it to a PRERELEASE tag requires telling a prerelease release from a stable one, and
  **the `workflow_run` context does not carry that flag**. It has to be passed down by
  `bump-version.yml` - which is a WP-3 item ("carries the prerelease flag downstream").

So committing WP-2 alone leaves the dev estate unreachable by any deploy until WP-3 lands, and
`one coherent commit per work package` is what forbids that. **Treat 2+3 as one package**, or accept
a window in which only production can be deployed. This is a plan-shape decision, so it is recorded
here rather than settled in passing, and the ORDER inside the merged package still matters: the flag
must exist before anything keys off it.

### WP-2 - the branch, and deploy-at-bump

- [ ] `cd.yml`: `on: push` and `workflow_dispatch` removed (section 3 explains why the dispatch goes)
- [ ] `cd.yml`: `build-frontend-dev`, `build-frontend-images-dev`, `promote-dev-to-main` deleted
- [ ] `cd.yml`: `deploy-dev` kept, re-wired to fire on a PRERELEASE tag
- [ ] a CI that runs at merge on `main` (the user's ask), and which becomes the convergent trigger
      the auto-merge needs
- [ ] `dependabot-auto-merge.yml`: its `workflow_run` on CD and its `workflow_dispatch` CALL to CD
      both re-pointed at that CI
- [ ] `.github/dependabot.yml`: the 6 `target-branch: "dev"` removed
- [ ] a ruleset on `main`: pull request required, required checks, admin bypass
- [ ] `origin/dev` deleted
- [ ] `dev-refresh.yml` left running (the estate survives)

### WP-3 - pre-releases

- [ ] `scripts/bump-app-version.sh` accepts `X.Y.Z-alpha.N` and derives BOTH store numbers: a
      monotonic `versionCode` and a numeric `CFBundleShortVersionString` with the counter in
      `CFBundleVersion`
- [ ] `bump-version.yml` carries the prerelease flag downstream
- [ ] `android-release.yml`: track `internal` when prerelease, `production` otherwise
- [ ] `ios-release.yml`: TestFlight INTERNAL group when prerelease
- [ ] an alpha build carries the DEV `VITE_*` set, a stable build production's, and **the job FAILS
      when the tag's nature and the backend URL disagree** - this is the one place in the chantier
      where a mistake ships to phones, so it is an assertion and never a convention
- [ ] a prerelease tag deploys the dev estate; a stable tag deploys production
- [ ] the first pre-release is `0.15.0-alpha.1` (`0.14.15` stays the stable in the stores)

### WP-5 - the campaign, from zero

- [ ] a new rig root at `D:\Documents\Programmation\canari-harness\`, fresh Chrome profiles, fresh
      test accounts, target LOCAL
- [ ] the board reset, old verdicts archived in a dated "rig LITHIUM, ledger lost" section
- [ ] the campaign pages rewritten: the target is local, the phone enters by `adb reverse`, and the
      cookie reservation of section 4 is stated per row
- [ ] **two standing rules DELETED, and that is a gain**: "a campaign run and a push to `main` are
      mutually exclusive" no longer holds (a local run cannot be voided by a deploy), and "the rig
      targets PRODUCTION" becomes false

### WP-6 - documentation (26 files touched)

- [ ] `CLAUDE.md` first: "WORK ON `main`, commit directly" is replaced by the PR flow, the
      deploy-at-bump rule, and the release conventions
- [ ] `durable-rules.md`, `cicd.md`, `infrastructure/dev-environment.md`, `backlog.md`, `index.md`,
      `README.md`, `infrastructure/MIGRATION.md`
- [ ] `sessions.md`, `infrastructure/databases.md`, `infrastructure/docker.md`,
      `services/chat-gateway.md`
- [ ] the three campaign pages, `.github/scripts/tests/deploy-env.test.sh`,
      `.github/scripts/tests/deploy-migrations.test.sh`, `infrastructure/deploy/env-manifest.tsv`,
      `tools/cross-client-harness/srvlog.mjs`
- [ ] `development.md` extended with the local estate (NOT a new page - this one already owns local
      setup, the Makefile, compose and the hooks)
- [ ] `docs/user-guide/workflow-developpement.md` - French, the user's own page, and the most
      rewritten of all
- [ ] `CHANGELOG.md` under `[Unreleased]`

## 6. Traps this chantier must not leave behind

- **Pull request #309 (`postgres 15-alpine -> 18-alpine`) must stay refused** until the PG migration
  is performed, and the refusal must NAME the test that would lift it. It is the update that took
  production down for 33 minutes on 2026-09-01. With deploy-at-bump it would merge in silence and
  break the first release instead - later, and further from its cause.
- **Deleting `pre-push` before its gates exist in CI** is the hole four of its own comments were
  written to close. WP-4 is ordered before WP-2 for that reason alone.
- **An alpha build pointed at production** is the one mistake here that reaches a phone. WP-3 makes
  it a failing assertion, not a convention.
- **`dev-environment.md` keeps its estate and loses its branch.** Half of that page is right and half
  is void from WP-2; a reader who trusts the wrong half will look for a branch that no longer exists.
