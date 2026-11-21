#!/usr/bin/env bash
#
# Self-test for `image-scan-targets.sh`: the list the image scan reads must be the images the estates
# RUN. Its failure mode is an absence - an image nothing scans - so every assertion here is about
# something being IN the list, or a source that cannot be read failing rather than shrinking it.
#
# Usage: bash .github/scripts/tests/image-scan-targets.test.sh   (no network)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../image-scan-targets.sh"
repo_root="$(cd "$here/../../.." && pwd)"
failures=0
ok() { echo "  ok   $1"; }
ko() { echo "  FAIL $1"; failures=$((failures + 1)); }

list="$(bash "$script" "$repo_root")" || { echo "FAIL image-scan-targets.sh failed on this repository"; exit 1; }

echo "every third-party image a production or dev compose file runs is scanned:"
for f in infrastructure/docker-compose.prod.yml infrastructure/docker-compose.dev.yml; do
  while read -r ref; do
    [ -z "$ref" ] && continue
    if grep -qxF "$ref" <<< "$list"; then ok "$ref ($f)"; else ko "$ref, run by $f, is not scanned"; fi
  done < <(awk '$1 == "image:" && $2 !~ /\$\{/ { print $2 }' "$repo_root/$f")
done

echo "every Dockerfile's SHIPPED stage is scanned, and no builder stage is:"
for df in "$repo_root"/infrastructure/local/Dockerfile.*; do
  last="$(awk 'toupper($1) == "FROM" { ref = $2 } END { print ref }' "$df")"
  built="dockerfile:infrastructure/local/${df##*/}"
  if grep -qxF "$last" <<< "$list"; then ok "$last (${df##*/})"
  elif grep -qxF "$built" <<< "$list"; then ok "$built is built and scanned (its shipped stage upgrades packages)"
  else ko "$last, the runtime base of ${df##*/}, is not scanned, and neither is the image it builds"; fi
done
echo "the patched adminer is scanned as BUILT, never as the upstream base it upgrades:"
adminer_base="$(awk 'toupper($1) == "FROM" { ref = $2 } END { print ref }' "$repo_root/infrastructure/local/Dockerfile.adminer")"
if grep -qxF "dockerfile:infrastructure/local/Dockerfile.adminer" <<< "$list"; then ok "Dockerfile.adminer is a build target"; else ko "Dockerfile.adminer is not built for the scan"; fi
if grep -qxF "$adminer_base" <<< "$list"; then ko "$adminer_base, the base the patch upgrades, is scanned instead of the image production runs"; else ok "the upstream adminer base is not a target"; fi
echo "every image the scan BUILDS is built uncached by the release, so a cached upgrade layer cannot be older than what was scanned:"
# The expression must be a plain OR of `matrix.name == '<name>'` terms: a name merely appearing in it
# (`... && false`) proves nothing. And the matrix name is not assumed to be the Dockerfile suffix:
# build.yml's own `[<name>]="./infrastructure/local/Dockerfile.<x>"` line is what ties the two.
build_yml="$repo_root/.github/workflows/build.yml"
no_cache="$(grep -E '^[[:space:]]*no-cache:' "$build_yml")"
term="matrix\.name == '[A-Za-z0-9_-]+'"
shape='^[[:space:]]*no-cache:[[:space:]]*[$][{][{][[:space:]]*'"$term"'([[:space:]]*[|][|][[:space:]]*'"$term"')*[[:space:]]*[}][}][[:space:]]*$'
if [ "$(grep -cE "$shape" <<< "$no_cache")" -eq 1 ]; then ok "no-cache is one OR of matrix names"; else ko "build.yml's no-cache is not one plain OR of matrix.name terms: $no_cache"; fi
while read -r built; do
  [ -z "$built" ] && continue
  dockerfile="${built#dockerfile:}"
  name="$(sed -nE 's#^[[:space:]]*\[([A-Za-z0-9_-]+)\]="\./'"$dockerfile"'"[[:space:]]*$#\1#p' "$build_yml")"
  if [ -z "$name" ]; then ko "build.yml maps no matrix name to ./$dockerfile, so no release builds what the scan read"; continue; fi
  ok "build.yml builds ./$dockerfile as matrix name $name"
  if grep -qF "matrix.name == '$name'" <<< "$no_cache"; then ok "$name is built with no-cache"; else ko "build.yml builds $name from its cache, while the scan builds $dockerfile fresh"; fi
