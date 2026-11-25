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
# Prints it, or a reason on stderr and status 1 - the reason never names the file's path, which the
# caller prints repository-relative (the job log is public).
ak_pin_image() {
  local server worker
  server="$(ak_service_image "$1" server)"
  worker="$(ak_service_image "$1" worker)"
  if [ -z "$server" ] || [ -z "$worker" ]; then
    echo "no server or worker image in the compose file" >&2
    return 1
  fi
  # shellcheck disable=SC2016 # the literal `${` is what is searched for, not an expansion.
  case "$server$worker" in *'${'*)
    echo "the server or worker image interpolates a variable ($server); the pin must be literal" >&2
    return 1
    ;;
  esac
  if [ "$server" != "$worker" ]; then
    echo "server ($server) and worker ($worker) pin different images" >&2
    return 1
  fi
  # A DIGEST CAN NEVER BE DEPLOYED: the host's compose builds the reference from AUTHENTIK_TAG alone,
  # so `config --images` would never name a pin carrying `@sha256:` and every release would stop.
  case "$server" in *@*)
    echo "the authentik pin carries a digest ($server); the host's compose builds the image from AUTHENTIK_TAG alone and can never run it - pin a tag" >&2
    return 1
    ;;
  esac
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

# ak_repo_of <image-reference>  - the repository, tag and digest dropped (`reg:5000/a/b:1@sha256:x` ->
# `reg:5000/a/b`).
ak_repo_of() {
  local ref="${1%%@*}" last
  last="${ref##*/}"
  case "$last" in *:*) printf '%s\n' "${ref%:*}" ;; *) printf '%s\n' "$ref" ;; esac
}

# ak_decide <pinned-image> <running-server-image> <running-worker-image> <env-tag> [<newer: keep|refuse>]
# What the release does to one stack, from durable state only - the images its containers RUN and
# the tag line of its `.env` - never from a clock or from what the last run believed:
#   noop      both containers run the pin and `.env` names it: nothing to do
#   record    both run the pin, `.env` names another tag: write the line, restart nothing
#   upgrade   at least one container runs something else, older: dump, retag, restart, check
#   keep-newer:<tag>  ONLY with <newer> = keep (production's stable; the default is refuse): both
#             containers run the SAME image of the pin's own repository, NEWER than the pin: left
#             untouched. It is
#             what a rerun of an older release's deploy meets (the documented rollback of the estate,
#             docs/wiki/cicd.md), and every rerun after a stable whose MiConnect step passed and whose
#             estate deploy failed. authentik's migrations do not run backwards, so MiConnect is not
#             taken back; the release goes on with the estate (the caller warns and checks the stack).
#   refuse:<why>  a stack that is not running, a version that cannot be ordered, the two containers
#             on different versions with one newer than the pin, a newer image of ANOTHER repository,
#             or any newer version under <newer> = refuse - a PRE-RELEASE refuses it, so the test stack
#             never silently skips rehearsing the upgrade the stable will make (gate 4 relies on it)
ak_decide() {
  local pin="$1" server="$2" worker="$3" env_tag="$4" policy="${5:-refuse}" pin_tag running running_tag newer=no older=no
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
    if ak_version_gt "$running_tag" "$pin_tag"; then newer=yes; else older=yes; fi
  done
  if [ "$newer" = yes ]; then
    if [ "$policy" != keep ]; then
      echo "refuse:DOWNGRADE - '$server' / '$worker' run and the repository pins '$pin'; authentik's migrations do not run backwards, and this stack refuses a newer version (--newer refuse: a pre-release must rehearse the stable's upgrade, never skip it). Pin that version or a newer one again"
    elif [ "$older" = yes ] || [ "$server" != "$worker" ]; then
      echo "refuse:server runs '$server' and worker '$worker', one of them NEWER than the pin '$pin' - neither keeping nor upgrading is one version; align them by hand"
    elif [ "$(ak_repo_of "$server")" != "$(ak_repo_of "$pin")" ]; then
      echo "refuse:'$server' runs, a newer version from ANOTHER repository than the pin's '$(ak_repo_of "$pin")' - it is not kept as the same image"
    else
      echo "keep-newer:$(ak_tag_of "$server")"
    fi
    return 0
  fi
  echo upgrade
}

