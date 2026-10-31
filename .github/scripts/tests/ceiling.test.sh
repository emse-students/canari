#!/usr/bin/env bash
#
# Self-tests for `lib/ceiling.sh`, the table that decides which Dependabot updates this repository
# has a gate for.
#
# IT EXISTS BECAUSE THE TABLE'S FAILURE MODE IS AN ABSENCE, AND AN ABSENCE IS INVISIBLE. On
# 2026-09-01 `postgres 15-alpine -> 18-alpine` auto-merged on a fully green suite and PostgreSQL 18
# refused to start on production's data directory; every backend service went down with `auth_db`,
# the only database. Nothing was broken - `postgres` had simply never been written into the table,
# and no test asked what the table covered.
#
# SO THE CENTRAL TEST BELOW DOES NOT HARDCODE A LIST OF NAMES. It reads the images out of
# `docker-compose.prod.yml` and requires an entry for every one that mounts a NAMED VOLUME. A gate
# that picks its subject by name does not cover the service nobody added to it - the same reasoning
# `app-module.boot-spec.ts` uses to walk every registered entity rather than a named few - so the
# next stateful service is covered on the day it is declared, by whoever declares it.
#
# Usage: .github/scripts/tests/ceiling.test.sh   (no arguments, no network, no dependencies)
set -uo pipefail

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/ceiling.sh
. "$(dirname "$0")/../lib/ceiling.sh"

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
compose="$repo_root/infrastructure/docker-compose.prod.yml"

failures=0

# THE SWEEP CHECKS OUT `.github/scripts` SPARSELY, so this file is one of two things that puts the
# compose file in the tree - the other being the `sparse-checkout` list in
# `ci.yml` (the `dependency-ceiling` job). Said here, by name, because the two have to
# move together and the
# failure otherwise reads as "the parse is broken" rather than "the file is not there".
if [ ! -f "$compose" ]; then
  echo "FAIL $compose is not in the tree, so the coverage assertion below cannot run."
  echo "     Add it to the sparse-checkout list in .github/workflows/ci.yml."
  exit 1
fi

# THE ESCAPE HATCH MUST BE READABLE, AND IN CI IT WAS NOT. The datastore refusal ends by naming
# `infrastructure/dev/version-gap.yml` as the way to retire itself - `dev_proven_major` reads it, and
# an `evidence: in_place_upgrade` row there is what lifts the refusal. That file was outside the
# `dependency-ceiling` job's `sparse-checkout`, so in CI `dev_proven_major` read an absent file and
# answered empty: recording the rehearsal would have retired nothing, and #309 would have stayed
# refused with no way left to say so. A refusal whose own documented remedy cannot be seen is the
# queue nobody drains. Asserted here, beside the compose file, because the two move together.
if [ ! -f "$CEILING_VERSION_GAP" ]; then
  echo "FAIL $CEILING_VERSION_GAP is not in the tree, so the refusal below cannot read its own"
  echo "     escape hatch and no rehearsal could ever retire it."
  echo "     Add infrastructure/dev/version-gap.yml to the sparse-checkout list in .github/workflows/ci.yml."
  exit 1
fi

# A dependency this repository must NOT merge unattended: the table has to name a gate for it.
expect_refused() {
  local name="$1" version="$2" why="$3" ecosystem="${4:-}" file="${5:-}" gate
  gate=$(gate_for_dependency "$name" "$version" "$ecosystem" "$file")
  if [ -n "$gate" ]; then
    echo "  ok   $name ${version:-(no version)} is refused"
  else
    echo "  FAIL $name ${version:-(no version)} is NOT refused, and it must be: $why"
    failures=$((failures + 1))
  fi
}

# A dependency the check suite IS evidence about. Asserted so the table cannot quietly widen into a
# blanket refusal, which would rebuild the queue nobody drains.
expect_allowed() {
  local name="$1" version="$2" ecosystem="${3:-}" file="${4:-}" gate
  gate=$(gate_for_dependency "$name" "$version" "$ecosystem" "$file")
  if [ -z "$gate" ]; then
    echo "  ok   $name ${version:-(no version)} is allowed"
  else
    echo "  FAIL $name ${version:-(no version)} is refused, but the suite is supposed to be evidence about it"
    echo "       gate: $gate"
    failures=$((failures + 1))
  fi
}