done < <(grep '^dockerfile:' <<< "$list")
if grep -q '^rust:' <<< "$list"; then ko "a rust builder image is scanned, and it never reaches an estate"; else ok "no rust builder image is in the list"; fi

echo "an interpolated reference is read as its default, and this repository's own images are left out:"
if grep -qE '^ghcr\.io/goauthentik/server:[0-9]' <<< "$list"; then ok "the identity provider's server image is in the list at its pinned tag"; else ko "the identity provider's server image is missing or unresolved"; fi
if grep -qF 'ghcr.io/emse-students/canari/' <<< "$list"; then ko "an image this repository builds is in the list"; else ok "no image this repository builds is in the list"; fi

echo "a source that cannot be read fails instead of shrinking the list:"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/infrastructure/local" "$work/infrastructure/authentik"
printf 'FROM alpine:3 AS b\nFROM debian:bookworm-slim\n' > "$work/infrastructure/local/Dockerfile.x"
printf 'services:\n  a:\n    image: redis:8\n' > "$work/infrastructure/docker-compose.prod.yml"
printf 'services:\n  a:\n    image: redis:8\n' > "$work/infrastructure/docker-compose.dev.yml"
# shellcheck disable=SC2016 # a compose file's own `${...}` is the fixture, written literally.
printf 'services:\n  a:\n    image: ${IMG:-postgres}:${TAG:-16-alpine}\n' > "$work/infrastructure/authentik/compose.yml"
got="$(bash "$script" "$work" 2>/dev/null | tr '\n' ' ')"
if [ "$got" = "debian:bookworm-slim postgres:16-alpine redis:8 " ]; then ok "a fixture reads as its shipped stage, its images and its defaults"; else ko "the fixture read as '$got'"; fi
printf 'FROM alpine:3 AS b\nRUN apk upgrade --no-cache x\nFROM debian:bookworm-slim\n# RUN apt-get upgrade, in a comment\n' > "$work/infrastructure/local/Dockerfile.y"
printf 'FROM alpine:3 AS b\nFROM alpine:3.23\nUSER root\nRUN apk upgrade --no-cache libpq\nUSER app\n' > "$work/infrastructure/local/Dockerfile.z"
got="$(bash "$script" "$work" 2>/dev/null | tr '\n' ' ')"
if [ "$got" = "debian:bookworm-slim dockerfile:infrastructure/local/Dockerfile.z postgres:16-alpine redis:8 " ]; then ok "an upgrade in the shipped stage makes the build the target; one in a builder stage or a comment does not"; else ko "the upgrade fixture read as '$got'"; fi
rm "$work/infrastructure/local/Dockerfile.y" "$work/infrastructure/local/Dockerfile.z"
# shellcheck disable=SC2016 # the same: a literal compose interpolation.
printf 'services:\n  a:\n    image: ${NO_DEFAULT}\n' > "$work/infrastructure/authentik/compose.yml"
if bash "$script" "$work" >/dev/null 2>&1; then ko "an image named by a variable with no default passed"; else ok "an image named by a variable with no default fails"; fi
rm "$work/infrastructure/docker-compose.dev.yml"
if bash "$script" "$work" >/dev/null 2>&1; then ko "a missing compose file passed"; else ok "a missing compose file fails"; fi

