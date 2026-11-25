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
  9. the reminder links to the link flow with THIS authorization as `next`, is skippable and shows
     once per session (a new session meets it again); the blocking page shows at every
     authorization, cannot be submitted until the link exists, and goes on once it does;
 10. the link step's link (reminder and block): no D49 page, ONE Alumnforce answer, and the SAME
     authorization ends on the application's code - the link resumed with no Enterprise stage;
 11. the routing page's "I have a School account", from a signed-out authorization: the login page,
     Alumnforce, the routing page, a CAS-only page (one source, no field: the login page's own
     auto-redirect rule), the CAS, Alumnforce, and the SAME authorization's code; no second account;
 12. the boundary: no offer, an offer to another account, a `next` leaving MiConnect or a spent offer
     show the D49 page; a resume token planted for another account is refused and links nothing; a
     direct visit drops a stale token and ends on the settings, as authentik does.
Each IdP answer (Alumnforce, the CAS) is authentik's own SourceFlowManager.get_flow on the client's
session (`source_answers`): only the round trip to the IdP is not driven.

THE TABLE IS HANDED IN by test-blueprints.sh, which prepends `ALUMNI_ACCESS_B64 = "<base64 of the
JSON>"` to this program (it runs on stdin inside the container, where the repository is not).
"""
import base64
import copy
import json
import re
from html import unescape
from datetime import date, datetime
from importlib import import_module
from urllib.parse import parse_qs, urlencode, urlparse

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.contrib.messages.storage.fallback import FallbackStorage
from django.http import HttpResponseRedirect
from django.test import Client, RequestFactory
from structlog.stdlib import get_logger

from authentik.core.models import Application, Group, Source, User, UserSourceConnection
from authentik.core.sources.flow_manager import SESSION_KEY_OVERRIDE_FLOW_TOKEN
from authentik.core.sources.matcher import SourceMatcher
from authentik.flows.models import Flow, FlowToken
from authentik.flows.planner import PLAN_CONTEXT_PENDING_USER, PLAN_CONTEXT_REDIRECT, FlowPlanner
from authentik.policies.models import PolicyBinding
from authentik.flows.views.executor import SESSION_KEY_GET, SESSION_KEY_PLAN
from authentik.policies.engine import PolicyEngine
from authentik.providers.oauth2.models import OAuth2Provider, RedirectURIType
from authentik.root.middleware import SessionMiddleware
from authentik.sources.oauth.models import OAuthSource, UserOAuthSourceConnection
from authentik.sources.oauth.views.callback import OAuthSourceFlowManager
from authentik.sources.saml.models import SAMLSource, UserSAMLSourceConnection
from authentik.sources.saml.processors.response import SAMLSourceFlowManager
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
            # The shell page; the executor API is what the shell itself calls, with the page's own
            # query string as `query` (what the flow executor stores as the flow's GET, `next` included).
            slug = parsed.path.split("/")[3]
            location = f"/api/v3/flows/executor/{slug}/?{urlencode({'query': parsed.query})}"
        elif parsed.path.startswith(("/if/user/", "/if/admin/")):
            # An interface page: where the browser lands, not a flow.
            return {"landed": location}
        response = client.get(location)
    assert response.status_code == 200, (response.status_code, response.content[:500])
    challenge = response.json()
    if challenge.get("component") == "xak-flow-redirect":
        target = challenge["to"]
        if urlparse(target).netloc not in ("", "localhost"):
            return {"external": target}
        return follow(client, HttpResponseRedirect(target))
    return challenge


def go(client, url):
    """The browser following a link to `url` (a flow shell, a source entry): followed to the next challenge."""
    return follow(client, HttpResponseRedirect(url))


def session_of(client):
    """The server-side session the client's cookie names."""
    return import_module(settings.SESSION_ENGINE).SessionStore(SessionMiddleware.decode_session_key(client.cookies[settings.SESSION_COOKIE_NAME].value))


