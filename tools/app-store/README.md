# App Store submission

`submit.mjs` finishes the iOS half of a stable release: it creates the App Store version, attaches
the build the same run uploaded, writes the release notes into every localization, and submits the
whole thing for review. It is called by `.github/workflows/ios.yml` for the release, and by the
`stores` job of `.github/workflows/scheduled.yml` to complete a submission the release had to defer
(`--catch-up`, below) - one implementation for both.

## What it exists for

`xcrun altool --upload-app` hands Apple the binary and stops. The binary lands in TestFlight, which
is the whole point for a pre-release. For a **stable** it left the release one manual gesture short
of shipped - somebody had to open App Store Connect, create the version, attach the build and press
Submit - while the same release put Android on the Play `production` track by itself. Nothing asked
for that gesture and nothing reported its absence, so a stable release was **half-shipped by
construction**. `ios.yml` said so in its own comments: *"submission is still a manual act in App
Store Connect"*.

## The one thing a human owes each stable release

`store/whats-new.txt` - the App Store release notes, in French, at most 4000
characters, **whose first line names the version they are for**:

```
version: 0.16.0
Messages manquants : ...
```

Apple requires release notes on a version and refuses the submission without them, so their absence
has to be a refusal somewhere. It is a refusal in `release-preflight.sh`, before the bump: publish
`v0.16.0` without updating this file and the release stops in seconds, having deployed nothing and
shipped nothing.

**The version marker is not bureaucracy.** A plain "is the file non-empty" check passes for ever on
a notes file nobody updated, and the store then carries the previous release's notes - a staleness no
mechanism could detect, because a file cannot be asked when it was last meant. Naming the version
makes it *impossible* rather than *reported*, which is the same choice the dev-coverage gate makes
one question earlier. The bump deliberately does **not** rewrite this line: a marker the machine
maintains would only ever be in step with itself.

## Reading it without changing anything

`DRY_RUN=1` resolves the app, waits for the build, reads the existing version and stops before the
first write. It needs the three App Store Connect secrets and nothing else.

```sh
ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_API_KEY_P8="$(base64 -w0 AuthKey_XXX.p8)" \
APP_BUNDLE_ID=fr.emse.canari MARKETING_VERSION=0.16.0 BUILD_NUMBER=1600099 \
DRY_RUN=1 bun tools/app-store/submit.mjs
```

`bun tools/app-store/submit.mjs --check-notes` needs no credentials at all - it is the notes rule
alone, and it is the mode the release preflight calls so that the rule has exactly one
implementation.

## What is idempotent, and why that matters

A re-run is an ordinary event: a release can be re-published, and `release.yml` has a hand-dispatched
path for re-running a chain that died on an infrastructure fault. So every step asks what already
exists first - a version already with Apple is reported as **done**, never resubmitted; an item
already in the review submission is left alone; an open submission is reused rather than duplicated.

Two decisions are worth knowing because their failure mode is silence:

- **The build number is read off the archive** (`ApplicationProperties:CFBundleVersion`), never
  recomputed. `scripts/bump-app-version.sh` owns the store band formula; a second implementation
  here would eventually disagree, and the disagreement would look like a submission waiting 45
  minutes for a build nobody uploaded.
- **An unrecognised build or version state is a refusal, not a wait.** Apple adds states; a
  classifier that treats anything unknown as "keep polling" holds a macOS runner until the job times
  out and explains nothing.