echo "image-scan.sh: a build target we own that does not build is a FINDING (1), an outage stays 2:"
# Stubs on PATH, no network: `trivy` answers every scan clean, `docker` fails every build.
stubs="$work/stubs"
mkdir -p "$stubs"
printf '#!/usr/bin/env bash\nexit 0\n' > "$stubs/trivy"
printf '#!/usr/bin/env bash\nexit 1\n' > "$stubs/docker"
chmod +x "$stubs/trivy" "$stubs/docker"
rc=0
out="$(PATH="$stubs:$PATH" bash "$here/../image-scan.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 1 ] && grep -F 'could not be built for the scan' <<< "$out" >/dev/null; then ok "a dockerfile: target that does not build exits 1, as a finding"; else ko "a failed dockerfile: build exited $rc: $(tail -2 <<< "$out")"; fi
printf '#!/usr/bin/env bash\nexit 1\n' > "$stubs/trivy"
rc=0
PATH="$stubs:$PATH" bash "$here/../image-scan.sh" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then ok "a database that cannot be downloaded is still an outage (2)"; else ko "a database outage exited $rc, not 2"; fi

echo "image-scan.sh: a build's context is what its COPY names; an IGNORED output is staged empty, a typo fails:"
# A throwaway repository holding the two scripts, the allowlist and one Dockerfile: `docker` records
# the context it was handed and fails (the finding path, already asserted above), `trivy` is clean.
fake="$work/repo"
mkdir -p "$fake/.github/scripts" "$fake/infrastructure/local" "$fake/infrastructure/authentik" "$fake/web/src"
cp "$here/../image-scan.sh" "$here/../image-scan-targets.sh" "$fake/.github/scripts/"
cp "$here/../../image-scan-allowlist.yaml" "$fake/.github/"
printf 'services:\n  a:\n    image: redis:8\n' | tee "$fake/infrastructure/docker-compose.prod.yml" "$fake/infrastructure/docker-compose.dev.yml" > "$fake/infrastructure/authentik/compose.yml"
printf '/web/build\n' > "$fake/.gitignore"
printf 'conf\n' > "$fake/web/src/nginx.conf"
printf 'FROM node:24 AS b\nFROM nginx:x\nRUN apk upgrade --no-cache libxml2\nCOPY --from=b /out /srv\nCOPY web/build/client web/src/nginx.conf /srv/\n' > "$fake/infrastructure/local/Dockerfile.web"
git -C "$fake" init -q
printf '#!/usr/bin/env bash\nexit 0\n' > "$stubs/trivy"
# shellcheck disable=SC2016 # the stub's own `$ctx` and `$*` expand when docker runs, not here.
printf '#!/usr/bin/env bash\nctx="${*: -1}"; (cd "$ctx" && find . | sort) > "%s/context-seen"; exit 1\n' "$work" > "$stubs/docker"
rc=0
PATH="$stubs:$PATH" bash "$fake/.github/scripts/image-scan.sh" >/dev/null 2>&1 || rc=$?
seen="$(tr '\n' ' ' < "$work/context-seen" 2>/dev/null)"
if [ "$seen" = ". ./web ./web/build ./web/build/client ./web/src ./web/src/nginx.conf " ]; then ok "the context holds the COPY sources, the ignored output empty, and no --from path"; else ko "the context read as '$seen'"; fi
if [ "$rc" -eq 1 ]; then ok "the build was still run (and its failure is a finding)"; else ko "the staged build exited $rc"; fi
rm -f "$work/context-seen"
printf 'FROM nginx:x\nRUN apk upgrade --no-cache libxml2\nCOPY web/tpyo /srv/\n' > "$fake/infrastructure/local/Dockerfile.web"
rc=0
out="$(PATH="$stubs:$PATH" bash "$fake/.github/scripts/image-scan.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 1 ] && [ ! -e "$work/context-seen" ] && grep -F 'git does not ignore it' <<< "$out" >/dev/null; then ok "a COPY source that is neither in the tree nor ignored fails before any build"; else ko "a missing, unignored COPY source exited $rc: $(tail -2 <<< "$out")"; fi
# The forms the reader does not stage are refused BY NAME, before any build: each must print its own
# refusal, not merely fail on a source that happens not to exist.
refusals=(
  'COPY ["web/src/nginx.conf", "/srv/"]|the JSON form is a COPY/ADD form this reader does not stage'
  'COPY <<EOF /srv/x|a heredoc is a COPY/ADD form this reader does not stage'
  'COPY web/src/*.conf /srv/|a glob (web/src/*.conf) is a COPY/ADD form this reader does not stage'
  'ADD https://example.org/x.tar /srv/|a remote source (https://example.org/x.tar) is a COPY/ADD form this reader does not stage'
)
for refusal in "${refusals[@]}"; do
  form="${refusal%%|*}"
  printf 'FROM nginx:x\nRUN apk upgrade --no-cache libxml2\n%s\n' "$form" > "$fake/infrastructure/local/Dockerfile.web"
  rc=0
  out="$(PATH="$stubs:$PATH" bash "$fake/.github/scripts/image-scan.sh" 2>&1)" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -e "$work/context-seen" ] && grep -F "Dockerfile.web: ${refusal#*|}" <<< "$out" >/dev/null && grep -F 'could not be staged' <<< "$out" >/dev/null; then ok "'$form' is refused by name"; else ko "'$form' exited $rc without its refusal: $(tail -3 <<< "$out")"; fi
