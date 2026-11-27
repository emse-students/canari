"""Proves the `school_mail` claim (10-mappings.yaml, `miconnect-claim-school-mail`) goes to the accounts it
is meant for and to no other, and travels the way core-service and the client rely on.

Run through `ak shell` by test-blueprints.sh, after the blueprints applied (NEVER on production: it
creates users and redeems codes). Owner, 2026-11-27 (docs/wiki/mail-client-transport.md#eligibility): the
real address reaches Canari's mail client only for an account the CAS created, and only on a school
domain. The Alumni address is typed by its holder at Alumnforce and may name any mailbox, so an
Alumni-created account never gets it - not even once it holds a CAS link. It prints `SCHOOL-MAIL-OK`
when every assertion held.

Part 1 EVALUATES the mapping on accounts made for the test. Part 2 drives the REAL authorize and token
endpoints, the way core-service redeems a code (`oidcCallback`), and MEASURES what core-service reads:
  - the token answer's `scope` names the GRANTED scopes, `school_mail` included only when it was asked
    for - core-service writes the class only then, so an older client's sign-in leaves it alone;
  - the claim is in the userinfo, and NOT in the id_token (`include_claims_in_id_token: false`): the
    client keeps the id_token for the sign-out, and the address must not ride in it;
  - asking a provider that has no `school_mail` mapping for it is not refused: the rest is granted.
"""
import base64
import json
import secrets
from urllib.parse import parse_qs, urlencode, urlparse

from django.conf import settings
from django.test import Client

from authentik.core.models import User
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping
from authentik.root.middleware import SessionMiddleware
from authentik.sources.oauth.models import OAuthSource, UserOAuthSourceConnection
from authentik.stages.prompt.models import Prompt

MAPPING = "miconnect-claim-school-mail"
CANARI_PROVIDERS = {"miconnect-canari", "miconnect-canari-dev"}


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"  ok   {message}", flush=True)


mapping = ScopeMapping.objects.get(name=MAPPING)
check(mapping.scope_name == "school_mail", "the mapping has its own scope, school_mail")

bound = {p.name for p in OAuth2Provider.objects.filter(property_mappings=mapping)}
check(bound == CANARI_PROVIDERS, f"bound to Canari's production and dev providers and no other ({sorted(bound)})")
for name in ("miconnect-canari", "miconnect-canari-dev", "miconnect-canari-local"):
    check(
        OAuth2Provider.objects.get(name=name).include_claims_in_id_token is False,
        f"{name} copies no scope claim into the id_token",
    )

cas = OAuthSource.objects.get(slug="cas-emse")
made = []
TERMS = Prompt.objects.get(name="miconnect-consent-prompt-version").initial_value


def account(username, email, cas_identifier=None):
    user = User.objects.create(username=f"{username}", email=email, name="School Mail Probe")
    # The terms are accepted (as test-pkce.py does), so part 2 never stops on the terms page.
    user.attributes["cgu_version"] = TERMS
    user.save()
    made.append(user)
    if cas_identifier is not None:
        UserOAuthSourceConnection.objects.create(user=user, source=cas, identifier=cas_identifier)
    return user


def claim(user):
    return mapping.evaluate(user=user, request=None)


def signed_in_client(user):
    # authentik's session cookie is a signed JWT: re-encoded with its own middleware (test-pkce.py).
    client = Client(HTTP_HOST="localhost")
    client.force_login(user)
    key = client.session.session_key
    client.cookies[settings.SESSION_COOKIE_NAME] = SessionMiddleware.encode_session(key, user)
    return client


def authorization_redirect(provider):
    for uri in provider.redirect_uris:
        if "authorization" in str(getattr(uri, "redirect_uri_type", "authorization")):
            return uri.url
    raise AssertionError(f"{provider.name} has no authorization redirect URI")