- **A 5xx is retried, and which calls may be is decided by the resource rather than the verb.** A
  status code is an answer; `500 An unexpected error occurred on the server side` is Apple saying it
  never reached one, so repeating the request is not a fallback path - nothing different happens. The
  subtle half is WHICH requests may repeat. GET and PATCH always may. Of the two POSTs in the
  submission chain, `reviewSubmissionItems` may - Apple enforces uniqueness on (submission, version)
  and refuses a second one with a 409 whose content is the postcondition we wanted - and
  `reviewSubmissions` may NOT, because a second create simply succeeds and leaves the app with two
  open submissions. So the call site declares `appleRefusesDuplicate`, and that 409 is then
  **verified against the items list** rather than taken on Apple's word: a 409 for another reason
  must not become a green submission. `ApiError` carries the status as a fact so none of this is
  decided by matching Apple's prose. `v0.16.1` and `v0.18.10` each cost a production deploy to the
  two halves of this, one call apart in the same chain.
- **A submission App Review sent back is resent, not left stuck.** A rejection leaves the
  submission open as `UNRESOLVED_ISSUES` with its item `REJECTED`; the version is editable again,
  so the next release renames it and writes its build and notes, and `submitted: true` is then
  refused 409 *"Version is not ready to be submitted yet"* however long it waits. The script marks
  the rejected item of THIS version `resolved: true` (the API side of "Resubmit to App Review") and
  never touches another resource's rejection. Found 2026-10-12, when the 1.2.1 rejection would have
  turned every later stable's iOS arm red, and the production deploy with it.
- **Apple's nested errors are printed.** A 409 is often a wrapper whose reason sits under
  `meta.associatedErrors`; `describeAppleErrors` puts it in the log line.

## A deferred submission completes itself (`--catch-up`, 2026-11-25)

**The defect.** Apple gives an app ONE non-terminal version slot. The `1.8.1` stable's iOS arm found
`1.8.0` holding it in `WAITING_FOR_REVIEW` and deferred - `SlotHeldError`, exit 75, green, correct.
Then `1.8.0` was approved, the slot freed, and **nothing ever asked again**: the App Store had no
`1.8.1` version at all, Play had it, iOS users stayed on the old version, and the daily store
report (`tools/store-divergence/`) went red every morning and only reported. A deferral whose
completion waits for a human to notice is a queue nobody drains.

**The mechanism.** Both facts that decide it are durable already: the latest stable GitHub release
says what must ship, and App Store Connect's version list says what is there. So the `stores` job
of `scheduled.yml` (daily, 09:00 UTC) runs, BEFORE its report:

1. `bun tools/store-divergence/divergence.mjs --catch-up-target` - the latest stable's tag
   (`pickLatestStable`, the same answer the report uses), or nothing while a stable's `release.yml`
   run is unfinished (`releaseInFlight`): a stable is published twenty minutes and more before its
   build exists, and in that window the release owns the submission. GitHub is asked once per
   unfinished status (`UNFINISHED_RUN_STATUSES`), not for the newest twenty runs, so an old re-run
   is still seen; a run on an `-alpha.N` tag is ignored (a pre-release never touches an App Store
   version), and a run whose tag is unknown counts as in flight. This step holds no App Store
   credential.