# -------------------------------------------------------------------------------------------------
# THE TEST THE OUTAGE ASKED FOR: every stateful image in production is in the table
# -------------------------------------------------------------------------------------------------
# The parse itself is `third_party_stateful_images` in `lib/ceiling.sh`, shared with
# `dev-gap.test.sh`; see the reasoning there.
echo "a MAJOR crossing is refused for every stateful third-party image production runs:"

seen=0
while read -r name vols; do
  [ -z "$name" ] && continue
  seen=$((seen + 1))

  # The crossing is CONSTRUCTED from what production runs rather than hardcoded, so this assertion
  # keeps meaning the same thing after the pins move - including after the postgres 18 migration,
  # when it will start demanding that 19 be refused without anybody editing this file.
  current=$(prod_image_major "$name")
  if [ -z "$current" ]; then
    echo "  FAIL could not read the major production pins for $name; the comparison cannot be made"
    failures=$((failures + 1))
    continue
  fi
  expect_refused "$name" "$((current + 1))" \
    "it mounts $vols named volume(s) in production, and every gate here starts from an empty one"
  # And the same-major direction, on the pin itself: a patch must keep flowing, or the digest pin
  # becomes the freeze `dependabot.yml` was written to prevent.
  expect_allowed "$name" "$current"
done <<< "$(third_party_stateful_images "$compose")"

# A parse that silently matched nothing would make the loop above vacuously green - the exact shape
# of failure this file exists to prevent. Production runs three stateful third-party images.
if [ "$seen" -lt 3 ]; then
  echo "  FAIL only $seen stateful image(s) were read out of $compose; the parse is broken, not the table"
  failures=$((failures + 1))
else
  echo "  ok   read $seen stateful image(s) from the compose file"
fi

# -------------------------------------------------------------------------------------------------
# The named entries, each asserted on the reason it is there
# -------------------------------------------------------------------------------------------------
echo "the datastore arm reads a version, and fails CLOSED when it cannot:"
# THE INCIDENT, PINNED TO ITS SHAPE RATHER THAN TO ITS NUMBER. On 2026-09-01 the trailer read
# `postgres||18-alpine` while production ran 15 - note the EMPTY update-type, which is why this arm
# cannot be a semver rule. Production crossed to 18 on 2026-09-18, and a fixture still spelling `18`
# would from that day have asserted that production's OWN major must be refused. So the crossing is
# CONSTRUCTED from the compose file, exactly as the derived loop above already does: what is pinned
# is the SHAPE the incident arrived in - an alpine tag, no update-type, a major production does not
# run - and that shape survives every crossing without this file being edited on the day of one.
pg_major=$(prod_image_major postgres)
expect_refused postgres "$((pg_major + 1))-alpine" "a major crossing arrives exactly as the 2026-09-01 trailer did, with no update-type"
expect_allowed postgres "${pg_major}.19-alpine"   # a patch within the running major
# DOWN IS THE SAME HAZARD AS UP, and this assertion only became expressible on 2026-09-18: before the
# crossing there was no major below the one production ran. An older server does not read a newer
# cluster either, so a rollback by image tag alone is refused here rather than at startup.
expect_refused postgres "$((pg_major - 1))-alpine" "an older major cannot read the cluster the running one wrote"
expect_allowed redis "8.10-alpine"       # #306 and #308: a minor, and the on-disk format is stable
expect_refused redis "9-alpine" "a redis major may rewrite the on-disk format of the message log"
expect_allowed "dxflrs/garage" "v2.4.0"  # garage is tagged with a leading v
expect_refused "dxflrs/garage" "v3.0.0" "garage holds the media store, and a major may move it"
# FAILING CLOSED IS THE POINT: a version nothing can parse must not read as "same major".
expect_refused postgres "" "an absent version cannot be compared, so it must not pass"
expect_refused postgres "latest" "an unparseable tag cannot be compared, so it must not pass"

# A NAME IS NOT UNIQUE ACROSS ECOSYSTEMS, and the datastore arm is about a data directory. `redis`
# is both an image production mounts a volume for and a Rust CLIENT crate `apps/chat-gateway`
# depends on; the arm refused the crate (#668, measured 2026-09-15) and told a client library to
# prove an on-disk upgrade path, which cannot be written for something that holds no disk.
echo "the datastore arm is about an IMAGE, not about a name:"
expect_allowed redis "1.7.0" cargo           # the client crate: it holds no data directory
expect_allowed redis "9.0.0" cargo           # and a crate major is still the suite's business
expect_refused redis "9-alpine" "the image still crosses a major that may rewrite the on-disk log" docker_compose
expect_refused postgres "$((pg_major + 1))-alpine" "a major crossing arrives as a compose image, which is how the 2026-09-01 one did" docker_compose
# FAILING CLOSED ON AN UNKNOWN ECOSYSTEM is what makes the argument safe to add: a caller that does
# not know still gets today's behaviour, so only a caller that KNOWS can release the arm.
expect_refused postgres "$((pg_major + 1))-alpine" "an absent ecosystem must not be read as permission" ""

