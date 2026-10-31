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

# THE IDENTITY PROVIDER'S STACK IS A SECOND COMPOSE FILE WITH ITS OWN DATABASE, ON ITS OWN MAJOR.
# `infrastructure/authentik/compose.yml` runs a PostgreSQL that is NOT production's: on 2026-10-23
# it was 16 where production ran 18. Compared against production's file, `16-alpine -> 18-alpine`
# there reads "same major as production" and passes - the 2026-09-01 outage, moved onto the one
# database that holds every account's sign-in. So an update to THAT file is compared with THAT
# file, read off the branch Dependabot pushed (`ceiling_compose_from_ref`).
: "${CEILING_AUTHENTIK_COMPOSE:=$(dirname "${BASH_SOURCE[0]}")/../../../infrastructure/authentik/compose.yml}"

# EVERY COMPOSE FILE THAT RUNS A THIRD-PARTY IMAGE, space-separated: the population an image's
# statefulness is read from (`ceiling_image_may_cross_major`). Overridable for the self-tests. A file
# named here and absent from the tree makes every image's statefulness UNKNOWN, which is refused.
: "${CEILING_WATCHED_COMPOSES:=$CEILING_PROD_COMPOSE $(dirname "${BASH_SOURCE[0]}")/../../../infrastructure/docker-compose.dev.yml $(dirname "${BASH_SOURCE[0]}")/../../../infrastructure/local/docker-compose.yml $CEILING_AUTHENTIK_COMPOSE}"

# An image reference reduced to the name Dependabot and production both mean. The identity
# provider's file spells `docker.io/library/postgres`, production's `postgres`; a table matched on
# one spelling walks past the other, so both sides of every comparison go through this.
ceiling_image_name() { # <image name>
  local n="${1:-}"
  n="${n#docker.io/}"
  n="${n#library/}"
  printf '%s' "$n"
}

