#!/usr/bin/env bash
#
# THE CEILING'S NAME TABLE: given a dependency name, the gate this repository is MISSING for it.
#
# It lived inline in `dependabot-auto-merge.sh` (deleted 2026-09-04) until 2026-09-01, and the
# reason it moved is the
# incident that day: `postgres 15-alpine -> 18-alpine` auto-merged on a green suite, the deploy
# recreated the container, and PostgreSQL 18 refused to start on a data directory initialised by 15.
# Production lost every backend service for 33 minutes. The arm that would have refused it was simply
# ABSENT, and nothing could say so, because a `case` buried in a 300-line script has no way to be
# asked what it covers. The predicate beside this file has had self-tests since it was written; the
# table that decides what MERGES did not.
#
# ---------------------------------------------------------------------------------------------
# WHAT PUTS A NAME IN HERE, AND WHAT DOES NOT
# ---------------------------------------------------------------------------------------------
# THE CRITERION IS NOT SEVERITY AND IT IS NOT SEMVER - it is whether a gate in this repository would
# SEE the update fail. `update-type` is parsed by the caller and deliberately decides nothing: a
# major that breaks the tree stops it compiling, and the suite catches that on its own. A name
# belongs here only when the failure mode is INVISIBLE to every gate here, and the entry must name
# the test that would make it visible - because a refusal that names nothing is a queue nobody
# drains, and that is worse than the merge it prevented (user, 2026-08-31).
#
# AND THE OBVIOUS ALTERNATIVE WOULD NOT HAVE WORKED, WHICH IS WHY IT IS RECORDED AND NOT RE-TRIED.
# The tempting reading of the 2026-09-01 outage is "refuse every major". Replaying the ceiling
# against the real culprit trailer (commit `0f95d481`) parses to `postgres||18-alpine`: Dependabot
# emitted NO `update-type` at all, because `15-alpine -> 18-alpine` is not a semver comparison it can
# make. A semver ceiling would have called that update unclassified and merged it exactly as this one
# did. For a Docker tag the NAME is the only reliable discriminator there is.
#
# Usage: gate_for_dependency <name> [proposed-version] [ecosystem]
#          -> prints the missing gate, or nothing when the suite is evidence about this dependency.
#             Always exits 0. The version and the ecosystem are consulted ONLY by the datastore arm;
#             see below. An ABSENT ecosystem fails closed - the arm applies, which is the behaviour
#             this table had before the argument existed.

# The compose file that names the majors production is actually running. Overridable so the
# self-tests can drive the comparison off fixtures rather than off today's pins.
: "${CEILING_PROD_COMPOSE:=$(dirname "${BASH_SOURCE[0]}")/../../../infrastructure/docker-compose.prod.yml}"

# Prints the MAJOR of the tag production pins for image "$1", or nothing if it names no such image.
# `v2.3.0` and `15-alpine` both reduce to their leading integer; a digest suffix is discarded.
prod_image_major() {
  awk -v want="$1" '
    $1 == "image:" {
      ref = $2
      name = ref; sub(/:.*$/, "", name)
      if (name != want) next
      tag = ref; sub(/^[^:]*:/, "", tag); sub(/@.*$/, "", tag); sub(/^v/, "", tag)
      if (match(tag, /^[0-9]+/)) { print substr(tag, 1, RLENGTH); exit }
    }
  ' "$CEILING_PROD_COMPOSE" 2>/dev/null
}

# Emits `<image-name> <named-volume-count>` for every service in a compose file. The image name is
# the reference up to the first `:` - exactly what Dependabot writes into `dependency-name` - and a
# mount counts as a NAMED volume when its source is neither absolute nor relative, i.e. not a bind
# mount of configuration. Indentation is the block structure: services at two spaces, keys at four.
#
# IT LIVES HERE, NOT IN A TEST, because two tests now derive their subject from it - `ceiling.test.sh`
# asks which images the table must cover, and `dev-gap.test.sh` asks which images must declare a
# version gap - and a parser copied into both would drift in one of them silently.
compose_stateful_images() {
  awk '
    /^  [a-zA-Z0-9_-]+:[[:space:]]*$/ { if (image != "") print image, vols; image = ""; vols = 0; inv = 0; next }
    /^    image:[[:space:]]/ { image = $2; sub(/:.*$/, "", image); inv = 0; next }
    /^    volumes:[[:space:]]*$/ { inv = 1; next }
    /^    [a-zA-Z]/ { inv = 0 }
    inv && /^      - [a-zA-Z0-9_]+:/ { vols++ }
    END { if (image != "") print image, vols }
  ' "${1:-$CEILING_PROD_COMPOSE}"
}

