#!/usr/bin/env bash
# Asserts that the CONTAINERS of one estate really carry the secrets its .env declares.
#
# WHY THIS EXISTS AT ALL. A container keeps the environment it was created with, so a rendered .env
# proves nothing about what is running: `docker compose restart` re-reads no file, and a service
# created before a key was added goes on presenting the compose default through every restart. This
# repository has already paid for that - a media-service authenticating as `minioadmin` answered
# `403 No such key` on every request for as long as nobody read the storage log.
#
# WHY IT IS DERIVED AND NOT A LIST. `serve-prod.yml` verified five keys in four services, by hand,
# in five near-identical blocks - JWT, two Stripe, two Lydia. The other twenty-five secrets were
# verified nowhere, and dev verified nothing at all. The failure mode of a hand-written guard list
# is the entity nobody added to it, which is the defect this file is written against. So the pairs
# are DERIVED: the manifest says which keys this environment carries, the resolved compose file says
# which services read each one, and every pair that falls out is checked. A service that starts
# reading a new secret is covered on the day its compose block says so, by whoever wrote it.
#
# THE CONTAINER'S ENVIRONMENT IS READ WITH `docker inspect`, NOT WITH `exec`, AND THAT IS MEASURED.
# `exec` needs a shell, and `garage` is distroless: it has none. An `exec`-based check therefore
# reported production's two Garage secrets as MISMATCHED when `docker inspect` showed them
# byte-identical to .env - an inability to measure, dressed up as a failing measurement, which is
# the shape that gets a real check deleted for crying wolf. `.Config.Env` is also the exact thing
# the defect is about: it is what the container was CREATED with, which no restart re-reads.
#
# NO VALUE IS EVER PRINTED. The comparison is between two SHA-256 digests, and both `docker inspect`
# and `docker compose config` resolve secrets, so their output is piped and never echoed.
#
# Usage:
#   verify-secrets.sh --environment prod|dev --path /srv/canari
#
# It runs AFTER deploy-environment.sh: the services must be up for their environment to be readable.
set -euo pipefail

ENVIRONMENT=""
DEPLOY_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
  --environment)
    ENVIRONMENT="${2:-}"
    shift 2
    ;;
  --path)
    DEPLOY_PATH="${2:-}"
    shift 2
    ;;
  *)
    printf 'verify-secrets: unknown argument %s\n' "$1" >&2
    exit 2
    ;;
  esac
done

case "$ENVIRONMENT" in
prod | dev) ;;
*)
  printf 'verify-secrets: --environment must be prod or dev (got "%s")\n' "$ENVIRONMENT" >&2
  exit 2
  ;;
esac

[ -n "$DEPLOY_PATH" ] || {
  printf 'verify-secrets: --path is required\n' >&2
  exit 2
}

cd "$DEPLOY_PATH" || {
  printf 'verify-secrets: %s does not exist\n' "$DEPLOY_PATH" >&2
  exit 1
}

COMPOSE_FILE="infrastructure/docker-compose.${ENVIRONMENT}.yml"
ENV_FILE="infrastructure/.env"
MANIFEST="infrastructure/deploy/env-manifest.tsv"

for f in "$COMPOSE_FILE" "$ENV_FILE" "$MANIFEST"; do
  [ -f "$f" ] || {
    printf '::error::%s/%s is missing - verify-secrets runs after render-env.sh and deploy-environment.sh\n' \
      "$DEPLOY_PATH" "$f" >&2
    exit 1
  }
done

# Same resolution as deploy-environment.sh, for the same reason: the runner user may or may not be
# in the docker group, and both estates are verified the same way.
if docker info >/dev/null 2>&1; then
  DOCKER_CLI="docker"
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER_CLI="sudo docker"
else
  printf 'verify-secrets: cannot reach the Docker daemon as %s\n' "$(whoami)" >&2
  exit 1
fi

