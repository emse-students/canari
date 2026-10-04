"""Proves the service account Canari edits profiles through can do exactly that - and no more.

Run through `ak shell` by test-blueprints.sh, after the blueprints applied (and by hand on any
disposable instance). It calls authentik's REAL API in-process, with the token the blueprint wrote,
the way core-service does: read a user by uuid, PATCH its whole `attributes`. Then it proves the
role's limits - the same token may not create or delete a user, nor change a flow. It prints
`PROFILE-EDITOR-OK` when every assertion held and raises otherwise.

WHY THE API AND NOT `user.has_perm`: the permission list on a role says what was GRANTED, and the
API is what a stolen token could DO. A role that silently carried more than the blueprint named would
pass the first reading and fail the second.
"""
import json
import os

from django.test import Client

from authentik.core.models import Token, User
from authentik.flows.models import Flow

TOKEN = os.environ["MICONNECT_EDITOR_TOKEN"]
USERNAME = "miconnect-canari-editor"
PROBE = "miconnect-editor-probe"


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"  ok   {message}", flush=True)


client = Client(HTTP_HOST="localhost")
auth = {"HTTP_AUTHORIZATION": f"Bearer {TOKEN}"}


def call(method, path, body=None):
    kwargs = dict(auth)
    if body is not None:
        kwargs.update(data=json.dumps(body), content_type="application/json")
    return getattr(client, method)(path, **kwargs)


editor = User.objects.get(username=USERNAME)
check(editor.type == "service_account", "the editor is a service account")
check(not editor.is_superuser, "the editor is not a superuser")
token = Token.objects.get(identifier=USERNAME)
check(token.key == TOKEN and token.user_id == editor.pk, "the token is the one the environment holds, owned by the editor")
check(token.expiring is False, "the token does not expire")

User.objects.filter(username=PROBE).delete()
probe = User.objects.create(
    username=PROBE,
    name="Probe",
    attributes={"profile": {"version": 1, "campus": "gardanne", "cursus": [], "posts": ["EMSE"]}, "keep": "me"},
)
try:
    found = call("get", f"/api/v3/core/users/?uuid={probe.uuid}")
    check(found.status_code == 200, "the editor reads a user by uuid")
    results = found.json()["results"]
    check(len(results) == 1 and results[0]["pk"] == probe.pk, "the uuid addresses exactly one user")
    attributes = results[0]["attributes"]
    check(attributes.get("keep") == "me", "the read carries the whole attributes")

    merged = {**attributes, "profile": {**attributes["profile"], "campus": "saint-etienne"}}
    patched = call("patch", f"/api/v3/core/users/{probe.pk}/", {"attributes": merged})
    check(patched.status_code == 200, "the editor changes a user's attributes")
    probe.refresh_from_db()
    check(probe.attributes["profile"]["campus"] == "saint-etienne", "the profile was written")
    check(probe.attributes.get("keep") == "me", "the read-modify-write kept every other key")

    created = call("post", "/api/v3/core/users/", {"username": "miconnect-editor-intruder", "name": "x"})
    check(created.status_code == 403, f"the editor may NOT create a user (got {created.status_code})")
    check(not User.objects.filter(username="miconnect-editor-intruder").exists(), "no user was created")
    deleted = call("delete", f"/api/v3/core/users/{probe.pk}/")
    check(deleted.status_code == 403, f"the editor may NOT delete a user (got {deleted.status_code})")
    check(User.objects.filter(pk=probe.pk).exists(), "the user is still there")
    flow = Flow.objects.first()
    changed = call("patch", f"/api/v3/flows/instances/{flow.slug}/", {"title": "hijacked"})
    check(changed.status_code in (403, 404), f"the editor may NOT change a flow (got {changed.status_code})")
    flow.refresh_from_db()
    check(flow.title != "hijacked", "the flow is untouched")
finally:
    probe.delete()

print("PROFILE-EDITOR-OK")