echo "the branch Dependabot pushed states its own ecosystem:"
for ref_case in   "dependabot/cargo/apps/chat-gateway/redis-1.7.0|cargo"   "dependabot/docker_compose/infrastructure/postgres-18-alpine|docker_compose"   "dependabot/github_actions/actions/checkout-7|github_actions"   "deps/lock-refresh/cargo/dependabot-12|cargo"   "fix/a-human-branch|"; do
  ref="${ref_case%%|*}"; want="${ref_case##*|}"
  got=$(ceiling_ecosystem_from_ref "$ref")
  if [ "$got" = "$want" ]; then
    echo "  ok   $ref -> '${got}'"
  else
    echo "  FAIL $ref read as '${got}', expected '${want}'"
    failures=$((failures + 1))
  fi
done

# -------------------------------------------------------------------------------------------------
# THE IDENTITY PROVIDER'S STACK: A SECOND STATEFUL COMPOSE FILE, ON ITS OWN MAJOR (2026-10-23)
# -------------------------------------------------------------------------------------------------
# Dependabot watches `infrastructure/authentik/compose.yml` since 2026-10-23. Its PostgreSQL is not
# production's and does not run production's major, so judging an update there against production's
# file would pass `16 -> 18` as "same major" - the 2026-09-01 outage, on the database holding every
# sign-in. The same derivation as above, read from THAT file: every stateful third-party image in
# it is refused across its own major and allowed within it.
authentik_compose="$repo_root/infrastructure/authentik/compose.yml"
if [ ! -f "$authentik_compose" ]; then
  echo "FAIL $authentik_compose is not in the tree, so the identity provider's datastore cannot be judged."
  echo "     Add it to the sparse-checkout list in .github/workflows/ci.yml."
  exit 1
fi
echo "a MAJOR crossing is refused for every stateful image the identity provider's stack runs:"
auth_seen=0
while read -r name vols; do
  [ -z "$name" ] && continue
  auth_seen=$((auth_seen + 1))
  current=$(prod_image_major "$name" "$authentik_compose")
  if [ -z "$current" ]; then
    echo "  FAIL could not read the major the identity provider pins for $name"
    failures=$((failures + 1))
    continue
  fi
  expect_refused "$name" "$((current + 1))-alpine" "it mounts $vols named volume(s) in the identity provider's stack" docker_compose "$authentik_compose"
  expect_allowed "$name" "${current}.9-alpine" docker_compose "$authentik_compose"
  # THE SHAPE THIS SECTION EXISTS FOR: the major PRODUCTION runs, proposed for the identity
  # provider's file. Only expressible while the two differ, which they did on the day it was written.
  prod_current=$(prod_image_major "$name")
  if [ -n "$prod_current" ] && [ "$prod_current" != "$current" ]; then
    expect_refused "$name" "${prod_current}-alpine" "production's major is not the one this stack's data directory was written by" docker_compose "$authentik_compose"
  fi
done <<< "$(third_party_stateful_images "$authentik_compose")"
if [ "$auth_seen" -lt 1 ]; then
  echo "  FAIL no stateful image was read out of $authentik_compose; the parse is broken, not the table"
  failures=$((failures + 1))
fi

echo "an image name means the same with or without docker.io/library/:"
pg_now=$(prod_image_major postgres)
expect_refused "docker.io/library/postgres" "$((pg_now + 1))-alpine" "the long spelling of a datastore is still that datastore" docker_compose
expect_refused "library/postgres" "$((pg_now + 1))-alpine" "Dependabot may report the name without its registry" docker_compose
expect_allowed "docker.io/library/postgres" "${pg_now}-alpine" docker_compose

