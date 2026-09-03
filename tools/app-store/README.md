# App Store submission

`submit.mjs` finishes the iOS half of a stable release: it creates the App Store version, attaches
the build the same run uploaded, writes the release notes into every localization, and submits the
whole thing for review. It is called by `.github/workflows/ios.yml` and by nothing else.

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
DRY_RUN=1 node tools/app-store/submit.mjs
```

`node tools/app-store/submit.mjs --check-notes` needs no credentials at all - it is the notes rule
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

## Tests

`node tools/app-store/submit.test.mjs` (also run by `make test-ci-scripts`). It covers the
classifiers and the notes rule, and asserts the JWT is the shape App Store Connect accepts -
including that the ECDSA signature is the raw 64-byte `r||s` pair rather than Node's default DER,
which every verifier rejects with a bare 401 that says nothing about why. The HTTP calls are not
mocked: a fake would only assert that this repository's fake matches this repository's expectations.

## Secrets

`APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_P8` (the `.p8`
base64-encoded) - the same three the TestFlight upload already uses, so this added no new secret.
See `infrastructure/MIGRATION.md`.
