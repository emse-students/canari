"""Proves the service account Canari edits profiles and merges Alumni duplicates through can do
exactly that - and no more.

Run through `ak shell` by test-blueprints.sh, after the blueprints applied (and by hand on any
disposable instance). It calls authentik's REAL API in-process, with the token the blueprint wrote,
the way core-service does: read a user by uuid, PATCH its whole `attributes` (WP4); list a user's
source connections and delete an `alumni-` duplicate, its Alumni connection going with it (D48).
Then it proves the role's limits - the same token may not create a user, add, move or delete a
source connection, change the Alumni source, nor change a flow. It prints `PROFILE-EDITOR-OK` when
every assertion held and raises otherwise.

WHY THE API AND NOT `user.has_perm`: the permission list on a role says what was GRANTED, and the
API is what a stolen token could DO. A role that silently carried more than the blueprint named would
pass the first reading and fail the second.
"""
import json
import os

from django.test import Client

from authentik.core.models import Token, User, UserSourceConnection
from authentik.flows.models import Flow
from authentik.sources.oauth.models import OAuthSource, UserOAuthSourceConnection
from authentik.sources.saml.models import SAMLSource, UserSAMLSourceConnection

TOKEN = os.environ["MICONNECT_EDITOR_TOKEN"]
USERNAME = "miconnect-canari-editor"
PROBE = "miconnect-editor-probe"
DUPLICATE = "alumni-editor-probe-0001"


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
    flow = Flow.objects.first()
    changed = call("patch", f"/api/v3/flows/instances/{flow.slug}/", {"title": "hijacked"})
    check(changed.status_code in (403, 404), f"the editor may NOT change a flow (got {changed.status_code})")
    flow.refresh_from_db()
    check(flow.title != "hijacked", "the flow is untouched")
finally:
    probe.delete()

# THE MERGE (D47, D48). A CAS account (the target) and an `alumni-` account the Alumni source created
# for the same person (the duplicate). What core-service does: read the duplicate's connections, then
# delete it - and the Alumni identity goes with it, free to be linked onto the target from its
# settings page. What it must NOT be able to do: move or delete a connection on its own, touch the
# source, create the account.
alumni = SAMLSource.objects.get(slug="alumni")
cas = OAuthSource.objects.get(slug="cas-emse")
User.objects.filter(username__in=[PROBE, DUPLICATE]).delete()
target = User.objects.create(username=PROBE, name="Probe Person")
duplicate = User.objects.create(username=DUPLICATE, name="Probe Person")
UserOAuthSourceConnection.objects.create(user=target, source=cas, identifier="probe.person")
link = UserSAMLSourceConnection.objects.create(user=duplicate, source=alumni, identifier="0001")
try:
    listed = call("get", f"/api/v3/sources/user_connections/all/?user={duplicate.pk}")
    check(listed.status_code == 200, f"the editor lists a user's source connections (got {listed.status_code})")
    slugs = [c["source_obj"]["slug"] for c in listed.json()["results"]]
    check(slugs == ["alumni"], f"the duplicate holds exactly the Alumni connection (got {slugs})")
    listed = call("get", f"/api/v3/sources/user_connections/all/?user={target.pk}")
    slugs = [c["source_obj"]["slug"] for c in listed.json()["results"]]
    check(slugs == ["cas-emse"], f"the target's CAS connection is visible too (got {slugs})")

    # authentik's serializer makes a connection's `user` read-only: no token, however wide, moves a
    # link through the API - which is why the merge deletes the duplicate and the person re-links.
    # The global view permission is on the BASE connection model, so the SAML endpoint does not even
    # find the object for this token (404); either refusal holds.
    moved = call("patch", f"/api/v3/sources/user_connections/saml/{link.pk}/", {"user": target.pk})
    check(moved.status_code in (403, 404), f"the editor may NOT change a connection (got {moved.status_code})")
    added = call(
        "post",
        "/api/v3/sources/user_connections/saml/",
        {"user": target.pk, "source": str(alumni.pk), "identifier": "0001"},
    )
    check(added.status_code in (403, 404), f"the editor may NOT add a connection (got {added.status_code})")
    unlinked = call("delete", f"/api/v3/sources/user_connections/saml/{link.pk}/")
    check(unlinked.status_code in (403, 404), f"the editor may NOT delete a connection alone (got {unlinked.status_code})")
    link.refresh_from_db()
    check(link.user_id == duplicate.pk, "the Alumni connection is still the duplicate's")
    was_enabled = alumni.enabled
    source_changed = call("patch", f"/api/v3/sources/saml/{alumni.slug}/", {"enabled": not was_enabled})
    check(source_changed.status_code in (403, 404), f"the editor may NOT change the Alumni source (got {source_changed.status_code})")
    alumni.refresh_from_db()
    check(alumni.enabled == was_enabled, "the source is untouched")

    removed = call("delete", f"/api/v3/core/users/{duplicate.pk}/")
    check(removed.status_code == 204, f"the editor deletes the duplicate (got {removed.status_code})")
    check(not User.objects.filter(pk=duplicate.pk).exists(), "the duplicate is gone")
    check(
        not UserSourceConnection.objects.filter(source=alumni, identifier="0001").exists(),
        "its Alumni connection went with it - the identity is free to be linked again",
    )
    check(User.objects.filter(pk=target.pk).exists(), "the target is untouched")
finally:
    User.objects.filter(username__in=[PROBE, DUPLICATE]).delete()

print("PROFILE-EDITOR-OK")
