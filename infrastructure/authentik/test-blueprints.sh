#!/usr/bin/env bash
# Builds a FRESH MiConnect from this directory's compose.yml and proves the blueprints on it:
#   1. they apply to an empty authentik, every !Find and !Env resolving;
#   2. applying them a SECOND time changes nothing (0 change(s)) - a blueprint that keeps rewriting
#      a field would rewrite it on production at every release.
# With PREVIOUS_REF=<git ref>, step 1 starts from that ref's blueprints instead of an empty instance,
# so every RENAME entry actually runs, and the applier refuses one that leaves its old object.
#
# Run by CI (job `test-miconnect-blueprints`) and runnable on any machine with Docker. It uses the
# real compose.yml under a throwaway project name, so the file production runs is what boots here,
# and it removes its containers and volume on exit.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# The terms-of-use version is one value in four files; checked before any container starts.
bash "$here/check-consent-version.sh"

project="miconnect-blueprint-test"
work="$(mktemp -d)"

cleanup() {
  docker compose -p "$project" --project-directory "$work" -f "$work/compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

cp "$here/compose.yml" "$work/compose.yml"
# Throwaway values. The secret key only has to be long; the CAS secret only has to be SET, since
# this instance never talks to the CAS.
cat >"$work/.env" <<EOF
PG_PASS=blueprint-test
AUTHENTIK_SECRET_KEY=blueprint-test-$(date +%s)-0123456789abcdef0123456789abcdef
MIGALLERY_AVATAR_SIGNING_KEY=blueprint-test
MICONNECT_CAS_CONSUMER_SECRET=blueprint-test
MICONNECT_EDITOR_TOKEN=blueprint-test-editor-token-0123456789abcdef
AUTHENTIK_PUBLISH=127.0.0.1:0
EOF

echo "starting a fresh MiConnect ($(grep -o 'AUTHENTIK_TAG:-[^}]*' "$work/compose.yml" | head -1))"
docker compose -p "$project" --project-directory "$work" -f "$work/compose.yml" up -d --quiet-pull

worker="${project}-worker-1"
# READY MEANS authentik's OWN blueprints have all applied - ours !Find its default flows, stages
# and mappings. What ends the wait (and what happens when one never applies) is in the sourced file.
echo "waiting for authentik's default blueprints"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=wait-default-blueprints.sh
. "$here/wait-default-blueprints.sh"
wait_for_default_blueprints "$worker"

if [ -n "${PREVIOUS_REF:-}" ]; then
  # The UPGRADE path, which is the one production takes: build the instance from the blueprints at
  # PREVIOUS_REF (CI passes main), then apply these over it. A fresh instance alone never runs a
  # rename entry, since no old name exists on it.
  mkdir -p "$work/previous/blueprints"
  # From the repository ROOT: run inside a subdirectory, `git archive` prefixes even a `ref:path`
  # tree with that subdirectory and extracts nothing.
  root="$(git -C "$here" rev-parse --show-toplevel)"
  git -C "$root" archive "$PREVIOUS_REF:infrastructure/authentik/blueprints" | tar -x -C "$work/previous/blueprints"
  if ! compgen -G "$work/previous/blueprints/*.yaml" >/dev/null; then
    echo "::error::$PREVIOUS_REF has no infrastructure/authentik/blueprints/*.yaml to upgrade from"
    exit 1
  fi
  echo "previous apply: builds the instance from $PREVIOUS_REF's blueprints"
  BLUEPRINTS_DIR="$work/previous/blueprints" bash "$here/apply-blueprints.sh" apply "$worker"
  echo "first apply: upgrades it to these blueprints"
else
  echo "first apply: builds everything"
fi
bash "$here/apply-blueprints.sh" apply "$worker"

echo "second apply: must change nothing"
second="$(bash "$here/apply-blueprints.sh" apply "$worker" 2>&1 | tee >(cat >&2) | grep -E '^\[miconnect-blueprints\] [0-9]+ change\(s\)$')"
if [ "$second" != "[miconnect-blueprints] 0 change(s)" ]; then
  echo "::error::the blueprints are not idempotent - a second apply reported: ${second:-no change count at all}"
  exit 1
fi
echo "blueprints apply to a fresh instance and are idempotent"

# THE ENROLMENT FLOW, DRIVEN. Applying its blueprint proves the objects exist; only the flow
# executor shows what a person gets - the pages, the refusals, the profile written. The script
# prints ENROLLMENT-OK or raises (infrastructure/authentik/test-enrollment-flow.py).
echo "enrolment flow: driving it through the executor"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=ak-shell.sh
. "$here/ak-shell.sh"
if ! run_ak_shell "$worker" <"$here/test-enrollment-flow.py" 2>&1 | tee >(cat >&2) | grep -qx 'ENROLLMENT-OK'; then
  echo "::error::the enrolment flow did not behave - read the assertion above"
  exit 1
fi
echo "the enrolment flow lets the right people in, refuses the others, and writes the profile"

# THE WAYS IN THAT ARE NOT THE CAS, DRIVEN. A password sign-in refuses a superuser, asks for a second
# factor that exists, and stops after five wrong passwords; the enrolment flow does not plan without a
# source (infrastructure/authentik/test-password-guard.py).
echo "password sign-in and direct enrolment: driving them through the executor"
if ! run_ak_shell "$worker" <"$here/test-password-guard.py" 2>&1 | tee >(cat >&2) | grep -qx 'PASSWORD-GUARD-OK'; then
  echo "::error::a way into MiConnect that is not the CAS is not guarded - read the assertion above"
  exit 1
fi
echo "password sign-in is guarded and enrolment starts only from a source"

# THE PROFILE EDITOR, USED. Applying 80-profile-editor.yaml proves the account, role and token exist;
# only calling the API with the token shows what a holder of it can DO - read and change users, and
# nothing else (infrastructure/authentik/test-profile-editor.py).
echo "profile editor: calling the API with its token"
if ! run_ak_shell "$worker" <"$here/test-profile-editor.py" 2>&1 | tee >(cat >&2) | grep -qx 'PROFILE-EDITOR-OK'; then
  echo "::error::the profile editor's token does not behave - read the assertion above"
  exit 1
fi
echo "the profile editor reads and changes users, and nothing else"

# PKCE, REDEEMED. Canari's sign-in sends an S256 challenge and core-service redeems the code with its
# verifier; what makes a captured code worthless is MiConnect REFUSING it without the verifier. Only
# the real token endpoint shows that (infrastructure/authentik/test-pkce.py).
echo "PKCE: authorizing with a challenge and redeeming with and without the verifier"
if ! run_ak_shell "$worker" <"$here/test-pkce.py" 2>&1 | tee >(cat >&2) | grep -qx 'PKCE-OK'; then
  echo "::error::MiConnect did not enforce PKCE as the sign-in relies on - read the assertion above"
  exit 1
fi
echo "a challenged code is redeemed with its verifier only, and a verifier is never ignored"

# THE TERMS OF USE ARE HELD (user, 2026-10-17: stable 1.2.9 ships without them; docs/wiki/backlog.md).
# 45-consent.yaml waits in blueprints/held/, so the driven test (test-consent-flow.py) has no stage to
# drive. What is asserted instead is the hold itself, on the instance just built: no provider
# authorizes through `miconnect-authorization` - on the upgrade run the flow EXISTS (main's blueprints
# made it), so this is what proves these blueprints switch every provider back. Lifting the hold is
# `git revert` of the commit that wrote this, which brings the driven test back.
echo "terms of use: HELD - asserting no provider authorizes through miconnect-authorization"
if ! run_ak_shell "$worker" 2>&1 <<'PY' | tee >(cat >&2) | grep -qx 'CONSENT-HELD-OK'; then
from authentik.providers.oauth2.models import OAuth2Provider
on_flow = sorted(OAuth2Provider.objects.filter(authorization_flow__slug="miconnect-authorization").values_list("name", flat=True))
assert not on_flow, f"providers still on the held terms flow: {on_flow}"
print("CONSENT-HELD-OK")
PY
  echo "::error::a provider still authorizes through the held terms flow - read the assertion above"
  exit 1
fi
echo "the terms stage is held: every provider authorizes through the implicit-consent flow"

# EVERY SAML SOURCE IS SIGNED AND GATED. A SAML source with no verification key pair verifies no
# signature (authentik's ResponseProcessor.parse checks signatures only `if source.verification_kp`),
# so if such a source is ENABLED a forged, unsigned assertion is accepted and enrols an account. This
# asserts, on the instance just built, that the configuration can never be in that shape: no source
# is enabled without a verification key pair, every source demands a signed response AND a signed
# assertion, no source runs a weak (SHA-1/MD5) signature or digest algorithm, none allows
# IdP-initiated SSO (which skips request-ID validation), and each uses an expected NameID format.
echo "SAML sources: signed on both levels, no weak algorithm, and none enabled without a certificate"
if ! run_ak_shell "$worker" 2>&1 <<'PY' | tee >(cat >&2) | grep -qx 'SAML-SOURCES-OK'; then
from authentik.sources.saml.models import SAMLSource

ALLOWED_NAME_ID = {
    "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
}
WEAK = ("sha1", "md5", "#rsa-sha1", "#dsa-sha1")

problems = []
for s in SAMLSource.objects.all():
    tag = f"saml source '{s.slug}'"
    if not s.signed_assertion:
        problems.append(f"{tag}: signed_assertion is False (unsigned assertions would be accepted)")
    if not s.signed_response:
        problems.append(f"{tag}: signed_response is False (unsigned responses would be accepted)")
    if s.allow_idp_initiated:
        problems.append(f"{tag}: allow_idp_initiated is True (request-ID validation is skipped)")
    for field in ("signature_algorithm", "digest_algorithm"):
        val = (getattr(s, field, "") or "").lower()
        if not val:
            problems.append(f"{tag}: {field} is empty")
        elif any(w in val for w in WEAK):
            problems.append(f"{tag}: {field} is weak ({getattr(s, field)})")
    if s.name_id_policy not in ALLOWED_NAME_ID:
        problems.append(f"{tag}: name_id_policy {s.name_id_policy!r} is not in the allowlist")
    # The invariant: the IdP's certificate is what makes verification possible, so it is required the
    # instant a source is enabled. A source that lacks it must stay disabled.
    if s.enabled and s.verification_kp is None:
        problems.append(f"{tag}: ENABLED with no verification_kp (signatures are not verified)")

if problems:
    for p in problems:
        print("  -", p)
    raise SystemExit("a SAML source is unsigned, weakly signed, or enabled without a certificate")
print("SAML-SOURCES-OK")
PY
  echo "::error::a SAML source is unsigned, weakly signed, or enabled without a verification certificate - read the assertion above"
  exit 1
fi
echo "every SAML source is signed, strongly, and none is enabled without a verification certificate"
