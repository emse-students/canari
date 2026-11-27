"""Drives the REAL enrolment flow through authentik's own flow executor, once per kind of person.

Run through `ak shell` by test-blueprints.sh (and by hand on any disposable instance): the plan is
seeded the way a source seeds it (SourceFlowManager.handle_enroll + _prepare_flow - the identity the
property mapping returned, and NO pending user), then the executor's GET and POST do the rest, so
the prompt stages, their validation policies, the stage-binding policies, the user write and the
login are all the ones production runs. It prints `ENROLLMENT-OK` when every assertion held and
raises otherwise.

WHY THE FLOW IS DRIVEN AND NOT ONLY ITS POLICIES EVALUATED: the policies alone said "fine" for a flow
whose seeded context never reached the write stage. Only the executor shows what a person gets.

Two traps met writing it, both about the TEST and not the flow:
  * authentik's session cookie is a signed JWT; the bare session key is accepted only under TEST, so
    a hand-made cookie is ignored and the executor quietly PLANS ANEW, with an empty context;
  * a completed POST is answered with a redirect to the next challenge, which must be followed.

THE ROLLED-BACK MERGE (D54: `transaction.on_commit(merged.save)` - no Event, so no push, for a merge
that rolls back) is driven by raising INSIDE the policy's own atomic block, after the merge registered
its Event: `django.db.transaction.on_commit` is wrapped for that one sign-in. The other form - the
whole sign-in inside an OUTER `transaction.atomic()` here, rolled back after - CANNOT RUN: on
2026-11-27 the step never returned and was killed after about six hours, the executor planning again
and again inside the open outer transaction. Do not reintroduce it.
"""
import json
import os
import threading
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import import_module
from urllib.parse import parse_qs, urlencode, urlparse

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.test import Client, RequestFactory

from authentik.core.models import Group, User
from authentik.events.models import Event, Notification, NotificationRule, NotificationTransport
from authentik.events.tasks import gdpr_cleanup
from authentik.policies.engine import PolicyEngine
from authentik.policies.models import PolicyEngineMode
from guardian.shortcuts import get_anonymous_user
from authentik.flows.planner import PLAN_CONTEXT_PENDING_USER
from authentik.lib.merge import MERGE_LIST_UNIQUE
from authentik.policies.utils import delete_none_values
from authentik.core.sources.stage import PLAN_CONTEXT_SOURCES_CONNECTION, PostSourceStage
from authentik.flows.models import Flow, in_memory_stage
from authentik.flows.planner import PLAN_CONTEXT_SOURCE, PLAN_CONTEXT_SSO, FlowPlanner
from authentik.flows.views.executor import SESSION_KEY_PLAN
from authentik.root.middleware import SessionMiddleware
from authentik.sources.oauth.models import OAuthSource, UserOAuthSourceConnection
from authentik.sources.saml.models import SAMLSource, UserSAMLSourceConnection
from authentik.stages.identification.models import IdentificationStage
from authentik.stages.password import BACKEND_INBUILT
from authentik.stages.password.stage import PLAN_CONTEXT_AUTHENTICATION_BACKEND
from authentik.stages.prompt.stage import PLAN_CONTEXT_PROMPT
from authentik.stages.user_write.stage import PLAN_CONTEXT_USER_PATH
from authentik.tenants.models import Tenant

SLUG = "miconnect-enrollment"
PAGE_ONE = ["campus", "is_student", "post_emse", "post_me", "post_alumni"]
PAGE_TWO = ["attributes.promo", "attributes.formation"]
BOXES_OFF = {"post_emse": False, "post_me": False, "post_alumni": False}


def seed(slug, context, append=()):
    """A client whose session holds the plan of flow `slug`, seeded the way a source seeds it (with the
    stages the source appends, `append`)."""
    flow = Flow.objects.get(slug=slug)
    client = Client(HTTP_HOST="localhost")
    request = RequestFactory().get("/")
    request.user = AnonymousUser()
    request.session = client.session
    plan = FlowPlanner(flow).plan(request, {PLAN_CONTEXT_USER_PATH: "users", PLAN_CONTEXT_AUTHENTICATION_BACKEND: BACKEND_INBUILT, PLAN_CONTEXT_SSO: True, **context})
    for stage in append:
        plan.append_stage(stage)
    session = client.session
    session[SESSION_KEY_PLAN] = plan
    session.save()
    client.cookies[settings.SESSION_COOKIE_NAME] = SessionMiddleware.encode_session(session.session_key, AnonymousUser())
    return client


def start(username, name):
    source = OAuthSource.objects.get(slug="cas-emse")
    return seed(SLUG, {
        PLAN_CONTEXT_PROMPT: {"username": username, "name": name},
        PLAN_CONTEXT_SOURCE: source,
        PLAN_CONTEXT_SOURCES_CONNECTION: UserOAuthSourceConnection(source=source, identifier=username),
    })


def alumni_properties(af_id, cotisant="1", firstname="Claire", lastname="de la Fontaine"):
    """What an Alumni sign-in carries: the base properties SAMLSource builds from the attributes measured
    on 2026-11-23 (the persistent NameID is the `username`), passed through the source's REAL mappings
    and merged the way SourceMapper merges them."""
    source = SAMLSource.objects.get(slug="alumni")
    properties = {"af_id": af_id, "firstname": firstname, "lastname": lastname, "email": f"claire.{af_id}@example.org", "username": af_id, "path": "users", "attributes": {}}
    if cotisant is not None:
        properties["cotisant"] = cotisant
    for mapping in source.user_property_mappings.all().select_subclasses():
        value = mapping.evaluate(user=None, request=None, source=source, properties=properties)
        if isinstance(value, dict):
            MERGE_LIST_UNIQUE.merge(properties, value)
    return delete_none_values(properties)


