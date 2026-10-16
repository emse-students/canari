"""Drives the REAL terms-of-use stage (45-consent.yaml) through a real OIDC authorization, end to end.

Run through `ak shell` by test-blueprints.sh (and by hand on any disposable instance). A throwaway
user signs in through `password-login` - a real login, so the session carries the login event the
authorize endpoint demands - then `/application/o/authorize/` plans `miconnect-authorization`
exactly as a provider does in production, and the flow executor's GET and POST do the rest. It
prints `CONSENT-OK` when every assertion held and raises otherwise.

WHY THE FLOW IS DRIVEN AND NOT ONLY APPLIED: a blueprint that applies proves the objects exist.
Whether the notice reaches the page, whether the box is really required, whether the hidden values
are written to the account and whether a second sign-in skips the page are all things only the
executor shows.

What it proves, in order:
  1. a user with no `cgu_version` is shown the prompt: the notice with the link, the required box,
     the hidden version and date;
  2. a POST without the tick is REFUSED, and nothing is written - authentik does NOT enforce a
     checkbox's `required` server-side, so this is the validation policy's work;
  3. a POST with the tick writes `cgu_version` and an ISO `cgu_accepted_at` (the hidden field's
     initial-value expression, evaluated - a placeholder expression would have written its source
     text) and nothing else, then the authorization ends on the redirect URI with a code;
  4. a second authorization for the same user skips the page and ends on the code at once;
  5. a user whose `cgu_version` is an older text is asked again;
  6. every provider authorizing through this flow ends on a code once the terms are accepted.
"""
import json
from datetime import datetime
from urllib.parse import parse_qs, urlencode, urlparse

from django.test import Client

from authentik.core.models import Application, User
from authentik.providers.oauth2.models import OAuth2Provider, RedirectURIType
from authentik.tenants.models import Tenant

SLUG = "miconnect-authorization"
VERSION = "2026-10-16"
TERMS_URL = "https://canari.emse.fr/legal/miconnect"
PASSWORD = "consent-test-Password-0123456789"
PREFIX = "consent-e2e-"
PROMPT_KEYS = ["cgu_notice", "cgu_accept", "attributes.cgu_version", "attributes.cgu_accepted_at"]


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"  ok   {message}", flush=True)


def follow(client, response):
    """Follows the executor's internal redirects; returns the JSON challenge or the external URL."""
    while response.status_code in (301, 302):
        location = response["Location"]
        parsed = urlparse(location)
        if parsed.netloc and parsed.netloc != "localhost":
            return {"external": location}
        if parsed.scheme and parsed.scheme not in ("http", "https"):
            return {"external": location}
        if parsed.path.startswith("/if/flow/"):
            # The shell page; the executor API is what the shell itself calls.
            slug = parsed.path.split("/")[3]
            query = parse_qs(parsed.query).get("query", [""])[0]
            location = f"/api/v3/flows/executor/{slug}/?{urlencode({'query': query})}"
        response = client.get(location)
    assert response.status_code == 200, (response.status_code, response.content[:500])
    challenge = response.json()
    if challenge.get("component") == "xak-flow-redirect":
        target = challenge["to"]
        if urlparse(target).netloc not in ("", "localhost"):
            return {"external": target}
        return follow(client, client.get(target))
    return challenge


def executor(client, slug, payload=None, query=""):
    url = f"/api/v3/flows/executor/{slug}/?{urlencode({'query': query})}"
    if payload is None:
        return follow(client, client.get(url))
    return follow(client, client.post(url, data=json.dumps(payload), content_type="application/json"))


def signed_in(username, attributes=None):
    """A fresh user and a client signed in as them through password-login, a REAL login."""
    User.objects.filter(username=username).delete()
    user = User.objects.create(username=username, name="Consent Test", attributes=attributes or {})
    user.set_password(PASSWORD)
    user.save()
    client = Client(HTTP_HOST="localhost")
    first = executor(client, "password-login")
    assert first.get("component") == "ak-stage-identification", first
    second = executor(client, "password-login", {"component": "ak-stage-identification", "uid_field": username})
    if second.get("component") == "ak-stage-password":
        second = executor(client, "password-login", {"component": "ak-stage-password", "password": PASSWORD})
    assert second.get("component") != "ak-stage-password", ("the password was refused", second)
    return user, client


def authorize(client, provider):
    """Starts an authorization code request for `provider`; returns the challenge or the redirect."""
    redirect = next(uri.url for uri in provider.redirect_uris if uri.redirect_uri_type == RedirectURIType.AUTHORIZATION)
    query = urlencode({"client_id": provider.client_id, "redirect_uri": redirect, "response_type": "code", "scope": "openid profile", "state": "consent-e2e"})
    return redirect, follow(client, client.get(f"/application/o/authorize/?{query}")), query


def ended_on_code(result, redirect):
    target = result.get("external", "")
    params = parse_qs(urlparse(target).query)
    return target.startswith(redirect) and bool(params.get("code")) and params.get("state") == ["consent-e2e"]


