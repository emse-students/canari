#!/usr/bin/env bash
#
# Asserts the HOLD of a MiConnect blueprint: a file in `infrastructure/authentik/blueprints/held/` is
# never sent to authentik, is NAMED at every run of apply-blueprints.sh, and no blueprint that IS sent
# finds an object only a held file would create.
#
# WHY IT EXISTS. On 2026-10-17 the user decided that stable 1.2.9 ships WITHOUT the terms-of-use
# stage (45-consent.yaml, #1955), already merged and inside its pre-releases; the stable deploy runs
# `apply-blueprints.sh apply`, a production write on the identity provider. A hold that only a
# comment states is one the next edit undoes in silence, so the real script is run here against the
# real tree, with a fake transport that records the program it would have sent. Lifting the hold is
# `git revert` of the commit that wrote this file (docs/wiki/backlog.md).
#
# Run by `make test-ci-scripts` and by CI. No Docker, no network.
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1

failures=0
checks=0
pass() { checks=$((checks + 1)); echo "  ok   $1"; }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); echo "  FAIL  $1"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The transport: apply-blueprints.sh runs `$AK_REMOTE docker exec ...` with the program on stdin.
cat >"$tmp/fake-remote" <<EOF
#!/usr/bin/env bash
cat >"$tmp/program"
EOF
chmod +x "$tmp/fake-remote"

blueprints="infrastructure/authentik/blueprints"

echo "held blueprints - the real tree, through the real script"
if AK_REMOTE="$tmp/fake-remote" bash infrastructure/authentik/apply-blueprints.sh dry-run >"$tmp/out" 2>"$tmp/err"; then
  pass "apply-blueprints.sh runs on the tree"
else
  fail "apply-blueprints.sh failed: $(cat "$tmp/err")"
fi

held_count=0
for file in "$blueprints"/held/*.yaml; do
  [ -e "$file" ] || continue
  held_count=$((held_count + 1))
  name="$(basename "$file")"
  if grep -q "held/$name is NOT applied" "$tmp/err"; then pass "the run NAMES held/$name"; else fail "the run is silent about held/$name"; fi
  if grep -q "BLUEPRINTS.append(('$name'," "$tmp/program"; then fail "held/$name was SENT to authentik"; else pass "held/$name is not sent"; fi
done
# THE HOLD THE USER DECIDED, named rather than derived: an empty held/ would pass every loop above.
if [ -f "$blueprints/held/45-consent.yaml" ] && [ ! -e "$blueprints/45-consent.yaml" ]; then
  pass "45-consent.yaml (the terms stage) is held"
else
  fail "45-consent.yaml is not held - lifting the hold is a revert of its commit, together with this test"
fi
if grep -q "BLUEPRINTS.append(('50-providers.yaml'," "$tmp/program"; then pass "an active blueprint is still sent"; else fail "50-providers.yaml was not sent"; fi

# No active blueprint may !Find what only a held one defines: on production the object does not
# exist, and the apply would fail (or worse, set a reference to nothing).
defined="$(awk '
  /^[[:space:]]*identifiers:/ { match($0, /^[[:space:]]*/); depth = RLENGTH; inside = 1; next }
  inside { match($0, /^[[:space:]]*/); if (RLENGTH <= depth) { inside = 0 } else if ($1 ~ /^(slug|name):$/) { v = $2; gsub(/"/, "", v); print v } }
' "$blueprints"/held/*.yaml 2>/dev/null | sort -u)"
dangling=""
for value in $defined; do
  if grep -l "!Find.*\"$value\"" "$blueprints"/*.yaml >/dev/null 2>&1; then
    dangling="$dangling $value($(grep -l "!Find.*\"$value\"" "$blueprints"/*.yaml | xargs -n1 basename | tr '\n' ' '))"
  fi
done
if [ "$held_count" -gt 0 ] && [ -z "$defined" ]; then
  fail "read no identifier in the held blueprints - the file changed shape, fix this test with it"
elif [ -z "$dangling" ]; then
  pass "no active blueprint finds an object only a held one defines"
else
  fail "active blueprints find held objects:$dangling"
fi

echo "$checks checks, $failures failure(s)"
[ "$failures" -eq 0 ]
