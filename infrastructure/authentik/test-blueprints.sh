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
# The gate's generated configuration, mounted by the `gate` service (compose.yml).
cp -R "$here/leave-in-app-browser" "$work/leave-in-app-browser"
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
  # PRODUCTION'S DAILY CHECK BEFORE THE STABLE THAT BRINGS THE WRITE FLOW: main's editor-reach.sh with
  # the RELEASED (here: previous) blueprint, on an instance built from it, must be green - a released
  # file that declares no write flow is not a finding, or the drift job would be red from the merge on.
  if [ -f "$work/previous/blueprints/80-profile-editor.yaml" ]; then
    echo "profile editor: the reach check, with the previous blueprint, on the previous instance"
    if ! bash "$here/editor-reach.sh" "$work/previous/blueprints/80-profile-editor.yaml" "$worker"; then
      echo "::error::editor-reach.sh is red on an instance built from $PREVIOUS_REF with its own blueprint - production's daily check would be red until the stable"
      exit 1
    fi
  fi
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
echo "the profile editor reads users and writes through its one flow, and nothing else"

# THE EDITOR'S REACH, REPORTED as production's daily job reports it (editor-reach.sh): after the token
# test above wrote through the flow and was refused everything else, the account holds exactly the
# blueprint's grant and every write it authored is an expected one.
echo "profile editor: its grant and the writes it authored"
if ! bash "$here/editor-reach.sh" "$here/blueprints/80-profile-editor.yaml" "$worker"; then
  echo "::error::the profile editor's reach is not what its blueprint grants - read the FINDING lines above"
  exit 1
fi
# A CHECK NEVER SEEN RED PROVES NOTHING. Each of these, planted and then removed, must turn it red: a
# grant the applier would not revoke (an object permission on one user), a write through another path
# (a deletion recorded as the account's), a PATCH of a user made after the older path closed (a write
# whose path was once expected, past its cutoff), a second token for the account, a second
# policy binding on the write flow, and on a gated provider the refresh grant or an offline_access
# mapping (part 4, the read-only form of test-refresh-gate.py's check).
# It tests the DETECTOR, which an upgrade does not change, so it runs on a fresh instance only (the
# CI job's fresh leg); the upgraded leg runs the cutoff's own checks below.
if [ -z "${PREVIOUS_REF:-}" ]; then
for plant in grant write patch token binding refresh offline; do
  run_ak_shell "$worker" >/dev/null 2>&1 <<PY
from authentik.core.models import Token, TokenIntents, User
from authentik.events.models import Event
from authentik.flows.models import Flow
from authentik.policies.models import PolicyBinding
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping
editor = User.objects.get(username="miconnect-canari-editor")
other = User.objects.exclude(pk=editor.pk).exclude(type="internal_service_account").first()
def planted(method, path, action):
    Event.objects.create(action=action, app="test", user={"pk": editor.pk, "username": editor.username}, context={"model": {"app": "authentik_core", "model_name": "user"}, "http_request": {"path": path, "method": method}}, client_ip="127.0.0.1")
if "$plant" == "grant":
    editor.get_managed_role(create=True).assign_perms("authentik_core.change_user", other)
elif "$plant" == "write":
    planted("DELETE", "/api/v3/core/users/1/", "model_deleted")
elif "$plant" == "patch":
    planted("PATCH", "/api/v3/core/users/1/", "model_updated")
elif "$plant" == "token":
    Token.objects.create(identifier="editor-reach-planted", user=editor, intent=TokenIntents.INTENT_API, expiring=False)
elif "$plant" == "refresh":
    provider = OAuth2Provider.objects.get(name="miconnect-migallery")
    provider.grant_types = [*provider.grant_types, "refresh_token"]
    provider.save()
elif "$plant" == "offline":
    OAuth2Provider.objects.get(name="miconnect-migallery").property_mappings.add(ScopeMapping.objects.get(managed="goauthentik.io/providers/oauth2/scope-offline_access"))
else:
    PolicyBinding.objects.create(target=Flow.objects.get(slug="miconnect-profile-write"), user=other, order=99)