done

echo "image-scan.sh --upgraded-packages: the packages the SHIPPED stage upgrades, whatever the line shape:"
cat > "$work/Dockerfile.shapes" <<'DF'
FROM alpine:3 AS builder
RUN apk upgrade --no-cache zlib
FROM nginx:x
RUN apk upgrade --no-cache \
    libxml2 \
    # a comment inside the continuation, which Docker drops
    libcurl && apk info -e libxml2
RUN apk upgrade libpq\
 && true
RUN apk upgrade openssl; echo done
RUN apk add --no-cache tini
DF
got="$(bash "$here/../image-scan.sh" --upgraded-packages "$work/Dockerfile.shapes" | tr '\n' ' ')"
if [ "$got" = "libcurl libpq libxml2 openssl " ]; then ok "a continued list, 'libpq\\', 'openssl;' read whole; the builder stage and 'apk add' are not"; else ko "the shapes read as '$got'"; fi
printf 'FROM nginx:x\nRUN apk upgrade --no-cache\n' > "$work/Dockerfile.all"
got="$(bash "$here/../image-scan.sh" --upgraded-packages "$work/Dockerfile.all")"
if [ -z "$got" ]; then ok "an upgrade naming no package names none"; else ko "a bare upgrade read as '$got'"; fi

echo "image-scan.sh --shipped-base: a stage or an ARG is followed to an image, or skipped with a reason:"
cat > "$work/Dockerfile.stages" <<'DF'
ARG TAG=1.31-alpine
FROM --platform=linux/amd64 nginx:${TAG} AS base
RUN apk upgrade --no-cache libxml2
FROM base AS middle
FROM middle
DF
got="$(bash "$here/../image-scan.sh" --shipped-base "$work/Dockerfile.stages")"
if [ "$got" = 'nginx:1.31-alpine' ]; then ok "a chain of stages and an ARG default resolve to the image"; else ko "the stage chain read as '$got'"; fi
# shellcheck disable=SC2016 # a literal, unexpanded build argument is the fixture.
printf 'FROM nginx:$NO_DEFAULT\n' > "$work/Dockerfile.arg"
got="$(bash "$here/../image-scan.sh" --shipped-base "$work/Dockerfile.arg")"
if [ "${got%% *}" = 'SKIP' ]; then ok "an ARG with no default is skipped with a reason"; else ko "an unresolved ARG read as '$got'"; fi