def source_answers(client, slug, identifier, user=None, properties=None):
    """What a source's return does once its IdP has answered: the Alumni source's ACS
    (sources/saml/views.py, ACSView.post) or the CAS callback (sources/oauth/views/callback.py), from the
    verified identity on - authentik's OWN SourceFlowManager.get_flow, on this client's session, then
    followed. Only the IdP round trip itself (the signed assertion, the CAS token exchange) is not driven:
    a throwaway instance has no Alumnforce and no CAS. `user` is the account the session holds (None:
    signed out). Returns the next challenge, or where the browser lands."""
    source = Source.objects.get_subclass(slug=slug)
    manager_class = SAMLSourceFlowManager if isinstance(source, SAMLSource) else OAuthSourceFlowManager
    store = session_of(client)
    request = RequestFactory().post(f"/source/{slug}/")
    request.session = store
    request.user = user or AnonymousUser()
    request._messages = FallbackStorage(request)
    if isinstance(source, SAMLSource) and SESSION_KEY_PLAN in store:
        # ACSView.post: the pre-authentication plan's `redirect` becomes the `next` the manager reads.
        plan_redirect = store[SESSION_KEY_PLAN].context.get(PLAN_CONTEXT_REDIRECT)
        if plan_redirect:
            store[SESSION_KEY_GET] = {"next": plan_redirect}
    # The manager as its constructor leaves it, without the property mapping (the identity is given).
    manager = object.__new__(manager_class)
    manager.source, manager.request, manager.identifier = source, request, identifier
    manager.user_info, manager.policy_context, manager.groups_properties = {}, {}, {}
    manager.user_properties = properties or {}
    manager.matcher = SourceMatcher(source, manager_class.user_connection_type, manager_class.group_connection_type)
    manager._logger = get_logger().bind(source=source, identifier=identifier)
    response = manager.get_flow()
    store.save()
    if response.status_code not in (301, 302):
        return {"refused": response.status_code, "body": getattr(response, "error_message", "")}
    return follow(client, response)


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


def link_of(html):
    """The href of the one link in a static prompt's HTML, as the browser reads it."""
    return unescape(re.search(r'href="([^"]+)"', html).group(1))