echo "a recorded dev rehearsal lifts production's refusal and nobody else's:"
gap_work=$(mktemp -d)
printf 'services:\n  postgres:\n    image: postgres:15-alpine\n    volumes:\n      - pg:/var/lib/postgresql/data\n' > "$gap_work/prod.yml"
printf 'services:\n  postgresql:\n    image: docker.io/library/postgres:15-alpine\n    volumes:\n      - database:/var/lib/postgresql/data\n' > "$gap_work/authentik.yml"
printf 'postgres:\n  dev_major: "16"\n  evidence: in_place_upgrade\n  proof: "a fixture"\n' > "$gap_work/gap.yml"
gap_prod=$(CEILING_PROD_COMPOSE="$gap_work/prod.yml" CEILING_VERSION_GAP="$gap_work/gap.yml" gate_for_dependency postgres 16-alpine docker_compose "$gap_work/prod.yml")
gap_auth=$(CEILING_PROD_COMPOSE="$gap_work/prod.yml" CEILING_VERSION_GAP="$gap_work/gap.yml" gate_for_dependency postgres 16-alpine docker_compose "$gap_work/authentik.yml")
rm -rf "$gap_work"
if [ -z "$gap_prod" ] && [ -n "$gap_auth" ]; then
  echo "  ok   the rehearsal lifts production's 15 -> 16 and leaves the identity provider's refused"
else
  echo "  FAIL production lifted: '$([ -z "$gap_prod" ] && echo yes || echo no)', identity provider refused: '$([ -n "$gap_auth" ] && echo yes || echo no)'"
  failures=$((failures + 1))
fi

echo "the branch names the compose file an update is in:"
for c_case in "dependabot/docker_compose/infrastructure/authentik/postgres-18-alpine|$CEILING_AUTHENTIK_COMPOSE" \
  "dependabot/docker_compose/infrastructure/postgres-18-alpine|$CEILING_PROD_COMPOSE" \
  "dependabot/docker_compose/infrastructure/local/postgres-18-alpine|$CEILING_PROD_COMPOSE" \
  "dependabot/docker/infrastructure/local/node-26-alpine|$CEILING_PROD_COMPOSE" \
  "|$CEILING_PROD_COMPOSE"; do
  ref="${c_case%%|*}"; want="${c_case##*|}"
  got=$(ceiling_compose_from_ref "$ref")
  if [ "$got" = "$want" ]; then
    echo "  ok   '${ref}' -> ${got##*/infrastructure/}"
  else
    echo "  FAIL '${ref}' read as '${got}', expected '${want}'"
    failures=$((failures + 1))
  fi
done

# A TREE NO PULL-REQUEST JOB BUILDS refuses whatever it carries. The JVM test project is built by
# `test-android` and the Android app module by `compile-android-app` (2026-10-30); those are the two
# Gradle directories let through - an allowlist, so a Gradle directory added later starts refused.
echo "a Gradle update is refused unless a pull-request job builds its tree:"
for t_case in "dependabot/gradle/frontend/src-tauri/gen/android/com.google.firebase-firebase-messaging-ktx-25.0.0|allowed" \
  "dependabot/gradle/frontend/src-tauri/gen/android/gradle-wrapper-9.7.1|allowed" \
  "dependabot/gradle/frontend/src-tauri/gen/android-extra/junit-junit-4.13.3|refused"   "dependabot/gradle/frontend/src-tauri/gen/android/sub/directory/junit-junit-4.13.3|refused"   "dependabot/gradle/frontend/src-tauri/gen/android/production-dependencies-25cde2b0f9|allowed" \
  "dependabot/gradle/some/new/directory/junit-junit-4.13.3|refused" \
  "dependabot/gradle/frontend/src-tauri/android-tests/junit-junit-4.13.3|allowed" \
  "dependabot/cargo/apps/chat-gateway/serde-1.0.5|allowed" \
  "fix/a-human-branch|allowed"; do
  ref="${t_case%%|*}"; want="${t_case##*|}"
  if [ -n "$(ceiling_gate_for_ref "$ref")" ]; then got=refused; else got=allowed; fi
  if [ "$got" = "$want" ]; then
    echo "  ok   $ref -> $got"
  else
    echo "  FAIL $ref -> $got, expected $want"
    failures=$((failures + 1))
  fi
done

