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

# ONE INSTANCE PER CHECKOUT: two worktrees running this at once must never share a compose project,
# or one's `down -v` kills the other's database. The suffix is a hash of this checkout's path;
# MICONNECT_TEST_PROJECT overrides it.
project="${MICONNECT_TEST_PROJECT:-miconnect-blueprint-test-$(printf '%s' "$here" | cksum | cut -d' ' -f1)}"
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
MICONNECT_READER_TOKEN=blueprint-test-reader-token-0123456789abcdef
AUTHENTIK_PUBLISH=127.0.0.1:0
EOF

echo "starting a fresh MiConnect ($(grep -o 'AUTHENTIK_TAG:-[^}]*' "$work/compose.yml" | sed -n 1p))"
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
  # PREVIOUS_REF (CI passes the tested commit's first parent: the main it sits on, never a newer
  # one, whose blueprints may need what this tree's compose.yml does not give the worker), then apply
  # these over it. A fresh instance alone never runs a rename entry, since no old name exists on it.
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
if ! run_ak_shell "$worker" <"$here/test-enrollment-flow.py" 2>&1 | tee >(cat >&2) | grep -x 'ENROLLMENT-OK' >/dev/null; then
  echo "::error::the enrolment flow did not behave - read the assertion above"
  exit 1
fi
echo "the enrolment flow lets the right people in, refuses the others, and writes the profile"

# THE WAYS IN THAT ARE NOT THE CAS, DRIVEN. A password sign-in refuses a superuser, asks for a second
# factor that exists, and stops after five wrong passwords; the enrolment flow does not plan without a
# source (infrastructure/authentik/test-password-guard.py).
echo "password sign-in and direct enrolment: driving them through the executor"
if ! run_ak_shell "$worker" <"$here/test-password-guard.py" 2>&1 | tee >(cat >&2) | grep -x 'PASSWORD-GUARD-OK' >/dev/null; then
  echo "::error::a way into MiConnect that is not the CAS is not guarded - read the assertion above"
  exit 1
fi
echo "password sign-in is guarded and enrolment starts only from a source"

# THE PROFILE EDITOR, USED. Applying 80-profile-editor.yaml proves the account, role and token exist;
# only calling the API with the token shows what a holder of it can DO - read and change users, and
# nothing else (infrastructure/authentik/test-profile-editor.py).
echo "profile editor: calling the API with its token"
if ! run_ak_shell "$worker" <"$here/test-profile-editor.py" 2>&1 | tee >(cat >&2) | grep -x 'PROFILE-EDITOR-OK' >/dev/null; then
  echo "::error::the profile editor's token does not behave - read the assertion above"
  exit 1
fi
echo "the profile editor reads and changes users, and nothing else"

# THE HANDOFF READER, USED. What core-service's mint reads (a user by uuid, the three handoff
# applications, their bindings, the default-access flag) and nothing else: no other application, no
# write (infrastructure/authentik/test-handoff-reader.py).
echo "handoff reader: calling the API with its token"
if ! run_ak_shell "$worker" <"$here/test-handoff-reader.py" 2>&1 | tee >(cat >&2) | grep -x 'HANDOFF-READER-OK' >/dev/null; then
  echo "::error::the handoff reader's token does not behave - read the assertion above"
  exit 1
fi
echo "the handoff reader reads what the mint needs, and nothing else"

# PKCE, REDEEMED. Canari's sign-in sends an S256 challenge and core-service redeems the code with its
# verifier; what makes a captured code worthless is MiConnect REFUSING it without the verifier. Only
# the real token endpoint shows that (infrastructure/authentik/test-pkce.py).
echo "PKCE: authorizing with a challenge and redeeming with and without the verifier"
if ! run_ak_shell "$worker" <"$here/test-pkce.py" 2>&1 | tee >(cat >&2) | grep -x 'PKCE-OK' >/dev/null; then
  echo "::error::MiConnect did not enforce PKCE as the sign-in relies on - read the assertion above"
  exit 1
fi
echo "a challenged code is redeemed with its verifier only, and a verifier is never ignored"

# THE TERMS OF USE, DRIVEN. 45-consent.yaml builds the flow on every instance; which providers ask
# for it is declared in 50-providers.yaml: all eight since the hold on production was lifted
# (2026-11-20). The driven test asserts that exact set, walks the page on a bound provider, and
# proves production's provider stops a person who never accepted on it (test-consent-flow.py).
echo "terms of use: driving the stage, and asserting which providers ask for it"
# It also runs every case of libs/contracts/alumni-access.json, the table core-service's handoff gate
# runs too: handed in base64 ahead of the program, since the container holds no repository.
alumni_access="$(base64 <"$here/../../libs/contracts/alumni-access.json" | tr -d '\n')"
if ! { printf 'ALUMNI_ACCESS_B64 = "%s"\n' "$alumni_access"; cat "$here/test-consent-flow.py"; } | run_ak_shell "$worker" 2>&1 | tee >(cat >&2) | grep -x 'CONSENT-OK' >/dev/null; then
  echo "::error::the terms-of-use stage did not behave, or a provider outside the declared set asks for it - read the assertion above"
  exit 1
