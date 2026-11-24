"""Proves the service account Canari edits profiles and marks Alumni duplicates through can do
exactly that - and no more.

Run through `ak shell` by test-blueprints.sh, after the blueprints applied (and by hand on any
disposable instance). It calls authentik's REAL API in-process, with the token the blueprint wrote,
the way core-service does: read a user by uuid, PATCH its whole `attributes` (WP4); list a user's
source connections and write the merge mark on an `alumni-` duplicate (D48). Then it proves the
role's limits - the same token may not create or DELETE a user, add, move or delete a source
connection, change the Alumni source, nor change a flow. It prints `PROFILE-EDITOR-OK` when
every assertion held and raises otherwise.

WHY THE API AND NOT `user.has_perm`: the permission list on a role says what was GRANTED, and the
API is what a stolen token could DO. A role that silently carried more than the blueprint named would
pass the first reading and fail the second.
"""
import json
import os

from django.test import Client

from authentik.core.models import Group, Token, User, UserSourceConnection
from authentik.flows.models import Flow
from authentik.rbac.models import Role
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

# WHAT THE TOKEN MAY NOT GRANT: a superuser group, to anyone or to itself, and a role.
User.objects.filter(username__startswith="miconnect-editor-reach").delete()
Group.objects.filter(name__startswith="miconnect-editor-reach").delete()
superusers = Group.objects.create(name="miconnect-editor-reach-su", is_superuser=True)
reach = User.objects.create(username="miconnect-editor-reach-u", name="Reach Probe")
try:
    escalated = call("patch", f"/api/v3/core/users/{reach.pk}/", {"groups": [str(superusers.pk)]})
    reach.refresh_from_db()
    check(escalated.status_code == 400 and not reach.groups.filter(pk=superusers.pk).exists(), f"the token may NOT put anyone in a superuser group (got {escalated.status_code})")
    itself = call("patch", f"/api/v3/core/users/{editor.pk}/", {"groups": [str(superusers.pk)]})
    editor.refresh_from_db()
    check(itself.status_code in (400, 403) and not editor.groups.filter(pk=superusers.pk).exists(), f"the token may NOT put its own account in a superuser group (got {itself.status_code})")
    role = Role.objects.get(name="miconnect-profile-editor")
    granted = call("patch", f"/api/v3/core/users/{reach.pk}/", {"roles": [str(role.pk)]})
    check(granted.status_code in (400, 403) and not reach.roles.exists(), f"the token may NOT assign a role (got {granted.status_code})")
finally:
    User.objects.filter(username__startswith="miconnect-editor-reach").delete()
    Group.objects.filter(name__startswith="miconnect-editor-reach").delete()

# THE MARK (D47, D48). A CAS account (the target) and an `alumni-` account the Alumni source created
# for the same person (the duplicate). What core-service does: read both accounts' connections, then
# write the mark on the duplicate - the merge itself is authentik's, at the next Alumni sign-in
# (test-enrollment-flow.py, step M). What it must NOT be able to do: delete the duplicate (or any
# account), move or delete a connection, touch the source.
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
    served = listed.json()["results"][0].get("identifier")
    check(served == "0001", f"the listing serves each connection's identifier, which core-service's completion reads (got {served!r})")
    listed = call("get", f"/api/v3/sources/user_connections/all/?user={target.pk}")
    slugs = [c["source_obj"]["slug"] for c in listed.json()["results"]]
    check(slugs == ["cas-emse"], f"the target's CAS connection is visible too (got {slugs})")

    # authentik's serializer makes a connection's `user` read-only: no token, however wide, moves a
    # link through the API - which is why the merge is done by authentik itself, at sign-in.
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

    mark = {"alumni_merge_into": str(target.uuid), "alumni_merge_marked_by": "probe-admin", "alumni_merge_marked_at": "2026-11-23T12:00:00Z"}
    marked = call("patch", f"/api/v3/core/users/{duplicate.pk}/", {"attributes": {**duplicate.attributes, **mark}})
    check(marked.status_code == 200, f"the editor writes the merge mark on the duplicate (got {marked.status_code})")
    duplicate.refresh_from_db()
    check(duplicate.attributes.get("alumni_merge_into") == str(target.uuid), "the mark names the target")

    for victim, label in ((duplicate, "the duplicate"), (target, "the target")):
        removed = call("delete", f"/api/v3/core/users/{victim.pk}/")
        check(removed.status_code in (403, 404), f"the editor may NOT delete {label} (got {removed.status_code})")
        check(User.objects.filter(pk=victim.pk).exists(), f"{label} still exists")
    check(
        UserSourceConnection.objects.filter(source=alumni, identifier="0001", user=duplicate).exists(),
        "the Alumni connection is still the duplicate's, until its next sign-in",
    )
finally:
    User.objects.filter(username__in=[PROBE, DUPLICATE]).delete()

print("PROFILE-EDITOR-OK")