def start_alumni(af_id, cotisant="1"):
    source = SAMLSource.objects.get(slug="alumni")
    return seed(SLUG, {
        PLAN_CONTEXT_PROMPT: alumni_properties(af_id, cotisant),
        PLAN_CONTEXT_SOURCE: source,
        PLAN_CONTEXT_SOURCES_CONNECTION: UserSAMLSourceConnection(source=source, identifier=af_id),
    })


def sign_in_alumni(user, connection, cotisant, meanwhile=None):
    """Runs the Alumni source's own sign-in flow for `user`, as SourceFlowManager.handle_auth seeds it;
    `meanwhile` runs between the plan and its execution, as an edit made elsewhere during a sign-in."""
    source = connection.source
    client = seed(source.authentication_flow.slug, {
        PLAN_CONTEXT_PENDING_USER: user,
        PLAN_CONTEXT_PROMPT: alumni_properties(connection.identifier, cotisant),
        PLAN_CONTEXT_SOURCE: source,
        PLAN_CONTEXT_SOURCES_CONNECTION: connection,
    })
    if meanwhile:
        meanwhile()
    step(client, slug=source.authentication_flow.slug)
    user.refresh_from_db()


def sign_in_to_the_end(user, connection, asserted=("Claire", "de la Fontaine")):
    """The Alumni source's sign-in flow for `user`, seeded EXACTLY as SourceFlowManager.handle_auth seeds
    it (PostSourceStage appended), Alumnforce asserting the `asserted` first and last names, and driven
    to its end; returns the last challenge and the username the session is signed in as (None when
    nobody is)."""
    source = connection.source
    slug = source.authentication_flow.slug
    client = seed(slug, {
        PLAN_CONTEXT_PENDING_USER: user,
        PLAN_CONTEXT_PROMPT: alumni_properties(connection.identifier, "1", *asserted),
        PLAN_CONTEXT_SOURCE: source,
        PLAN_CONTEXT_SOURCES_CONNECTION: connection,
    }, append=[in_memory_stage(PostSourceStage)])
    response = client.get(f"/api/v3/flows/executor/{slug}/?query=")
    for _ in range(10):
        if response.status_code not in (301, 302):
            break
        response = client.get(response["Location"])
    me = client.get("/api/v3/core/users/me/")
    return response.json(), (me.json()["user"]["username"] if me.status_code == 200 else None)


def signed_in(user, password):
    """A client signed in as `user` through `password-login`, a REAL login: the session carries what a
    person signed in through the CAS carries when they reach the Alumni source."""
    user.set_password(password)
    user.save()
    client = Client(HTTP_HOST="localhost")
    url = "/api/v3/flows/executor/password-login/?query="

    def run(payload=None):
        response = client.get(url) if payload is None else client.post(url, data=json.dumps(payload), content_type="application/json")
        # Every stage that completes answers a redirect to the executor: followed to the next challenge.
        for _ in range(10):
            if response.status_code not in (301, 302):
                break
            response = client.get(response["Location"])
        return response.json()

    first = run()
    assert first.get("component") == "ak-stage-identification", first
    second = run({"component": "ak-stage-identification", "uid_field": user.username})
    if second.get("component") == "ak-stage-password":
        second = run({"component": "ak-stage-password", "password": password})
    assert second.get("component") not in ("ak-stage-identification", "ak-stage-password"), ("the sign-in was refused", second)
    return client


def enter_alumni_source(client):
    """GETs the Alumni source's entry as a browser does; returns the pre-authentication flow's executor
    URL (the POST binding plans it - InitiateView) and its first challenge."""
    response = client.get("/source/saml/alumni/")
    assert response.status_code == 302, ("the entry did not hand over to a flow", response.status_code)
    location = urlparse(response["Location"])
    assert location.path == "/if/flow/miconnect-alumni-pre-authentication/", ("the entry went elsewhere", response["Location"])
    url = f"/api/v3/flows/executor/miconnect-alumni-pre-authentication/?{urlencode({'query': location.query})}"
    return url, client.get(url).json()


def post_prompt(client, url, payload):
    response = client.post(url, data=json.dumps({"component": "ak-stage-prompt", **payload}), content_type="application/json")
    if response.status_code in (301, 302):
        response = client.get(response["Location"])
    return response.json()


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"  ok   {message}", flush=True)


def step(client, payload=None, slug=SLUG):
    url = f"/api/v3/flows/executor/{slug}/?query="
    if payload is None:
        response = client.get(url)
    else:
        response = client.post(url, data=json.dumps({"component": "ak-stage-prompt", **payload}), content_type="application/json")
    if response.status_code in (301, 302):
        response = client.get(response["Location"])
    return response.json() if response.status_code != 302 and response.content else {}


def field_keys(challenge):
    return [field.get("field_key") for field in challenge.get("fields", [])]


def messages(challenge):
    return [error.get("string") for errors in (challenge.get("response_errors") or {}).values() for error in errors]


def enrol(username, name, page_one, page_two=None):
    """Runs one person through the flow and returns the user it created, asserting the pages."""
    User.objects.filter(username=username).delete()
    client = start(username, name)
    first = step(client)
    assert first.get("component") == "ak-stage-prompt" and field_keys(first) == PAGE_ONE, (username, "page 1", first.get("component"), field_keys(first))
    second = step(client, page_one)
    if page_two is None:
        assert second.get("component") != "ak-stage-prompt", (username, "a person with no cursus was asked for one", field_keys(second))
    else:
        assert second.get("component") == "ak-stage-prompt" and sorted(field_keys(second)) == sorted(PAGE_TWO), (username, "page 2", field_keys(second))
        step(client, page_two)
    user = User.objects.filter(username=username).first()
    assert user is not None, (username, "no user was created")
    return user


def refused(username, name, page_one, page_two=None):
    """Runs a person who must NOT get in; returns the message shown and asserts no user exists."""
    User.objects.filter(username=username).delete()
    client = start(username, name)
    step(client)
    shown = step(client, page_one)
    if page_two is not None:
        shown = step(client, page_two)
    assert shown.get("component") == "ak-stage-prompt", (username, "a refused person left the form", shown.get("component"))
    assert not User.objects.filter(username=username).exists(), (username, "a refused person got an account")
    return messages(shown)