# Prints the MAJOR of the tag a compose file pins for image "$1", or nothing if it names no such
# image. The file is "$2", production's by default. `v2.3.0` and `15-alpine` both reduce to their
# leading integer; a digest suffix is discarded; `docker.io/library/` is not part of the name.
prod_image_major() {
  awk -v want="$(ceiling_image_name "$1")" '
    $1 == "image:" {
      ref = $2
      name = ref; sub(/:.*$/, "", name); sub(/^docker\.io\//, "", name); sub(/^library\//, "", name)
      if (name != want) next
      tag = ref; sub(/^[^:]*:/, "", tag); sub(/@.*$/, "", tag); sub(/^v/, "", tag)
      if (match(tag, /^[0-9]+/)) { print substr(tag, 1, RLENGTH); exit }
    }
  ' "${2:-$CEILING_PROD_COMPOSE}" 2>/dev/null
}

# THE COMPOSE FILE AN UPDATE IS IN, read off the branch Dependabot pushed:
# `dependabot/docker_compose/<directory>/<dependency>-<version>`. Only the identity provider's
# directory names a file of its own; everything else - production's compose, the local one, a
# Dockerfile, an unknown branch - is compared with production, which is what this table did before
# a second stateful file was watched.
ceiling_compose_from_ref() { # <head ref>
  case "${1:-}" in
    dependabot/docker_compose/infrastructure/authentik/*) printf '%s' "$CEILING_AUTHENTIK_COMPOSE" ;;
    *) printf '%s' "$CEILING_PROD_COMPOSE" ;;
  esac
}

# A TREE NO PULL-REQUEST JOB BUILDS, named by the branch an update arrives on. Prints the missing
# gate, or nothing. It is about the DIRECTORY, not the dependency, which is why it is apart from
# `gate_for_dependency`: every name a Gradle update to a tree no job builds carries is equally unseen.
#
# TWO DIRECTORIES ARE LET THROUGH, and each because a pull-request job builds it - an ALLOWLIST, so a
# Gradle directory added to `dependabot.yml` later is refused until somebody shows a gate builds it:
#   - `frontend/src-tauri/android-tests`, a plain JVM project `test-android` builds and runs.
#   - `frontend/src-tauri/gen/android`, the Android app. Until 2026-10-30 nothing on a pull request
#     configured its `:app` module (it needs the generated, git-ignored `tauri.settings.gradle` and
#     a `google-services.json`), so four bumps - the wrapper, AndroidX, Firebase - sat refused.
#     `compile-android-app` in `ci.yml` now generates the first the way `tauri android build` does
#     and uses a committed stub for the second, then compiles `:app`
#     (`.github/scripts/android-app-compile.sh`). `ceiling.test.sh` asserts that job, its trigger and its
#     wiring into `ci-passed` still exist, so a pull request that removes or disables the gate
#     FAILS `test-ci-scripts` instead of silently leaving an allowance with nothing behind it.
ceiling_gate_for_ref() { # <head ref>
  local missing
  missing="a pull-request job that compiles the Gradle tree this update is in. Only \`frontend/src-tauri/android-tests\` (\`test-android\`) and \`frontend/src-tauri/gen/android\` (\`compile-android-app\`) are built on a pull request; a Gradle directory added to dependabot.yml needs its own job, then an arm in \`ceiling_gate_for_ref\` - see docs/wiki/cicd.md, 'Native and identity-provider manifests'"
  case "${1:-}" in
    # DEPENDABOT'S DIRECT SHAPE ONLY: `gen/android/<dependency>-<version>`. A branch one directory
    # deeper is not a shape Dependabot writes for this block, so it is not the update this job was
    # written to judge, and it is refused rather than trusted by prefix.
    dependabot/gradle/frontend/src-tauri/gen/android/*/*) echo "$missing" ;;
    dependabot/gradle/frontend/src-tauri/android-tests/*) ;;
    dependabot/gradle/frontend/src-tauri/gen/android/*) ;;
    dependabot/gradle/*) echo "$missing" ;;
    *) ;;
  esac
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

# MAY A CONTAINER IMAGE MOVE ACROSS A MAJOR WITH NO PERSON IN THE LOOP? Exit 0 only when it is
# PROVEN stateless; every other answer, unknown included, is no.
#
# AN ALLOWLIST, NOT A DENYLIST OF DATASTORE NAMES (2026-10-31). The arm in `gate_for_dependency`
# matched `postgres | redis | garage` by name, and `ceiling.test.sh` kept that list honest only for
# the two compose files it read. A stateful image added to the dev or local stack, or a new
# datastore under a name nobody typed, crossed a major as a "stateless" image. So the question is
# turned round: an image may cross a major only when it is not a known datastore AND every watched
# compose file (`CEILING_WATCHED_COMPOSES`) could be read AND none of them gives it a named volume.
# A Dockerfile base (`node`, `rust`) is in no compose file and holds no data directory, so it passes;
# `adminer`, `nginx` and `coturn` mount no named volume and pass. A missing file fails closed.
ceiling_image_may_cross_major() { # <image name>
  local want f name vols
  want="$(ceiling_image_name "${1:-}")"
  want="${want%@sha256*}"
  case "$want" in
    '' | postgres | redis | garage | dxflrs/garage) return 1 ;;
  esac
  for f in $CEILING_WATCHED_COMPOSES; do
    [ -r "$f" ] || return 1
    while read -r name vols; do
      [ -z "$name" ] && continue
      name="$(ceiling_image_name "${name%@sha256*}")"
      if [ "$name" = "$want" ] && [ "${vols:-0}" -gt 0 ]; then
        return 1
      fi
    done <<EOF
$(compose_stateful_images "$f")
EOF
  done
  return 0
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
    # The lockfile refresh (`cargo-lock-refresh.sh`) names its branch `deps/lock-refresh/<ecosystem>/...`
    # and carries Dependabot's commits, so its ecosystem is as known as Dependabot's own.
    deps/lock-refresh/*)
      local rest="${1#deps/lock-refresh/}"
      printf '%s' "${rest%%/*}"
      ;;
    *) ;;
  esac
}

# THE `updated-dependencies` BLOCKS OF DEPENDABOT'S COMMIT MESSAGES, ONE `name|update-type|version`
# PER DEPENDENCY, read from stdin.
#
# ONE PARSER FOR TWO READERS: `dependency-ceiling.sh` (the CI check) and `cargo-lock-refresh.sh` (the
# scheduled completion of a cargo bump) must agree on what an update IS, or the second could move a
# crate the first never judged. Parsed AS BLOCKS, never as three independent lists: a grouped pull
# request carries several, and an update Dependabot could not classify has no `update-type`, so
# three lists pasted side by side would pair the wrong name with the wrong version
# ([cicd](../../../docs/wiki/cicd.md#two-traps-in-reading-dependabots-own-commit-trailers)).
#
# DEPENDABOT YAML-QUOTES A NAME STARTING WITH `@`, so the quotes are stripped here, once - a `case`
# on `@nestjs/*` against `"@nestjs/common"` matches nothing, which is how a first draft of the
# ceiling merged the major it was written to refuse. The update type is reduced to `major`, `minor`
# or `patch`, and is EMPTY when Dependabot wrote none (a requirement update, a Docker tag).
ceiling_parse_updates() {
  awk '
    function flush() {
      if (name == "") return
      gsub(/^"|"$/, "", name)
      print name "|" type "|" version
    }
    /^ *- dependency-name:/ {
      flush()
      name = $0; sub(/^ *- dependency-name: */, "", name); type = ""; version = ""
      next
    }
    /^ *dependency-version:/ { version = $0; sub(/^ *dependency-version: */, "", version) }
    /^ *update-type:/ { type = $0; sub(/^ *update-type: *version-update:semver-/, "", type) }
    END { flush() }
  '
}