# The subset of the above that a dependency gate is about: THIRD-PARTY images that hold state.
#
# Our own service images are built from this tree, so the suite that builds them IS the gate and
# Dependabot never proposes them. They are written `${REGISTRY:-ghcr.io}/...`, so BOTH shapes have to
# be skipped - matching only the literal registry left `${REGISTRY` looking like a third-party image
# with a volume, which is a false accusation. `\$\{` rather than a quoted `'\''${'\''`: the brace is
# meant literally, and quoting it made shellcheck read an unexpanded expression (SC2016).
third_party_stateful_images() {
  local name vols
  while read -r name vols; do
    [ -z "$name" ] && continue
    case "$name" in ghcr.io/* | \$\{*) continue ;; esac
    [ "${vols:-0}" -eq 0 ] && continue
    printf '%s %s\n' "$name" "$vols"
  done <<EOF
$(compose_stateful_images "${1:-$CEILING_PROD_COMPOSE}")
EOF
}

# THE ECOSYSTEM DEPENDABOT IS UPDATING, READ OFF THE BRANCH IT PUSHED.
#
# IT EXISTS BECAUSE THE TABLE MATCHES ON A NAME AND A NAME IS NOT UNIQUE ACROSS ECOSYSTEMS. `redis`
# is a Docker image production mounts a volume for, and it is ALSO a Rust client crate
# `apps/chat-gateway` depends on. The datastore arm refused `redis 1.6.0 -> 1.7.0` (#668, measured
# 2026-09-15) and told a client-library bump to prove an on-disk upgrade path - a test that cannot be
# written for it, because a client holds no data directory. That is precisely the queue nobody drains
# this table was written to avoid.
#
# Dependabot encodes the ecosystem in the branch it pushes: `dependabot/<ecosystem>/<path>/<name>`.
# `cargo`, `docker`, `docker_compose`, `bun`, `github_actions`. It is the ecosystem's OWN statement of
# what it is updating, which is why it is read rather than guessed from the version's shape.
ceiling_ecosystem_from_ref() {
  case "${1:-}" in
    dependabot/*)
      local rest="${1#dependabot/}"
      printf '%s' "${rest%%/*}"
      ;;
    *) ;;
  esac
}

# The declared major gap between dev and production, and what each gap has been PROVEN to
# demonstrate. Overridable so the self-tests can drive the lift off fixtures rather than off the
# state of the real environment.
: "${CEILING_VERSION_GAP:=$(dirname "${BASH_SOURCE[0]}")/../../../infrastructure/dev/version-gap.yml}"

# Prints the major dev is declared to run for image "$1", IF AND ONLY IF that gap has been proven by
# an in-place upgrade of production's OWN data directory. Prints nothing in every other case.
#
# IT FAILS CLOSED, AND THE REASON IS A MEASUREMENT RATHER THAN CAUTION. The dev environment is loaded
# by `infrastructure/dev/copy-prod-to-dev.sh`, which is a LOGICAL copy - `pg_dump` replayed into a
# cluster the new major initialised itself, from empty. So "dev runs 18 and serves" is evidence about
# a SCHEMA, not about a data directory, and it cannot fail the way production failed on 2026-09-01.
# Accepting it here would have re-armed that outage behind a gate that reads as proof. Of the four
# `evidence` values in `version-gap.yml` only `in_place_upgrade` answers the question this arm asks,
# and a row claiming it without a `proof` is a claim nobody can check, so it is refused too.
dev_proven_major() {
  awk -v want="$1" '
    # A row header: a key at column zero. Comments and the indented fields below are not headers.
    /^[^[:space:]#][^:]*:[[:space:]]*$/ {
      key = $0; sub(/:[[:space:]]*$/, "", key); inrow = (key == want); next
    }
    !inrow { next }
    /^  dev_major:/ { v = $2; gsub(/"/, "", v); dev = v; next }
    /^  evidence:/  { ev = $2; next }
    /^  proof:/     { p = $0; sub(/^  proof:[[:space:]]*/, "", p); gsub(/"/, "", p); proof = p; next }
    END { if (ev == "in_place_upgrade" && proof != "" && dev != "") print dev }
  ' "$CEILING_VERSION_GAP" 2>/dev/null
}

