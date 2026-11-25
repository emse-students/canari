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
# for it is declared in 50-providers.yaml: all nine since the hold on production was lifted
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

# THE RESEAU CONSOLE (owner, 2026-11-25): the Rootz association's supervision console of the MDE
# network. The configuration as declared - a confidential client with the code grant only (the group
# gate would be outlived by a refresh), one strict redirect, the name and identity scopes, the terms
# flow, a pinned subject, its own `profile` mapping - and ONE binding, the group `acces-reseau`, under
# engine mode `all`. Then BEHAVIOUR: a person outside the group is shown authentik's access-denied page
# and no tile; a member sees the tile, gets a code with an S256 challenge, and redeems it with the
# secret and the verifier only, into an id_token whose issuer is the application's, whose subject is
# the hashed user id, and whose `groups` is `acces-reseau` alone though the member holds another group.
# Last, the daily drift dry run is shown to SEE the binding deleted or disabled by hand.
echo "reseau console: its provider, its one group binding, and who gets a code"
if ! run_ak_shell "$worker" 2>&1 <<'PY' | tee >(cat >&2) | grep -x 'RESEAU-APP-OK' >/dev/null; then
import base64, hashlib, json, secrets
from urllib.parse import parse_qs, urlencode, urlparse

from django.conf import settings
from django.test import Client

from authentik.core.models import Application, Group, User
from authentik.policies.denied import AccessDeniedResponse
from authentik.policies.models import PolicyBinding
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping
from authentik.root.middleware import SessionMiddleware
from authentik.stages.prompt.models import Prompt

REDIRECT = "https://reseau.rootz-emse.fr/auth/callback"
provider = OAuth2Provider.objects.get(name="miconnect-reseau")
assert provider.client_type == "confidential", provider.client_type
assert provider.client_secret, "no client secret was generated"
assert provider.grant_types == ["authorization_code"], provider.grant_types
assert provider.sub_mode == "hashed_user_id", provider.sub_mode
assert provider.authorization_flow.slug == "miconnect-authorization", provider.authorization_flow.slug
value = lambda v: str(getattr(v, "value", v))
uris = [(value(u.matching_mode), u.url, value(u.redirect_uri_type)) for u in provider.redirect_uris]
assert uris == [("strict", REDIRECT, "authorization")], uris
scopes = sorted(ScopeMapping.objects.filter(provider=provider).values_list("scope_name", flat=True))
assert scopes == ["name", "openid", "profile"], scopes
mappings = sorted(m.managed or m.name for m in ScopeMapping.objects.filter(provider=provider))
assert mappings == ["goauthentik.io/providers/oauth2/scope-openid", "miconnect-claim-name", "miconnect-claim-reseau-profile"], mappings

app = Application.objects.get(slug="reseau")
assert app.provider_id == provider.pk and app.name == "Réseau MDE", (app.provider_id, app.name)
assert app.meta_launch_url == "https://reseau.rootz-emse.fr/", app.meta_launch_url
assert app.policy_engine_mode == "all", app.policy_engine_mode
bindings = list(PolicyBinding.objects.including_expired().filter(target=app))
assert [(b.group.name if b.group else None, b.policy_id, b.user_id, b.order, b.enabled, b.negate) for b in bindings] == [("acces-reseau", None, None, 0, True, False)], bindings
group = Group.objects.get(name="acces-reseau")


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def client_for(u):
    c = Client(HTTP_HOST="localhost")
    c.force_login(u)
    c.cookies[settings.SESSION_COOKIE_NAME] = SessionMiddleware.encode_session(c.session.session_key, u)
    return c


def authorize(u, challenge):
    """The target the authorization ends on, followed through the flow executor."""
    c = client_for(u)
    query = urlencode({"client_id": provider.client_id, "redirect_uri": REDIRECT, "response_type": "code",
                       "scope": "openid profile name", "state": "reseau-probe",
                       "code_challenge": challenge, "code_challenge_method": "S256"})
    resp = c.get(f"/application/o/authorize/?{query}")
    target = resp.get("Location", "") if resp.status_code in (301, 302) else ""
    if target.startswith(REDIRECT) or isinstance(resp, AccessDeniedResponse):
        return target, None, resp
    body = c.get(f"/api/v3/flows/executor/{provider.authorization_flow.slug}/?{urlencode({'query': query})}").json()
    return body.get("to", ""), body, resp


def listed(u):
    listing = client_for(u).get("/api/v3/core/applications/?page_size=200")
    assert listing.status_code == 200, listing.status_code
    return {a["slug"] for a in listing.json()["results"]}


def probe(username):
    """A signed-in person who accepted the current terms; no cursus, so no Alumni step."""
    u, _ = User.objects.get_or_create(username=username, defaults={"name": "Reseau Probe"})
    u.attributes["profile"] = {"version": 1, "firstName": "Reseau", "lastName": "Probe", "cursus": [], "posts": []}
    u.attributes["cgu_version"] = Prompt.objects.get(name="miconnect-consent-prompt-version").initial_value
    u.save()
    return u