# THE ALLOWANCE FOR `gen/android` IS ONLY AS GOOD AS THE JOB BEHIND IT. If `compile-android-app` is
# removed, disabled (`if: false`), narrowed so it no longer sees `gen/android`, or dropped from
# `ci-passed`, the arm above would let a Gradle bump merge on a suite that never compiles `:app` -
# the exact hole it was written to close. A pull request that does any of that FAILS HERE, in
# `test-ci-scripts`; the guard makes the removal visible, it cannot restore the gate.
echo "the gen/android allowance has a gate behind it:"
tests_dir="$(dirname "${BASH_SOURCE[0]}")"
ci_yml="$tests_dir/../../workflows/ci.yml"
check_that() { # <description> <command...>: ok when the command succeeds
  local description="$1"; shift
  if "$@"; then echo "  ok   $description"; else echo "  FAIL $description"; failures=$((failures + 1)); fi
}
check_not() { # <description> <command...>: ok when the command FAILS
  local description="$1"; shift
  if "$@"; then echo "  FAIL $description"; failures=$((failures + 1)); else echo "  ok   $description"; fi
}
# The job's own text: from its key to the next job key at the same indentation.
job_block="$(awk '/^  compile-android-app:/{f=1; print; next} f && /^  [a-zA-Z0-9_-]+:/{exit} f{print}' "$ci_yml")"
job_has() { grep -qE "$1" <<<"$job_block"; }
check_that "ci.yml carries a compile-android-app job" test -n "$job_block"
check_that "the job runs when the android_app filter says so, and not under some other condition" \
  job_has '^    if: \$\{\{ needs\.changes\.outputs\.run-android-app == .true. \}\}$'
check_that "the job runs android-app-compile.sh" job_has '^        run: bash \.github/scripts/android-app-compile\.sh$'
check_that "android-app-compile.sh is executable" test -x "$tests_dir/../android-app-compile.sh"
# The filter itself is EVALUATED, not grepped: the `if has ...` of the `android_app` block is run
# against a real path of the tree this job exists to watch, and against one it must not fire on.
filter_if="$(awk '/-- Android `:app` compile --/{f=1} f && /^          if has/{c=1} c{print} c && /; then$/{exit}' "$ci_yml")"
# shellcheck disable=SC2317,SC2329  # `has` is called by the `if has ...` text evaluated below
filter_fires() { # <path>: does the android_app filter fire for a change to that single path?
  (
    CHANGED="$1"
    has() { echo "$CHANGED" | grep -qE "$1"; }
    eval "$filter_if
      exit 0
    else
      exit 1
    fi"
  )
}
check_that "the filter fires for a change to gen/android" filter_fires "frontend/src-tauri/gen/android/app/build.gradle.kts"
check_that "the filter fires for the Gradle wrapper (the #2564 case)" filter_fires "frontend/src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties"
check_that "the filter fires for the app crate's Rust, the only Android-target compile on a pull request" filter_fires "frontend/src-tauri/src/lib.rs"
check_not "the filter stays quiet for an unrelated change" filter_fires "apps/core-service/src/main.ts"
# ...and it must be in the aggregate the ruleset requires, or its failure would block nothing.
ci_passed_needs() { sed -n '/^  ci-passed:/,$p' "$ci_yml" | sed -n '/needs:/,/\]/p' | grep -q 'compile-android-app'; }
check_that "ci-passed needs compile-android-app" ci_passed_needs