dc() {
  $DOCKER_CLI compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

printf '\n=== verifying the %s estate carries its secrets ===\n' "$ENVIRONMENT"

# WHICH SERVICE READS WHICH KEY, taken from the RESOLVED compose file rather than the raw one, so an
# `env_file:` or an anchor is followed the same way Docker follows it. Only key names are printed;
# the values that come with them stay in the pipe.
# shellcheck disable=SC2016 # the single quotes are the point: this is Python source, not shell
PAIRS="$(dc config --format json | python3 -c '
import json, sys

config = json.load(sys.stdin)
for service, spec in sorted((config.get("services") or {}).items()):
    environment = spec.get("environment") or {}
    # A list form ("KEY=value") is possible in hand-written files; `config` normalises to a map,
    # but accepting both costs one branch and removes a way for this to silently find nothing.
    names = environment.keys() if isinstance(environment, dict) else (
        item.split("=", 1)[0] for item in environment
    )
    for name in sorted(names):
        print(name, service)
')"

[ -n "$PAIRS" ] || {
  printf '::error::no service environment could be read from %s - refusing to report success on an empty derivation\n' \
    "$COMPOSE_FILE" >&2
  exit 1
}

# The services that are actually up. A pair naming a service that is not running is reported rather
# than skipped: deploy-environment.sh has already required every non-exempt service to be running,
# so an absent one here means something stopped between the two scripts.
RUNNING="$(dc ps --status running --services || true)"

checked=0
absent=0
unread=0
failed=0

# The manifest's own rows decide what this environment is supposed to carry. The disposition column
# is per environment, so a key production requires and dev skips is not looked for in dev.
#
# FD 3, AND THAT IS NOT A STYLE CHOICE. This loop body runs `docker compose exec`, which reads
# stdin - so a manifest fed on stdin is EATEN a few rows in. Measured against production before
# this line existed: five pairs checked out of thirty-three keys, reported green. A verification
# that silently examines a sixth of what it claims is worse than none, because it is believed.
while IFS=$'\t' read -r key prod dev _source _note <&3; do
  case "$key" in '' | '#'*) continue ;; esac

  disposition="$prod"
  [ "$ENVIRONMENT" = "dev" ] && disposition="$dev"
  case "$disposition" in skip | skip:*) continue ;; esac

  # Only a name a shell may safely carry into the container's `sh -c`.
  case "$key" in
  [A-Za-z_]*) ;;
  *)
    printf '::error::%s is not a usable environment variable name\n' "$key" >&2
    failed=$((failed + 1))
    continue
    ;;
  esac

  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  if [ -z "$value" ]; then
    # Nothing to verify. Whether an empty value is acceptable is render-env.sh's decision, taken
    # before any container started; repeating that judgement here would be a second opinion on one
    # question, which is how two guards come to disagree.
    absent=$((absent + 1))
    continue
  fi

  services="$(printf '%s\n' "$PAIRS" | awk -v k="$key" '$1 == k { print $2 }')"
  if [ -z "$services" ]; then
    # Rendered and read by nobody. Not fatal - several keys are consumed by the frontend build or by
    # nginx rather than by a service - but it is the shape a stale manifest row has, so it is said.
    printf '  %-34s no service declares it\n' "$key"
    unread=$((unread + 1))
    continue
  fi

  expected="$(printf '%s' "$value" | sha256sum | awk '{ print $1 }')"

  for service in $services; do
    if ! printf '%s\n' "$RUNNING" | grep -qx "$service"; then
      printf '::error::%s should carry %s and is not running\n' "$service" "$key" >&2
      failed=$((failed + 1))
      continue
    fi

    for cid in $(dc ps -q "$service"); do
      got="$($DOCKER_CLI inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" |
        grep -E "^${key}=" | tail -1 | cut -d= -f2- | tr -d '\n' | sha256sum | awk '{ print $1 }')"

      checked=$((checked + 1))
      if [ "$got" != "$expected" ]; then
        # The digests are deliberately not printed: they are of a secret, and a digest that leaks
        # the value of a short or guessable one is a leak. What a reader needs is the pair.
        printf '::error::%s in %s does not match %s - the container was created before this value, or the compose file does not pass it\n' \
          "$key" "$service" "$ENV_FILE" >&2
        failed=$((failed + 1))
      fi
    done
  done
done 3<"$MANIFEST"

printf '\n%s pair(s) checked, %s key(s) empty, %s key(s) read by no service\n' \
  "$checked" "$absent" "$unread"

if [ "$failed" -ne 0 ]; then
  printf '::error::%s secret(s) are not applied in the containers that read them\n' "$failed" >&2
  exit 1
fi

[ "$checked" -gt 0 ] || {
  printf '::error::nothing was verified - a green run here would mean only that the derivation found no pairs\n' >&2
  exit 1
}

printf 'every secret this estate renders is the one its containers hold\n'