# Does an update BREAK compatibility, as cargo and npm read a version? Exit 0 when it does.
#
# `update-type` names the semver FIELD that moved, and below 1.0 that is not compatibility: `^0.17`
# does not match `0.20`, so a "minor" `0.x` bump is a major in all but name - #431, `webrtc 0.17.2 ->
# 0.20.5`, moved every module of the facade crate. `0.0.x` gives even the patch field that meaning.
# AN ABSENT OR UNKNOWN TYPE IS BREAKING: Dependabot writes none for "update the requirement to permit
# the latest version" (#297, openmls 0.9.0), and unknown must be read as the worst case.
#
# THE CEILING ITSELF DOES NOT REFUSE ON THIS - a major that breaks the tree stops it compiling, and
# the suite sees that. It is the UNATTENDED SECOND ACTOR, `cargo-lock-refresh.sh`, that refuses a
# breaking update, because it writes lockfiles on a bump no person asked for; see that script. And
# `dependency-ceiling.sh` refuses it again on a `deps/lock-refresh/` branch, so the refusal binds
# the pull request that gets ARMED, not only the job that opened it.
ceiling_update_is_breaking() { # <update-type> <proposed-version>
  case "${1:-}" in
    patch) case "${2:-}" in 0.0.*) return 0 ;; esac ;;
    minor) case "${2:-}" in 0.*) return 0 ;; esac ;;
    *) return 0 ;;
  esac
  return 1
}

# Is this crate part of the Tauri RUNTIME? Exit 0 when it is. A runtime bump changes what runs on a
# phone, which no gate here exercises; it is a native work package owed a device reading, so the
# UNATTENDED lockfile refresh never carries one - refused by `cargo-lock-refresh.sh` before it opens
# anything, and again by `dependency-ceiling.sh` on a `deps/lock-refresh/` branch.
ceiling_is_tauri_runtime_crate() { # <crate name>
  case "${1:-}" in tauri | tauri-* | wry | tao) return 0 ;; esac
  return 1
}

# The declared major gap between dev and production, and what each gap has been PROVEN to
# demonstrate. Overridable so the self-tests can drive the lift off fixtures rather than off the
# state of the real environment.
: "${CEILING_VERSION_GAP:=$(dirname "${BASH_SOURCE[0]}")/../../../infrastructure/dev/version-gap.yml}"

