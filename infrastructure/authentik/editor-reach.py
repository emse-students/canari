"""WHAT CAN CANARI'S MICONNECT EDITOR ACCOUNT REACH, AND WHAT HAS IT WRITTEN? A read-only report.

Run through `ak shell` by editor-reach.sh, which prefixes `BLUEPRINT` (the text of the
80-profile-editor.yaml it was given: on production the RELEASED one, in CI this tree's) and `KNOWN`
(the event ids already examined, from editor-reach-known.txt). Prints one `FINDING` line per problem
and `EDITOR-REACH-OK` when there is none; exits 1 otherwise. Writes nothing.

THREE PARTS (docs/wiki/infrastructure/authentik.md, "The profile editor's one write path"):
  1. THE GRANT. The account is the service account the blueprint builds, not a superuser, a member of
     `miconnect-profile-editors` alone (no parent group), holding exactly ONE token, and every role
     reaching it - the group's, its own, a managed one - holds no global permission beyond the
     blueprint role's list and no object permission at all. A grant made by hand that the applier
     does not revoke (an object permission, another group, a direct role) is found here.
  2. THE WRITE PATH, when the given blueprint declares it (a released file older than the flow does
     not, and its production has no flow yet). The flow `miconnect-profile-write` is bound as declared:
     policy engine mode `all`, ONE policy binding (the editors' group, enabled, not negated), ONE
     stage (the prompt `miconnect-profile-write`, no binding on it), whose ONE validation policy is
     `miconnect-profile-write`. A binding added by hand that widened who may run it is found here.
  3. THE WRITES. Every authentik Event the account authored that records a write. Expected: a USER
     updated through the write flow; or through `PATCH /api/v3/core/users/<pk>/`, the older write
     path, only while the role still holds the user-change permission (before the release that
     dropped it) or when the Event predates the applier's first `custom_role_permission_revoked`
     Event for that permission on this role (apply-blueprints.py records it in the same transaction
     as the revocation) - a cutoff read from MiConnect's own state, never a clock. Anything else is a
     finding until its id is added to editor-reach-known.txt with what it was. What a log cannot
     say: WHICH fields a PATCH changed (authentik records the diff only under its enterprise licence).

The log is PUBLIC (the scheduled job's): a finding names an event id, its action, the model kind and
the request path - never a person, a value or an address.
"""
import re
import sys

from guardian.models import RoleModelPermission, RoleObjectPermission

from authentik.blueprints.v1.importer import Importer
from authentik.core.models import Token, User
from authentik.events.models import Event
from authentik.flows.models import Flow, FlowStageBinding
from authentik.policies.models import PolicyBinding
from authentik.stages.prompt.models import PromptStage

EDITOR = "miconnect-canari-editor"
GROUP = "miconnect-profile-editors"
ROLE = "miconnect-profile-editor"
WRITE_FLOW = "miconnect-profile-write"
FLOW_PATH = f"/api/v3/flows/executor/{WRITE_FLOW}/"
USERS_PATH = "/api/v3/core/users/"
USER_CHANGE = "authentik_core.change_user"
WRITES = ("model_created", "model_updated", "model_deleted", "password_set", "secret_rotate", "impersonation_started")

findings = []


def finding(text):
    findings.append(text)
    print(f"FINDING  {text}", flush=True)


def perms_of(role):
    return {
        f"{row.permission.content_type.app_label}.{row.permission.codename}"
        for row in RoleModelPermission.objects.filter(role=role).select_related("permission__content_type")
    }


# The role's list, read from the blueprint as the applier reads it.
allowed = None
# Whether the given blueprint declares the write flow: the RELEASED file before the stable that
# brought it does not, and production has no such flow yet - nothing to check, not a finding.
flow_declared = False
for entry in Importer.from_string(BLUEPRINT).blueprint.iter_entries():  # noqa: F821 - prefixed
    if entry.model == "authentik_rbac.role" and entry.identifiers.get("name") == ROLE:
        allowed = set(entry.attrs["permissions"])
    if entry.model == "authentik_flows.flow" and entry.identifiers.get("slug") == WRITE_FLOW:
        flow_declared = True
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
tokens = sorted(Token.objects.filter(user=editor).values_list("identifier", flat=True))
if tokens != [EDITOR]:
    finding(f"the account holds {len(tokens)} token(s), not exactly its own one")
