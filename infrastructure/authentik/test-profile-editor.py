"""Proves the service account Canari edits profiles and marks Alumni duplicates through can do
exactly that - and no more.

Run through `ak shell` by test-blueprints.sh, after the blueprints applied (and by hand on any
disposable instance). It calls authentik's REAL API in-process, with the token the blueprint wrote,
the way core-service does: read a user by uuid; WRITE only through the flow `miconnect-profile-write`
(one POST to the flow executor, no session carried, as core-service sends it) - the profile and the
name (WP4), the merge mark on an `alumni-` duplicate and its removal (D48); list a user's source
connections. Then it proves the limits: the same token may not PATCH a user at all, nor create or
DELETE one, add, move or delete a source connection, change the Alumni source, nor change a flow; the
write flow refuses every field, attribute and account outside its allowlist, and every other caller.
It prints `PROFILE-EDITOR-OK` when every assertion held and raises otherwise.

WHY THE API AND NOT `user.has_perm`: the permission list on a role says what was GRANTED, and the
API is what a stolen token could DO. A role that silently carried more than the blueprint named would
pass the first reading and fail the second.
"""
import json
import os

from django.test import Client

from authentik.core.models import Group, Token, TokenIntents, User, UserSourceConnection
from authentik.flows.models import Flow
from authentik.rbac.models import Role
from authentik.sources.oauth.models import OAuthSource, UserOAuthSourceConnection
from authentik.sources.saml.models import SAMLSource, UserSAMLSourceConnection

TOKEN = os.environ["MICONNECT_EDITOR_TOKEN"]
USERNAME = "miconnect-canari-editor"
PROBE = "miconnect-editor-probe"
DUPLICATE = "alumni-editor-probe-0001"
WRITE_FLOW = "/api/v3/flows/executor/miconnect-profile-write/?query="


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


def write(target, changes, token=TOKEN):
    """One write through the flow, as core-service sends it: a FRESH client (no session cookie, so
    every call plans the flow anew), the token, the prompt. Returns the challenge authentik answered."""
    body = {
        "component": "ak-stage-prompt",
        "target": str(target),
        "changes": changes if isinstance(changes, str) else json.dumps(changes),
    }
    answer = Client(HTTP_HOST="localhost").post(
        WRITE_FLOW, data=json.dumps(body), content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}"
    )
    if answer.status_code != 200:
        raise AssertionError(f"the write flow answered {answer.status_code}, not 200")
    return answer.json()


def written(challenge):
    """The flow ran to its end: the write held."""
    return challenge.get("component") == "xak-flow-redirect"


