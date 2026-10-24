"""Drives the ways into MiConnect that do NOT go through the CAS, and proves each is guarded.

Run through `ak shell` by test-blueprints.sh (and by hand on any disposable instance), after the
blueprints applied. Every check goes through authentik's REAL flow executor over HTTP, the way a
browser does, so the stage bindings, their policies and the reputation scores are the ones
production runs. It prints `PASSWORD-GUARD-OK` when every assertion held and raises otherwise.

What it proves (docs/wiki/infrastructure/authentik.md, "Signing in without the CAS"):
  * `password-login` and `default-authentication-flow` refuse a SUPERUSER before the password page,
    even one whose password is right;
  * `password-login` asks an account that has a second factor for it, and lets one without through
    with its password alone (the store-review account);
  * five wrong passwords for one account refuse the next attempt, the right password included;
  * `miconnect-enrollment`, opened directly rather than by a source, does not even plan.
"""
import json

from django.test import Client

from authentik.core.models import Group, User
from authentik.flows.models import Flow
from authentik.policies.models import PolicyBinding
from authentik.policies.reputation.models import Reputation
from authentik.stages.authenticator_totp.models import TOTPDevice
from authentik.tenants.models import Tenant

PASSWORD = "guard-test-correct-1"
PREFIX = "guard-test-"


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"  ok   {message}", flush=True)


def sign_in(slug, username, password, address):
    """Runs one password sign-in and returns (the last challenge component, signed in?)."""
    client = Client(HTTP_HOST="localhost", REMOTE_ADDR=address)
    url = f"/api/v3/flows/executor/{slug}/?query="

    def post(payload):
        response = client.post(url, data=json.dumps(payload), content_type="application/json")
        # A stage that completes, or one that skips itself (the second factor of an account with
        # none), answers with a redirect to the executor; follow until a challenge comes back.
        for _ in range(5):
            if response.status_code not in (301, 302):
                break
            response = client.get(response["Location"])
        return response.json() if response.content else {}

    client.get(url)
    challenge = post({"component": "ak-stage-identification", "uid_field": username})
    if challenge.get("component") == "ak-stage-password":
        challenge = post({"component": "ak-stage-password", "password": password})
    signed_in = client.get("/api/v3/core/users/me/").status_code == 200
    return challenge.get("component"), signed_in


def make_user(name, superuser=False, totp=False):
    user = User.objects.create(username=f"{PREFIX}{name}", name=name)
    user.set_password(PASSWORD)
    user.save()
    if superuser:
        Group.objects.filter(is_superuser=True).first().users.add(user)
    if totp:
        TOTPDevice.objects.create(user=user, name="guard-test", confirmed=True)
    return user


with Tenant.objects.get(ready=True):
    User.objects.filter(username__startswith=PREFIX).delete()
    Reputation.objects.filter(identifier__startswith=PREFIX).delete()
    try:
        admin = make_user("admin", superuser=True)
        second_factor = make_user("totp", totp=True)
        reviewer = make_user("reviewer")
        check(admin.is_superuser, "the admin probe is a superuser")

        for slug in ("password-login", "default-authentication-flow"):
            component, signed_in = sign_in(slug, admin.username, PASSWORD, "198.51.100.1")
            check(component == "ak-stage-access-denied" and not signed_in, f"{slug} refuses a superuser, right password and all (got {component})")

        component, signed_in = sign_in("password-login", second_factor.username, PASSWORD, "198.51.100.2")
        check(component == "ak-stage-authenticator-validate" and not signed_in, f"password-login asks for the second factor (got {component})")

        component, signed_in = sign_in("password-login", reviewer.username, PASSWORD, "198.51.100.3")
        check(signed_in, f"password-login signs in an account with no second factor (got {component})")

        # A fresh account: a successful sign-in earns +1, which the reviewer above just did.
        target = make_user("target")
        for attempt in range(5):
            component, signed_in = sign_in("password-login", target.username, f"wrong-{attempt}", f"198.51.100.{10 + attempt}")
            check(component == "ak-stage-password" and not signed_in, f"wrong password {attempt + 1} is refused by the password stage")
        component, signed_in = sign_in("password-login", target.username, PASSWORD, "198.51.100.20")
        check(component == "ak-stage-access-denied" and not signed_in, f"after five wrong passwords, from five addresses, the right one is refused (got {component})")

        flow = Flow.objects.get(slug="miconnect-enrollment")
        bindings = PolicyBinding.objects.filter(target=flow.pbm_uuid)
        check(bindings.count() == 1, f"the enrolment flow carries exactly one policy binding (got {bindings.count()})")
        anonymous = Client(HTTP_HOST="localhost").get("/api/v3/flows/executor/miconnect-enrollment/?query=").json()
        check(anonymous.get("component") == "ak-stage-access-denied", f"the enrolment flow, opened directly, does not plan (got {anonymous.get('component')})")
    finally:
        User.objects.filter(username__startswith=PREFIX).delete()
        Reputation.objects.filter(identifier__startswith=PREFIX).delete()
    print("PASSWORD-GUARD-OK")
