#!/usr/bin/env bash
# Sourced, never run. The DECISIONS of the release's MiConnect deploy (deploy-stack.sh) and of the
# daily drift report, as pure functions: every input is an argument or stdin, nothing here calls
# docker, curl or the clock, so `.github/scripts/tests/authentik-release.test.sh` proves each verdict
# without a host. The mechanism and its reasons: docs/wiki/infrastructure/authentik.md, "The release
# deploys MiConnect's version".

# ak_service_image <compose-file> <service>
# The `image:` of one service, as written (quotes stripped). Empty when the service or its image is
# absent. Reads the two-space service keys under `services:` and nothing deeper.
ak_service_image() {
  awk -v want="$2" '
    /^services:[[:space:]]*$/ { in_services = 1; next }
    /^[^[:space:]#]/ { in_services = 0 }
    in_services && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { svc = $1; sub(/:$/, "", svc); next }
    in_services && svc == want && $1 == "image:" { img = $2; gsub(/^["\047]|["\047]$/, "", img); print img; exit }
  ' "$1"
}

# ak_pin_image <compose-file>
# The ONE authentik image the repository pins: server and worker must name the same LITERAL
# reference, because a literal is what Dependabot can read and what the release can compare.
# Prints it, or a reason on stderr and status 1.
ak_pin_image() {
  local server worker
  server="$(ak_service_image "$1" server)"
  worker="$(ak_service_image "$1" worker)"
  if [ -z "$server" ] || [ -z "$worker" ]; then
    echo "no server or worker image in $1" >&2
    return 1
  fi
  # shellcheck disable=SC2016 # the literal `${` is what is searched for, not an expansion.
  case "$server$worker" in *'${'*)
    echo "the server or worker image of $1 interpolates a variable ($server); the pin must be literal" >&2
    return 1
    ;;
  esac
  if [ "$server" != "$worker" ]; then
    echo "server ($server) and worker ($worker) pin different images in $1" >&2
    return 1
  fi
  printf '%s\n' "$server"
}

# ak_tag_of <image-reference>  - the tag (digest and repository dropped); empty when there is none.
ak_tag_of() {
  local ref="${1%%@*}" last
  last="${ref##*/}"
  case "$last" in *:*) printf '%s\n' "${last##*:}" ;; *) printf '\n' ;; esac
}

# ak_is_version <tag> - authentik's calendar versions, `2026.8.5`.
ak_is_version() { [[ "$1" =~ ^[0-9]+(\.[0-9]+)+$ ]]; }

# ak_version_gt <a> <b> - true when a is strictly newer than b (both versions).
ak_version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

# ak_decide <pinned-image> <running-server-image> <running-worker-image> <env-tag>
# What the release does to one stack, from durable state only - the images its containers RUN and
# the tag line of its `.env` - never from a clock or from what the last run believed:
#   noop      both containers run the pin and `.env` names it: nothing to do
#   record    both run the pin, `.env` names another tag: write the line, restart nothing
#   upgrade   at least one container runs something else, older: dump, retag, restart, check
#   refuse:<why>  a stack that is not running, a version that cannot be ordered, or a DOWNGRADE -
#             authentik's migrations do not run backwards, so going back is a restore by hand
ak_decide() {
  local pin="$1" server="$2" worker="$3" env_tag="$4" pin_tag running running_tag
  pin_tag="$(ak_tag_of "$pin")"
  if [ "$server" = "$pin" ] && [ "$worker" = "$pin" ]; then
    if [ "$env_tag" = "$pin_tag" ]; then echo noop; else echo record; fi
    return 0
  fi
  if [ -z "$server" ] || [ -z "$worker" ]; then
    echo "refuse:the server or worker container is not running - the release upgrades a running stack and never creates one"
    return 0
  fi
  if ! ak_is_version "$pin_tag"; then
    echo "refuse:the pinned tag '$pin_tag' is not an authentik version, so it cannot be ordered against what runs"
    return 0
  fi
  for running in "$server" "$worker"; do
    running_tag="$(ak_tag_of "$running")"
    if ! ak_is_version "$running_tag"; then
      echo "refuse:the running image '$running' has no version tag, so a downgrade cannot be ruled out"
      return 0
    fi
    if ak_version_gt "$running_tag" "$pin_tag"; then
      echo "refuse:DOWNGRADE - '$running' runs and the repository pins '$pin'; authentik's migrations do not run backwards, so this is a database restore by hand"
      return 0
    fi
  done
  echo upgrade
}

# ak_env_tag  - the AUTHENTIK_TAG a `.env` on stdin sets (the last line wins, quotes stripped).
ak_env_tag() {
  awk -F= '/^[[:space:]]*AUTHENTIK_TAG[[:space:]]*=/ { v = substr($0, index($0, "=") + 1) } END { gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", v); print v }'
}

# ak_env_set_tag <tag>  - the `.env` on stdin with exactly ONE `AUTHENTIK_TAG=<tag>` line: the first
# one rewritten in place, any later one dropped, appended when there was none. Every other line is
# copied untouched - the file carries the stack's secrets and only this line is the release's.
ak_env_set_tag() {
  awk -v tag="$1" '
    /^[[:space:]]*AUTHENTIK_TAG[[:space:]]*=/ { if (!done) { print "AUTHENTIK_TAG=" tag; done = 1 }; next }
    { print }
    END { if (!done) print "AUTHENTIK_TAG=" tag }
  '
}

# ak_rollback_plan <migrations-before> <migrations-after>
#   retag    the failed version applied no migration: putting the old tag back is the whole rollback
#   restore  it did, or the count cannot be read: the old version cannot run on a newer schema, so
#            the dump taken before the change is restored. Destructive, hence gated on a FAILED check
#            AND on the schema having moved (or being unknowable) - never on the failure alone.
ak_rollback_plan() {
  if [ -n "$1" ] && [ "$1" = "$2" ]; then echo retag; else echo restore; fi
}

# ak_health_verdict <state> <health> <restart-count>
# Docker's own verdict on a recreated container, which is the image author's healthcheck (`ak
# healthcheck`, its start period and retries) - a proof, not a timer of ours:
#   healthy | waiting | failed:<why>
# A restart counts as failure: a crash-looping container resets its health to `starting` on every
# start and would otherwise be "waiting" for ever.
ak_health_verdict() {
  local state="$1" health="$2" restarts="${3:-0}"
  if [ "$restarts" != 0 ]; then
    echo "failed:restarted $restarts time(s)"
  elif [ "$state" != running ]; then
    echo "failed:state $state"
  else
    case "$health" in
      healthy) echo healthy ;;
      starting) echo waiting ;;
      unhealthy) echo "failed:docker reports it unhealthy" ;;
      *) echo "failed:no healthcheck verdict ('$health') - the authentik image declares one, so this is not that image" ;;
    esac
  fi
}

# ak_blueprint_drift_verdict  - reads apply-blueprints.sh dry-run output on stdin:
#   clean | drift:<n> | unknown
# A dry run of the RELEASED blueprints against the instance they were applied to reports 0 changes
# unless somebody edited an object by hand since - which the next stable would silently revert.
ak_blueprint_drift_verdict() {
  local count
  count="$(grep -E '^\[miconnect-blueprints\] [0-9]+ change\(s\)$' | tail -n 1 | grep -oE '[0-9]+' || true)"
  if [ -z "$count" ]; then echo unknown; elif [ "$count" = 0 ]; then echo clean; else echo "drift:$count"; fi
}