# -------------------------------------------------------------------------------------------------
# WHICH IMAGES MAY CROSS A MAJOR IS AN ALLOWLIST: PROVEN STATELESS, OR REFUSED (2026-10-31)
# -------------------------------------------------------------------------------------------------
# #2742 proposed `library/postgres 16-alpine -> 18-alpine` for the identity provider's stack. These
# run off FIXTURES spelling that stack's numbers, so they keep asserting the incident's shape after
# the real pins move. The watched set is overridden, so "stateful" is read from the fixtures alone.
#
# THROUGH THE REAL PATH: `expect_on_ref` derives the ecosystem and the compose file from the branch,
# exactly as `dependency-ceiling.sh` does. Handing `gate_for_dependency` a file by hand asserted a
# wiring the driver never has (review of #2779).
expect_on_ref() { # <allowed|refused> <name> <version> <branch> [why]
  local want="$1" name="$2" version="$3" ref="$4" why="${5:-}" gate got
  gate=$(gate_for_dependency "$name" "$version" "$(ceiling_ecosystem_from_ref "$ref")" "$(ceiling_compose_from_ref "$ref")")
  if [ -n "$gate" ]; then got=refused; else got=allowed; fi
  if [ "$got" = "$want" ]; then
    echo "  ok   $name $version on ${ref#dependabot/} is $got"
  else
    echo "  FAIL $name $version on ${ref#dependabot/} is $got, expected $want${why:+: $why}"
    failures=$((failures + 1))
  fi
}
# Statefulness alone, for the mount shapes: is this image PROVEN stateless?
expect_stateless() { # <yes|no> <image> <why>
  local got=no
  if ceiling_image_may_cross_major "$2"; then got=yes; fi
  if [ "$got" = "$1" ]; then
    echo "  ok   $2 may cross a major: $got"
  else
    echo "  FAIL $2 may cross a major: $got, expected $1 - $3"
    failures=$((failures + 1))
  fi
}
echo "an image may cross a major only when no watched compose file mounts data for it:"
allow_work=$(mktemp -d)
printf 'services:\n  postgresql:\n    image: docker.io/library/postgres:16-alpine\n    volumes:\n      - database:/var/lib/postgresql/data\n' > "$allow_work/authentik.yml"
printf 'services:\n  garage:\n    image: dxflrs/garage:v2.4.1\n    volumes:\n      - meta:/var/lib/garage/meta\n  edge:\n    image: nginx:1.31.8-alpine\n    volumes:\n      - ./nginx.conf:/etc/nginx/nginx.conf:ro\n  admin:\n    image: adminer@sha256:251295c1\n' > "$allow_work/prod.yml"
# EVERY MOUNT SHAPE THE FIRST PARSER READ AS STATELESS (review of #2779), one image each, in no name
# list - so only the parse can make them stateful.
cat > "$allow_work/local.yml" <<'YAML'
services:
  hyphenated:
    image: bitnami/postgresql:16
    volumes:
      - auth-db-data:/bitnami/postgresql
  quoted:
    image: valkey/valkey:8.1-alpine
    volumes:
      - "vk:/data"
  anonymous:
    image: mariadb:11.4
    volumes:
      - /var/lib/mysql
  writable-bind:
    image: mongo:7
    volumes:
      - ./pgdata:/data/db
  long-syntax:
    image: mysql:8.4
    volumes:
      - type: volume
        source: mysql
        target: /var/lib/mysql
  read-only-bind:
    image: traefik:3.1
    volumes:
      - type: bind
        source: ./traefik.yml
        target: /etc/traefik/traefik.yml
        read_only: true
volumes:
  auth-db-data:
