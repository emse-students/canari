"""WHAT CAN CANARI'S MICONNECT EDITOR ACCOUNT REACH, AND WHAT HAS IT WRITTEN? A read-only report.

Run through `ak shell` by editor-reach.sh, which prefixes `BLUEPRINT` (the text of the
80-profile-editor.yaml it was given: on production the RELEASED one, in CI this tree's) and `KNOWN`
(the event ids already examined, from editor-reach-known.txt). Prints one `FINDING` line per problem
and `EDITOR-REACH-OK` when there is none; exits 1 otherwise. Writes nothing.

TWO HALVES (docs/wiki/backlog.d/the-miconnect-editor-token-reach.md):
  1. THE GRANT. The account is the service account the blueprint builds, not a superuser, a member of
     `miconnect-profile-editors` alone (no parent group), and every role reaching it - the group's,
     its own, a managed one - holds no global permission beyond the blueprint role's list and no
     object permission at all. A grant made by hand in the admin UI that the applier does not
     revoke (an object permission, another group, a direct role) is found here; a global one the
     applier does revoke is also its `REVOKED` line in the daily blueprint dry run.
  2. THE WRITES. Every authentik Event the account authored that records a write. One kind is
     expected: a USER updated through the write flow `miconnect-profile-write`, or through
     `PATCH /api/v3/core/users/<pk>/` - the path the role's `change_user` served until the release
     that dropped it, and that the token is refused since. Anything else - a creation, a deletion, a
     write on another model, a write through another path - is a finding, until its id is added to
     editor-reach-known.txt with what it was. What a log cannot say: WHICH fields a PATCH changed
     (authentik records the diff only under its enterprise licence), so a PATCH from the interim is
     expected by its path alone.

The log is PUBLIC (the scheduled job's): a finding names an event id, its action, the model kind and
the request path - never a person, a value or an address.
"""
import sys

from guardian.models import RoleModelPermission, RoleObjectPermission

from authentik.blueprints.v1.importer import Importer
from authentik.core.models import User
from authentik.events.models import Event

EDITOR = "miconnect-canari-editor"
GROUP = "miconnect-profile-editors"
ROLE = "miconnect-profile-editor"
FLOW_PATH = "/api/v3/flows/executor/miconnect-profile-write/"
USERS_PATH = "/api/v3/core/users/"
WRITES = ("model_created", "model_updated", "model_deleted", "password_set", "secret_rotate", "impersonation_started")

findings = []


def finding(text):
    findings.append(text)
    print(f"FINDING  {text}", flush=True)


# The role's list, read from the blueprint as the applier reads it.
allowed = None
for entry in Importer.from_string(BLUEPRINT).blueprint.iter_entries():  # noqa: F821 - prefixed
    if entry.model == "authentik_rbac.role" and entry.identifiers.get("name") == ROLE:
        allowed = set(entry.attrs["permissions"])
if allowed is None:
    print(f"ERROR the blueprint given names no role {ROLE}", flush=True)
    sys.exit(2)
print(f"the blueprint's role grants: {sorted(allowed)}", flush=True)

editor = User.objects.filter(username=EDITOR).first()
if editor is None:
    print(f"ERROR no account {EDITOR}", flush=True)
    sys.exit(2)

# 1. THE GRANT.
if editor.type != "service_account":
    finding(f"the account is a {editor.type} account, not a service account")
if editor.is_superuser:
    finding("the account is a superuser")
groups = sorted(editor.all_groups().values_list("name", flat=True))
if groups != [GROUP]:
    finding(f"the account's groups, ancestors included, are {groups}, not [{GROUP!r}]")
for role in editor.all_roles():
    held = {
        f"{row.permission.content_type.app_label}.{row.permission.codename}"
        for row in RoleModelPermission.objects.filter(role=role).select_related("permission__content_type")
    }
    for extra in sorted(held - allowed):
        finding(f"role {role.name} holds the global permission {extra}, beyond the blueprint's list")
    objects = RoleObjectPermission.objects.filter(role=role).select_related("permission__content_type")
    for row in objects:
        finding(
            f"role {role.name} holds the object permission "
            f"{row.permission.content_type.app_label}.{row.permission.codename} on one object"
        )
    if role.name != ROLE and held:
        finding(f"role {role.name} reaches the account beside {ROLE}")

# 2. THE WRITES.
known = set(KNOWN)  # noqa: F821 - prefixed
counted = 0
for event in Event.objects.filter(user__username=EDITOR, action__in=WRITES).order_by("created"):
    counted += 1
    context = event.context or {}
    model = context.get("model") or {}
    kind = f"{model.get('app', '?')}.{model.get('model_name', '?')}"
    http = context.get("http_request") or {}
    path = str(http.get("path") or "")
    method = str(http.get("method") or "")
    expected = (
        event.action == "model_updated"
        and kind == "authentik_core.user"
        and (path == FLOW_PATH or (method == "PATCH" and path.startswith(USERS_PATH)))
    )
    if expected or str(event.pk) in known:
        continue
    finding(f"event {event.pk}: {event.action} of {kind} through {method or '?'} {path or '?'}")
print(f"{counted} write event(s) authored by the account examined", flush=True)

if findings:
    print(f"{len(findings)} finding(s)", flush=True)
    sys.exit(1)
print("EDITOR-REACH-OK", flush=True)