def profile(user):
    return user.attributes.get("profile")


PUSH = "miconnect-alumni-merge-push"
PUSH_SECRET_HEADER = "X-MiConnect-Alumni-Merge-Secret"


class PushStub:
    """Canari's `POST /api/hooks/miconnect/alumni-merge`, stubbed: a receiver on the worker's loopback
    that records every POST with its path (85-alumni-merge-push.yaml).

    THE PUSH IS DELIVERED SYNCHRONOUSLY, never awaited from the worker. Every Event of this run is
    dispatched to every rule (`event_trigger_dispatch`), thousands of tasks the worker drains in its
    own time - measured on a fresh instance, the merge's tasks were still queued two minutes after
    the sign-in. `deliver` therefore runs what authentik's `notification_transport` runs, for the
    rule's own destination, from this process, to `/sync`. The stored transport is pointed at
    `/worker` for the whole run and NEVER given its production URL back: this instance is thrown
    away, and the worker, still draining after the run, would otherwise send the test's merges to
    production."""

    def __init__(self):
        self.received = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                stub.received.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": json.loads(self.rfile.read(length) or b"{}")})
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"completed":true}')

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        NotificationTransport.objects.filter(name=PUSH).update(webhook_url=f"{self.base}/worker")

    def deliver(self, event):
        """What `notification_transport` does for this rule, synchronously: one Notification per
        destination user (`send_once` stops at the first), sent by the stored transport - its body
        and header mappings, its secret - to `/sync`. Returns how many were sent."""
        rule = NotificationRule.objects.get(name=PUSH)
        transport = NotificationTransport.objects.get(name=PUSH)
        transport.webhook_url = f"{self.base}/sync"
        sent = 0
        for destination in rule.destination_users(event):
            notification = Notification(severity=rule.severity, body=event.summary, event=event, user=User.objects.get(pk=destination.pk))
            transport.send(notification)
            sent += 1
            if transport.send_once:
                break
        return sent

    def for_duplicate(self, duplicate_uuid):
        return [r for r in self.received if r["path"] == "/sync" and r["body"].get("duplicateUuid") == duplicate_uuid]

    def close(self):
        self.server.shutdown()


def rule_sends(event):
    """Whether the push rule's policies pass `event`, decided as authentik's `event_trigger_handler`
    decides it - synchronously, so a refusal is proven NOT pushed without waiting on the worker."""
    rule = NotificationRule.objects.get(name=PUSH)
    user = User.objects.filter(pk=(event.user or {}).get("pk")).first() or get_anonymous_user()
    engine = PolicyEngine(rule, user)
    engine.mode = PolicyEngineMode.MODE_ANY
    engine.empty_result = False
    engine.use_cache = False
    engine.request.obj = event
    engine.request.context["event"] = event
    engine.build()
    return engine.result.passing


