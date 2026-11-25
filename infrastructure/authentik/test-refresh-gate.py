"""Proves, on a real authentik, that no refresh token can outlive an application's access policy.

authentik 2026.8.6's `refresh_token` grant evaluates no application binding (`create_refresh_response`
in providers/oauth2/views/token.py), so on a provider whose application carries bindings (the D43 gate
and `acces-<app>` on MiGallery and Le Cercle) the refresh grant is CLOSED: no `refresh_token` grant
type, no `offline_access` scope mapping (docs/wiki/infrastructure/authentik.md, "The refresh grant is
closed on gated providers").

Run through `ak shell` by test-blueprints.sh after the blueprints apply (and by hand on any disposable
instance, NEVER on production: it creates a user and tokens, and flips a provider's grant types for the
control). It prints `REFRESH-GATE-OK` when every assertion held and raises otherwise.

What it asserts:
  a. read from the instance, not from the files: every application with a policy binding (expired ones
     included) has an OAuth2 provider with no `refresh_token` grant type and no `offline_access` scope
     mapping - and MiGallery and Le Cercle are among them, so the guard is never vacuous;
  b. a live probe on each such provider: a refresh token planted in the database (the shape one minted
     before the grant was closed would have) is refused `400 invalid_grant` at the token endpoint, and
     nothing is minted;
  c. the control that shows (b) can go red: with `refresh_token` put back in the provider's grant types
     for one request, the SAME planted token refreshes (200) - the hole the closed grant type prevents,
     since the planted token's own scope carries `offline_access` past the missing mapping. The grant
     types are restored in a `finally`, and asserted restored.
"""
from datetime import timedelta
from urllib.parse import urlencode

from django.test import Client, RequestFactory
from django.utils import timezone

from authentik.core.models import Application, User
from authentik.policies.models import PolicyBinding
from authentik.providers.oauth2.id_token import IDToken
from authentik.providers.oauth2.models import AccessToken, OAuth2Provider, RefreshToken, ScopeMapping

USERNAME = "refresh-gate-probe"
MUST_BE_GATED = {"migallery", "cercle"}


def refresh(provider, raw):
    """POSTs a refresh grant as a site would, and returns (status, json body)."""
    form = {
        "grant_type": "refresh_token",
        "refresh_token": raw,
        "client_id": provider.client_id,
        "client_secret": provider.client_secret,
    }
    response = Client(HTTP_HOST="localhost").post(
        "/application/o/token/", data=urlencode(form), content_type="application/x-www-form-urlencoded"
    )
    try:
        body = response.json()
    except ValueError:
        body = {"raw": response.content[:200].decode(errors="replace")}
    return response.status_code, body


def plant(provider, user):
    """A refresh token as the code exchange would have minted it with `offline_access` granted."""
    now = timezone.now()
    token = RefreshToken(
        user=user, provider=provider, scope=["openid", "offline_access"], expires=now + timedelta(hours=2), auth_time=now
    )
    token.id_token = IDToken.new(provider, token, RequestFactory().get("/", HTTP_HOST="localhost"))
    token.save()
    return token


def minted(provider, user):
    return (
        AccessToken.objects.including_expired().filter(provider=provider, user=user).count(),
        RefreshToken.objects.including_expired().filter(provider=provider, user=user).count(),
    )


# a. The applications the guard covers, read from the instance.
gated = {}
for application in Application.objects.all():
    if PolicyBinding.objects.including_expired().filter(target=application).exists():
        gated[application.slug] = application
missing = MUST_BE_GATED - set(gated)
assert not missing, f"the D43 applications carry no binding on this instance: {sorted(missing)}"
print(f"applications with policy bindings: {sorted(gated)}")

providers = []
for slug, application in sorted(gated.items()):
    provider = OAuth2Provider.objects.filter(pk=application.provider_id).first()
    assert provider is not None, f"{slug}: a gated application with no OAuth2 provider - extend this guard to its type"
    assert "refresh_token" not in provider.grant_types, f"{slug}: {provider.name} allows the refresh grant {provider.grant_types}"
    offline = list(ScopeMapping.objects.filter(provider=provider, scope_name="offline_access").values_list("name", flat=True))
    assert not offline, f"{slug}: {provider.name} carries offline_access mappings {offline}"
    print(f"  {slug}: {provider.name} grant_types={provider.grant_types}, no offline_access mapping")
    providers.append((slug, provider))

user, _ = User.objects.get_or_create(username=USERNAME, defaults={"name": "Refresh gate probe"})
try:
    for slug, provider in providers:
        # b. The closed grant, probed live with a token that exists.
        token = plant(provider, user)
        before = minted(provider, user)
        status, body = refresh(provider, token.token)
        print(f"  {slug}: refresh with a planted token: {status} {body.get('error')}")
        assert status == 400 and body.get("error") == "invalid_grant", f"{slug}: the refresh grant answered {status} {body}"
        assert minted(provider, user) == before, f"{slug}: a refused refresh minted tokens"

        # c. The control: the same token, the grant type put back for one request, refreshes.
        kept = list(provider.grant_types)
        try:
            provider.grant_types = [*kept, "refresh_token"]
            provider.save()
            status, body = refresh(provider, token.token)
            print(f"  {slug}: control, refresh_token grant put back: {status}")
            assert status == 200 and body.get("access_token"), f"{slug}: the control did not refresh ({status} {body}) - the probe above proves nothing"
        finally:
            provider.grant_types = kept
            provider.save()
        provider.refresh_from_db()
        assert "refresh_token" not in provider.grant_types, f"{slug}: the control's grant type was not restored"
finally:
    user.delete()

print("REFRESH-GATE-OK")
