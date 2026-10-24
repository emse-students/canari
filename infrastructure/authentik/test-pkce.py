"""Proves, on a real authentik, what Canari's PKCE sign-in relies on MiConnect to refuse.

Run through `ak shell` by test-blueprints.sh (and by hand on any disposable instance, NEVER on
production: it creates a user and redeems codes). It drives the real authorize endpoint and the real
token endpoint of the `miconnect-canari-local` provider, the way core-service redeems a code
(`oidcCallback` in apps/core-service/src/auth/auth.controller.ts: a form POST carrying the client
secret, plus `code_verifier` when the client sent one). It prints `PKCE-OK` when every assertion held
and raises otherwise.

What it asserts, each on a fresh code:
  1. a code authorized WITH an S256 challenge, redeemed with NO verifier, is refused (`invalid_grant`)
     - the claim the client half rests on: a code captured without its verifier is worth nothing,
     even to core-service, which holds the client secret;
  2. the same with a WRONG verifier is refused;
  3. the same with the RIGHT verifier is redeemed, and an id_token comes back;
  4. a code authorized WITHOUT a challenge, redeemed WITH a verifier, is refused - so a verifier is
     never ignored, and stripping the challenge on the way out does not let a stolen code through.

Why a core-service with no verifier fails (and so ships before the client half): case 1 is what an
older core-service, which drops the field, does with a challenged code.

The session cookie is the trap test-enrollment-flow.py describes: authentik's cookie is a signed JWT,
so the logged-in client's cookie is re-encoded with authentik's own SessionMiddleware.
"""
import base64
import hashlib
import json
import secrets
from urllib.parse import parse_qs, urlencode, urlparse

from django.conf import settings
from django.test import Client

from authentik.core.models import User
from authentik.providers.oauth2.models import OAuth2Provider
from authentik.root.middleware import SessionMiddleware

PROVIDER = "miconnect-canari-local"
REDIRECT = "http://localhost:1420/auth/callback"
USERNAME = "pkce-probe"

provider = OAuth2Provider.objects.get(name=PROVIDER)
flow_slug = provider.authorization_flow.slug
user, _ = User.objects.get_or_create(username=USERNAME, defaults={"name": "PKCE probe"})


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def pkce_pair():
    verifier = b64url(secrets.token_bytes(32))
    return verifier, b64url(hashlib.sha256(verifier.encode()).digest())


def signed_in_client():
    client = Client(HTTP_HOST="localhost")
    client.force_login(user)
    key = client.session.session_key
    client.cookies[settings.SESSION_COOKIE_NAME] = SessionMiddleware.encode_session(key, user)
    return client


def authorize(challenge):
    """Runs authorize -> the authorization flow, and returns the code handed to the redirect URI."""
    client = signed_in_client()
    state = secrets.token_urlsafe(16)
    params = {
        "client_id": provider.client_id,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": "openid profile",
        "state": state,
    }
    if challenge:
        params.update(code_challenge=challenge, code_challenge_method="S256")
    query = urlencode(params)
    response = client.get(f"/application/o/authorize/?{query}")
    target = response.get("Location", "") if response.status_code in (301, 302) else ""
    if not target.startswith(REDIRECT):
        # The authorization flow runs in the executor; it answers with the redirect as a challenge.
        executor = client.get(f"/api/v3/flows/executor/{flow_slug}/?{urlencode({'query': query})}")
        body = executor.json()
        target = body.get("to", "")
        assert target.startswith(REDIRECT), f"authorize ended elsewhere: {json.dumps(body)[:400]}"
    got = parse_qs(urlparse(target).query)
    assert got.get("state") == [state], f"state not echoed: {target}"
    return got["code"][0]


def redeem(code, verifier):
    """Redeems a code as core-service does, and returns (status, json body)."""
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT,
        "client_id": provider.client_id,
        "client_secret": provider.client_secret,
    }
    if verifier is not None:
        form["code_verifier"] = verifier
    response = Client(HTTP_HOST="localhost").post(
        "/application/o/token/", data=urlencode(form), content_type="application/x-www-form-urlencoded"
    )
    try:
        body = response.json()
    except ValueError:
        body = {"raw": response.content[:200].decode(errors="replace")}
    return response.status_code, body


def refused(label, status, body):
    print(f"  {label}: {status} {body.get('error')}")
    assert status == 400 and body.get("error") == "invalid_grant", f"{label} was not refused: {status} {body}"


verifier, challenge = pkce_pair()
status, body = redeem(authorize(challenge), None)
refused("challenged code, no verifier", status, body)

status, body = redeem(authorize(challenge), pkce_pair()[0])
refused("challenged code, wrong verifier", status, body)

status, body = redeem(authorize(challenge), verifier)
print(f"  challenged code, right verifier: {status} id_token={'id_token' in body}")
assert status == 200 and body.get("id_token"), f"the right verifier was refused: {status} {body}"

status, body = redeem(authorize(None), verifier)
refused("unchallenged code, a verifier", status, body)

user.delete()
print("PKCE-OK")