# Prints the major dev is declared to run for image "$1", IF AND ONLY IF that gap has been proven by
# an in-place upgrade of production's OWN data directory. Prints nothing in every other case.
#
# IT FAILS CLOSED, AND THE REASON IS A MEASUREMENT RATHER THAN CAUTION. The dev environment holds a
# fictional seed loaded by SQL (`infrastructure/dev/reset-dev-to-seed.sh`; until 2026-10-16 it held a
# `pg_dump` of production, which was no better) - rows replayed into a cluster the new major
# initialised itself, from empty. So "dev runs 18 and serves" is evidence about a SCHEMA, not about a
# data directory, and it cannot fail the way production failed on 2026-09-01.
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
# evidence about it. The name is matched AFTER quote-stripping by the caller, and with
# `docker.io/library/` removed (`ceiling_image_name`). "$4" is the compose file the update is in
# (`ceiling_compose_from_ref`), production's when absent.
gate_for_dependency() {
  local __ceiling_compose="${4:-$CEILING_PROD_COMPOSE}"
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
  # The gate is the same shape for every image that holds data, which is why they share one arm.
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
  #
  # WHICH IMAGES IT APPLIES TO IS AN ALLOWLIST (2026-10-31): every container image EXCEPT those
  # `ceiling_image_may_cross_major` proves stateless - a named datastore, an image any watched
  # compose file gives a named volume, and any image at all while a watched file is unreadable.
  case "${3:-}" in
    '' | docker | docker_compose)
      if ! ceiling_image_may_cross_major "$1"; then
        # A NAME IS A DATASTORE ONLY WHEN IT IS AN IMAGE, and this arm is about a data directory on a
        # volume. A Cargo crate called `redis` is a CLIENT: it holds nothing on disk, so the failure
        # mode below cannot reach it and the test the refusal names cannot be written for it. Refusing
        # it anyway is the queue nobody drains, and it happened - #668, measured 2026-09-15.
        #
        # AN UNKNOWN ECOSYSTEM STILL FAILS CLOSED. The argument is optional so that every existing
        # caller keeps its behaviour exactly; only a caller that KNOWS the update is not a container
        # releases the arm, which is the safe direction of this change.
        __ceiling_current=$(prod_image_major "$1" "$__ceiling_compose")
        __ceiling_proposed=$(printf '%s' "${2:-}" | sed -e 's/^v//' -e 's/[^0-9].*$//')
        if [ -n "$__ceiling_current" ] && [ -n "$__ceiling_proposed" ] &&
          [ "$__ceiling_current" = "$__ceiling_proposed" ]; then
          # Same major: the on-disk format the stack already has is the one this image reads.
          return 0
        fi
        # A DECLARED AND PROVEN GAP IN DEV RELEASES EXACTLY THE MAJOR IT WAS PROVEN FOR, and nothing
        # else - not the next major, not a sibling image that happens to sit in the same arm, and not
        # another stack's database: `version-gap.yml` records rehearsals of PRODUCTION's data
        # directory, so it says nothing about the identity provider's.
        __ceiling_proven=''
        if [ "$__ceiling_compose" = "$CEILING_PROD_COMPOSE" ]; then
          __ceiling_proven=$(dev_proven_major "$(ceiling_image_name "$1")")
        fi
        if [ -n "$__ceiling_proposed" ] && [ -n "$__ceiling_proven" ] &&
          [ "$__ceiling_proven" = "$__ceiling_proposed" ]; then
          return 0
        fi
        echo "a migration plan, because a MAJOR bump of an image that holds data cannot be judged by any gate here: a test that starts this image's NEW major against a data directory written by the OLD one, and proves the documented upgrade path carries it - for postgres, \`pg_upgrade\` plus the 18+ mount move from \`/var/lib/postgresql/data\` to \`/var/lib/postgresql\`. This update crosses the major \`${__ceiling_compose##*/infrastructure/}\` runs (\`${__ceiling_current:-unreadable}\` -> \`${__ceiling_proposed:-unreadable}\`), and every gate here initialises an EMPTY volume - so a green suite only ever proves the new major can create a fresh cluster, while the failure mode is the cluster production already HAS, which nothing in this repository looks at. Production lost all eight services this way on 2026-09-01. A patch or minor within the same major is not refused. To retire this refusal, rehearse the upgrade in dev and record it in \`infrastructure/dev/version-gap.yml\` with \`evidence: in_place_upgrade\` - note that a green dev deploy alone is NOT that evidence, because the dev copy is logical and builds its cluster from empty; see \`docs/wiki/backlog.md\`"
        return 0
      fi
      ;;
  esac
  case "$(ceiling_image_name "$1")" in
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

    # `webrtc*`, `str0m`, `sdp`, `ice`, `turn` AND `stun` WERE REFUSED HERE UNTIL 2026-10-09, and the
    # entry is gone because the test it named now exists: `apps/call-service/tests/relay_path.rs`
    # gathers a RELAY candidate on an in-process TURN server and carries a data-channel message and
    # an SRTP packet across two relay-only peers, built the way the SFU builds them. It is a job of
    # `ci.yml`'s Rust matrix (`cargo test` in `apps/call-service`). The `webrtc` 0.20 major is NOT
    # refused by name any more because it does not need to be: it does not compile against this
    # SFU (26 errors, measured 2026-09-15), which is what the suite sees on its own, and the port
    # that makes it compile meets this test the day it is written.
    #
    # WHAT IT DOES NOT COVER: the SFU's forwarding logic (`main.rs` is a binary), a browser peer,
    # or a TURN provider other than the library's own.

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