def comes_back(href, query):
    """True when `href` is the link flow with, as `next`, the authorization whose query is `query`."""
    parsed = urlparse(href)
    back = urlparse(parse_qs(parsed.query).get("next", [""])[0])
    return parsed.path == "/if/flow/miconnect-alumni-link/" and back.path == "/application/o/authorize/" and parse_qs(back.query) == parse_qs(query)


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
        href = link_of(fields(page)["alumni_link_reminder"]["initial_value"])
        check(comes_back(href, query), f"the reminder links to the link flow, coming back to THIS authorization ({href})")
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
        href = link_of(fields(page)["alumni_link_required"]["initial_value"])
        check(comes_back(href, query), f"the blocking page links to the link flow, coming back to THIS authorization ({href})")
        again, _, _ = met(date(2027, 3, 1))
        check(again == "alumni_link_required", f"the blocking page shows again in the same session ({again})")
        shown, page, query = met(date(2027, 3, 1))
        refused_page = executor(student_client, SLUG, {"component": "ak-stage-prompt"}, query)
        said = [error.get("string", "") for errors in (refused_page.get("response_errors") or {}).values() for error in errors]
        check(refused_page.get("component") == "ak-stage-prompt" and any("Lie d'abord" in text for text in said), f"the blocking page cannot be submitted unlinked ({said})")
        UserSAMLSourceConnection.objects.create(source=alumni, user=student, identifier="99001")
        done = executor(student_client, SLUG, {"component": "ak-stage-prompt"}, query)
        check("external" in done, f"once linked (another tab), the blocking page goes on ({done.get('component')})")

        # 10 - THE LINK STEP COMES BACK TO THE APPLICATION (miconnect-sign-in-paths.md, paths P8-P9).
        # Before: the D49 page, Alumnforce, "Successfully linked" on the settings, and a second sign-in to
        # the application. Now: the step's link, Alumnforce, and the SAME authorization ends on its code.
        for promos, today, page_key in (([2024], date(2026, 1, 15), "alumni_link_reminder"), ([2020], date(2027, 3, 1), "alumni_link_required")):
            become({"promos": promos, "posts": [], "alumni": None, "linked": False})
            browser = new_session(student.username)
            target, page, query = authorize_on(browser, local, today)
            met_on_the_way = [list(fields(page))[0]]
            to_alumnforce = go(browser, link_of(fields(page)[page_key]["initial_value"]))
            met_on_the_way.append(to_alumnforce.get("component"))
            check(to_alumnforce.get("url") == alumni.sso_url, f"{page_key}: the link goes to Alumnforce with no confirmation page - D49 is every link outside the D44 step ({met_on_the_way})")
            ended = source_answers(browser, "alumni", "99101", user=student)
            check(met_on_the_way == [page_key, "ak-stage-autosubmit"] and ended_on_code(ended, target), f"{page_key}: one page, one Alumnforce sign-in, and the SAME authorization ends on the application's code ({met_on_the_way}, {ended})")
            check(UserSAMLSourceConnection.objects.filter(user=student, source=alumni, identifier="99101").exists(), f"{page_key}: the identity Alumnforce asserted is linked to the signed-in account")
            check(SESSION_KEY_OVERRIDE_FLOW_TOKEN not in session_of(browser) and not FlowToken.objects.filter(user=student).exists(), f"{page_key}: the resume token is spent: out of the session and the database")

        # The OFFER outlives its page: after "Continuer" under the reminder, and while the block shows.
        # A visit to the link flow that does not carry the page's nonce (a lured link) meets D49.
        for promos, today, page_key in (([2024], date(2026, 1, 15), "alumni_link_reminder"), ([2020], date(2027, 3, 1), "alumni_link_required")):
            become({"promos": promos, "posts": [], "alumni": None, "linked": False})
            browser = new_session(student.username)
            target, page, query = authorize_on(browser, local, today)
            href = link_of(fields(page)[page_key]["initial_value"])
            if page_key == "alumni_link_reminder":
                gone = executor(browser, SLUG, {"component": "ak-stage-prompt"}, query)
                check("external" in gone, f"{page_key}: 'Continuer' ends the authorization")
            check(isinstance(session_of(browser).get("miconnect/alumni-link-offered"), dict), f"{page_key}: the offer is still in the session after its page")
            for lure in ("/if/flow/miconnect-alumni-link/", "/if/flow/miconnect-alumni-link/?offer=0123456789abcdef0123456789abcdef"):
                page = go(browser, lure)
                check(page.get("component") == "ak-stage-prompt" and "alumni_link_confirm" in fields(page), f"{page_key}: a link without the page's nonce ({lure}) meets the D49 confirmation ({page.get('component')})")
            to_alumnforce = go(browser, href)
            check(to_alumnforce.get("component") == "ak-stage-autosubmit", f"{page_key}: the page's own link still skips D49 ({to_alumnforce.get('component')})")
            check("miconnect/alumni-link-offered" not in session_of(browser), f"{page_key}: the offer is spent once its nonce is used")
            page = go(browser, href)
            check("alumni_link_confirm" in fields(page), f"{page_key}: the same link a second time meets D49")

        # 11 - THE ROUTING PAGE'S "I HAVE A SCHOOL ACCOUNT" (D47), FROM THE APPLICATION BACK TO IT
        # (path P6). Before: the login page again, the CAS, the D49 page, Alumnforce a second time,
        # the settings, and a second sign-in to the application. Now (owner, 2026-11-25, option 1): the
        # identity of the FIRST Alumnforce sign-in is linked after the CAS - at once when the names
        # agree, after a page naming both when they differ - with the membership read it carried.
        cas_source = OAuthSource.objects.get(slug="cas-emse")
        read = {"cotisant": True, "read_on": "2026-11-25"}

        def routing(suffix, af_id, asserted, meanwhile=None):
            """A CAS account and a signed-out browser that went: the application's authorization, the
            login page, Alumnforce (asserting `asserted`), the routing page, "I have a School account",
            the CAS-only page, the CAS. Returns the account, the browser, what the CAS's return led to, the pages met
            and (the authorization's redirect URI, its query)."""
            account, _ = signed_in(PREFIX + suffix, {"cgu_version": VERSION, "cgu_accepted_at": "2026-11-23T00:00:00+00:00", **copy.deepcopy(PROFILE)})
            UserOAuthSourceConnection.objects.create(user=account, source=cas_source, identifier=f"cas-e2e-{suffix}")
            browser = Client(HTTP_HOST="localhost")
            target, login_page, query = authorize(browser, local)
            buttons = {button.get("name") for button in login_page.get("sources", [])}
            assert login_page.get("component") == "ak-stage-identification" and len(buttons) == 2, ("the login page with both buttons", login_page.get("component"), buttons)
            met = [go(browser, "/source/saml/alumni/").get("component")]
            route = source_answers(browser, "alumni", af_id, properties={"username": f"alumni-{af_id}", "name": " ".join(asserted), "firstname": asserted[0], "lastname": asserted[1], "alumni_read": read})
            met.append(list(fields(route))[0] if route.get("component") == "ak-stage-prompt" else route.get("component"))
            cas_page = executor(browser, "miconnect-enrollment", {"component": "ak-stage-prompt", "alumni_route": "cas"})
            cas_only = [button["challenge"].get("to") for button in cas_page.get("sources", [])]
            check(
                cas_page.get("component") == "ak-stage-identification" and cas_only == ["/source/oauth/login/cas-emse/"] and not cas_page.get("user_fields") and not cas_page.get("passwordless_url"),
                f"[{suffix}] 'I have a School account' goes to a page with the CAS alone, no field, no other way: the login page's own rule sends the browser on by itself ({cas_page.get('component')}, {cas_only})",
            )
            after_cas = session_of(browser)[SESSION_KEY_GET].get("next", "")
            check(comes_back(after_cas, query), f"[{suffix}] after the CAS, the link flow, then THIS authorization ({after_cas})")
            parked = session_of(browser).get("miconnect/alumni-link-parked", {})
            check(parked.get("identifier") == af_id and parked.get("nonce") and parse_qs(urlparse(after_cas).query).get("parked") == [parked["nonce"]], f"[{suffix}] the identity Alumnforce asserted is kept in the session, server-side, with a nonce only this link names")
            if meanwhile:
                meanwhile()
            return account, browser, source_answers(browser, "cas-emse", f"cas-e2e-{suffix}"), met, (target, query)

        # The names agree ("Consent Test", the account's): linked at once, no second Alumnforce sign-in.
        holder, browser, ended, met, (target, _) = routing("f", "99102", ("Consent", "TEST"))
        check(met == ["ak-stage-autosubmit", "alumni_route"] and ended_on_code(ended, target), f"names that agree: the login page, Alumnforce ONCE, the routing page, the CAS, and the SAME authorization ends on its code ({met}, {ended})")
        check(UserSAMLSourceConnection.objects.filter(user=holder, source=alumni, identifier="99102").exists() and not User.objects.filter(username="alumni-99102").exists(), "the Alumni identity is linked to the CAS account, and no second account exists")
        holder.refresh_from_db()
        check(holder.attributes.get("alumni") == read, f"the membership read of that Alumnforce sign-in is stored on the linked account (D43) ({holder.attributes.get('alumni')})")
        check("miconnect/alumni-link-parked" not in session_of(browser), "the parked identity is spent")

        # The names differ: a page naming both accounts, nothing linked without the tick, then linked.
        other, browser, page, met, (target, query) = routing("h", "99105", ("Jeanne", "Martin"))
        notice = fields(page).get("alumni_link_parked_notice", {}).get("initial_value") or ""
        check(page.get("component") == "ak-stage-prompt" and "Jeanne Martin" in notice and "Consent Test" in notice, f"names that differ: a page naming BOTH accounts ({page.get('component')}, {notice[:120]})")
        # The page POSTs with the shell's own query, as the browser does: the link flow's `next`.
        link_query = urlencode({"next": f"/application/o/authorize/?{query}"})
        url = f"/api/v3/flows/executor/miconnect-alumni-link/?{urlencode({'query': link_query})}"
        refused_page = follow(browser, browser.post(url, data=json.dumps({"component": "ak-stage-prompt", "alumni_link_parked_confirm": False}), content_type="application/json"))
        check(refused_page.get("component") == "ak-stage-prompt" and not UserSAMLSourceConnection.objects.filter(user=other).exists(), "without the tick nothing is linked")
        ended = follow(browser, browser.post(url, data=json.dumps({"component": "ak-stage-prompt", "alumni_link_parked_confirm": True}), content_type="application/json"))
        check(ended_on_code(ended, target) and UserSAMLSourceConnection.objects.filter(user=other, source=alumni, identifier="99105").exists(), f"with the tick, linked, and the SAME authorization ends on its code ({ended})")
        # The residual risk, stated: a HOMONYM. Someone who leaves a browser after "I have a School
        # account" and a person of the SAME name who signs in with the CAS in that browser are linked
        # with no page; any other name meets the page above (owner, 2026-11-25).

        # A parked identity linked to another account meanwhile (another tab) is refused, nothing changes.
        elsewhere = User.objects.create(username=PREFIX + "elsewhere", name="Elsewhere")
        fourth, browser, refused_again, met, _ = routing("j", "99107", ("Consent", "Test"), meanwhile=lambda: UserSAMLSourceConnection.objects.create(user=elsewhere, source=alumni, identifier="99107"))
        check(refused_again.get("component") == "ak-stage-access-denied" and not UserSAMLSourceConnection.objects.filter(user=fourth).exists(), f"an identity linked to another account meanwhile is refused, nothing linked ({refused_again.get('component')})")

        # A PARKED RECORD LEFT BEHIND: X signs in with Alumni in a shared browser, chooses "I have a School
        # account" and walks away at the CAS page; V (a HOMONYM, the case no page would catch) signs in
        # there by the ordinary login page - Django's login keeps the anonymous session's data - and later
        # follows the D44 step's link. X's identity must not be linked to V: the link does not name the
        # record's nonce, so the record is dropped and the step's link goes on as for anyone.
        browser = Client(HTTP_HOST="localhost")
        authorize(browser, local)
        go(browser, "/source/saml/alumni/")
        source_answers(browser, "alumni", "99108", properties={"username": "alumni-99108", "name": "Consent Test", "firstname": "Consent", "lastname": "Test", "alumni_read": read})
        executor(browser, "miconnect-enrollment", {"component": "ak-stage-prompt", "alumni_route": "cas"})
        check(session_of(browser).get("miconnect/alumni-link-parked", {}).get("identifier") == "99108", "X's identity is parked, X walks away")
        become({"promos": [2024], "posts": [], "alumni": None, "linked": False})
        executor(browser, "password-login")
        executor(browser, "password-login", {"component": "ak-stage-identification", "uid_field": student.username})
        executor(browser, "password-login", {"component": "ak-stage-password", "password": PASSWORD})
        check(session_of(browser).get("miconnect/alumni-link-parked", {}).get("identifier") == "99108", "V's ordinary sign-in keeps the anonymous session's data, X's record included")
        target, page, query = authorize_on(browser, local, date(2026, 1, 15))
        followed = go(browser, link_of(fields(page)["alumni_link_reminder"]["initial_value"]))
        check(followed.get("component") == "ak-stage-autosubmit" and not UserSourceConnection.objects.filter(source=alumni, identifier="99108").exists(), f"V's link step goes to Alumnforce, and X's parked identity is linked to nobody ({followed.get('component')})")
        check("miconnect/alumni-link-parked" not in session_of(browser), "the record the link did not name is dropped")

        # 12 - THE BOUNDARY: only a link MiConnect proposed in this session, to this account, skips the
        # confirmation and resumes; nothing a browser sends can make one.
        stranger, stranger_client = signed_in(PREFIX + "g", {"cgu_version": VERSION, **copy.deepcopy(PROFILE)})
        page = go(stranger_client, "/if/flow/miconnect-alumni-link/?next=%2Fapplication%2Fo%2Fauthorize%2F")
        check(page.get("component") == "ak-stage-prompt" and "alumni_link_confirm" in fields(page), f"the link flow reached with no offer (a link from anywhere) shows the D49 confirmation ({page.get('component')})")

        def offer(pk, session_key=None, value=None):
            store = session_of(stranger_client)
            store["miconnect/alumni-link-offered"] = {"pk": pk, "nonce": "n0nce"}
            if session_key:
                store[session_key] = value
            store.save()

        offer(holder.pk)
        page = go(stranger_client, "/if/flow/miconnect-alumni-link/?offer=n0nce")
        check("alumni_link_confirm" in fields(page), "an offer made to ANOTHER account of the session shows the confirmation")
        for evil in ("https%3A%2F%2Fevil.example%2F", "%2F%09%2Fevil.example%2F", "%2F%5Cevil.example"):
            offer(stranger.pk)
            page = go(stranger_client, f"/if/flow/miconnect-alumni-link/?offer=n0nce&next={evil}")
            check("alumni_link_confirm" in fields(page), f"an offer whose `next` leaves MiConnect ({evil}) is no proposal: the confirmation shows")
        page = go(stranger_client, "/if/flow/miconnect-alumni-link/?offer=n0nce")
        check("alumni_link_confirm" in fields(page), "an offer is spent once its nonce is read: a second visit shows the confirmation")
        offer(stranger.pk, "authentik/impersonate/user", stranger)
        page = go(stranger_client, "/if/flow/miconnect-alumni-link/?offer=n0nce")
        check("alumni_link_confirm" in fields(page), f"an offer in an IMPERSONATED session is no proposal: the confirmation shows ({page.get('component')})")
        store = session_of(stranger_client)
        store.pop("authentik/impersonate/user", None)
        store.save()
        # A crafted NON-ASCII nonce is a mismatch like any other, never an error: the D49 page, not a
        # blank naming page; the offer stays for the page's own link, the parked record is dropped.
        for crafted in ("offer=%C3%A9", "parked=%C3%A9"):
            offer(stranger.pk, "miconnect/alumni-link-parked", {"nonce": "p4rked", "identifier": "99111", "firstname": "Consent", "lastname": "Test"})
            page = go(stranger_client, f"/if/flow/miconnect-alumni-link/?{crafted}")
            check(page.get("component") == "ak-stage-prompt" and "alumni_link_confirm" in fields(page), f"a non-ASCII nonce ({crafted}) is a mismatch: the D49 confirmation ({page.get('component')}, {list(fields(page))})")
            check(isinstance(session_of(stranger_client).get("miconnect/alumni-link-offered"), dict) and "miconnect/alumni-link-parked" not in session_of(stranger_client), f"({crafted}) the offer is kept for its own link, the unnamed parked record is dropped")
        check(not UserSourceConnection.objects.filter(source=alumni, identifier="99111").exists(), "and nothing is linked from it")
        store = session_of(stranger_client)
        store.pop("miconnect/alumni-link-offered", None)
        store.save()
        # A resume token planted for ANOTHER account (a stale or foreign plan) never links: the done flow refuses.
        done_flow = Flow.objects.get(slug="miconnect-alumni-link-done")

        def token_for(account, name):
            planner = FlowPlanner(done_flow)
            planner.use_cache = False
            plant = RequestFactory().get("/")
            plant.user = account
            plant.session = session_of(stranger_client)
            return FlowToken.objects.create(user=account, flow=done_flow, identifier=f"consent-e2e-{name}", _plan=FlowToken.pickle(planner.plan(plant, {PLAN_CONTEXT_PENDING_USER: account})))

        foreign = token_for(holder, "foreign-token")
        UserSAMLSourceConnection.objects.filter(user=holder).delete()

        def plant_token(token=None, next_url=None):
            store = session_of(stranger_client)
            store[SESSION_KEY_OVERRIDE_FLOW_TOKEN] = token or foreign
            store.pop(SESSION_KEY_PLAN, None)
            store[SESSION_KEY_GET] = {"next": next_url} if next_url else {}
            store.save()

        plant_token()
        refused_link = source_answers(stranger_client, "alumni", "99103", user=stranger)
        check(refused_link.get("component") == "ak-stage-access-denied", f"a resume token of another account is refused by the done flow ({refused_link.get('component')})")
        check(not UserSourceConnection.objects.filter(source=alumni, identifier="99103").exists(), "and nothing is linked, to either account")
        # A direct visit after an abandoned proposal drops the stale token: authentik's default, the settings.
        plant_token()
        page = go(stranger_client, "/source/saml/alumni/")
        check("alumni_link_confirm" in fields(page) and SESSION_KEY_OVERRIDE_FLOW_TOKEN not in session_of(stranger_client), "a direct visit shows the confirmation and drops any stale resume token")
        url = "/api/v3/flows/executor/miconnect-alumni-pre-authentication/?query="
        sent = follow(stranger_client, stranger_client.post(url, data=json.dumps({"component": "ak-stage-prompt", **{key: field.get("initial_value") for key, field in fields(page).items()}, "alumni_link_confirm": True}), content_type="application/json"))
        check(sent.get("component") == "ak-stage-autosubmit", f"ticked, the request goes to Alumnforce ({sent.get('component')})")
        landed = source_answers(stranger_client, "alumni", "99104", user=stranger)
        check("#/settings;page-sources" in landed.get("landed", ""), f"a link nobody proposed ends where authentik ends it, on the settings ({landed})")
        check(UserSAMLSourceConnection.objects.filter(user=stranger, identifier="99104").exists(), "and is linked to the session's account")

        # The done flow's other refusals: the account already holds an Alumni link (99104 above)...
        plant_token(token_for(stranger, "own-token"))
        refused_link = source_answers(stranger_client, "alumni", "99109", user=stranger)
        check(refused_link.get("component") == "ak-stage-access-denied" and not UserSourceConnection.objects.filter(source=alumni, identifier="99109").exists(), f"a resumed link to an account that already holds an Alumni link is refused, nothing linked ({refused_link.get('component')})")
        # ... and a redirect that leaves MiConnect, even a tab variant.
        UserSAMLSourceConnection.objects.filter(user=stranger).delete()
        for evil in ("https://evil.example/", "/\t/evil.example/"):
            plant_token(token_for(stranger, "own-token-evil"), evil)
            refused_link = source_answers(stranger_client, "alumni", "99110", user=stranger)
            check(refused_link.get("component") == "ak-stage-access-denied" and not UserSourceConnection.objects.filter(source=alumni, identifier="99110").exists(), f"a resumed link whose redirect leaves MiConnect ({evil!r}) is refused, nothing linked ({refused_link.get('component')})")
        # A token left by an abandoned Alumni link that meets a link of ANOTHER source (the CAS from the
        # settings) does not refuse it: linked to the session's own account, as authentik links it.
        plant_token(token_for(stranger, "own-token-cas"))
        linked = source_answers(stranger_client, "cas-emse", "cas-e2e-stale", user=stranger)
        check(linked.get("component") != "ak-stage-access-denied" and UserOAuthSourceConnection.objects.filter(user=stranger, source=cas_source, identifier="cas-e2e-stale").exists(), f"a stale Alumni token does not refuse a CAS link from the settings: linked to the session's account ({linked})")
        check(SESSION_KEY_OVERRIDE_FLOW_TOKEN not in session_of(stranger_client), "and the stale token is spent")
    finally:
        User.objects.filter(username__startswith=PREFIX).delete()
        User.objects.filter(username__startswith="alumni-991").delete()
        FlowToken.objects.filter(identifier__startswith="consent-e2e-").delete()
    print("CONSENT-OK")