PY
  # RED FOR THE RIGHT REASON: the plant's own FINDING line, never a bare non-zero exit, which a crash
  # (a no-verdict) would also give.
  case "$plant" in
    grant) expected='FINDING  role .* holds the object permission authentik_core.change_user on one object' ;;
    write) expected='FINDING  event .*: model_deleted of authentik_core.user through DELETE ' ;;
    patch) expected='FINDING  event .*: model_updated of authentik_core.user through PATCH ' ;;
    token) expected='FINDING  the account holds 2 token\(s\), not exactly its own one' ;;
    binding) expected='FINDING  the write flow carries 2 policy binding\(s\), not exactly the editors. group' ;;
    refresh) expected='FINDING  provider miconnect-migallery of gated application migallery allows the refresh_token grant' ;;
    offline) expected='FINDING  provider miconnect-migallery of gated application migallery carries an offline_access scope mapping' ;;
  esac
  reach_status=0
  reach_output="$(bash "$here/editor-reach.sh" "$here/blueprints/80-profile-editor.yaml" "$worker" 2>&1)" || reach_status=$?
  if [ "$reach_status" -eq 0 ] || ! grep -Eq "$expected" <<<"$reach_output"; then
    printf '%s\n' "$reach_output"
    echo "::error::editor-reach.sh did not report a planted $plant by its own FINDING (exit $reach_status) - the daily check would miss one"
    exit 1
  fi
  echo "planted $plant: reported ($(grep -Eo -m 1 "$expected" <<<"$reach_output"))"
  run_ak_shell "$worker" >/dev/null 2>&1 <<PY
from authentik.core.models import Token, User
from authentik.events.models import Event
from authentik.policies.models import PolicyBinding
editor = User.objects.get(username="miconnect-canari-editor")
role = editor.get_managed_role()
if role is not None:
    role.delete()
Event.objects.filter(app="test", user__username=editor.username).delete()
Token.objects.filter(identifier="editor-reach-planted").delete()
PolicyBinding.objects.filter(target__flow__slug="miconnect-profile-write", order=99).delete()
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping
provider = OAuth2Provider.objects.get(name="miconnect-migallery")
provider.grant_types = [g for g in provider.grant_types if g != "refresh_token"]
provider.save()
provider.property_mappings.remove(*ScopeMapping.objects.filter(scope_name="offline_access"))
PY
done
if ! bash "$here/editor-reach.sh" "$here/blueprints/80-profile-editor.yaml" "$worker" >/dev/null 2>&1; then
  echo "::error::editor-reach.sh stays red after every planted fault was removed"
  exit 1
fi
echo "the profile editor holds exactly its grant, and the check sees each planted fault"
else
  echo "the planted-fault self-test of the reach check runs in the fresh leg (it tests the detector, which an upgrade does not change)"
fi
# THE CUTOFF, PROVEN ON THE UPGRADE: the applier recorded exactly one revocation of the old user-change
# permission on the editor role, and a PATCH Event dated before it is accepted (an older write on the
# path that was open then) - the green half of the `patch` plant above. Only on an upgrade FROM a
# blueprint that still granted it: once main carries this file, there is nothing left to revoke.
if [ -n "${PREVIOUS_REF:-}" ] && grep -q 'authentik_core.change_user' "$work/previous/blueprints/80-profile-editor.yaml" 2>/dev/null; then
  if ! run_ak_shell "$worker" 2>&1 <<'PY' | grep -x 'CUTOFF-PLANTED' >/dev/null; then
from datetime import timedelta
from authentik.core.models import User
from authentik.events.models import Event
editor = User.objects.get(username="miconnect-canari-editor")
revoked = list(Event.objects.filter(action="custom_role_permission_revoked", context__role="miconnect-profile-editor", context__permission="authentik_core.change_user"))
if len(revoked) != 1:
    raise SystemExit(f"{len(revoked)} revocation Event(s), not exactly one")
older = Event.objects.create(action="model_updated", app="test", user={"pk": editor.pk, "username": editor.username}, context={"model": {"app": "authentik_core", "model_name": "user"}, "http_request": {"path": "/api/v3/core/users/1/", "method": "PATCH"}}, client_ip="127.0.0.1")
Event.objects.filter(pk=older.pk).update(created=revoked[0].created - timedelta(seconds=1))
print("CUTOFF-PLANTED")
PY
    echo "::error::the upgrade did not record exactly one revocation Event, or the pre-cutoff PATCH could not be planted"
    exit 1
  fi
  if ! bash "$here/editor-reach.sh" "$here/blueprints/80-profile-editor.yaml" "$worker"; then
    echo "::error::editor-reach.sh reports a PATCH made before the recorded revocation - the cutoff is not honoured"
    exit 1
  fi
  run_ak_shell "$worker" >/dev/null 2>&1 <<'PY'
from authentik.events.models import Event
Event.objects.filter(app="test").delete()
PY
  echo "the upgrade recorded its revocation once, and a PATCH older than it is accepted"
fi

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