def sign_in(user, provider_name, scope):
    """Authorize then redeem, as core-service does. Returns (token answer, id_token claims, userinfo)."""
    provider = OAuth2Provider.objects.get(name=provider_name)
    redirect = authorization_redirect(provider)
    client = signed_in_client(user)
    state = secrets.token_urlsafe(16)
    query = urlencode(
        {"client_id": provider.client_id, "redirect_uri": redirect, "response_type": "code", "scope": scope, "state": state}
    )
    response = client.get(f"/application/o/authorize/?{query}")
    target = response.get("Location", "") if response.status_code in (301, 302) else ""
    if not target.startswith(redirect):
        body = client.get(f"/api/v3/flows/executor/{provider.authorization_flow.slug}/?{urlencode({'query': query})}").json()
        target = body.get("to", "")
        assert target.startswith(redirect), f"authorize ended elsewhere: {json.dumps(body)[:400]}"
    code = parse_qs(urlparse(target).query)["code"][0]
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect,
        "client_id": provider.client_id,
        "client_secret": provider.client_secret,
    }
    answer = Client(HTTP_HOST="localhost").post(
        "/application/o/token/", data=urlencode(form), content_type="application/x-www-form-urlencoded"
    )
    assert answer.status_code == 200, f"the code was not redeemed: {answer.status_code} {answer.content[:200]}"
    token = answer.json()
    payload = token["id_token"].split(".")[1]
    id_claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    userinfo = Client(HTTP_HOST="localhost").get(
        "/application/o/userinfo/", HTTP_AUTHORIZATION=f"Bearer {token['access_token']}"
    ).json()
    return token, id_claims, userinfo


try:
    # Part 1 - who gets the claim.
    student = account("smc.student", "SMC.Student@etu.emse.fr", cas_identifier="smc.student")
    check(claim(student) == {"school_mail": "smc.student@etu.emse.fr"}, "a CAS student gets its address, lowercased")

    staff = account("smc.staff", "smc.staff@emse.fr", cas_identifier="smc.staff")
    check(claim(staff) == {"school_mail": "smc.staff@emse.fr"}, "a CAS staff member gets its address")

    elsewhere = account("smc.elsewhere", "smc@example.org", cas_identifier="smc.elsewhere")
    check(claim(elsewhere) == {}, "a CAS account whose address is not on a school domain gets nothing")

    subdomain = account("smc.sub", "smc.sub@mail.emse.fr", cas_identifier="smc.sub")
    check(claim(subdomain) == {}, "a subdomain is not a school domain")

    two_ats = account("smc.twoats", "a@b@etu.emse.fr", cas_identifier="smc.twoats")
    check(claim(two_ats) == {}, "an address with two @ is not one address")

    spaced = account("smc.spaced", "smc spaced@etu.emse.fr", cas_identifier="smc.spaced")
    check(claim(spaced) == {}, "an address with whitespace is not one address")

    alumni = account("alumni-990001", "someone@emse.fr")
    check(claim(alumni) == {}, "an Alumni account with a school-looking address and no CAS link gets nothing")

    alumni_linked = account("alumni-990002", "someone.else@etu.emse.fr", cas_identifier="smc.linked")
    check(
        claim(alumni_linked) == {},
        "an Alumni-created account that LATER linked the CAS gets nothing: its address is still the typed one",
    )

    no_link = account("smc.nolink", "smc.nolink@etu.emse.fr")
    check(claim(no_link) == {}, "an account with no CAS link gets nothing")

    # Part 2 - how it travels, measured on the real endpoints.
    token, id_claims, userinfo = sign_in(student, "miconnect-canari-dev", "openid profile school_mail")
    print(f"  measured: token answer keys {sorted(token)}, scope {token.get('scope')!r}", flush=True)
    check("school_mail" in str(token.get("scope", "")).split(" "), "the token answer's scope names school_mail when it was asked for")
    check(userinfo.get("school_mail") == "smc.student@etu.emse.fr", "the userinfo carries the address")
    check("school_mail" not in id_claims, "the id_token does NOT carry the address")
    check("campus" not in id_claims and "name" not in id_claims, f"the id_token carries no scope claim ({sorted(id_claims)})")
    check(str(id_claims.get("iss", "")).endswith("/"), "the id_token still names its issuer, which the sign-out reads")

    token, _, userinfo = sign_in(student, "miconnect-canari-dev", "openid profile")
    check(
        "school_mail" not in str(token.get("scope", "")).split(" "),
        f"an older client that does not ask for it is not granted school_mail (scope {token.get('scope')!r})",
    )
    check("school_mail" not in userinfo, "and its userinfo carries no address")

    token, _, userinfo = sign_in(student, "miconnect-canari-local", "openid profile school_mail")
    check(
        "school_mail" not in str(token.get("scope", "")).split(" ") and "school_mail" not in userinfo,
        "a provider without the mapping grants the rest and no address (the local estate)",
    )
finally:
    for user in made:
        user.delete()

print("SCHOOL-MAIL-OK")