def refused(challenge):
    """The prompt came back with the policy's refusal: nothing was written."""
    errors = (challenge.get("response_errors") or {}).get("non_field_errors") or []
    return challenge.get("component") == "ak-stage-prompt" and any(
        (e.get("string") or "").startswith("refused:") for e in errors
    )


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
    email="probe@example.invalid",
    attributes={"profile": {"version": 1, "campus": "gardanne", "cursus": [], "posts": ["EMSE"]}, "keep": "me"},
)
try:
    found = call("get", f"/api/v3/core/users/?uuid={probe.uuid}")
    check(found.status_code == 200, "the editor reads a user by uuid")
    results = found.json()["results"]
    check(len(results) == 1 and results[0]["pk"] == probe.pk, "the uuid addresses exactly one user")
    attributes = results[0]["attributes"]
    check(attributes.get("keep") == "me", "the read carries the whole attributes")

    # NO DIRECT WRITE: the role holds no `change_user`, so a PATCH of anything - the attributes
    # included - is refused, and the account is untouched.
    for body, label in (
        ({"attributes": {**attributes, "profile": {"campus": "saint-etienne"}}}, "attributes"),
        ({"email": "intruder@example.invalid"}, "e-mail"),
        ({"is_active": False}, "active flag"),
        ({"username": "renamed-probe"}, "username"),
    ):
        patched = call("patch", f"/api/v3/core/users/{probe.pk}/", body)
        check(patched.status_code == 403, f"the editor may NOT PATCH a user's {label} (got {patched.status_code})")
    probe.refresh_from_db()
    check(
        probe.attributes["profile"]["campus"] == "gardanne"
        and probe.email == "probe@example.invalid"
        and probe.is_active
        and probe.username == PROBE,
        "no PATCH changed the account",
    )

    # THE ALLOWLISTED WRITE: the profile and the name, MERGED server-side - every other key kept.
    profile = {**attributes["profile"], "campus": "saint-etienne"}
    check(written(write(probe.uuid, {"name": "Probe Renamed", "attributes": {"profile": profile}})), "the flow writes the profile and the name")
    probe.refresh_from_db()
    check(probe.attributes["profile"]["campus"] == "saint-etienne", "the profile was written")
    check(probe.name == "Probe Renamed", "the name was written")
    check(probe.attributes.get("keep") == "me", "every other attribute key was kept")
    check(probe.email == "probe@example.invalid" and probe.is_active, "nothing outside the allowlist changed")

    # THE ALLOWLIST, REFUSED ENTRY BY ENTRY - each answer a refusal, the account unchanged.
    before = (probe.name, dict(probe.attributes), probe.email, probe.is_active, probe.username)
    for changes, label in (
        ({"email": "intruder@example.invalid"}, "a field outside the allowlist (email)"),
        ({"is_active": False}, "a field outside the allowlist (is_active)"),
        ({"username": "renamed"}, "a field outside the allowlist (username)"),
        ({"groups": []}, "a field outside the allowlist (groups)"),
        ({"name": "x", "type": "service_account"}, "an allowlisted field beside one outside it"),
        ({"attributes": {"keep": "changed"}}, "an attribute outside the allowlist"),
        ({"attributes": {"goauthentik.io/user/sources": []}}, "an authentik attribute"),
        ({"attributes": {"profile": "not an object"}}, "a profile that is not an object"),
        ({"attributes": {"alumni_merge_into": str(probe.uuid)}}, "a merge mark on an account that is not alumni-"),
        ({"name": ""}, "an empty name"),
        ({}, "an empty change"),
        ("not json", "a change that is not JSON"),
    ):
        check(refused(write(probe.uuid, changes)), f"the flow refuses {label}")
    check(refused(write("not-a-uuid", {"name": "x"})), "the flow refuses a target that is not a uuid")
    check(refused(write("00000000-0000-4000-8000-000000000000", {"name": "x"})), "the flow refuses a uuid no account carries")
    probe.refresh_from_db()
    check((probe.name, probe.attributes, probe.email, probe.is_active, probe.username) == before, "no refused write changed the account")

    created = call("post", "/api/v3/core/users/", {"username": "miconnect-editor-intruder", "name": "x"})
    check(created.status_code == 403, f"the editor may NOT create a user (got {created.status_code})")
    check(not User.objects.filter(username="miconnect-editor-intruder").exists(), "no user was created")
    flow = Flow.objects.exclude(slug="miconnect-profile-write").first()
    changed = call("patch", f"/api/v3/flows/instances/{flow.slug}/", {"title": "hijacked"})
    check(changed.status_code in (403, 404), f"the editor may NOT change a flow (got {changed.status_code})")
    flow.refresh_from_db()
    check(flow.title != "hijacked", "the flow is untouched")
    own = Flow.objects.get(slug="miconnect-profile-write")
    changed = call("patch", f"/api/v3/flows/instances/{own.slug}/", {"title": "hijacked"})
    check(changed.status_code in (403, 404), f"the editor may NOT change its own write flow (got {changed.status_code})")
finally:
    probe.delete()