with Tenant.objects.get(ready=True):
    flow = Flow.objects.get(slug=SLUG)
    for source in (OAuthSource.objects.get(slug="cas-emse"), SAMLSource.objects.get(slug="alumni")):
        assert source.enrollment_flow_id == flow.pk, f"source {source.slug} does not enrol through {SLUG}"
    for gone in ("miconnect-enrollment-cas", "miconnect-enrollment-alumni"):
        assert not Flow.objects.filter(slug=gone).exists(), f"{gone} still exists"

    stub = None
    try:
        # A - a student: both pages, the legacy attributes still written for the old claims.
        user = enrol("e2e-a", "Jean DUPONT", {"campus": "saint-etienne", "is_student": True, **BOXES_OFF}, {"attributes.formation": "ICM", "attributes.promo": 2024})
        assert profile(user) == {"version": 1, "campus": "saint-etienne", "cursus": [{"formation": "ICM", "promo": 2024}], "posts": [], "firstName": "Jean", "lastName": "DUPONT"}, profile(user)
        assert user.attributes["school_status"] == "Elève" and user.attributes["formation"] == "ICM" and user.attributes["promo"] == 2024

        # B - the campus is the person's own choice, never deduced from the formation (D6).
        user = enrol("e2e-b", "Marie-Claire DE LA TOUR", {"campus": "gardanne", "is_student": True, **BOXES_OFF}, {"attributes.formation": "ISMIN", "attributes.promo": 2025})
        assert profile(user)["campus"] == "gardanne" and profile(user)["lastName"] == "DE LA TOUR" and profile(user)["firstName"] == "Marie-Claire", profile(user)
        user = enrol("e2e-b2", "Eva LEROY", {"campus": "saint-etienne", "is_student": True, **BOXES_OFF}, {"attributes.formation": "ISMIN", "attributes.promo": 2025})
        assert profile(user)["campus"] == "saint-etienne", "an ISMIN student who chose Saint-Etienne was put in Gardanne"

        # C - staff: one page only, one post per box ticked, no cursus.
        user = enrol("e2e-c", "Paul MARTIN", {"campus": "saint-etienne", "is_student": False, "post_emse": True, "post_me": True, "post_alumni": False})
        assert profile(user)["cursus"] == [] and profile(user)["posts"] == ["EMSE", "ME"], profile(user)
        assert user.attributes["school_status"] == "Personnel de l'école" and "formation" not in user.attributes

        # D - cumulative (D1): a cursus AND a post.
        user = enrol("e2e-d", "Ana PEREZ", {"campus": "saint-etienne", "is_student": True, "post_emse": False, "post_me": False, "post_alumni": True}, {"attributes.formation": "Autre", "attributes.promo": 2023})
        assert profile(user)["cursus"] == [{"formation": "Autre", "promo": 2023}] and profile(user)["posts"] == ["ALUMNI"], profile(user)

        # E - nobody outside the boxes gets in (D12), and is told why.
        said = refused("e2e-e", "Lea BERNARD", {"campus": "saint-etienne", "is_student": False, **BOXES_OFF})
        assert any("coche au moins une case" in text for text in said), said

        # F - an impossible entry year is refused WITH a message, not silently.
        said = refused("e2e-f", "Tom ROBERT", {"campus": "saint-etienne", "is_student": True, **BOXES_OFF}, {"attributes.formation": "ICM", "attributes.promo": 1800})
        assert any("1816" in text for text in said), said

        # G - an Alumni identity with no link meets the routing page FIRST (D47); the CAS never does (A-F
        # above opened on page one).
        client = start_alumni("90001")
        route = step(client)
        check(route.get("component") == "ak-stage-prompt" and field_keys(route) == ["alumni_route"], f"an Alumni identity is asked whether it has a School account first ({field_keys(route)})")
        # ...and "I have one" leaves for the CAS-only sign-in, then the link MiConnect proposes; with no
        # application in the plan, the link flow has no `next` (test-consent-flow.py step 11 drives the
        # path from an application back to it).
        def after_cas(to):
            """The link flow `to` sends the browser to after the CAS-only sign-in: (its path, its query)."""
            outer = urlparse(to)
            inner = urlparse(parse_qs(outer.query).get("next", [""])[0])
            return outer.path, inner.path, parse_qs(inner.query)

        left = step(client, {"alumni_route": "cas"})
        cas_path, link_path, link_query = after_cas(left.get("to", ""))
        check(left.get("component") == "xak-flow-redirect" and (cas_path, link_path) == ("/if/flow/miconnect-auth-cas/", "/if/flow/miconnect-alumni-link/") and "next" not in link_query, f"'I have a School account' sends to the CAS, then to the link ({left})")
        parked = import_module(settings.SESSION_ENGINE).SessionStore(SessionMiddleware.decode_session_key(client.cookies[settings.SESSION_COOKIE_NAME].value)).get("miconnect/alumni-link-parked", {})
        check(parked.get("identifier") == "90001" and parked.get("nonce") and link_query.get("parked") == [parked["nonce"]], "and keeps the identity Alumnforce asserted in the session, with a nonce only that link names")
        # The plan's application comes along: the link flow's `next` is where the sign-in was going.
        client = seed(SLUG, {
            PLAN_CONTEXT_PROMPT: alumni_properties("90008"),
            PLAN_CONTEXT_SOURCE: SAMLSource.objects.get(slug="alumni"),
            PLAN_CONTEXT_SOURCES_CONNECTION: UserSAMLSourceConnection(source=SAMLSource.objects.get(slug="alumni"), identifier="90008"),
            "redirect": "/application/o/authorize/?client_id=x&state=y",
        })
        step(client)
        left = step(client, {"alumni_route": "cas"})
        check(after_cas(left.get("to", ""))[2].get("next") == ["/application/o/authorize/?client_id=x&state=y"], f"...with the application's authorization as the link's `next` ({left.get('to')})")
        client = seed(SLUG, {
            PLAN_CONTEXT_PROMPT: alumni_properties("90009"),
            PLAN_CONTEXT_SOURCE: SAMLSource.objects.get(slug="alumni"),
            PLAN_CONTEXT_SOURCES_CONNECTION: UserSAMLSourceConnection(source=SAMLSource.objects.get(slug="alumni"), identifier="90009"),
            "redirect": "https://evil.example/",
        })
        step(client)
        left = step(client, {"alumni_route": "cas"})
        check(after_cas(left.get("to", ""))[1] == "/if/flow/miconnect-alumni-link/" and "next" not in after_cas(left.get("to", ""))[2], f"...and never a `next` that leaves MiConnect ({left.get('to')})")
        check(not User.objects.filter(username="alumni-90001").exists(), "and creates no account")

        # H - "I have none" creates the account (D46): `alumni-<af_id>`, the Alumni e-mail, the two names
        # as sent, and the membership read with its date.
        client = start_alumni("90002")
        step(client)
        first = step(client, {"alumni_route": "create"})
        check(field_keys(first) == PAGE_ONE, f"'I have none' goes on to page one ({field_keys(first)})")
        step(client, {"campus": "saint-etienne", "is_student": True, **BOXES_OFF})
        step(client, {"attributes.formation": "ICM", "attributes.promo": 2012})
        user = User.objects.filter(username="alumni-90002").first()
        check(user is not None, "an account created through Alumni is named alumni-<af_id>")
        check(user.email == "claire.90002@example.org", f"it keeps the Alumni e-mail ({user.email})")
        check(profile(user)["firstName"] == "Claire" and profile(user)["lastName"] == "de la Fontaine", f"the two names are taken as sent, not split by capitals ({profile(user)})")
        check(profile(user)["cursus"] == [{"formation": "ICM", "promo": 2012}], f"the profile is the one declared ({profile(user)})")
        alumni = user.attributes.get("alumni") or {}
        check(alumni.get("cotisant") is True and date.fromisoformat(alumni.get("read_on", "")).isoformat() == alumni.get("read_on"), f"the membership read and its date are written at enrolment ({alumni})")
        check(not {"af_id", "cotisant", "firstname", "lastname", "alumni_route", "alumni_read"} & set(user.attributes), f"no raw source attribute lands on the account ({sorted(user.attributes)})")

        # I - a cotisant value that is neither "1" nor "0", or none, carries no read at all.
        for odd in ("oui", None):
            carried = alumni_properties("90003", odd).get("alumni_read")
            check(carried is None, f"cotisant={odd!r} carries no membership read ({carried})")
        check(alumni_properties("90003", "0")["alumni_read"]["cotisant"] is False, "cotisant '0' is read as false")

        # J - EVERY Alumni sign-in into an existing account writes the read, and ONLY the read (D43): a
        # CAS account keeps its username, name and e-mail.
        source = SAMLSource.objects.get(slug="alumni")
        cas = User.objects.create(username="e2e-cas-linked", name="Jean DUPONT", email="", attributes={"profile": {"version": 1, "cursus": [{"formation": "ICM", "promo": 2015}], "posts": []}, "alumni": {"cotisant": False, "read_on": "2020-01-01"}})
        connection = UserSAMLSourceConnection.objects.create(source=source, user=cas, identifier="90004")
        sign_in_alumni(cas, connection, "1")
        check((cas.username, cas.name, cas.email) == ("e2e-cas-linked", "Jean DUPONT", ""), f"the sign-in renames nothing ({cas.username}, {cas.name}, {cas.email!r})")
        check(cas.attributes["alumni"]["cotisant"] is True and cas.attributes["alumni"]["read_on"] != "2020-01-01", f"the new read replaces the old one ({cas.attributes['alumni']})")
        check(cas.attributes["profile"]["cursus"] == [{"formation": "ICM", "promo": 2015}], "the profile is untouched")
        # ...and a sign-in without a read writes nothing: the last read keeps its date and expires on its own.
        before = dict(cas.attributes["alumni"])
        sign_in_alumni(cas, connection, None)
        check(cas.attributes["alumni"] == before and cas.username == "e2e-cas-linked", f"a sign-in with no read leaves the last one ({cas.attributes['alumni']})")
        # ...and the write touches the read alone, on the account as it is NOW: an edit made elsewhere
        # while the sign-in ran (the profile editor) survives it - the plan's copy of the account is stale.
        def edit_elsewhere():
            fresh = User.objects.get(pk=cas.pk)
            fresh.attributes["profile"]["cursus"] = [{"formation": "ICM", "promo": 2016}]
            fresh.save()
        sign_in_alumni(cas, connection, "1", meanwhile=edit_elsewhere)
        check(cas.attributes["profile"]["cursus"] == [{"formation": "ICM", "promo": 2016}] and cas.attributes["alumni"]["cotisant"] is True, f"an edit made during the sign-in survives it ({cas.attributes})")

        # K - both ways in are on the login page (D45), and the Alumni source signs in through its own flow.
        check(source.promoted and source.authentication_flow.slug == "miconnect-alumni-authentication", "the Alumni source is promoted and signs in through miconnect-alumni-authentication")
        listed = {s.slug for s in IdentificationStage.objects.get(name="miconnect-identification").sources.all()}
        check(listed == {"cas-emse", "alumni"}, f"the login page lists the CAS and the Alumni SSO ({sorted(listed)})")
        check(source.binding_type == "POST_AUTO" and source.pre_authentication_flow.slug == "miconnect-alumni-pre-authentication", "the Alumni source is POST_AUTO, so its pre-authentication flow runs (read on production 2026-11-23)")

        # L - THE LINK CONFIRMATION (D49), DRIVEN THROUGH THE SOURCE'S OWN ENTRY. A signed-in person who
        # reaches `/source/saml/alumni/` is shown the page naming their account; it refuses without the
        # tick, then hands over to the auto-submitted request towards Alumnforce. A signed-out person
        # meets no page: the request goes at once.
        User.objects.filter(username="e2e-d49").delete()
        cas_person = User.objects.create(username="e2e-d49", name="Marie Curie", attributes={"profile": {"version": 1, "campus": "saint-etienne", "cursus": [], "posts": ["EMSE"]}})
        client = signed_in(cas_person, "d49-test-Password-0123456789")
        url, page = enter_alumni_source(client)
        shown = {field["field_key"]: field for field in page.get("fields", [])}
        check(page.get("component") == "ak-stage-prompt" and set(shown) == {"alumni_link_notice", "alumni_link_confirm"}, f"a signed-in person meets the link confirmation ({page.get('component')}, {sorted(shown)})")
        check("Marie Curie" in shown["alumni_link_notice"]["initial_value"], "the page names the signed-in account")
        unticked = post_prompt(client, url, {"alumni_link_confirm": False})
        check(unticked.get("component") == "ak-stage-prompt" and messages(unticked), f"without the tick it does not go on ({messages(unticked)})")
        ticked = post_prompt(client, url, {"alumni_link_confirm": True})
        check(ticked.get("component") == "ak-stage-autosubmit" and ticked.get("url") == source.sso_url and "SAMLRequest" in (ticked.get("attrs") or {}), f"with the tick, the request is POSTed to Alumnforce ({ticked.get('component')}, {ticked.get('url')})")
        check(not UserSAMLSourceConnection.objects.filter(user=cas_person).exists(), "nothing is linked before Alumnforce answers")
        _, anonymous = enter_alumni_source(Client(HTTP_HOST="localhost"))
        check(anonymous.get("component") == "ak-stage-autosubmit" and anonymous.get("url") == source.sso_url, f"a signed-out person meets no page: the request goes at once ({anonymous.get('component')})")

        # M - THE MERGE AT SIGN-IN (D48). Canari MARKS the duplicate; its next Alumni sign-in moves the
        # link onto the marked account, deletes the duplicate and signs the TARGET in - only when the target
        # holds a CAS link and carries the name Alumnforce asserts at THIS sign-in - and journals an Event.
        # Every refusal changes nothing, keeps the mark, journals an Event and shows the deny stage. A
        # mark whose target no longer exists is an orphan: cleared, and the sign-in is an ordinary one.
        cas_source = OAuthSource.objects.get(slug="cas-emse")
        admins = Group.objects.create(name="e2e-merge-superusers", is_superuser=True)
        check(Tenant.objects.get(ready=True).gdpr_compliance is True, "the tenant keeps gdpr_compliance on (D57 fixes the Event, not the setting)")
        rule = NotificationRule.objects.get(name=PUSH)
        check(rule.destination_event_user and list(rule.transports.values_list("name", flat=True)) == [PUSH], "the push rule sends to the event's user through its one transport")
        check([b.policy.name for b in rule.bindings.all()] == ["miconnect-alumni-merge-is-the-event"], "the push rule is bound to its one policy")
        transport = NotificationTransport.objects.get(name=PUSH)
        check(transport.mode == "webhook" and transport.send_once and transport.webhook_url.endswith("/api/hooks/miconnect/alumni-merge") and transport.webhook_mapping_body and transport.webhook_mapping_headers, f"the push transport is a send-once webhook to Canari's hook ({transport.mode}, {transport.webhook_url})")
        stub = PushStub()
        secret = os.environ["MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET"]
        pushed = []

        asserted = ("Jean Marie", "Dupont")

        def merge_case(af_id, target_kwargs=None, duplicate_name="Jean Marie Dupont", duplicate_username=None, into=None, extra=None, cas=True, mark=None):
            """A CAS target, an `alumni-<af_id>` duplicate holding the Alumni link, the mark; `extra`
            bends one fact to make a refusal."""
            target = User.objects.create(**{"username": f"e2e-merge-{af_id}", "name": "Jean-Marie DUPONT", **(target_kwargs or {})})
            if cas:
                UserOAuthSourceConnection.objects.create(user=target, source=cas_source, identifier=f"merge.{af_id}")
            duplicate = User.objects.create(username=duplicate_username or f"alumni-{af_id}", name=duplicate_name)
            link = UserSAMLSourceConnection.objects.create(user=duplicate, source=source, identifier=af_id)
            if extra:
                extra(target, duplicate)
            duplicate.attributes = {"alumni_merge_into": into or str(target.uuid), "alumni_merge_marked_by": "e2e-admin", "alumni_merge_marked_at": "2026-11-23T12:00:00Z", **(mark or {})}
            duplicate.save()
            return target, duplicate, link

        # The target's "Jean-Marie DUPONT" is the asserted "Jean Marie" "Dupont", folded.
        target, duplicate, link = merge_case("90020")
        duplicate_pk = duplicate.pk
        duplicate_uuid = str(duplicate.uuid)
        duplicate_subject_before = duplicate.uid
        last, signed_in_as = sign_in_to_the_end(duplicate, link, asserted)
        link.refresh_from_db()
        check(signed_in_as == target.username, f"a marked duplicate's sign-in signs the TARGET in ({signed_in_as}, {last.get('component')})")
        check(link.user_id == target.pk, "the Alumni link moved onto the target")
        check(not User.objects.filter(pk=duplicate_pk).exists(), "the duplicate is deleted")
        check(not User.objects.filter(attributes__alumni_merge_into=str(target.uuid)).exists(), "no account carries the mark any more")
        merged = Event.objects.filter(action="custom_alumni_merge", context__target_pk=target.pk, context__duplicate_pk=duplicate_pk).first()
        check(merged is not None and merged.context.get("marked_by") == "e2e-admin" and merged.context.get("af_id") == "90020", f"the merge is journalled as an Event naming both accounts, who marked it and the af_id ({merged and merged.context})")
        # D57: the Event survives the duplicate. authentik's `gdpr_compliance` deletes EVERY Event of a
        # deleted user (`event_user_pre_delete_cleanup` -> `gdpr_cleanup`, run by the worker); it is run
        # HERE, synchronously, for the duplicate's pk, so the assertion does not wait on the worker.
        gdpr_cleanup.fn(duplicate_pk)
        survivors = list(Event.objects.filter(action="custom_alumni_merge", context__duplicate_pk=duplicate_pk))
        check(len(survivors) == 1, f"EXACTLY ONE merge Event exists after the duplicate's GDPR cleanup ({len(survivors)})")
        check(survivors[0].user.get("pk") == target.pk, f"its user is the TARGET, not the deleted duplicate ({survivors[0].user})")
        check(survivors[0].context.get("duplicate_uuid") == duplicate_uuid and survivors[0].context.get("target_uuid") == str(target.uuid) and survivors[0].context.get("mode") == "auto", f"its context names both uuids and the mode ({survivors[0].context})")
        # D54: both OIDC subjects, the duplicate's read before its delete (it derives from the pk).
        check(survivors[0].context.get("target_subject") == target.uid, f"its context names the target's subject ({survivors[0].context.get('target_subject')})")
        check(duplicate_subject_before and survivors[0].context.get("duplicate_subject") == duplicate_subject_before, f"its context names the DUPLICATE's subject as it was before the delete ({survivors[0].context.get('duplicate_subject')})")
        check(survivors[0].client_ip, "it carries the client's address")
        check(rule_sends(survivors[0]), "the push rule sends the merge's Event")
        pushed.append(survivors[0])

        target.refresh_from_db()
        check((target.attributes.get("alumni") or {}).get("cotisant") is True, f"the membership read is written on the target ({target.attributes.get('alumni')})")
        _, again = sign_in_to_the_end(target, link, asserted)
        check(again == target.username, "the next Alumni sign-in is an ordinary one into the target")

        unrelated = User.objects.create(username="e2e-merge-unrelated", name="Someone Else")
        refusals = [
            ("90021", "the target already holds an Alumni link", dict(extra=lambda t, d: UserSAMLSourceConnection.objects.create(user=t, source=source, identifier="90121"))),
            ("90022", "the target is a superuser", dict(extra=lambda t, d: admins.users.add(t))),
            ("90023", "the target is inactive", dict(target_kwargs={"is_active": False})),
            ("90024", "the name asserted at this sign-in differs, though the duplicate's stored name matches", dict(asserted=("Jeanne", "Dupont"))),
            ("90025", "the duplicate holds a CAS link too", dict(extra=lambda t, d: UserOAuthSourceConnection.objects.create(user=d, source=cas_source, identifier="merge.dup.90025"))),
            ("90026", "the target was created by an Alumni sign-in", dict(target_kwargs={"username": "alumni-e2e-90026"})),
            ("90028", "the mark is not a uuid", dict(into="not-a-uuid")),
            ("90029", "the marked account was not created by an Alumni sign-in", dict(duplicate_username="e2e-merge-notdup-90029")),
            ("90030", "the target is a service account", dict(target_kwargs={"type": "service_account"})),
            ("90031", "the mark names another person", dict(into=str(unrelated.uuid))),
            ("90032", "the target holds no CAS link", dict(cas=False)),
        ]
        for af_id, why, bend in refusals:
            said = bend.pop("asserted", asserted)
            target, duplicate, link = merge_case(af_id, **bend)
            last, signed_in_as = sign_in_to_the_end(duplicate, link, said)
            link.refresh_from_db()
            duplicate.refresh_from_db()
            check(
                last.get("component") == "ak-stage-access-denied"
                and "contacte un administrateur" in (last.get("error_message") or "")
                and signed_in_as is None
                and link.user_id == duplicate.pk
                and duplicate.attributes.get("alumni_merge_into")
                and User.objects.filter(pk=target.pk).exists(),
                f"refused when {why}: the deny page, nobody signed in, the link, the duplicate and the mark kept ({last.get('component')}, {signed_in_as})",
            )
            refusal = Event.objects.filter(action="custom_alumni_merge_refused", context__af_id=af_id).first()
            check(refusal is not None and refusal.client_ip, f"the refusal when {why} is journalled as an Event with the client's address ({refusal and refusal.client_ip})")
            check(not rule_sends(refusal), f"the refusal when {why} is never pushed")
        check("name_mismatch" in Event.objects.get(action="custom_alumni_merge_refused", context__af_id="90024").context["reasons"], "an asserted name that differs is refused as name_mismatch")

        # A hyphenated, particled name: "Marie-Claire DE LA TOUR" is the asserted "Marie Claire" "de la Tour".
        target, duplicate, link = merge_case("90036", target_kwargs={"name": "Marie-Claire DE LA TOUR"}, duplicate_name="Marie Claire de la Tour")
        hyphenated_uuid = str(duplicate.uuid)
        _, signed_in_as = sign_in_to_the_end(duplicate, link, ("Marie Claire", "de la Tour"))
        link.refresh_from_db()
        check(signed_in_as == target.username and link.user_id == target.pk, f"a hyphenated name matches the asserted one, folded ({signed_in_as})")
        pushed.append(Event.objects.get(action="custom_alumni_merge", context__duplicate_uuid=hyphenated_uuid))

        # D55 - THE MANUAL MARK: an admin decided identity, with a reason Canari keeps. The names differ
        # between Alumnforce and the target, and the merge goes through, because what the admin SAW is
        # what is still true at the sign-in: the asserted name is the Alumni name the admin saw, the
        # target's name is the one the admin saw.
        def manual(seen_alumni="Jean Marie Dupont", seen_target="Jean-Marie MARTIN", **over):
            return {"alumni_merge_mode": "manual", "alumni_merge_id": "00000000-0000-4000-8000-000000000055", "alumni_merge_seen_alumni_name": seen_alumni, "alumni_merge_seen_target_name": seen_target, **over}

        target, duplicate, link = merge_case("90040", target_kwargs={"name": "Jean-Marie MARTIN"}, mark=manual())
        manual_pk, manual_uuid = duplicate.pk, str(duplicate.uuid)
        _, signed_in_as = sign_in_to_the_end(duplicate, link, asserted)
        link.refresh_from_db()
        check(signed_in_as == target.username and link.user_id == target.pk and not User.objects.filter(pk=manual_pk).exists(), f"a manual mark merges despite a different name ({signed_in_as})")
        gdpr_cleanup.fn(manual_pk)
        manual_event = Event.objects.get(action="custom_alumni_merge", context__duplicate_pk=manual_pk)
        check(manual_event.context.get("mode") == "manual" and manual_event.context.get("merge_id") == "00000000-0000-4000-8000-000000000055", f"its Event names the mode and Canari's merge id ({manual_event.context})")
        check(manual_event.context.get("duplicate_uuid") == manual_uuid, "the manual merge's Event names the duplicate")
        pushed.append(manual_event)

        manual_refusals = [
            ("90041", "alumni_name_changed", "the name Alumnforce asserts is not the Alumni name the admin saw", dict(target_kwargs={"name": "Jean-Marie MARTIN"}, mark=manual(seen_alumni="Pierre Durand"))),
            ("90042", "target_changed", "the target's name is not the one the admin saw", dict(target_kwargs={"name": "Jean-Marie MARTIN"}, mark=manual(seen_target="Paul MARTIN"))),
            ("90043", "manual_mark_incomplete", "a manual mark misses the target name the admin saw", dict(target_kwargs={"name": "Jean-Marie MARTIN"}, mark={k: v for k, v in manual().items() if k != "alumni_merge_seen_target_name"})),
            ("90044", "manual_mark_incomplete", "a manual mark misses its merge id", dict(target_kwargs={"name": "Jean-Marie MARTIN"}, mark={k: v for k, v in manual().items() if k != "alumni_merge_id"})),
            ("90045", "mark_mode_unknown", "the mark's mode is neither auto nor manual", dict(mark={"alumni_merge_mode": "forced"})),
        ]
        for af_id, code, why, bend in manual_refusals:
            target, duplicate, link = merge_case(af_id, **bend)
            last, signed_in_as = sign_in_to_the_end(duplicate, link, asserted)
            link.refresh_from_db()
            refusal = Event.objects.filter(action="custom_alumni_merge_refused", context__af_id=af_id).first()
            check(last.get("component") == "ak-stage-access-denied" and signed_in_as is None and link.user_id == duplicate.pk and refusal is not None and code in refusal.context["reasons"], f"refused as {code} when {why} ({last.get('component')}, {refusal and refusal.context.get('reasons')})")
            check(not rule_sends(refusal), f"the refusal when {why} is never pushed")

        # The mark changed between the start of the sign-in and the merge: refused, the new mark kept.
        target, duplicate, link = merge_case("90035")
        other = User.objects.create(username="e2e-merge-90035-other", name="Jean-Marie DUPONT")
        User.objects.filter(pk=duplicate.pk).update(attributes={**duplicate.attributes, "alumni_merge_into": str(other.uuid)})
        last, signed_in_as = sign_in_to_the_end(duplicate, link, asserted)
        link.refresh_from_db()
        changed = Event.objects.filter(action="custom_alumni_merge_refused", context__af_id="90035").first()
        check(last.get("component") == "ak-stage-access-denied" and link.user_id == duplicate.pk and changed is not None and "mark_changed" in changed.context["reasons"], f"a mark changed during the sign-in is refused as mark_changed ({last.get('component')}, {changed and changed.context.get('reasons')})")
        check(User.objects.get(pk=duplicate.pk).attributes.get("alumni_merge_into") == str(other.uuid), "the new mark is kept")

        # The ORPHAN: the marked target was deleted since the mark - the mark is cleared, nothing is
        # refused, and the sign-in is an ordinary one into the duplicate.
        target, duplicate, link = merge_case("90027")
        target.delete()
        last, signed_in_as = sign_in_to_the_end(duplicate, link, asserted)
        duplicate.refresh_from_db()
        check(signed_in_as == duplicate.username and not duplicate.attributes.get("alumni_merge_into") and not duplicate.attributes.get("alumni_merge_marked_by"), f"an orphaned mark is cleared and the duplicate signs in ({signed_in_as}, {duplicate.attributes})")

        # An orphan whose mark CHANGED meanwhile (an admin re-marked it into another account): the
        # clear re-reads the mark under the lock and keeps the new one.
        target, duplicate, link = merge_case("90037")
        target.delete()
        other = User.objects.create(username="e2e-merge-90037-other", name="Jean-Marie DUPONT")
        User.objects.filter(pk=duplicate.pk).update(attributes={**duplicate.attributes, "alumni_merge_into": str(other.uuid)})
        _, signed_in_as = sign_in_to_the_end(duplicate, link, asserted)
        check(User.objects.get(pk=duplicate.pk).attributes.get("alumni_merge_into") == str(other.uuid), f"an orphan clear keeps a mark that changed under it ({signed_in_as})")

        # D54 - A MERGE THAT ROLLS BACK ANNOUNCES NOTHING (`transaction.on_commit(merged.save)`). The
        # fault is raised INSIDE the policy's own atomic block, after the merge registered its Event's
        # save: `django.db.transaction.on_commit` - which the policy reads at call time - is wrapped to
        # register that ONE callback and then raise, so the block exits by an exception and Django
        # discards its on-commit callbacks with the rollback. Every other on_commit of the sign-in is
        # passed through untouched. (Why not an outer atomic around the sign-in: see the docstring.)
        from django.db import transaction as django_transaction

        real_on_commit = django_transaction.on_commit
        injected = []

        def on_commit_then_fail(func, *args, **kwargs):
            real_on_commit(func, *args, **kwargs)
            owner = getattr(func, "__self__", None)
            if isinstance(owner, Event) and owner.action == "custom_alumni_merge":
                injected.append(owner.context.get("duplicate_uuid"))
                raise RuntimeError("e2e: a fault after the merge registered its Event")

        target, duplicate, link = merge_case("90046")
        rolled_pk, rolled_uuid = duplicate.pk, str(duplicate.uuid)
        django_transaction.on_commit = on_commit_then_fail
        try:
            last, signed_in_as = sign_in_to_the_end(duplicate, link, asserted)
        finally:
            django_transaction.on_commit = real_on_commit
        link.refresh_from_db()
        check(injected == [rolled_uuid], f"the fault was raised inside the merge's atomic block, after its Event was registered ({injected})")
        check(User.objects.filter(pk=rolled_pk).exists() and link.user_id == rolled_pk, f"the merge rolled back: the duplicate and its Alumni link stand ({last.get('component')}, {signed_in_as})")
        check(not Event.objects.filter(action="custom_alumni_merge", context__duplicate_uuid=rolled_uuid).exists(), "a rolled-back merge saves NO merge Event")
        check(not [r for r in stub.received if r["body"].get("duplicateUuid") == rolled_uuid], "a rolled-back merge is never pushed")

        # D54 - THE PUSH, RECEIVED: of every alumni Event of this run, the rule passes the merges and

        # nothing else, and each merge is delivered EXACTLY once, to its target, carrying the
        # duplicate's uuid, the target's and the shared secret.
        passed = [e for e in Event.objects.filter(action__startswith="custom_alumni") if rule_sends(e)]
        check(sorted(str(e.pk) for e in passed) == sorted(str(e.pk) for e in pushed), f"the rule passes the merges and nothing else ({len(passed)} Event(s) for {len(pushed)} merge(s))")
        for event in pushed:
            duplicate_uuid = event.context["duplicate_uuid"]
            check(stub.deliver(event) == 1, f"the merge of {duplicate_uuid[:8]} has ONE destination, its target")
            got = stub.for_duplicate(duplicate_uuid)
            check(len(got) == 1, f"the merge of {duplicate_uuid[:8]} is pushed EXACTLY once ({len(got)})")
            check(got[0]["headers"].get(PUSH_SECRET_HEADER.lower()) == secret, "the push carries the shared secret")
            check(got[0]["body"] == {"duplicateUuid": duplicate_uuid, "targetUuid": event.context["target_uuid"], "mergeId": event.context.get("merge_id", ""), "duplicateSubject": event.context["duplicate_subject"], "targetSubject": event.context["target_subject"]}, f"the push names the duplicate, the target, the merge and both subjects ({got[0]['body']})")
            check(event.context["duplicate_subject"] and event.context["target_subject"], "both subjects are pushed non-empty")
    finally:
        if stub is not None:
            stub.close()
        User.objects.filter(username__startswith="e2e-").delete()
        User.objects.filter(username__startswith="alumni-900").delete()
        User.objects.filter(username__startswith="alumni-e2e-").delete()
        Group.objects.filter(name="e2e-merge-superusers").delete()
    print("ENROLLMENT-OK")