# The `.env` line the release owns: `AUTHENTIK_TAG=` or `export AUTHENTIK_TAG=` (compose's dotenv
# reader accepts both), leading blanks allowed.
ak_env_tag_line='^[[:space:]]*(export[[:space:]]+)?AUTHENTIK_TAG[[:space:]]*='

# ak_env_tag  - the AUTHENTIK_TAG a `.env` on stdin sets (the last line wins, quotes stripped).
ak_env_tag() {
  awk -v re="$ak_env_tag_line" '$0 ~ re { v = substr($0, index($0, "=") + 1) } END { gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", v); print v }'
}

# ak_front_door  - the address the host's nginx proxies MiConnect to, read from the `.env` on stdin:
# `<IPv4>:<port>` (the loopback for an absent or `0.0.0.0` host), or `refuse:<cause>`. The line is
# `AUTHENTIK_PUBLISH=` as compose's dotenv reader takes it - an `export ` prefix, CRLF line ends, an
# inline ` #comment` after an unquoted value, surrounding quotes, the LAST assignment winning - and an
# absent or empty value is compose's own default, `${AUTHENTIK_PUBLISH:-9000}`. Anything it cannot
# turn into one probe-able address (port 0, a range, a name, an IPv6 address, an unclosed quote) is a
# REFUSAL naming why, never a guess: a wrong address would fail the morning preflight for a reason
# nobody could read. The value itself is never printed (the log is public).
ak_front_door() {
  awk '
    { sub(/\r$/, "") }
    /^[[:space:]]*(export[[:space:]]+)?AUTHENTIK_PUBLISH[[:space:]]*=/ { v = substr($0, index($0, "=") + 1) }
    END {
      sub(/^[[:space:]]+/, "", v)
      if (v ~ /^"/) {
        v = substr(v, 2); i = index(v, "\"")
        if (!i) { print "refuse:AUTHENTIK_PUBLISH opens a double quote it never closes"; exit }
        v = substr(v, 1, i - 1)
      } else if (v ~ /^\047/) {
        v = substr(v, 2); i = index(v, "\047")
        if (!i) { print "refuse:AUTHENTIK_PUBLISH opens a single quote it never closes"; exit }
        v = substr(v, 1, i - 1)
      } else {
        sub(/[[:space:]]+#.*$/, "", v); sub(/[[:space:]]+$/, "", v)
      }
      if (v == "") v = "9000"
      n = split(v, part, ":")
      if (n == 1) { host = ""; port = part[1] }
      else if (n == 2) { host = part[1]; port = part[2] }
      else { print "refuse:AUTHENTIK_PUBLISH is neither <port> nor <IPv4>:<port>"; exit }
      if (port !~ /^[0-9]+$/) { print "refuse:AUTHENTIK_PUBLISH names no numeric port"; exit }
      if (port + 0 == 0) { print "refuse:AUTHENTIK_PUBLISH names port 0, an ephemeral port no proxy can be pointed at"; exit }
      if (port + 0 > 65535) { print "refuse:AUTHENTIK_PUBLISH names a port above 65535"; exit }
      if (host == "" || host == "0.0.0.0") host = "127.0.0.1"
      else if (host !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) { print "refuse:AUTHENTIK_PUBLISH names a host that is not an IPv4 address"; exit }
      print host ":" (port + 0)
    }
  '
}

# ak_env_set_tag <tag>  - the `.env` on stdin with exactly ONE `AUTHENTIK_TAG=<tag>` line: the first
# one rewritten in place (an `export ` prefix kept), any later one dropped, appended when there was
# none. Every other line is copied untouched - the file carries the stack's secrets and only this line
# is the release's.
ak_env_set_tag() {
  awk -v tag="$1" -v re="$ak_env_tag_line" '
    $0 ~ re {
      if (!done) { prefix = ($0 ~ /^[[:space:]]*export[[:space:]]/) ? "export " : ""; print prefix "AUTHENTIK_TAG=" tag; done = 1 }
      next
    }
    { print }
    END { if (!done) print "AUTHENTIK_TAG=" tag }
  '
}

# ak_rollback_plan <state-before> <state-after>  - each state is `<django migrations>:<version row>`
# (deploy-stack.sh, db_state), read with server and worker STOPPED, so nothing can still be migrating:
#   retag    the database is where it was: putting the old tag back is the whole rollback
#   restore  it moved - a Django migration ran, OR authentik's own system migrations did. Those run
#            BEFORE Django's (lifecycle/migrate.py) and, on every new version, add a row to
#            `authentik_version_history` (system_migrations/version_history_update.py, 2026.8.5), which
#            is what the next start's `ensure_allowed_version` reads as the database's version. A release
#            that got that far and no further left a database that says it is the new version, so the
#            dump taken before the change is restored. Destructive, hence gated on a FAILED check AND a
#            state that MOVED. The row is compared by its id (a BIGSERIAL, never reused): authentik
#            trims the table to 1000 rows, so a count could stay flat while a row was added.
#   unknown  either state is unreadable: nothing proves the database moved, and a restore on a guess
#            would drop a database that may be fine - the rollback stops and hands over to a human.
ak_rollback_plan() {
  if ! [[ "$1" =~ ^[0-9]+:[0-9]+$ ]] || ! [[ "$2" =~ ^[0-9]+:[0-9]+$ ]]; then
    echo unknown
  elif [ "$1" = "$2" ]; then
    echo retag
  else
    echo restore
  fi
}

# ak_migrations_rising <previous-count> <current-count>  - true when both are counts and the second is
# larger: the new version is still applying migrations, so its healthcheck failing is not a verdict.
ak_migrations_rising() {
  [[ "$1" =~ ^[0-9]+$ ]] && [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -gt "$1" ]
}

# ak_health_verdict <state> <health> <restarts> [<migrating: yes|no>]
# <restarts> is the INCREASE of Docker's RestartCount since this run first saw the container (the
# count is cumulative over the container's life: a restart weeks ago is not this run's verdict).
# Docker's own verdict on a recreated container, which is the image author's healthcheck (`ak
# healthcheck`, its start period and retries) - a proof, not a timer of ours:
#   healthy | waiting | failed:<why>
# A restart counts as failure: a crash-looping container resets its health to `starting` on every
# start and would otherwise be "waiting" for ever. `unhealthy` is NOT final while the migration count
# is still rising (and nothing restarted): a long migration outlasts the healthcheck's start period,
# and calling it a failure would restore the dump over a good upgrade. The caller's deadline still
# bounds the wait, and reaching it fails.
ak_health_verdict() {
  local state="$1" health="$2" restarts="${3:-0}" migrating="${4:-no}"
  if [ "$restarts" != 0 ]; then
    echo "failed:restarted $restarts time(s)"
  elif [ "$state" != running ]; then
    echo "failed:state $state"
  else
    case "$health" in
      healthy) echo healthy ;;
      starting) echo waiting ;;
      unhealthy)
        if [ "$migrating" = yes ]; then echo waiting; else echo "failed:docker reports it unhealthy"; fi
        ;;
      *) echo "failed:no healthcheck verdict ('$health') - the authentik image declares one, so this is not that image" ;;
    esac
  fi
}