YAML
# FOUR SPACES PER LEVEL: the first parser yielded no row at all for it.
printf 'services:\n    store:\n        image: minio/minio:RELEASE.2026-01-01T00-00-00Z\n        volumes:\n            - objects:/data\n' > "$allow_work/four.yml"
# The real files are restored after this block: the assertions below it read them.
saved_composes=("$CEILING_PROD_COMPOSE" "$CEILING_AUTHENTIK_COMPOSE" "$CEILING_WATCHED_COMPOSES" "$CEILING_VERSION_GAP")
CEILING_PROD_COMPOSE="$allow_work/prod.yml"
CEILING_AUTHENTIK_COMPOSE="$allow_work/authentik.yml"
CEILING_WATCHED_COMPOSES="$allow_work/prod.yml $allow_work/local.yml $allow_work/four.yml $allow_work/authentik.yml"
CEILING_VERSION_GAP="$allow_work/no-gap.yml"
auth_ref=dependabot/docker_compose/infrastructure/authentik/library/postgres-18-alpine
prod_ref=dependabot/docker_compose/infrastructure/dxflrs/garage-v2.5.0
local_ref=dependabot/docker_compose/infrastructure/local/image-x
# THE #2742 TRAILER, verbatim: `library/postgres`, `18-alpine`, on its own branch.
expect_on_ref refused "library/postgres" "18-alpine" "$auth_ref" "#2742: a postgres major on the identity provider's 16 cluster"
expect_on_ref allowed "library/postgres" "16.5-alpine" "$auth_ref"   # 16.4 -> 16.5
expect_on_ref allowed "dxflrs/garage" "v2.5.0" "$prod_ref"           # #2741, a minor
expect_on_ref refused "dxflrs/garage" "v3.0.0" "$prod_ref" "garage mounts a named volume"
# A stateless image's major is the suite's business, and so is a Dockerfile base in no compose file.
expect_on_ref allowed nginx "2.0.0-alpine" "$prod_ref"   # a read-only bind of configuration is not state
expect_on_ref allowed adminer "6.0.0" "$prod_ref"
expect_on_ref allowed node "27-alpine" dependabot/docker/frontend/node-27-alpine
# The mount shapes, one by one.
expect_stateless no bitnami/postgresql "a hyphenated named volume is a named volume"
expect_stateless no valkey/valkey "a quoted entry is still a volume"
expect_stateless no mariadb "an anonymous volume persists across a recreate"
expect_stateless no mongo "a writable bind mount of a data directory is data"
expect_stateless no mysql "a long-syntax volume is a volume"
expect_stateless yes traefik "a long-syntax bind marked read_only is configuration"
expect_stateless no minio/minio "a file indented four spaces per level parses too"
# A REGISTRY SPELLING IS STILL THE NAME: the name list matched only the short form.
expect_stateless no mirror.gcr.io/library/postgres "a mirror's spelling of postgres is postgres"
expect_stateless no index.docker.io/library/postgres "Docker Hub's long spelling of postgres is postgres"
mirror_major=$(prod_image_major postgres <(printf 'services:\n  db:\n    image: "mirror.gcr.io/library/postgres:16-alpine"\n'))
check_that "the running major is read through a mirror's spelling and quotes (got '${mirror_major}')" test "$mirror_major" = 16
# THE REAL WIRING ON A LOCAL-STACK BRANCH: `ceiling_compose_from_ref` compares it with PRODUCTION's
# file, which does not run valkey, so the major "running" is unreadable and even a minor is refused.
# Fail-closed, and the cost is real: a data store only the local stack runs never moves unattended.
expect_on_ref refused "valkey/valkey" "9.0-alpine" "$local_ref" "valkey mounts data, though no list names it"
expect_on_ref refused "valkey/valkey" "8.2-alpine" "$local_ref" "production runs no valkey, so no major can be read to compare with"
# FAILING CLOSED: a watched file that cannot be read, or that parses to no image, is not a proof.
CEILING_WATCHED_COMPOSES="$allow_work/prod.yml $allow_work/absent.yml"
expect_on_ref refused nginx "2.0.0-alpine" "$prod_ref" "a watched compose file is unreadable, so nginx is not PROVEN stateless"
printf 'services: {edge: {image: "nginx:1.31"}}\n' > "$allow_work/flow.yml"
CEILING_WATCHED_COMPOSES="$allow_work/prod.yml $allow_work/flow.yml"
expect_on_ref refused nginx "2.0.0-alpine" "$prod_ref" "a watched compose file parses to no image row"
# ...and none of that reaches a crate: the arm is about images.
expect_on_ref allowed serde "2.0.0" dependabot/cargo/apps/chat-gateway/serde-2.0.0
CEILING_PROD_COMPOSE="${saved_composes[0]}"
CEILING_AUTHENTIK_COMPOSE="${saved_composes[1]}"
CEILING_WATCHED_COMPOSES="${saved_composes[2]}"
CEILING_VERSION_GAP="${saved_composes[3]}"
rm -rf "$allow_work"

# THE MAJOR "RUNNING" IS THE BASE BRANCH'S, so the job must check out the base. A `pull_request`
# checkout is the merge ref, which already carries Dependabot's new pin: #2742 read 18 out of its own
# bumped file and would have passed as same-major. And every watched compose file must be in the
# sparse checkout, or `ceiling_image_may_cross_major` reads an absent file and refuses every major.
echo "the dependency-ceiling job reads the base branch, and every file the table reads:"
ceiling_job="$(awk '/^  dependency-ceiling:/{f=1; print; next} f && /^  [a-zA-Z0-9_-]+:/{exit} f{print}' "$ci_yml")"
ceiling_job_has() { grep -qF -- "$1" <<<"$ceiling_job"; }
# shellcheck disable=SC2016  # the workflow expression is matched literally, never expanded
check_that "the checkout is the pull request's BASE commit" ceiling_job_has 'ref: ${{ github.event.pull_request.base.sha }}'
for sparse_path in .github/scripts .github/workflows/ci.yml infrastructure/docker-compose.prod.yml \
  infrastructure/docker-compose.dev.yml infrastructure/local/docker-compose.yml \
  infrastructure/dev/version-gap.yml infrastructure/authentik/compose.yml; do
  check_that "the sparse checkout carries $sparse_path" ceiling_job_has "            $sparse_path"
done
# The watched set and the sparse list must name the same files, or one of them drifts silently.
for watched in $CEILING_WATCHED_COMPOSES; do
  rel="infrastructure/${watched##*/infrastructure/}"
  check_that "the watched compose file $rel is in the sparse checkout" ceiling_job_has "            $rel"
  check_that "the watched compose file $rel exists" test -r "$watched"
done