def fields(challenge):
    return {field["field_key"]: field for field in challenge.get("fields", [])}


def accept(client, challenge, query, tick=True):
    """POSTs the prompt the way the browser does: every field it was given, the box as chosen."""
    payload = {"component": "ak-stage-prompt"}
    for key, field in fields(challenge).items():
        payload[key] = field.get("initial_value")
    payload["cgu_accept"] = tick
    return executor(client, SLUG, payload, query)


with Tenant.objects.get(ready=True):
    providers = list(OAuth2Provider.objects.filter(authorization_flow__slug=SLUG).order_by("name"))
    check(len(providers) == 8, f"every provider authorizes through {SLUG} ({len(providers)}: {', '.join(p.name for p in providers)})")
    canari = OAuth2Provider.objects.get(name="miconnect-canari-local")

    try:
        # 1 - a person who never accepted is shown the page, with everything on it.
        user, client = signed_in(PREFIX + "a")
        redirect, page, query = authorize(client, canari)
        check(page.get("component") == "ak-stage-prompt", f"a first authorization stops on the prompt (got {page.get('component') or page})")
        shown = fields(page)
        check(list(shown) == PROMPT_KEYS, f"the prompt carries the four fields in order ({list(shown)})")
        notice = shown["cgu_notice"]
        check(notice["type"] == "static" and TERMS_URL in (notice.get("initial_value") or ""), "the notice is a static field carrying the link to the terms")
        check("<strong>nom</strong>" in notice["initial_value"], "the notice HTML reaches the challenge unescaped")
        check(shown["cgu_accept"]["type"] == "checkbox" and shown["cgu_accept"]["required"] is True, "the acceptance box is a REQUIRED checkbox")
        check(shown["attributes.cgu_version"]["type"] == "hidden" and shown["attributes.cgu_version"]["initial_value"] == VERSION, f"the hidden version carries {VERSION}")
        stamp = shown["attributes.cgu_accepted_at"]
        check(stamp["type"] == "hidden" and datetime.fromisoformat(stamp["initial_value"]).tzinfo is not None, f"the hidden date's expression evaluated to an aware ISO date ({stamp['initial_value']})")

        # 2 - no tick, no entry, and nothing written.
        refused = accept(client, page, query, tick=False)
        said = [error.get("string", "") for errors in (refused.get("response_errors") or {}).values() for error in errors]
        check(refused.get("component") == "ak-stage-prompt" and any("Coche la case" in text for text in said), f"a POST without the tick is refused, and told why ({said})")
        user.refresh_from_db()
        check("cgu_version" not in user.attributes, "a refused POST writes nothing to the account")

        # 3 - the tick writes the version and the date, and the authorization ends on a code.
        done = accept(client, refused, query, tick=True)
        check(ended_on_code(done, redirect), f"the accepted authorization ends on the redirect URI with a code ({done.get('external') or done})")
        user.refresh_from_db()
        check(user.attributes.get("cgu_version") == VERSION, f"cgu_version is written ({user.attributes.get('cgu_version')})")
        accepted = datetime.fromisoformat(user.attributes.get("cgu_accepted_at", ""))
        check(accepted.tzinfo is not None and abs((datetime.now(accepted.tzinfo) - accepted).total_seconds()) < 300, f"cgu_accepted_at is the time of acceptance ({user.attributes.get('cgu_accepted_at')})")
        check(set(user.attributes) == {"cgu_version", "cgu_accepted_at"}, f"nothing else lands on the account ({sorted(user.attributes)})")

        # 4 - a second authorization does not ask again.
        _, again, _ = authorize(client, canari)
        check(ended_on_code(again, redirect), f"a second authorization skips the page and ends on a code ({again.get('external') or again.get('component')})")
        user.refresh_from_db()
        check(user.attributes["cgu_accepted_at"] == accepted.isoformat(), "a second authorization does not rewrite the date")

        # 5 - an older text is asked again, and replaced.
        old, old_client = signed_in(PREFIX + "b", {"cgu_version": "2000-01-01", "cgu_accepted_at": "2000-01-01T00:00:00+00:00"})
        _, page, query = authorize(old_client, canari)
        check(page.get("component") == "ak-stage-prompt", "a user who accepted an older text is asked again")
        done = accept(old_client, page, query)
        old.refresh_from_db()
        check(old.attributes["cgu_version"] == VERSION and not old.attributes["cgu_accepted_at"].startswith("2000"), "accepting again replaces the version and the date")

        # 6 - every application signs the accepted user in.
        for provider in providers:
            if not Application.objects.filter(provider=provider).exists():
                print(f"  skip {provider.name}: no application", flush=True)
                continue
            target, result, _ = authorize(client, provider)
            check(ended_on_code(result, target), f"{provider.name} ends on a code for an accepted user ({result.get('external') or result.get('component')})")
    finally:
        User.objects.filter(username__startswith=PREFIX).delete()
    print("CONSENT-OK")
