#!/usr/bin/env bash
#
# THE CEILING'S NAME TABLE: given a dependency name, the gate this repository is MISSING for it.
#
# It lived inline in `dependabot-auto-merge.sh` until 2026-09-01, and the reason it moved is the
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
# Usage: gate_for_dependency <name> [proposed-version]
#          -> prints the missing gate, or nothing when the suite is evidence about this dependency.
#             Always exits 0. The version is consulted ONLY by the datastore arm; see below.

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
      __ceiling_current=$(prod_image_major "$1")
      __ceiling_proposed=$(printf '%s' "${2:-}" | sed -e 's/^v//' -e 's/[^0-9].*$//')
      if [ -n "$__ceiling_current" ] && [ -n "$__ceiling_proposed" ] &&
        [ "$__ceiling_current" = "$__ceiling_proposed" ]; then
        # Same major: the on-disk format production already has is the one this image reads.
        return 0
      fi
      echo "a test that starts this image's NEW major against a data directory written by the OLD one, and proves the documented upgrade path carries it - for postgres, \`pg_upgrade\` plus the 18+ mount move from \`/var/lib/postgresql/data\` to \`/var/lib/postgresql\`. This update crosses the major production runs (\`${__ceiling_current:-unreadable}\` -> \`${__ceiling_proposed:-unreadable}\`), and every gate here initialises an EMPTY volume - so a green suite only ever proves the new major can create a fresh cluster, while the failure mode is the cluster production already HAS, which nothing in this repository looks at. Production lost all eight services this way on 2026-09-01. A patch or minor within the same major is not refused; see \`docs/wiki/backlog.md\`"
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
    openmls | openmls_* | tls_codec | tls_codec_derive | hpke-rs* | libcrux*)
      # A WIRE FORMAT IS READ BY OTHER DEVICES, ON OTHER VERSIONS, so both directions matter and a
      # frozen fixture can only ever see one of them. `cross_version_state.rs` proves today's code
      # opens a group and a frame minted by v0.14.14; nothing here proves a frame minted TODAY is
      # readable by the v0.14.14 clients still in the fleet, and only an old binary could.
      echo "the FORWARD half of a cross-version test. \`tests/cross_version_state.rs\` now covers the backward half - today opening what v0.14.14 wrote - but a wire format is read by OTHER devices on OTHER versions, and nothing here runs an old binary against a frame minted by the new one"
      ;;

    webrtc | webrtc-* | str0m | sdp | ice | turn | stun)
      echo "one relay-path call. The SFU has ten tests and not one of them touches the ICE stack; that is campaign rung 15 CALL, which has no runner yet"
      ;;

    stripe)
      # THE COMPILER ALREADY DOES HALF OF THIS, AND THE HALF IT DOES IS THE SAFE HALF. The SDK types
      # `apiVersion` as the string LITERAL its release was cut against, and this service pins that
      # value in one exported constant (`src/payment/stripe-api-version.ts`). So an SDK bump that
      # still compiles cannot change which API the app talks to - the constant governs - and it
      # merges on its own like anything else. An SDK bump that CROSSES an API version stops the
      # tree compiling, in four files at once, which is exactly the coupling being made visible.
      #
      # What no gate here can answer is the other half: whether the app still reads what the new API
      # sends. An API version decides webhook payload shapes and object fields, so crossing one is a
      # decision about PAYMENTS, and today the only evidence is Stripe's changelog and somebody
      # reading it. That is not a semver judgement this script can make.
      echo "a test that pins this service's Stripe surface to FIXTURES per API version - the webhook events \`webhook.controller.ts\` handles and the fields \`stripe-payment-provider.ts\` and \`users.service.ts\` read - so that crossing an API version is PROVED rather than read in a changelog. The SDK's literal type already refuses a silent crossing: if this update stopped the tree compiling, \`STRIPE_API_VERSION\` and \`stripe\` have to move together, deliberately"
      ;;

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