# ak_space_ok <database-bytes> <available-kilobytes>  - room for the dump: twice the database's size
# on disk. A custom-format dump is compressed and smaller than the database, so this bounds it from
# above and leaves the host the rest. False when either number is unreadable.
ak_space_ok() {
  [[ "$1" =~ ^[0-9]+$ ]] && [[ "$2" =~ ^[0-9]+$ ]] && [ "$(($2 * 1024))" -ge "$(($1 * 2))" ]
}

# ak_disk_ceiling_ok <used-kilobytes> <size-kilobytes> <added-bytes> <ceiling-percent>  - true when the
# root filesystem, with <added-bytes> more written to it, stays at or under <ceiling-percent> of its
# size: the shared host's 85 % (docs/wiki/infrastructure/host-updates.md, "The root disk", the same
# DISK_FAIL_PERCENT the daily `hosts` report turns red at). False when any number is unreadable.
ak_disk_ceiling_ok() {
  [[ "$1" =~ ^[0-9]+$ ]] && [[ "$2" =~ ^[0-9]+$ ]] && [[ "$3" =~ ^[0-9]+$ ]] && [[ "$4" =~ ^[0-9]+$ ]] &&
    [ "$2" -gt 0 ] && [ "$(((($1 * 1024) + $3) * 100))" -le "$(($4 * $2 * 1024))" ]
}

