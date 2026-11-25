"""Proves, on a real authentik, that the D43 gate refuses at a token REFRESH what it refuses at an authorization.

Run through `ak shell` by test-blueprints.sh (and by hand on any disposable instance, NEVER on
production: it creates a user and redeems codes). For each gated site provider (`miconnect-migallery`,
`miconnect-cercle`) it drives the real authorize endpoint and the real token endpoint the way a site
does (a form POST carrying the client secret), and prints `REFRESH-GATE-OK` when every assertion held.

What it asserts, per provider:
  0. the provider's ONLY `offline_access` mapping is `miconnect-offline-access-gated`, and it builds
     claims into the id_token - the two facts the refusal rests on (10-mappings.yaml);
  1. a person the gate admits (here through the group `acces-<app>`, the nominative exception) is
     authorized with `offline_access` and gets a refresh token;
  2. while still admitted, a refresh is answered 200 - the mapping lets an admitted person through;
  3. the gate's input flips (the group is taken away; the person has no post, no cursus, no Alumni
     read, so the policy refuses too): the SAME refresh token is now refused `400 invalid_grant`, and
     no new token was minted for it;
  4. the userinfo endpoint still answers 200 for the access token issued before the flip - the
     refusal belongs to the refresh grant only, never a 500 elsewhere;
  5. admitted again (the group given back), the same refresh token refreshes - the refusal is the
     gate re-read, not a revocation.

The session cookie is the trap test-enrollment-flow.py describes: authentik's cookie is a signed JWT,
so the logged-in client's cookie is re-encoded with authentik's own SessionMiddleware.
"""
import json
import secrets
from urllib.parse import parse_qs, urlencode, urlparse

from django.conf import settings
from django.test import Client

from authentik.core.models import Group, User
from authentik.providers.oauth2.models import AccessToken, OAuth2Provider, RefreshToken, ScopeMapping
from authentik.root.middleware import SessionMiddleware
from authentik.stages.prompt.models import Prompt

GATED = {"miconnect-migallery": "acces-migallery", "miconnect-cercle": "acces-cercle"}
USERNAME = "refresh-gate-probe"

user, _ = User.objects.get_or_create(username=USERNAME, defaults={"name": "Refresh gate probe"})
# Accepted the CURRENT terms (read from the prompt that writes them), and NOTHING the gate admits:
# no post, no cursus (so no Alumni link step either), no Alumni read. Only the group lets them in.
user.attributes = {
    "cgu_version": Prompt.objects.get(name="miconnect-consent-prompt-version").initial_value,
    "profile": {"posts": [], "cursus": []},
}
user.save()


def signed_in_client():
    client = Client(HTTP_HOST="localhost")
    client.force_login(user)
    key = client.session.session_key
    client.cookies[settings.SESSION_COOKIE_NAME] = SessionMiddleware.encode_session(key, user)
    return client


def authorize(provider, redirect):
    """Runs authorize -> the authorization flow, and returns the code handed to the redirect URI."""
    client = signed_in_client()
    state = secrets.token_urlsafe(16)
    query = urlencode({
        "client_id": provider.client_id,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": "openid offline_access",
        "state": state,
    })
    response = client.get(f"/application/o/authorize/?{query}")
    target = response.get("Location", "") if response.status_code in (301, 302) else ""
    if not target.startswith(redirect):
        executor = client.get(f"/api/v3/flows/executor/{provider.authorization_flow.slug}/?{urlencode({'query': query})}")
        body = executor.json()
        target = body.get("to", "")
        assert target.startswith(redirect), f"authorize ended elsewhere: {json.dumps(body)[:400]}"
    got = parse_qs(urlparse(target).query)
    assert got.get("state") == [state], f"state not echoed: {target}"
    return got["code"][0]


def token(provider, form):
    """POSTs to the token endpoint as a site does, and returns (status, json body)."""
    form = {**form, "client_id": provider.client_id, "client_secret": provider.client_secret}
    response = Client(HTTP_HOST="localhost").post(
        "/application/o/token/", data=urlencode(form), content_type="application/x-www-form-urlencoded"
    )
    try:
        body = response.json()
    except ValueError:
        body = {"raw": response.content[:200].decode(errors="replace")}
    return response.status_code, body


for name, group_name in GATED.items():
    provider = OAuth2Provider.objects.get(name=name)
    group = Group.objects.get(name=group_name)
    redirect = next(u.url for u in provider.redirect_uris if u.redirect_uri_type == "authorization")
    print(f"{name}:")

    # 0. The facts the refusal rests on.
    offline = list(ScopeMapping.objects.filter(provider=provider, scope_name="offline_access").values_list("name", flat=True))
    assert offline == ["miconnect-offline-access-gated"], f"{name}: offline_access mappings are {offline}"
    assert provider.include_claims_in_id_token, f"{name}: include_claims_in_id_token is off, the gate would never run"

    # 1. Admitted, authorized with offline_access: a refresh token.
    group.users.add(user)
    status, body = token(provider, {"grant_type": "authorization_code", "code": authorize(provider, redirect), "redirect_uri": redirect})
    assert status == 200 and body.get("refresh_token"), f"{name}: no refresh token for an admitted person: {status} {body}"
    refresh, access = body["refresh_token"], body["access_token"]
    print(f"  admitted, code exchanged: refresh_token issued, scope={body.get('scope')!r}")

    # 2. Still admitted: the refresh passes.
    status, body = token(provider, {"grant_type": "refresh_token", "refresh_token": refresh})
    assert status == 200 and body.get("access_token"), f"{name}: an admitted refresh was refused: {status} {body}"
    refresh = body.get("refresh_token", refresh)  # the cercle provider rotates (validity under its threshold)
    print(f"  admitted, refresh: {status}")

    # 3. The gate's input flips: the same refresh token is refused, and nothing is minted.
    group.users.remove(user)
    minted = (AccessToken.objects.filter(provider=provider, user=user).count(), RefreshToken.objects.filter(provider=provider, user=user).count())
    status, body = token(provider, {"grant_type": "refresh_token", "refresh_token": refresh})
    print(f"  refused by the gate, refresh: {status} {body.get('error')}")
    assert status == 400 and body.get("error") == "invalid_grant", f"{name}: a refused person refreshed: {status} {body}"
    after = (AccessToken.objects.filter(provider=provider, user=user).count(), RefreshToken.objects.filter(provider=provider, user=user).count())
    assert after == minted, f"{name}: a refused refresh minted tokens: {minted} -> {after}"
    assert not RefreshToken.objects.get(provider=provider, token=refresh).revoked, f"{name}: the refusal revoked the token"

    # 4. The userinfo endpoint is not the refresh grant: it answers, never a 500.
    response = Client(HTTP_HOST="localhost").get("/application/o/userinfo/", HTTP_AUTHORIZATION=f"Bearer {access}")
    assert response.status_code == 200, f"{name}: userinfo answered {response.status_code} after the flip"
    print(f"  refused by the gate, userinfo with the earlier access token: {response.status_code}")

    # 5. Admitted again: the same refresh token refreshes - the gate is re-read, nothing was revoked.
    group.users.add(user)
    status, body = token(provider, {"grant_type": "refresh_token", "refresh_token": refresh})
    assert status == 200 and body.get("access_token"), f"{name}: re-admitted, the refresh was refused: {status} {body}"
    print(f"  admitted again, refresh: {status}")
    group.users.remove(user)

user.delete()
print("REFRESH-GATE-OK")