# -------------------------------------------------------------------------------------------------
# What must KEEP merging on its own. Each of these left the table when its gate was written, and a
# regression that put one back would stop a whole class of update without anybody deciding to.
# -------------------------------------------------------------------------------------------------
echo "what the suite is evidence about:"
expect_allowed "@nestjs/common" "12.0.1"   # released by `boot-nest-apps`, 2026-08-31
expect_allowed "@nestjs/core" "12.0.1"
expect_allowed typeorm "1.1.0"             # released by `app-module.boot-spec.ts`, 2026-08-31
expect_allowed webrtc "0.17.3"             # released by `apps/call-service/tests/relay_path.rs`, 2026-10-09
expect_allowed webrtc-ice "0.17.3"
expect_allowed turn "0.17.3"
expect_allowed argon2 "0.6.0"              # released by `cross_version_state.rs`, 2026-08-31
expect_allowed aes-gcm "0.11.0"            # released by `cross_version_push.rs`
# THE WIRE-FORMAT FAMILY, released by `mls-forward-compat.test.sh` on 2026-09-15. It had been
# refused since this table was written, for the one direction no fixture can see: an old binary
# reading a frame minted by the new one. That gate now checks `FIXTURE_VERSION` out into a worktree,
# builds `frontend/mls-cross-version` against BOTH libraries and has them hold one conversation.
#
# THE WHOLE FAMILY LEAVES TOGETHER BECAUSE IT WAS REFUSED TOGETHER - the openmls release train moves
# as one piece, and the gate exercises the train, not a crate. A patch is asserted beside a minor
# for the same reason the refusal used to assert it: the failure mode never depended on the number.
expect_allowed openmls "0.9.0"
expect_allowed openmls "0.8.2"
expect_allowed openmls_traits "0.6.0"
expect_allowed tls_codec "0.5.0"
expect_allowed hpke-rs-crypto "0.3.0"
expect_allowed libcrux-kem "0.0.9"
# A STATELESS image is allowed even across a major: adminer mounts no volume, so there is no old
# data for a new version to refuse. This is the line that keeps the datastore arm about STATE rather
# than about being a container.
expect_allowed adminer "5.0.0"
expect_allowed svelte "6.0.0"
expect_allowed node "26-alpine"

# The caller strips the quotes Dependabot puts around a scoped name before consulting the table; if
# that ever regresses, `"@nestjs/common"` must not silently become an unmatched name. This asserts
# the table's contract: it is given a BARE name.
echo "the table is given a bare name:"
if [ -z "$(gate_for_dependency '"postgres"' '15-alpine')" ]; then
  echo "  ok   a quoted name does not match, so ceiling_parse_updates' stripping is load-bearing (tested below)"
else
  echo "  FAIL a quoted name matched; the table's contract is now ambiguous"
  failures=$((failures + 1))
fi

# THE ONE PARSER, read by `dependency-ceiling.sh` and `cargo-lock-refresh.sh` alike. The fixture is a
# grouped commit (two blocks) whose second block has NO `update-type`, plus a quoted scoped name -
# the three traps the parser exists for.
echo "the updated-dependencies blocks parse as blocks:"
parsed_want=$'serde|patch|1.0.5\n@nestjs/common||12.0.1'
parsed_got=$(ceiling_parse_updates <<'MSG'
chore(deps): bump two

---
updated-dependencies:
- dependency-name: serde
  dependency-version: 1.0.5
  dependency-type: direct:production
  update-type: version-update:semver-patch
- dependency-name: "@nestjs/common"
  dependency-version: 12.0.1
  dependency-type: direct:production
...
MSG
)
if [ "$parsed_got" = "$parsed_want" ]; then
  echo "  ok   two blocks, the absent type stays empty and the quotes are stripped"
else
  echo "  FAIL parsed as: $parsed_got"
  failures=$((failures + 1))
fi

echo "what an unattended actor reads as breaking:"
for b_case in "major|2.0.0|y" "minor|0.20.5|y" "patch|0.0.9|y" "|0.9.0|y" "weird|1.2.3|y" \
  "minor|1.4.0|n" "patch|1.0.5|n" "patch|0.17.3|n"; do
  IFS='|' read -r b_type b_ver b_want <<<"$b_case"
  if ceiling_update_is_breaking "$b_type" "$b_ver"; then b_got=y; else b_got=n; fi
  if [ "$b_got" = "$b_want" ]; then
    echo "  ok   '${b_type}' -> $b_ver: breaking=$b_got"
  else
    echo "  FAIL '${b_type}' -> $b_ver read as breaking=$b_got"
    failures=$((failures + 1))
  fi
done

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures assertion(s) failed."
  exit 1
fi
echo "all assertions passed."
