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
     The person's other attributes (the enrolment profile) survive the write unchanged;
  5. a user whose `cgu_version` is an older text is asked again, and FORGED hidden values in the
     POST are ignored for the server's; an IMPERSONATED session is neither shown nor written;
  6. every provider authorizing through this flow ends on a code once the terms are accepted;
  7. PRODUCTION: exactly the providers in BOUND name this flow (50-providers.yaml declares it, all
     eight since the hold was lifted on 2026-11-20), and production's provider shows the page to a
     person who never accepted, writing nothing until the tick;
  8. THE ALUMNI RULE (D42-D44), every case of libs/contracts/alumni-access.json - the table
     core-service's handoff gate runs too (apps/core-service/src/auth/handoff/alumni-access.spec.ts),
     so the two implementations cannot drift: the link page each person meets through the REAL
     authorization flow on that day ("today" is put in the plan as `miconnect_today`, never read
     from the wall clock), and MiGallery's and Le Cercle's answer through authentik's own policy
     engine; Sky stays unbound;
  9. the reminder links to the source, is skippable and shows once per session (a new session meets
     it again); the blocking page shows at every authorization, cannot be submitted until the link
     exists, and goes on once it does.

THE TABLE IS HANDED IN by test-blueprints.sh, which prepends `ALUMNI_ACCESS_B64 = "<base64 of the
JSON>"` to this program (it runs on stdin inside the container, where the repository is not).
"""
import base64
import copy
import json
from datetime import date, datetime
from importlib import import_module
from urllib.parse import parse_qs, urlencode, urlparse

from django.conf import settings
from django.test import Client

from authentik.core.models import Application, Group, User
from authentik.policies.models import PolicyBinding
from authentik.flows.views.executor import SESSION_KEY_PLAN
from authentik.policies.engine import PolicyEngine
from authentik.providers.oauth2.models import OAuth2Provider, RedirectURIType
from authentik.root.middleware import SessionMiddleware
from authentik.sources.saml.models import SAMLSource, UserSAMLSourceConnection
from authentik.tenants.models import Tenant

SLUG = "miconnect-authorization"
VERSION = "2026-11-24"
TERMS_URL = "https://canari.emse.fr/legal/miconnect"
PASSWORD = "consent-test-Password-0123456789"
PREFIX = "consent-e2e-"
# The providers that ask for the terms (50-providers.yaml): all eight since the hold of 2026-10-17 was
# lifted on 2026-11-20. Holding one again is removing it here and in that file, in one pull request.
BOUND = {"miconnect-archives", "miconnect-canari", "miconnect-canari-dev", "miconnect-canari-local", "miconnect-cercle", "miconnect-migallery", "miconnect-mino-wiki", "miconnect-sky"}
PRODUCTION = "miconnect-canari"
# What enrolment leaves on an account; the consent write must keep every key of it unchanged.
# A post, so the cotisant gate of MiGallery and Le Cercle (60-applications.yaml) admits them in step 6; no
# cursus, so the Alumni link step never shows.
PROFILE = {"profile": {"version": 1, "campus": "saint-etienne", "cursus": [], "posts": ["EMSE"]}, "school_status": "Elève", "promo": 2024, "formation": "ICM"}
PROMPT_KEYS =["cgu_notice", "cgu_accept", "attributes.cgu_version", "attributes.cgu_accepted_at"]
# libs/contracts/alumni-access.json, handed in by test-blueprints.sh (see the docstring).
ALUMNI_ACCESS = json.loads(base64.b64decode(ALUMNI_ACCESS_B64))  # noqa: F821


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
    return user, new_session(username)


def new_session(username):
    """A NEW MiConnect session for an existing user (made by `signed_in`): a new browser, a REAL login."""
    client = Client(HTTP_HOST="localhost")
    first = executor(client, "password-login")
    assert first.get("component") == "ak-stage-identification", first
    second = executor(client, "password-login", {"component": "ak-stage-identification", "uid_field": username})
    if second.get("component") == "ak-stage-password":
        second = executor(client, "password-login", {"component": "ak-stage-password", "password": PASSWORD})
    assert second.get("component") != "ak-stage-password", ("the password was refused", second)
    return client


def authorize(client, provider):
    """Starts an authorization code request for `provider`; returns the challenge or the redirect."""
    redirect = next(uri.url for uri in provider.redirect_uris if uri.redirect_uri_type == RedirectURIType.AUTHORIZATION)
    query = urlencode({"client_id": provider.client_id, "redirect_uri": redirect, "response_type": "code", "scope": "openid profile", "state": "consent-e2e"})
    return redirect, follow(client, client.get(f"/application/o/authorize/?{query}")), query


def authorize_on(client, provider, today):
    """An authorization whose plan carries `miconnect_today` = `today` before its first stage is evaluated:
    the authorize view plans the flow into the session and redirects; the date goes into that plan."""
    redirect = next(uri.url for uri in provider.redirect_uris if uri.redirect_uri_type == RedirectURIType.AUTHORIZATION)
    query = urlencode({"client_id": provider.client_id, "redirect_uri": redirect, "response_type": "code", "scope": "openid profile", "state": "consent-e2e"})
    first = client.get(f"/application/o/authorize/?{query}")
    store = import_module(settings.SESSION_ENGINE).SessionStore(SessionMiddleware.decode_session_key(client.cookies[settings.SESSION_COOKIE_NAME].value))
    plan = store[SESSION_KEY_PLAN]
    plan.context["miconnect_today"] = today
    store[SESSION_KEY_PLAN] = plan
    store.save()
    return redirect, follow(client, first), query


def admitted(slug, user, today):
    """authentik's own answer for `user` on application `slug`, with `today` in the request context."""
    engine = PolicyEngine(Application.objects.get(slug=slug), user)
    engine.use_cache = False
    engine.request.context["miconnect_today"] = today
    engine.build()
    return engine.result


