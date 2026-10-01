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
"""
import json

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.test import Client, RequestFactory

from authentik.core.models import User
from authentik.core.sources.stage import PLAN_CONTEXT_SOURCES_CONNECTION
from authentik.flows.models import Flow
from authentik.flows.planner import PLAN_CONTEXT_SOURCE, PLAN_CONTEXT_SSO, FlowPlanner
from authentik.flows.views.executor import SESSION_KEY_PLAN
from authentik.root.middleware import SessionMiddleware
from authentik.sources.oauth.models import OAuthSource, UserOAuthSourceConnection
from authentik.sources.saml.models import SAMLSource
from authentik.stages.password import BACKEND_INBUILT
from authentik.stages.password.stage import PLAN_CONTEXT_AUTHENTICATION_BACKEND
from authentik.stages.prompt.stage import PLAN_CONTEXT_PROMPT
from authentik.stages.user_write.stage import PLAN_CONTEXT_USER_PATH
from authentik.tenants.models import Tenant

SLUG = "miconnect-enrollment"
PAGE_ONE = ["campus", "is_student", "post_emse", "post_me", "post_alumni"]
PAGE_TWO = ["attributes.promo", "attributes.formation"]
BOXES_OFF = {"post_emse": False, "post_me": False, "post_alumni": False}


def start(username, name):
    flow = Flow.objects.get(slug=SLUG)
    source = OAuthSource.objects.get(slug="cas-emse")
    client = Client(HTTP_HOST="localhost")
    request = RequestFactory().get("/")
    request.user = AnonymousUser()
    request.session = client.session
    plan = FlowPlanner(flow).plan(
        request,
        {
            PLAN_CONTEXT_PROMPT: {"username": username, "name": name},
            PLAN_CONTEXT_USER_PATH: "users",
            PLAN_CONTEXT_AUTHENTICATION_BACKEND: BACKEND_INBUILT,
            PLAN_CONTEXT_SSO: True,
            PLAN_CONTEXT_SOURCE: source,
            PLAN_CONTEXT_SOURCES_CONNECTION: UserOAuthSourceConnection(source=source, identifier=username),
        },
    )
    session = client.session
    session[SESSION_KEY_PLAN] = plan
    session.save()
    client.cookies[settings.SESSION_COOKIE_NAME] = SessionMiddleware.encode_session(session.session_key, AnonymousUser())
    return client


def step(client, payload=None):
    url = f"/api/v3/flows/executor/{SLUG}/?query="
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


with Tenant.objects.get(ready=True):
    flow = Flow.objects.get(slug=SLUG)
    for source in (OAuthSource.objects.get(slug="cas-emse"), SAMLSource.objects.get(slug="alumni")):
        assert source.enrollment_flow_id == flow.pk, f"source {source.slug} does not enrol through {SLUG}"
    for gone in ("miconnect-enrollment-cas", "miconnect-enrollment-alumni"):
        assert not Flow.objects.filter(slug=gone).exists(), f"{gone} still exists"

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
    finally:
        User.objects.filter(username__startswith="e2e-").delete()
    print("ENROLLMENT-OK")