# ak_rehearsal_verdict <production-tag> <test-tag> <pin-tag>  - does this pre-release's test stack
# rehearse the upgrade the stable will make to PRODUCTION (review of #3486, 2026-11-19)?
#   ok            production already runs the pin (the stable changes nothing there), or the test
#                 stack starts from production's version
#   fail:<why>    the test stack must still upgrade, from ANOTHER version than production's: the
#                 rehearsal would prove a path the stable never takes
#   expected:<why> the test stack already runs the pin and production runs an OLDER version: the
#                 normal state between an alpha that upgraded the test stack and the stable that
#                 upgrades production, every morning of that window. A log line, never a warning
#                 (review of #3486, 2026-11-20): a warning repeated daily for the normal flow is noise
#                 that teaches its reader to skip it. Whether production's older version is the one
#                 its stable RELEASED is not this verdict's question - the `drift` job's image report
#                 compares it with `prod-released`'s pin every morning, and goes red when it differs.
#                 Which version the earlier pre-release upgraded FROM is not in the running state any
#                 more; its evidence is that run's log, and its dump's name (`<from>-to-<pin>`).
#   warn:<why>    the test stack already runs the pin and production runs a NEWER one, or a version
#                 that does not compare: not the normal flow, and not a failure either - refusing it
#                 would refuse every later pre-release of the same version.
ak_rehearsal_verdict() {
  local prod="$1" test="$2" pin="$3"
  if [ -z "$prod" ] || [ -z "$test" ] || [ -z "$pin" ]; then
    echo "fail:a running tag could not be read (production '${prod:-?}', test '${test:-?}', pin '${pin:-?}')"
  elif [ "$prod" = "$pin" ] || [ "$test" = "$prod" ]; then
    echo ok
  elif [ "$test" = "$pin" ] && ak_is_version "$prod" && ak_is_version "$pin" && ak_version_gt "$pin" "$prod"; then
    echo "expected:the test stack already runs $pin and production still runs $prod - an earlier pre-release made the upgrade the next stable will make to production"
  elif [ "$test" = "$pin" ]; then
    echo "warn:the test stack already runs $pin and production runs $prod: the upgrade was rehearsed by an earlier pre-release, from a version the running state no longer shows. Were production NEWER than the pin, the stable would keep it (--newer keep) and upgrade nothing, so there is nothing to rehearse"
  else
    echo "fail:the test stack runs $test and production runs $prod: upgrading the test stack to $pin would rehearse $test -> $pin, not the $prod -> $pin the stable will make. Put the test stack on $prod first"
  fi
}