# Prints the gate this repository lacks for "$1", or nothing at all when the check suite is already
# evidence about it. The name is matched AFTER quote-stripping by the caller.
gate_for_dependency() {
  case "$1" in
    # ---------------------------------------------------------------------------------------------
    # STATEFUL DATASTORES: THE ONE FAILURE MODE CI STRUCTURALLY CANNOT SEE
    # ---------------------------------------------------------------------------------------------
    # A library bump either compiles or it does not. A DATASTORE MAJOR is refused by the DATA THAT
    # IS ALREADY ON DISK, and every gate in this repository starts from an empty volume - `make
    # run-ci`, `boot-nest-apps` and the compose stacks all create their database from nothing, so
    # they exercise the ONE case that always works. Green here says "18 can initialise a fresh
    # cluster"; it says nothing whatsoever about the cluster production actually has.
    #
    # Measured, not inferred, on 2026-09-01: postgres 18 exits on startup with `database files are
    # incompatible with server` / `Counter to that, there appears to be PostgreSQL data in:
    # /var/lib/postgresql/data`, because 18+ images changed the mount layout to
    # major-version-specific subdirectories on top of needing `pg_upgrade`. Eight services depend on
    # `auth_db`, the only database, so the whole estate went with it.
    #
    # The gate is the same shape for all three, which is why they share an arm.
    #
    # IT REFUSES A MAJOR CROSSING AND NOTHING ELSE, and that limit is as load-bearing as the arm.
    # Refusing the whole NAME was the first draft of this repair, and it was wrong for a reason this
    # repository has already written down: `dependabot.yml` exists over the compose files precisely
    # because "a digest nothing updates is a FREEZE, not a pin - it converts silently moving into
    # silently ageing, and the second failure mode is the one nobody notices for a year". Two open
    # pull requests would have been caught by that draft (#306, #308: `redis 8.8-alpine ->
    # 8.10-alpine`) and neither can meet the failure mode - an on-disk format is stable WITHIN a
    # major, which is the entire content of the major-version contract. So the discriminator is the
    # major production is running, read from the compose file rather than assumed.
    #
    # IT FAILS CLOSED. If either major cannot be read - an unparseable tag, an image the compose file
    # does not name, an empty `dependency-version` - the update is refused. The cost of a false
    # refusal is one comment naming a test; the cost of a false pass was 33 minutes of downtime.
    postgres | redis | garage | dxflrs/garage)
      # A NAME IS A DATASTORE ONLY WHEN IT IS AN IMAGE, and this arm is about a data directory on a
      # volume. A Cargo crate called `redis` is a CLIENT: it holds nothing on disk, so the failure
      # mode below cannot reach it and the test the refusal names cannot be written for it. Refusing
      # it anyway is the queue nobody drains, and it happened - #668, measured 2026-09-15.
      #
      # AN UNKNOWN ECOSYSTEM STILL FAILS CLOSED. The argument is optional so that every existing
      # caller keeps its behaviour exactly; only a caller that KNOWS the update is not a container
      # releases the arm, which is the safe direction of this change.
      case "${3:-}" in
        '' | docker | docker_compose) ;;
        *) return 0 ;;
      esac
      __ceiling_current=$(prod_image_major "$1")
      __ceiling_proposed=$(printf '%s' "${2:-}" | sed -e 's/^v//' -e 's/[^0-9].*$//')
      if [ -n "$__ceiling_current" ] && [ -n "$__ceiling_proposed" ] &&
        [ "$__ceiling_current" = "$__ceiling_proposed" ]; then
        # Same major: the on-disk format production already has is the one this image reads.
        return 0
      fi
      # A DECLARED AND PROVEN GAP IN DEV RELEASES EXACTLY THE MAJOR IT WAS PROVEN FOR, and nothing
      # else - not the next major, and not a sibling image that happens to sit in the same arm.
      __ceiling_proven=$(dev_proven_major "$1")
      if [ -n "$__ceiling_proposed" ] && [ -n "$__ceiling_proven" ] &&
        [ "$__ceiling_proven" = "$__ceiling_proposed" ]; then
        return 0
      fi
      echo "a test that starts this image's NEW major against a data directory written by the OLD one, and proves the documented upgrade path carries it - for postgres, \`pg_upgrade\` plus the 18+ mount move from \`/var/lib/postgresql/data\` to \`/var/lib/postgresql\`. This update crosses the major production runs (\`${__ceiling_current:-unreadable}\` -> \`${__ceiling_proposed:-unreadable}\`), and every gate here initialises an EMPTY volume - so a green suite only ever proves the new major can create a fresh cluster, while the failure mode is the cluster production already HAS, which nothing in this repository looks at. Production lost all eight services this way on 2026-09-01. A patch or minor within the same major is not refused. To retire this refusal, rehearse the upgrade in dev and record it in \`infrastructure/dev/version-gap.yml\` with \`evidence: in_place_upgrade\` - note that a green dev deploy alone is NOT that evidence, because the dev copy is logical and builds its cluster from empty; see \`docs/wiki/backlog.md\`"
      ;;

    # ---------------------------------------------------------------------------------------------
    # WIRE FORMATS: A FROZEN FIXTURE CAN ONLY EVER SEE ONE DIRECTION
    # ---------------------------------------------------------------------------------------------
    # `argon2`, `chacha20poly1305` and `ciborium` WERE REFUSED HERE UNTIL 2026-08-31, and they left
    # because `tests/cross_version_state.rs` now opens artefacts those three sealed and serialised in
    # v0.14.14. The reason a backward-only test is ENOUGH for them, and not for the crates below, is
    # the same fact in both cases: an at-rest envelope is read only by the device that WROTE it, so
    # "does today's code still open yesterday's blob" is the whole question. Measured, not assumed -
    # every `encrypt_blob` call site is state persistence, in `crypto.rs` and `pin_crypto.rs`.
    #
    # `aes-gcm` USED TO HAVE ITS OWN ARM HERE and no longer does, because its gate was written:
    # `src-tauri/src/mobile/cross_version_push.rs` freezes a channel push and a Graine push, and
    # asserts BOTH directions. The forward half needed no old binary the way `openmls` does - an
    # AEAD is deterministic, so re-sealing the frozen plaintext under the frozen key and nonce must
    # reproduce the frozen bytes, and equal bytes are equal in both directions.
    # `openmls`, `openmls_*`, `tls_codec`, `tls_codec_derive`, `hpke-rs*` AND `libcrux*` WERE
    # REFUSED HERE UNTIL 2026-09-15, and the entry is gone because the test it named now exists.
    # The refusal asked for "the FORWARD half of a cross-version test [...] nothing here runs an old
    # binary against a frame minted by the new one". That is
    # `.github/scripts/mls-forward-compat.sh`, a job of `ci.yml`.
    #
    # IT RUNS THE OLD BINARY, because for this family nothing cheaper can. `aes-gcm` left this table
    # on determinism - re-sealing a frozen plaintext under a frozen key and nonce reproduces the
    # frozen bytes, and equal bytes are equal in both directions - and an MLS frame has no such
    # handle: it carries a random reuse guard, so today's code cannot reproduce a frozen ciphertext
    # and there is nothing to compare. So the old tag is checked out into a worktree and built
    # (~17 s), `frontend/mls-cross-version` is copied in and built there against the OLD library,
    # and the two binaries hold one conversation through files: the old side opens the group and
    # admits today's code by Welcome, today mints an application frame the old side must read, and
    # the old side mints one today must read. Both directions, one group, asserted inside the
    # process that decrypted rather than by a shell comparison.
    #
    # WHICH old version is not written there either - it is read from `FIXTURE_VERSION` in
    # `frontend/mls-core/tests/cross_version/params.rs`, the constant the frozen fixtures are
    # already stamped with, so the two halves of the cross-version story cannot come to disagree.
    #
    # WHAT IT DOES NOT COVER, so nobody mistakes its scope: one group, one epoch, one application
    # frame each way. A change that breaks only a removal, an external join or a PSK would pass it.
    # It is nonetheless the direction that had NO evidence at all, and the refusal it retires had
    # been standing since this table was written.

    # A REFUSAL THAT NAMES A MISSING TEST SAYS, BY OMISSION, THAT EVERYTHING ELSE PASSES. For this
    # family that stopped being true on 2026-09-15, and the second half is spelt out because a
    # reader who writes rung 15 CALL to retire this refusal would otherwise discover it afterwards.
    #
    # `webrtc` 0.20 is not a version of the library this SFU was written against. Measured locally
    # against #431 (`cargo check`, webrtc 0.20.5): 26 errors, and the imports do not even resolve -
    # the crate's root went from ~20 public modules to FIVE (`data_channel`, `media_stream`,
    # `peer_connection`, `rtp_transceiver`, `runtime`), so `webrtc::api`, `webrtc::ice`,
    # `webrtc::ice_transport`, `webrtc::interceptor`, `webrtc::rtcp` and `webrtc::track` are all
    # gone. 0.20 is a thin async layer over the Sans-I/O `rtc` crate: `PeerConnectionBuilder`
    # replaces `APIBuilder` + `MediaEngine` + `SettingEngine` + the interceptor `Registry`,
    # `PeerConnection` is a TRAIT driven by a background `PeerConnectionDriver`, the `on_*` closures
    # become a `PeerConnectionEventHandler` you implement, and the async runtime is a cargo feature.
    #
    # So the order is a PORT, then the call - and the call is still what retires this refusal,
    # because a ported SFU that compiles is the same nothing the current one is. The SFU's own P1 in
    # `docs/wiki/backlog.md` carries the detail.
    webrtc | webrtc-* | str0m | sdp | ice | turn | stun)
      echo "one relay-path call. The SFU has ten tests and not one of them touches the ICE stack; that is campaign rung 15 CALL, which has no runner yet. And for \`webrtc\` itself that call comes AFTER a port, not instead of one: 0.20 is a rewrite onto the Sans-I/O \`rtc\` crate and does not compile against this SFU (26 errors, measured 2026-09-15)"
      ;;

    # `stripe` WAS REFUSED HERE UNTIL 2026-09-15, and the entry is gone because the test it named
    # now exists. The refusal asked for "a test that pins this service's Stripe surface to FIXTURES
    # per API version - the webhook events `webhook.controller.ts` handles and the fields
    # `stripe-payment-provider.ts` and `users.service.ts` read". That is
    # `apps/core-service/src/payment/stripe-surface.ts` plus its spec, and the two halves are in
    # two files for a reason worth repeating here: the SDK's types are cut against ONE API version,
    # so a `satisfies` against them IS the compiler reading the new schema - but `ts-jest` runs
    # without diagnostics and `tsconfig.build.json` excludes the specs, so the pins only check
    # anything as SOURCE. They are source. `nest build` fails on a field or an event that left the
    # schema, in the same job that already fails when the API version literal moves, and the spec's
    # signed fixtures fail on a payload shape that changed under a branch.
    #
    # WHAT REMAINS TRUE AND IS NOT A REASON TO PUT THIS BACK: no gate here can see a change in
    # Stripe's BEHAVIOUR that keeps every shape. Stripe's own contract covers that half - since
    # `2024-09-30.acacia` the monthly releases inside a release train are additive and only the
    # version OPENING a train carries breaking changes - so crossing INTO a new train is a
    # different act, and the thing that makes it visible is the literal in `stripe-api-version.ts`
    # refusing to compile. A human still takes that decision; they no longer take it blind.

    # `@nestjs/*` WAS REFUSED HERE UNTIL 2026-08-31, and the entry is gone because the test it named
    # now exists and is green on all four services: `boot-nest-apps` builds the real `AppModule`
    # against a real Postgres, Redis and S3 endpoint. That is what a refusal is for - it names a
    # missing gate, and it leaves when the gate arrives. It released 22 of the 28 refusals measured
    # that morning.
    #
    # BARE `typeorm` WAS REFUSED HERE UNTIL 2026-08-31 TOO, and it left the same way. The boot job
    # proved the schema BUILDS and stopped there; every unit suite mocks its repositories, so a major
    # changing how a query is BUILT would have passed all 1105 of them and failed on the first
    # request in production. `app-module.boot-spec.ts` now issues a real `find` through EVERY entity
    # the app registered - every one, not a named list, because a gate that picks its subject by name
    # does not cover the entity nobody added to it. Green on core, social and chat-delivery in CD run
    # 33403833044; media-service carries a tripwire asserting it still has no ORM at all.
    *) ;;
  esac
}