# THE REFRESH GRANT, CLOSED ON GATED PROVIDERS. authentik's refresh_token grant evaluates no binding,
# so a provider whose application carries policy bindings (the D43 gate) must offer no refresh: read
# from the instance, then probed live with a planted refresh token, with a control that refreshes once
# the grant type is put back (infrastructure/authentik/test-refresh-gate.py).
echo "refresh grant: asserting it closed on every gated provider, and probing the token endpoint"
if ! run_ak_shell "$worker" <"$here/test-refresh-gate.py" 2>&1 | tee >(cat >&2) | grep -x 'REFRESH-GATE-OK' >/dev/null; then
  echo "::error::a provider whose application carries policy bindings accepts a refresh - read the assertion above"
  exit 1
fi
echo "no gated provider refreshes a token, and the probe is seen red with the grant put back"

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

# THE GATE IN FRONT OF EVERY PAGE, DRIVEN (owner decision of 2026-11-25). The real nginx, with the
# generated configuration, in front of this real authentik: every user agent of the shared fixtures
# gets the interstitial for a page request when it is a Meta in-app browser and authentik's own
# answer otherwise; a fetch, an API path and a crawler always reach authentik; and a recreated
# `server` - which is what a release does - is reached again with no gate restart.
echo "the in-app browser gate: driving it with every fixture"
gate_port="$(docker port "${project}-gate-1" 8080/tcp | awk -F: '!/^\[/ && !seen++ {print $NF}')"
[ -n "$gate_port" ] || { echo "::error::the gate publishes no port"; exit 1; }
gate="http://127.0.0.1:$gate_port"
page_accept='text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
fixtures="$(git -C "$here" rev-parse --show-toplevel)/libs/leave-in-app-browser/fixtures.json"
# One line per case: "gated|let" TAB user agent. Python reads the JSON - the CI job installs no bun,
# and the runner's interpreter is `python3` (PYTHON overrides it on a machine that names it otherwise);
# the shell only drives curl.
cases="$("${PYTHON:-python3}" -c 'import json, sys
for c in json.load(open(sys.argv[1], encoding="utf-8"))["cases"]:
    print(("gated" if c["expect"] else "let") + chr(9) + c["userAgent"])' "$fixtures")"
[ "$(grep -c . <<<"$cases")" -ge 20 ] || { echo "::error::the fixtures did not load"; exit 1; }
marker='<meta name="leave-iab-app"'
gated=0
while IFS=$'\t' read -r verdict ua; do
  body="$(curl -sS --max-time 20 -A "$ua" -H "Accept: $page_accept" "$gate/if/flow/default-authentication-flow/")"
  if [ "$verdict" = gated ]; then
    grep -qF "$marker" <<<"$body" || { echo "::error::the gate let an in-app browser through: $ua"; exit 1; }
    gated=$((gated + 1))
  else
    if grep -qF "$marker" <<<"$body"; then echo "::error::the gate blocked a client it must not: ${ua:-<no user agent>}"; exit 1; fi
  fi
done <<<"$cases"
messenger="$(awk -F'\t' '$1 == "gated" {print $2; exit}' <<<"$cases")"
# The CRs stripped: a header line ends in CRLF, and the comparison is on the text. Exact case - nginx
# writes each name as gate's nginx.conf spells it.
headers="$(curl -sS --max-time 20 -o /dev/null -D - -A "$messenger" -H 'Sec-Fetch-Dest: document' -H "Accept: $page_accept" "$gate/" | tr -d '\r')"
for expected in 'HTTP/1.1 200' 'Cache-Control: no-store' 'Vary: User-Agent' 'X-Robots-Tag: noindex, nofollow' "Content-Security-Policy: default-src 'none'; script-src 'sha256-"; do
  grep -qF "$expected" <<<"$headers" || { echo "::error::the interstitial lacks '$expected'"; printf '%s\n' "$headers" >&2; exit 1; }
done
# A fetch and an API path from the same in-app browser reach authentik. (A health path asked AS a page
# is a page: the deploy's probes reach authentik's own port, never through the gate.)
for probe in "-H Sec-Fetch-Dest:empty $gate/if/flow/default-authentication-flow/" "$gate/api/v3/root/config/"; do
  # shellcheck disable=SC2086 # the probe is a word list on purpose
  probe_body="$(curl -sS --max-time 20 -A "$messenger" -H "Accept: $page_accept" $probe)"
  if grep -qF "$marker" <<<"$probe_body"; then
    echo "::error::the gate answered a request that is not a page: $probe"; exit 1
  fi
done
echo "the gate sent $gated in-app browser(s) away and let every other client, fetch and API call through"
docker compose -p "$project" --project-directory "$work" -f "$work/compose.yml" up -d --no-deps --force-recreate --wait server >/dev/null
status="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$gate/-/health/live/")"
[ "$status" = 200 ] || { echo "::error::after recreating server, the gate answers $status on /-/health/live/ (stale upstream address?)"; exit 1; }
echo "a recreated server is reached through the gate with no restart of it"