# ak_prune_select <now-stamp> <keep> <max-days>  - reads the basenames of one stack's dump directory on
# stdin and prints those that must go (owner, 2026-11-19: "3 copies et 30 jours au plus"): per kind,
# everything beyond the <keep> newest AND everything taken more than <max-days> before <now-stamp>.
# THE COPIES HOLD EVERY MICONNECT ACCOUNT (emails, names, groups, password hashes), so they live no
# longer than the owner's bound, even when no release comes to replace them.
# AN ALLOWLIST, NOT A DENYLIST: only the names deploy-stack.sh writes are candidates -
# `<stamp>-*.dump`, `<stamp>-*.env`, `<stamp>-pg.log`, `<stamp>-compose.log`, the stamp being
# `YYYYMMDDTHHMMSSZ` (UTC). Anything else in the directory is never touched.
# `<stamp>-env-next.XXXXXX` is write_env's temporary copy of the `.env` (every secret in it): a run
# killed mid-write leaves one, it is never needed again, so it is ALWAYS selected - at most one run
# executes at a time (one runner), and the prune never runs during a write.
# THE AGE IS THE STAMP IN THE NAME - the moment the copy was taken - never the file's mtime, which a
# copy or a restore of the directory resets. <now-stamp> is an argument: nothing here reads the clock.
ak_prune_select() {
  local now="$1" keep="$2" days="$3"
  if ! [[ "$now" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || ! [[ "$keep" =~ ^[0-9]+$ ]] || ! [[ "$days" =~ ^[0-9]+$ ]]; then
    echo "ak_prune_select: expected <YYYYMMDDTHHMMSSZ> <keep> <max-days>, got '$now' '$keep' '$days'" >&2
    return 1
  fi
  # Newest first: the stamp leads every candidate name, so a byte sort orders them by time.
  LC_ALL=C sort -r | awk -v now="$now" -v keep="$keep" -v days="$days" '
    # Seconds since 1970 of a stamp, by the civil-from-days arithmetic (no `date -d`, no locale).
    function epoch(s,   y, m, d, era, yoe, doy, doe) {
      y = substr(s, 1, 4) + 0; m = substr(s, 5, 2) + 0; d = substr(s, 7, 2) + 0
      if (m <= 2) y--
      era = int(y / 400); yoe = y - era * 400
      doy = int((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1
      doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
      return (era * 146097 + doe - 719468) * 86400 + substr(s, 10, 2) * 3600 + substr(s, 12, 2) * 60 + substr(s, 14, 2)
    }
    BEGIN { limit = epoch(now) - days * 86400 }
    !/^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-/ { next }
    { kind = "" }
    /\.dump$/ { kind = "dump" }
    /\.env$/ { kind = "env" }
    /-pg\.log$/ { kind = "pg-log" }
    /-compose\.log$/ { kind = "compose-log" }
    /-env-next\.[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]$/ { print; next }
    kind == "" { next }
    { if (++seen[kind] > keep || epoch($0) < limit) print }
  '
}

# ak_dry_run_recreates  - reads `docker compose --dry-run up` output on stdin; true when compose
# would create or recreate a container. Asked with the tag each container already RUNS, a clean stack
# answers `Running`: anything else means the host's compose file or `.env` differ from what runs, and
# a real `up` would apply that difference too, beside the tag.
ak_dry_run_recreates() {
  grep -qE '[[:space:]](Recreate|Create)[[:space:]]*$'
}

# ak_redact_blueprint_output  - the applier's output on stdin, as the PUBLIC job log may show it:
# a CHANGED line keeps its object and field and loses its values (they can be callbacks, names or
# addresses); an indented validation line and any line that is not the applier's own (a traceback can
# quote a value) are withheld and counted. The full text is read on the host, by a person.
ak_redact_blueprint_output() {
  awk '
    /^\[miconnect-blueprints\] CHANGED / {
      if (match($0, /^\[miconnect-blueprints\] CHANGED +[^ ]+ [^ ]+ \.[A-Za-z0-9_]+/)) print substr($0, 1, RLENGTH)
      else print "[miconnect-blueprints] CHANGED (a line of an unexpected shape, withheld whole)"
      next
    }
    # A HELD blueprint is named by apply-blueprints.sh with its file name alone: kept, it is a notice.
    /^::warning title=MiConnect blueprint HELD::held\/[A-Za-z0-9._-]+ is NOT applied/ { print; next }
    /^\[miconnect-blueprints\]   / { withheld++; next }
    /^\[miconnect-blueprints\] / { print; next }
    NF { withheld++ }
    END { if (withheld) print "[miconnect-blueprints] " withheld " other line(s) withheld from this public log - run apply-blueprints.sh dry-run on the host to read them" }
  '
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