2. The build number from `scripts/bump-app-version.sh --code`, the band the stable's bump wrote into
   the archive, and the stable's tag fetched so `submit.mjs` reads the notes from THAT tree
   (`WHATS_NEW_REF`; `main` already carries the next version's). `submit.mjs` stays the only code
   that names the notes file (`release-chain.test.sh` asserts it).
3. `bun tools/app-store/submit.mjs --catch-up` - the release's own `submitToAppStore`, in the one
   step that holds the App Store credential, with one question asked first, from the WHOLE version
   list (`listAll` follows `links.next`; a page of 50 is not a promise) - `chooseCatchUp`:

| Apple holds | the catch-up | writes |
| --- | --- | --- |
| a version NEWER than the latest stable, in any state | nothing - never submit an older version than one already there | none |
| the latest stable, with Apple or released | nothing - the deferral is over | none |
| the latest stable, refused by App Review (`REJECTED`, `METADATA_REJECTED`, `INVALID_BINARY`) | nothing - resubmitting a refused build unread is a human's decision; the report says `rejected` | none |
| the latest stable, withdrawn by a human (`DEVELOPER_REJECTED`) | nothing - a clock does not undo a human's withdrawal of the very version it would resubmit | none |
| an OLDER version App Review refused, in the slot | nothing - the release renames over it because a release is a new answer; a catch-up has none. The report says `rejected` | none |
| another version, with Apple (in review, or approved and waiting for its developer release) | defers: exit 75, green, tomorrow asks again | none |
| a free slot, or an older version still editable (`DEVELOPER_REJECTED` included: a withdrawal is no refusal) | submits, exactly as the release would (create, or rename the editable one) | the release's chain |

**Nothing in a catch-up waits, and that is the bound the race argument rests on.** The build must
already be `VALID` and the store media already processed; either missing fails the step at once (an
absent build is a finding about the release that should have uploaded it; a version left with
unprocessed media is still editable, so tomorrow resumes it). So a catch-up's writes are a handful of
requests - seconds, a few minutes at the retry ceiling - and the job is killed at 10 minutes. Any
stable needs twenty minutes and more from publication to its own submit, because the iOS build comes
first. A stable published just after the in-flight check therefore cannot reach the App Store while
the catch-up is still writing. The job has its own concurrency group (`app-store-catch-up`), and
deliberately NOT `release.yml`'s: a pending run in a shared group is cancelled by the next one to join,
so a catch-up could cancel a queued release.

The run summary says what it did (`submitted`, `nothing`, `deferred`, `stood down`, `dry-run`); the
hand dispatch's `dry_run` reaches it.

**The latest stable always wins, and a stale missing stable is skipped - decided.** Only the newest
published stable is ever a target, so once `1.8.2` is out nothing submits `1.8.1`: the newer build
carries everything the older one did, and submitting the older first would hold the slot for a whole
review against the version users should actually get. The sequence when they overlap is then
mechanical: `1.8.1` submitted by the catch-up, `1.8.2` released while it is in review (deferred, and
the report reads `queued`, a pass), and the first morning after `1.8.1` leaves review, the catch-up
submits `1.8.2`.

**What it does not do.** It never cancels or edits a version Apple is reviewing, never renames a
version newer than its target, and never answers an App Review refusal. It also does not shorten the
wait: the daily slot is a floor, so a freed slot is filled within a day, never instantly.

## Tests

`bun tools/app-store/submit.test.mjs` (also run by `make test-ci-scripts`). It covers the
classifiers and the notes rule, and asserts the JWT is the shape App Store Connect accepts -
including that the ECDSA signature is the raw 64-byte `r||s` pair rather than Node's default DER,
which every verifier rejects with a bare 401 that says nothing about why.

**One fake App Store.** The catch-up's promise is about WHICH WRITES HAPPEN, so the file runs
`submitToAppStore` against an in-memory App Store that refuses any route it does not know: a busy
slot (defer, no write); a free slot with the latest missing (the release's chain, in order, then
nothing the next morning); the latest already in review (nothing); a newer stable out (only the
newest submitted, and handed the stale one anyway it refuses); an older version App Review refused
(nothing written over it) against one a human withdrew (renamed and submitted); the rename path end
to end; a version list paged through `links.next`, with the newer version on its last page; and the
release path itself (`catchUp: false`) - the build wait through `pollMs`, a deferral on a version in
review, and the one arm where the two paths differ on purpose (the release renames over an older
refusal). It proves the wiring and the decisions - never Apple's behaviour, which no fake can.
`.github/scripts/tests/scheduled.test.sh` asserts the job feeds it the right facts (the stable's tag
for the notes, the band, the in-flight guard, the credential in one step, the concurrency group, the
10-minute bound), and both workflows' `-eq 75` are asserted equal to `EXIT_SLOT_HELD`.

## Secrets

`APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_P8` (the `.p8`
base64-encoded) - the same three the TestFlight upload already uses, so this added no new secret.
See `infrastructure/MIGRATION.md`.