# TWO PEOPLE, never one moved into the group: authentik caches a person's application library, so a
# listing taken before a membership change would be read back after it.
outsider = probe("reseau-probe-outsider")
member = probe("reseau-probe-member")
member.groups.add(group)
member.groups.add(Group.objects.get(name="acces-migallery"))
try:
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())

    # Outside the group: no tile, and authentik's own access-denied answer at the authorization -
    # the application's policy refusing, not a flow that merely ended elsewhere.
    assert "reseau" not in listed(outsider), "the tile is listed to a person outside acces-reseau"
    target, body, resp = authorize(outsider, challenge)
    assert isinstance(resp, AccessDeniedResponse), f"the outsider was not refused by the access check: {resp.status_code} {type(resp).__name__} {target} {json.dumps(body)[:300]}"
    assert not target.startswith(REDIRECT), f"a person outside acces-reseau got a code: {target}"
    print(f"  outside the group: {type(resp).__name__} {resp.status_code}")

    # A member: the tile, a code, and a redeem that needs the verifier.
    assert "reseau" in listed(member), "the tile is not listed to a member"
    target, body, _ = authorize(member, challenge)
    assert target.startswith(REDIRECT), f"a member got no code: {json.dumps(body)[:400]}"
    code = parse_qs(urlparse(target).query)["code"][0]

    def redeem(extra):
        form = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
                "client_id": provider.client_id, "client_secret": provider.client_secret, **extra}
        r = Client(HTTP_HOST="localhost").post("/application/o/token/", data=urlencode(form),
                                               content_type="application/x-www-form-urlencoded")
        return r.status_code, r.json()

    status, answer = redeem({})
    assert status == 400 and answer.get("error") == "invalid_grant", f"a challenged code was redeemed without its verifier: {status} {answer}"
    target, _, _ = authorize(member, challenge)
    code = parse_qs(urlparse(target).query)["code"][0]
    status, answer = redeem({"code_verifier": verifier})
    assert status == 200 and answer.get("id_token"), f"the member's code was refused: {status} {answer}"
    assert "refresh_token" not in answer, "a refresh token was minted"
    payload = answer["id_token"].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert claims["iss"].endswith("/application/o/reseau/"), claims["iss"]
    assert claims["aud"] == provider.client_id, claims["aud"]
    assert claims["sub"] == member.uid, "the subject is not the hashed user id"
    assert claims.get("name") == "Reseau Probe", claims.get("name")
    assert (claims.get("firstName"), claims.get("lastName")) == ("Reseau", "Probe"), sorted(claims)
    assert claims.get("groups") == ["acces-reseau"], f"groups beyond the console's own: {claims.get('groups')}"
    assert claims.get("preferred_username") == member.username, claims.get("preferred_username")
    assert not {"promo", "formation", "profile", "school_status", "email"} & set(claims), sorted(claims)
    print(f"  a member: code redeemed with the verifier, iss {claims['iss']}, claims {sorted(claims)}")
finally:
    outsider.delete()
    member.delete()
print("RESEAU-APP-OK")
PY
  echo "::error::the Reseau console's provider or its group gate is wrong - read the assertion above"
  exit 1
fi
echo "the Reseau console admits acces-reseau only, by a confidential code grant with PKCE"

# THE DAILY DRIFT JOB SEES THE GATE TAMPERED WITH. An application with no enabled binding admits every
# account, so the binding deleted, or disabled, by hand must show in the dry run blueprint-drift.sh
# makes - each planted, read in the dry run's change list, then put back by an apply.
for plant in deleted disabled; do
  run_ak_shell "$worker" >/dev/null 2>&1 <<PY
from authentik.policies.models import PolicyBinding
binding = PolicyBinding.objects.get(target__application__slug="reseau", group__name="acces-reseau")
if "$plant" == "deleted":
    binding.delete()
else:
    binding.enabled = False
    binding.save()
PY
  case "$plant" in
    deleted) expected='^\[miconnect-blueprints\] CREATED  60-applications\.yaml#[0-9]+ authentik_policies\.policybinding$' ;;
    disabled) expected='^\[miconnect-blueprints\] CHANGED  60-applications\.yaml#[0-9]+ authentik_policies\.policybinding \.enabled: false -> true$' ;;
  esac
  dry="$(bash "$here/apply-blueprints.sh" dry-run "$worker" 2>&1 || true)"
  if ! grep -Eq "$expected" <<<"$dry"; then
    grep -E '^\[miconnect-blueprints\] (CREATED|CHANGED|DELETED|[0-9]+ change)' <<<"$dry" || true
    echo "::error::the drift dry run does not report the reseau binding $plant by hand - the daily job would miss it"
    exit 1
  fi
  echo "reseau binding $plant by hand: the drift dry run reports it"
  bash "$here/apply-blueprints.sh" apply "$worker" >/dev/null 2>&1
done
if [ "$(bash "$here/apply-blueprints.sh" dry-run "$worker" 2>&1 | grep -E '^\[miconnect-blueprints\] [0-9]+ change\(s\)$')" != "[miconnect-blueprints] 0 change(s)" ]; then
  echo "::error::the apply did not put the reseau binding back"
  exit 1
fi
echo "the drift dry run sees the reseau gate deleted or disabled, and an apply puts it back"