fi
echo "the terms stage asks on every provider, once per version"

# EVERY SAML SOURCE IS SIGNED AND GATED. A SAML source with no verification key pair verifies no
# signature (authentik's ResponseProcessor.parse checks signatures only `if source.verification_kp`),
# so if such a source is ENABLED a forged, unsigned assertion is accepted and enrols an account. This
# asserts, on the instance just built, that the configuration can never be in that shape: no source
# is enabled without a verification key pair, every source demands a signed response AND a signed
# assertion, no source runs a weak (SHA-1/MD5) signature or digest algorithm, none allows
# IdP-initiated SSO (which skips request-ID validation), and each uses an expected NameID format.
echo "SAML sources: signed on both levels, no weak algorithm, and none enabled without a certificate"
if ! run_ak_shell "$worker" 2>&1 <<'PY' | tee >(cat >&2) | grep -x 'SAML-SOURCES-OK' >/dev/null; then
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

# THE LOGIN BUTTON'S NAME, AND THE TWO DEV TILES. The CAS source is identified by its slug, so its
# display name ("Continue with <name>") is renamed in place: one source, not a second one. The dev and
# local applications are hidden from the application library WITHOUT a policy binding (a binding would
# gate sign-in to dev and to the local estate); every other application stays listed.
echo "login polish: the CAS button name, and the dev tiles hidden but not gated"
if ! run_ak_shell "$worker" 2>&1 <<'PY' | tee >(cat >&2) | grep -x 'LOGIN-POLISH-OK' >/dev/null; then
from authentik.core.models import Application
from authentik.policies.models import PolicyBinding
from authentik.sources.oauth.models import OAuthSource

cas = OAuthSource.objects.filter(slug="cas-emse")
assert cas.count() == 1 and cas.first().name == "CAS EMSE", [(s.slug, s.name) for s in cas]
assert not OAuthSource.objects.filter(name="Cas EMSE").exists(), "the old-named source is still there"
for slug in ("canari-dev", "canari-local"):
    app = Application.objects.get(slug=slug)
    assert app.meta_hide is True, f"{slug} is listed on the dashboard"
    assert not PolicyBinding.objects.filter(target=app).exists(), f"{slug} is gated by a binding"
for slug in ("canari", "archives", "sky"):
    assert Application.objects.get(slug=slug).meta_hide is False, f"{slug} must stay listed"

# BEHAVIOUR, NOT THE FIELD: as an ordinary signed-in person, the library the dashboard lists omits the
# dev tiles and keeps `canari`, and an authorization against the dev provider is still granted.
import json, secrets
from urllib.parse import parse_qs, urlencode, urlparse

from django.conf import settings
from django.test import Client

from authentik.core.models import User
from authentik.providers.oauth2.models import OAuth2Provider
from authentik.root.middleware import SessionMiddleware
from authentik.stages.prompt.models import Prompt

person, _ = User.objects.get_or_create(username="login-polish-probe", defaults={"name": "Login polish probe"})
person.attributes["cgu_version"] = Prompt.objects.get(name="miconnect-consent-prompt-version").initial_value
person.save()
assert not person.is_superuser


def client_for(u):
    c = Client(HTTP_HOST="localhost")
    c.force_login(u)
    c.cookies[settings.SESSION_COOKIE_NAME] = SessionMiddleware.encode_session(c.session.session_key, u)
    return c


listing = client_for(person).get("/api/v3/core/applications/?page_size=200")
assert listing.status_code == 200, listing.status_code
listed = {a["slug"] for a in listing.json()["results"]}
assert "canari" in listed, f"canari must stay listed: {sorted(listed)}"
assert not listed & {"canari-dev", "canari-local"}, f"hidden tiles are listed: {sorted(listed)}"

dev = OAuth2Provider.objects.get(name="miconnect-canari-dev")
redirect = "https://dev.canari-emse.fr/auth/callback"
query = urlencode({"client_id": dev.client_id, "redirect_uri": redirect, "response_type": "code",
                   "scope": "openid profile", "state": secrets.token_urlsafe(8)})
c = client_for(person)
resp = c.get(f"/application/o/authorize/?{query}")
target = resp.get("Location", "") if resp.status_code in (301, 302) else ""
if not target.startswith(redirect):
    body = c.get(f"/api/v3/flows/executor/{dev.authorization_flow.slug}/?{urlencode({'query': query})}").json()
    target = body.get("to", "")
    assert target.startswith(redirect), f"authorizing on dev was refused: {json.dumps(body)[:400]}"
assert "code" in parse_qs(urlparse(target).query), target
print("LOGIN-POLISH-OK")
PY
  echo "::error::the CAS button name or the hidden dev tiles are wrong - read the assertion above"
  exit 1
fi
echo "the CAS button reads CAS EMSE and the dev tiles are hidden, not gated"