# WHAT THE FLOW MAY NOT REACH: a superuser account, a service account (the editor itself), and any
# caller other than the editor - another account's token meets the access-denied stage.
Token.objects.filter(identifier="miconnect-editor-reach-token").delete()
User.objects.filter(username__startswith="miconnect-editor-reach").delete()
Group.objects.filter(name__startswith="miconnect-editor-reach").delete()
superusers = Group.objects.create(name="miconnect-editor-reach-su", is_superuser=True)
admin = User.objects.create(username="miconnect-editor-reach-admin", name="Reach Admin", attributes={"profile": {"version": 1}})
admin.groups.add(superusers)
reach = User.objects.create(username="miconnect-editor-reach-u", name="Reach Probe")
outsider_token = Token.objects.create(
    identifier="miconnect-editor-reach-token", user=reach, intent=TokenIntents.INTENT_API, expiring=False
)
try:
    check(refused(write(admin.uuid, {"attributes": {"profile": {"version": 1, "campus": "x"}}})), "the flow refuses a superuser account")
    admin.refresh_from_db()
    check(admin.attributes == {"profile": {"version": 1}}, "the superuser account is untouched")
    check(refused(write(editor.uuid, {"name": "Hijacked"})), "the flow refuses a service account (the editor itself)")
    editor.refresh_from_db()
    check(editor.name == "Canari - profile editor", "the editor account is untouched")
    outsider = write(reach.uuid, {"name": "Self Renamed"}, token=outsider_token.key)
    check(outsider.get("component") == "ak-stage-access-denied", f"another account's token may NOT run the write flow (got {outsider.get('component')})")
    reach.refresh_from_db()
    check(reach.name == "Reach Probe", "the outsider wrote nothing")

    # WHAT THE TOKEN MAY NOT GRANT: a group (superuser or not), to anyone or to itself, and a role.
    editors = Group.objects.get(name="miconnect-profile-editors")
    for group, label in ((superusers, "a superuser group"), (editors, "an ordinary group")):
        escalated = call("patch", f"/api/v3/core/users/{reach.pk}/", {"groups": [str(group.pk)]})
        reach.refresh_from_db()
        check(escalated.status_code in (400, 403) and not reach.groups.filter(pk=group.pk).exists(), f"the token may NOT put anyone in {label} (got {escalated.status_code})")
    itself = call("patch", f"/api/v3/core/users/{editor.pk}/", {"groups": [str(superusers.pk)]})
    editor.refresh_from_db()
    check(itself.status_code in (400, 403) and not editor.groups.filter(pk=superusers.pk).exists(), f"the token may NOT put its own account in a superuser group (got {itself.status_code})")
    role = Role.objects.get(name="miconnect-profile-editor")
    granted = call("patch", f"/api/v3/core/users/{reach.pk}/", {"roles": [str(role.pk)]})
    check(granted.status_code in (400, 403) and not reach.roles.exists(), f"the token may NOT assign a role (got {granted.status_code})")
finally:
    Token.objects.filter(identifier="miconnect-editor-reach-token").delete()
    User.objects.filter(username__startswith="miconnect-editor-reach").delete()
    Group.objects.filter(name__startswith="miconnect-editor-reach").delete()

# THE MARK (D47, D48). A CAS account (the target) and an `alumni-` account the Alumni source created
# for the same person (the duplicate). What core-service does: read both accounts' connections, then
# write the mark on the duplicate through the flow - the merge itself is authentik's, at the next
# Alumni sign-in (test-enrollment-flow.py, step M) - and, on "Annuler", remove it (null). What it must
# NOT be able to do: delete the duplicate (or any account), move or delete a connection, touch the source.
alumni = SAMLSource.objects.get(slug="alumni")
cas = OAuthSource.objects.get(slug="cas-emse")
User.objects.filter(username__in=[PROBE, DUPLICATE]).delete()
target = User.objects.create(username=PROBE, name="Probe Person")
duplicate = User.objects.create(username=DUPLICATE, name="Probe Person", attributes={"profile": {"version": 1}})
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
    check(written(write(duplicate.uuid, {"attributes": mark})), "the flow writes the merge mark on the duplicate")
    duplicate.refresh_from_db()
    check(duplicate.attributes.get("alumni_merge_into") == str(target.uuid), "the mark names the target")
    check(duplicate.attributes.get("profile") == {"version": 1}, "the mark kept the duplicate's profile")
    check(refused(write(duplicate.uuid, {"attributes": {"alumni_merge_into": 7}})), "the flow refuses a mark that is not a string")
    check(written(write(duplicate.uuid, {"attributes": {key: None for key in mark}})), "the flow removes the mark (null)")
    duplicate.refresh_from_db()
    check(not any(key in duplicate.attributes for key in mark) and duplicate.attributes.get("profile") == {"version": 1}, "the mark is gone and the profile kept")
    check(written(write(duplicate.uuid, {"attributes": mark})), "the flow writes the mark again")

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