def ended_on_code(result, redirect):
    target = result.get("external", "")
    params = parse_qs(urlparse(target).query)
    return target.startswith(redirect) and bool(params.get("code")) and params.get("state") == ["consent-e2e"]


def fields(challenge):
    return {field["field_key"]: field for field in challenge.get("fields", [])}


def accept(client, challenge, query, tick=True, forged=None):
    """POSTs the prompt the way the browser does: every field it was given, the box as chosen.

    `forged` overrides fields in the POST, the way a client that edits the hidden inputs would."""
    payload = {"component": "ak-stage-prompt"}
    for key, field in fields(challenge).items():
        payload[key] = field.get("initial_value")
    payload["cgu_accept"] = tick
    payload.update(forged or {})
    return executor(client, SLUG, payload, query)


def recent(stamp):
    """True when `stamp` is an aware ISO date within five minutes of now."""
    moment = datetime.fromisoformat(stamp)
    return moment.tzinfo is not None and abs((datetime.now(moment.tzinfo) - moment).total_seconds()) < 300


with Tenant.objects.get(ready=True):
    providers = list(OAuth2Provider.objects.filter(authorization_flow__slug=SLUG).order_by("name"))
    check({p.name for p in providers} == BOUND, f"exactly {sorted(BOUND)} authorize through {SLUG} ({', '.join(p.name for p in providers)})")
    canari = OAuth2Provider.objects.get(name="miconnect-canari-local")

    try:
        # 1 - a person who never accepted is shown the page, with everything on it.
        user, client = signed_in(PREFIX + "a", copy.deepcopy(PROFILE))
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
        check(recent(user.attributes["cgu_accepted_at"]), f"cgu_accepted_at is the time of acceptance ({user.attributes.get('cgu_accepted_at')})")
        check(set(user.attributes) == set(PROFILE) | {"cgu_version", "cgu_accepted_at"}, f"nothing else lands on the account ({sorted(user.attributes)})")
        kept = {key: user.attributes[key] for key in PROFILE}
        check(kept == PROFILE, f"the profile attributes survive the write unchanged ({kept})")

        # 4 - a second authorization does not ask again.
        _, again, _ = authorize(client, canari)
        check(ended_on_code(again, redirect), f"a second authorization skips the page and ends on a code ({again.get('external') or again.get('component')})")
        user.refresh_from_db()
        check(user.attributes["cgu_accepted_at"] == accepted.isoformat(), "a second authorization does not rewrite the date")

        # 5 - an older text is asked again, and replaced.
        old, old_client = signed_in(PREFIX + "b", {"cgu_version": "2000-01-01", "cgu_accepted_at": "2000-01-01T00:00:00+00:00"})
        _, page, query = authorize(old_client, canari)
        check(page.get("component") == "ak-stage-prompt", "a user who accepted an older text is asked again")
        # ...with FORGED hidden values in the POST, which the server must ignore for its own.
        done = accept(old_client, page, query, forged={"attributes.cgu_version": "9999", "attributes.cgu_accepted_at": "1999-01-01T00:00:00+00:00"})
        check("external" in done, f"the forged POST still completes the authorization ({done.get('component')})")
        old.refresh_from_db()
        check(old.attributes["cgu_version"] == VERSION, f"a forged version is ignored for the server's ({old.attributes['cgu_version']})")
        check(recent(old.attributes["cgu_accepted_at"]), f"a forged date is ignored for the server's ({old.attributes['cgu_accepted_at']})")

        # 5b - an impersonated session neither shows the terms nor writes them on the person
        # impersonated: only the person may accept, never an administrator acting as them.
        admin, admin_client = signed_in(PREFIX + "admin")
        admin.groups.add(Group.objects.get(name="authentik Admins"))
        target = User.objects.create(username=PREFIX + "c", name="Consent Impersonated")
        started = admin_client.post(f"/api/v3/core/users/{target.pk}/impersonate/", data=json.dumps({"reason": "consent-e2e"}), content_type="application/json")
        check(started.status_code in (200, 201, 204), f"the administrator impersonates the person (got {started.status_code})")
        target_redirect, seen, _ = authorize(admin_client, canari)
        check(ended_on_code(seen, target_redirect), f"an impersonated authorization is not shown the terms ({seen.get('external') or seen.get('component')})")
        target.refresh_from_db()
        check("cgu_version" not in target.attributes and "cgu_accepted_at" not in target.attributes, f"nothing is written on the impersonated person ({sorted(target.attributes)})")
        admin.refresh_from_db()
        check("cgu_version" not in admin.attributes, "nor on the administrator")

        # 6 - every application signs the accepted user in.
        for provider in providers:
            if not Application.objects.filter(provider=provider).exists():
                print(f"  skip {provider.name}: no application", flush=True)
                continue
            target, result, _ = authorize(client, provider)
            check(ended_on_code(result, target), f"{provider.name} ends on a code for an accepted user ({result.get('external') or result.get('component')})")

        # 7 - production: its provider shows the page to a person who never accepted, and writes nothing yet.
        production = OAuth2Provider.objects.get(name=PRODUCTION)
        check(production.authorization_flow.slug == SLUG, f"{PRODUCTION} names {SLUG} ({production.authorization_flow.slug})")
        fresh, fresh_client = signed_in(PREFIX + "d")
        _, shown_page, _ = authorize(fresh_client, production)
        check(shown_page.get("component") == "ak-stage-prompt", f"{PRODUCTION} stops a person who never accepted on the prompt ({shown_page.get('component') or shown_page})")
        fresh.refresh_from_db()
        check("cgu_version" not in fresh.attributes, f"and writes nothing before the tick ({sorted(fresh.attributes)})")

        # 8 - the Alumni rule (D42-D44): every case of the table core-service runs too.
        alumni = SAMLSource.objects.get(slug="alumni")
        student, student_client = signed_in(PREFIX + "e", {"cgu_version": VERSION, "cgu_accepted_at": "2026-11-23T00:00:00+00:00"})
        local = OAuth2Provider.objects.get(name="miconnect-canari-local")
        pages = {"code": "none", "alumni_link_reminder": "reminder", "alumni_link_required": "required"}

        def become(case):
            """Gives the student exactly the case's profile, Alumni read, group and connection."""
            attributes = {key: value for key, value in student.attributes.items() if key in ("cgu_version", "cgu_accepted_at")}
            attributes["profile"] = {"version": 1, "campus": "saint-etienne", "cursus": case["cursus"] if "cursus" in case else [{"formation": "ICM", "promo": promo} for promo in case["promos"]], "posts": case["posts"]}
            if case["alumni"] is not None:
                attributes["alumni"] = case["alumni"]
            student.attributes = attributes
            student.save()
            student.groups.clear()
            UserSAMLSourceConnection.objects.filter(user=student).delete()
            if case["linked"]:
                UserSAMLSourceConnection.objects.create(source=alumni, user=student, identifier="99001")

        def met(today, client=None):
            """The component the student meets first on `today` through the authorization flow, or 'code'."""
            target, page, query = authorize_on(client or student_client, local, today)
            if ended_on_code(page, target):
                return "code", page, query
            keys = list(fields(page))
            return (keys[0] if keys else page.get("component")), page, query

        for slug in ("migallery", "cercle"):
            check(Application.objects.get(slug=slug).policy_engine_mode == "any", f"{slug} admits on ANY binding")
        for case in ALUMNI_ACCESS["cases"]:
            today = date.fromisoformat(case["today"])
            become(case)
            # A new session per case: the reminder shows once per session (D44), so a case met in a
            # session an earlier case was reminded in would read "none".
            shown, _, _ = met(today, new_session(student.username))
            check(pages.get(shown) == case["link"], f"{case['name']}: the link step is {case['link']} ({shown})")
            for slug in ("migallery", "cercle"):
                student.groups.clear()
                if case["accessGroup"]:
                    student.groups.add(Group.objects.get(name=f"acces-{slug}"))
                verdict = admitted(slug, student, today)
                check(verdict.passing == case["gate"], f"{case['name']}: {slug} {'admits' if case['gate'] else 'refuses'}")
                if not case["gate"]:
                    check(any("cotisants" in str(text) for text in verdict.messages), f"{case['name']}: {slug} says why ({verdict.messages})")
        check(not PolicyBinding.objects.filter(target=Application.objects.get(slug="sky")).exists(), "Sky is not gated")

        # 9 - the pages themselves. The reminder carries the link to the source and lets the person go on.
        become({"promos": [2024], "posts": [], "alumni": None, "linked": False})
        shown, page, query = met(date(2026, 1, 15))
        check(shown == "alumni_link_reminder", f"promo 2024 on 2026-01-15 meets the reminder ({shown})")
        check('href="/source/saml/alumni/"' in fields(page)["alumni_link_reminder"]["initial_value"], "the reminder links to the Alumni source")
        done = executor(student_client, SLUG, {"component": "ak-stage-prompt"}, query)
        check("external" in done, f"the reminder is skippable: 'continue' ends the authorization ({done.get('component')})")
        # ONCE PER SESSION (owner, 2026-11-24): the next authorization of that session ends on a code,
        # and a new session is reminded again.
        again, page, _ = met(date(2026, 1, 15))
        check(again == "code", f"the reminder does not show twice in one session ({again})")
        again, _, _ = met(date(2026, 1, 15), new_session(student.username))
        check(again == "alumni_link_reminder", f"a new session is reminded again ({again})")

        # The blocking page refuses to go on while no link exists, and goes on once it does.
        become({"promos": [2020], "posts": [], "alumni": None, "linked": False})
        shown, page, query = met(date(2027, 3, 1))
        check(shown == "alumni_link_required", f"an unlinked promo 2020 is blocked after the grace ({shown})")
        again, _, _ = met(date(2027, 3, 1))
        check(again == "alumni_link_required", f"the blocking page shows again in the same session ({again})")
        shown, page, query = met(date(2027, 3, 1))
        refused_page = executor(student_client, SLUG, {"component": "ak-stage-prompt"}, query)
        said = [error.get("string", "") for errors in (refused_page.get("response_errors") or {}).values() for error in errors]
        check(refused_page.get("component") == "ak-stage-prompt" and any("Lie d'abord" in text for text in said), f"the blocking page cannot be submitted unlinked ({said})")
        UserSAMLSourceConnection.objects.create(source=alumni, user=student, identifier="99001")
        done = executor(student_client, SLUG, {"component": "ak-stage-prompt"}, query)
        check("external" in done, f"once linked (another tab), the blocking page goes on ({done.get('component')})")
    finally:
        User.objects.filter(username__startswith=PREFIX).delete()
    print("CONSENT-OK")