echo "image-scan.sh: an upgrade the bare base no longer needs is named in a warning, and fails nothing:"
# `docker` builds; `trivy` answers every scan clean except the bare base `nginx:x`, which reports
# libxml2 only while BASE_HAS_LIBXML2=1. The allowlist is empty, so no retirement is asked.
printf '# empty\n' > "$fake/.github/image-scan-allowlist.yaml"
printf 'FROM nginx:x\nRUN apk upgrade --no-cache libpq libxml2 && apk info -e libxml2\nCOPY web/src/nginx.conf /srv/\n' > "$fake/infrastructure/local/Dockerfile.web"
printf '#!/usr/bin/env bash\nexit 0\n' > "$stubs/docker"
cat > "$stubs/trivy" <<'STUB'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done
[ -n "$out" ] || exit 0
[ -n "${TRIVY_LOG:-}" ] && printf '%s\n' "${*: -1}" >> "$TRIVY_LOG"
if [ "${*: -1}" = 'nginx:x' ] && [ "${BASE_HAS_LIBXML2:-0}" = 1 ]; then
  printf '{"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-1","PkgName":"libxml2","InstalledVersion":"1"}]}]}\n' > "$out"
else
  printf '{"Results":[]}\n' > "$out"
fi
STUB
warning='::warning title=Image scan, an upgrade is likely a no-op::'
rc=0
out="$(BASE_HAS_LIBXML2=1 PATH="$stubs:$PATH" bash "$fake/.github/scripts/image-scan.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && grep -F 'libxml2: its base nginx:x still needs the upgrade' <<< "$out" >/dev/null; then ok "a package the base still reports is kept, silently"; else ko "the needed upgrade read as $rc: $(grep -E 'libxml2|::' <<< "$out")"; fi
if grep -F "${warning}no fixable HIGH/CRITICAL advisory left on libpq in nginx:x: the upgrade of libpq in infrastructure/local/Dockerfile.web is likely a no-op, check and delete it" <<< "$out" >/dev/null; then ok "a package the base no longer reports is named, as LIKELY a no-op"; else ko "no warning named libpq: $(grep -E 'libpq|::' <<< "$out")"; fi
rc=0
out="$(BASE_HAS_LIBXML2=0 PATH="$stubs:$PATH" bash "$fake/.github/scripts/image-scan.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -cF "$warning" <<< "$out")" -eq 2 ]; then ok "once the base carries both fixes, both packages are named, and the run still passes"; else ko "the fixed base read as $rc: $(grep -E '::' <<< "$out")"; fi
# A shipped stage that is an earlier stage is compared with THAT stage's image; one starting from an
# unresolved ARG is skipped with its reason, never scanned and never an outage.
printf 'FROM nginx:x AS base\nFROM base\nRUN apk upgrade --no-cache libpq libxml2\nCOPY web/src/nginx.conf /srv/\n' > "$fake/infrastructure/local/Dockerfile.web"
rc=0
out="$(BASE_HAS_LIBXML2=1 PATH="$stubs:$PATH" bash "$fake/.github/scripts/image-scan.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && grep -F 'libxml2: its base nginx:x still needs the upgrade' <<< "$out" >/dev/null; then ok "FROM <stage> is compared with the stage's own image"; else ko "FROM <stage> read as $rc: $(grep -E 'base|::' <<< "$out")"; fi
# shellcheck disable=SC2016 # a literal, unexpanded build argument is the fixture.
printf 'FROM nginx:$NO_DEFAULT\nRUN apk upgrade --no-cache libpq\nCOPY web/src/nginx.conf /srv/\n' > "$fake/infrastructure/local/Dockerfile.web"
rc=0
: > "$work/trivy-log"
out="$(TRIVY_LOG="$work/trivy-log" PATH="$stubs:$PATH" bash "$fake/.github/scripts/image-scan.sh" 2>&1)" || rc=$?
# shellcheck disable=SC2016 # a literal, unexpanded build argument is the fixture.
if [ "$rc" -eq 0 ] && grep -F 'its upgrades are not compared with a base - the shipped stage starts from nginx:$NO_DEFAULT' <<< "$out" >/dev/null && ! grep -qF 'NO_DEFAULT' "$work/trivy-log"; then ok "an unresolved ARG is skipped with its reason, not scanned, not an outage"; else ko "the unresolved ARG read as $rc: $(grep -E 'compared|::' <<< "$out")"; fi

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "OK: the image scan reads every image the estates run."