role_now = None
for role in editor.all_roles():
    held = perms_of(role)
    if role.name == ROLE:
        role_now = held
    for extra in sorted(held - allowed):
        finding(f"role {role.name} holds the global permission {extra}, beyond the blueprint's list")
    for row in RoleObjectPermission.objects.filter(role=role).select_related("permission__content_type"):
        finding(
            f"role {role.name} holds the object permission "
            f"{row.permission.content_type.app_label}.{row.permission.codename} on one object"
        )
    if role.name != ROLE and held:
        finding(f"role {role.name} reaches the account beside {ROLE}")

# 2. THE WRITE PATH, bound as declared - when the given blueprint declares it.
flow = Flow.objects.filter(slug=WRITE_FLOW).first() if flow_declared else None
print(f"the write flow is {'declared' if flow_declared else 'not declared'} by the blueprint given", flush=True)
if not flow_declared:
    pass
elif flow is None:
    finding(f"the write flow {WRITE_FLOW} is declared and does not exist")
else:
    if flow.policy_engine_mode != "all":
        finding(f"the write flow's policy engine mode is {flow.policy_engine_mode}, not all")
    bindings = list(PolicyBinding.objects.filter(target=flow).select_related("group"))
    if not (
        len(bindings) == 1
        and bindings[0].group is not None
        and bindings[0].group.name == GROUP
        and bindings[0].policy_id is None
        and bindings[0].user_id is None
        and bindings[0].enabled
        and not bindings[0].negate
    ):
        finding(f"the write flow carries {len(bindings)} policy binding(s), not exactly the editors' group")
    stages = list(FlowStageBinding.objects.filter(target=flow).select_related("stage"))
    if len(stages) != 1 or stages[0].stage.name != WRITE_FLOW:
        finding(f"the write flow binds {len(stages)} stage(s), not exactly its prompt")
    else:
        if PolicyBinding.objects.filter(target=stages[0]).exists():
            finding("the write flow's stage binding carries a policy binding")
        prompt = PromptStage.objects.filter(pk=stages[0].stage.pk).first()
        names = sorted(prompt.validation_policies.values_list("name", flat=True)) if prompt else None
        if names != [WRITE_FLOW]:
            finding(f"the write prompt's validation policies are {names}, not [{WRITE_FLOW!r}]")

# 3. THE WRITES.
# The older PATCH path is expected only before it closed: while the role still holds the permission,
# or before the FIRST recorded revocation of it on this role.

still_open = role_now is not None and USER_CHANGE in role_now
closed = (
    Event.objects.filter(
        action="custom_role_permission_revoked", context__role=ROLE, context__permission=USER_CHANGE
    )
    .order_by("created")
    .values_list("created", flat=True)
    .first()
)
print(
    "the older PATCH path is "
    + ("still open" if still_open else f"closed since {closed.isoformat()}" if closed else "never recorded open"),
    flush=True,
)
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
    user_update = event.action == "model_updated" and kind == "authentik_core.user"
    older_path = method == "PATCH" and path.startswith(USERS_PATH)
    expected = user_update and (
        path == FLOW_PATH or (older_path and (still_open or (closed is not None and event.created < closed)))
    )
    if expected or str(event.pk) in known:
        continue
    # The log is public: an account's pk or uuid in the path becomes <id>.
    shown = re.sub(r"/([0-9]+|[0-9a-fA-F-]{32,36})(?=/|$)", "/<id>", path) or "?"
    finding(f"event {event.pk}: {event.action} of {kind} through {method or '?'} {shown}")
print(f"{counted} write event(s) authored by the account examined", flush=True)

if findings:
    print(f"{len(findings)} finding(s)", flush=True)
    sys.exit(1)
print("EDITOR-REACH-OK", flush=True)
