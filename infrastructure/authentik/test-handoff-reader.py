"""Proves the account Canari's handoff mint reads MiConnect through can read what the mint needs - and
nothing more (55-handoff-reader.yaml).

Run through `ak shell` by test-blueprints.sh, after the blueprints applied. It calls authentik's REAL
API in-process with the token the blueprint wrote, the reads core-service makes
(apps/core-service/src/auth/handoff/miconnect-reader.client.ts): a user by uuid (with its `uid`), a
handoff application by slug (with its provider's two flows), each flow and its stage bindings, the
policy bindings on all of them (with the names of what they bind), the tenant's `core_default_app_access`
flag, a user's groups and whether they hold an Alumni connection. Then the limits: no other application,
no write of any kind, and -
the reason the design reads the INPUTS rather than the answer - `check_access?for_user` answers for
the CALLER, not for the user named. It prints `HANDOFF-READER-OK` when every assertion held.

WHY THE API AND NOT `user.has_perm`: the role says what was GRANTED; the API is what a stolen token
could DO.
"""
import json
import os

from django.test import Client

from authentik.core.models import Application, Group, Token, User
from authentik.flows.models import Flow, FlowStageBinding
from authentik.policies.expression.models import ExpressionPolicy
from authentik.policies.models import PolicyBinding
from authentik.sources.saml.models import SAMLSource, UserSAMLSourceConnection

TOKEN = os.environ["MICONNECT_READER_TOKEN"]
USERNAME = "miconnect-canari-handoff-reader"
PROBE = "miconnect-reader-probe"
HANDOFF_APPS = ("migallery", "sky", "cercle")
# The terms-of-use flow the handoff providers authorize through, and the ALLOWLIST the mint recognises on it
# (miconnect-reader.client.ts CONSENT_FLOW_ALLOWLIST): stage name -> the one policy on its stage binding. The
# terms prompt and write, and the Alumni link step's reminder and block (D44, 45-consent.yaml).
CONSENT_FLOW = "miconnect-authorization"
ALLOWLIST = {
    "miconnect-consent-ask": "miconnect-consent-needed",
    "miconnect-consent-write": "miconnect-consent-needed",
    "miconnect-alumni-link-remind": "miconnect-alumni-link-reminder",
    "miconnect-alumni-link-require": "miconnect-alumni-link-required",
}
# The Alumni gate (D42-D43, 60-applications.yaml), recognised by the mint in this exact shape: engine mode
# `any`, the policy and the group `acces-<app>`, on MiGallery and Le Cercle.
GATE_POLICY = "miconnect-access-window-post-or-cotisant"
APP_BINDINGS = {"migallery": 2, "sky": 0, "cercle": 2}


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


reader = User.objects.get(username=USERNAME)
check(reader.type == "service_account", "the reader is a service account")
check(not reader.is_superuser, "the reader is not a superuser")
token = Token.objects.get(identifier=USERNAME)
check(token.key == TOKEN and token.user_id == reader.pk, "the token is the one the environment holds, owned by the reader")
check(token.expiring is False, "the token does not expire")

User.objects.filter(username=PROBE).delete()
probe = User.objects.create(username=PROBE, name="Probe", is_active=True)
probe.groups.add(Group.objects.get(name="acces-migallery"))
alumni_source = SAMLSource.objects.get(slug="alumni")
policy = None
try:
    found = call("get", f"/api/v3/core/users/?uuid={probe.uuid}")
    check(found.status_code == 200, "the reader reads a user by uuid")
    results = found.json()["results"]
    check(len(results) == 1 and results[0]["pk"] == probe.pk, "the uuid addresses exactly one user")
    check(results[0]["is_active"] is True, "the read carries is_active")
    check(results[0]["uid"] == probe.uid, "the read carries the uid the mint compares with the account id")
    # The Alumni gate admits a member of `acces-<app>`: the mint reads the group NAMES from the user answer.
    check([g["name"] for g in results[0].get("groups_obj") or []] == ["acces-migallery"], f"the read carries the names of the user's groups ({results[0].get('groups_obj')!r})")

    # The Alumni link step asks whether a connection exists - read with the token, for THIS user only.
    connections = f"/api/v3/sources/user_connections/all/?user={probe.pk}&source__slug=alumni"
    unlinked = call("get", connections)
    check(unlinked.status_code == 200 and unlinked.json()["pagination"]["count"] == 0, f"the reader reads that the user holds no Alumni connection ({unlinked.status_code})")
    connection = UserSAMLSourceConnection.objects.create(source=alumni_source, user=probe, identifier="reader-probe-1")
    linked = call("get", connections)
    check(linked.json()["pagination"]["count"] == 1, "and SEES one once it exists - a missing grant would read it as none, not as a 403")
    other_user = call("get", f"/api/v3/sources/user_connections/all/?user={reader.pk}&source__slug=alumni")
    check(other_user.json()["pagination"]["count"] == 0, "the filter is by user: another user's answer does not count the probe's")

    for slug in HANDOFF_APPS:
        app = call("get", f"/api/v3/core/applications/{slug}/")
        check(app.status_code == 200, f"the reader sees the handoff application {slug}")
        pk = app.json()["pk"]
        bindings = call("get", f"/api/v3/policies/bindings/?target_in={pk}&enabled=true&page_size=100")
        check(bindings.status_code == 200, f"the reader lists {slug}'s bindings")
        check(bindings.json()["pagination"]["count"] == len(bindings.json()["results"]) == APP_BINDINGS[slug], f"{slug} carries {APP_BINDINGS[slug]} binding(s) on a fresh instance, all read ({bindings.json()['pagination']['count']})")
        if APP_BINDINGS[slug]:
            # The names the gate allowlist reads: the policy's, the group's, and the engine mode.
            check(app.json()["policy_engine_mode"] == "any", f"the reader reads {slug}'s engine mode")
            shape = sorted((b["policy_obj"] or {}).get("name") or "group:" + (b["group_obj"] or {}).get("name", "") for b in bindings.json()["results"])
            check(shape == sorted([GATE_POLICY, f"group:acces-{slug}"]) and all(b["negate"] is False for b in bindings.json()["results"]), f"{slug}'s bindings are the Alumni gate, by name ({shape})")
        provider = app.json()["provider_obj"]
        for kind in ("authentication_flow", "authorization_flow"):
            flow_uuid = provider[kind]
            check(bool(flow_uuid), f"{slug}'s provider names its {kind}")
            flows = call("get", f"/api/v3/flows/instances/?flow_uuid={flow_uuid}")
            check(flows.status_code == 200 and len(flows.json()["results"]) == 1, f"the reader reads {slug}'s {kind}")
            flow = flows.json()["results"][0]
            check(bool(flow["policybindingmodel_ptr_id"]) and bool(flow["authentication"]), f"{slug}'s {kind} carries its binding target and requirement")
            stages = call("get", f"/api/v3/flows/bindings/?target={flow_uuid}&page_size=100")
            check(stages.status_code == 200, f"the reader lists the stage bindings of {slug}'s {kind}")
            body = stages.json()
            check(body["pagination"]["count"] == len(body["results"]), f"one page holds every stage binding of {slug}'s {kind}")
            targets = [flow["policybindingmodel_ptr_id"]] + [b["policybindingmodel_ptr_id"] for b in body["results"]]
            query = "&".join(f"target_in={t}" for t in targets)
            counted = call("get", f"/api/v3/policies/bindings/?{query}&enabled=true&page_size=100")
            check(counted.status_code == 200, f"the reader lists the bindings on {slug}'s {kind} and its stages")
            listed = counted.json()
            if flow["slug"] == CONSENT_FLOW:
                # Since the terms hold was lifted (2026-11-20) the providers authorize through the consent flow, whose
                # two bindings the mint recognises by an ALLOWLIST (miconnect-reader.client.ts flowGate): exactly the
                # policy `miconnect-consent-needed`, not negated, on the stage bindings of the prompt and the write.
                # The reader must SEE the names the allowlist reads - a missing field would silently refuse every mint.
                stage_names = {b["policybindingmodel_ptr_id"]: b["stage_obj"]["name"] for b in body["results"]}
                check(set(stage_names.values()) == set(ALLOWLIST), f"{slug}'s {kind} is the consent flow, and the reader reads its stage names ({sorted(stage_names.values())})")
                check(listed["pagination"]["count"] == len(listed["results"]) == 4, f"the consent flow carries the two terms bindings and the two link-step bindings, all read ({listed['pagination']['count']})")
                # Each consent stage binding is asked ALONE through the same `target_in` filter the client uses: a
                # binding's own `target` field is not an id the client can compare (CI 2026-11-20), so the
                # attribution is by query. Print what `target` is, so the next reader of a failure sees it.
                print(f"  note target field of a consent binding: {listed['results'][0].get('target')!r}", flush=True)
                for ptr, name in stage_names.items():
                    one = call("get", f"/api/v3/policies/bindings/?target_in={ptr}&enabled=true&page_size=100").json()
                    check(one["pagination"]["count"] == len(one["results"]) == 1, f"the allowlisted stage binding {name} carries exactly one binding")
                    check(one["results"][0]["policy_obj"]["name"] == ALLOWLIST[name] and one["results"][0]["negate"] is False, f"on {name} it is {ALLOWLIST[name]}, not negated")
            else:
                check(listed["pagination"]["count"] == 0, f"nothing is bound on {slug}'s {kind} or its stages")

    other = call("get", "/api/v3/core/applications/canari/")
    check(other.status_code in (403, 404), f"the reader may NOT see another application (got {other.status_code})")

    # A binding added later is SEEN - the grant on bindings is global, so a new one cannot read as none.
    target = Application.objects.get(slug="migallery")
    policy = ExpressionPolicy.objects.create(name="miconnect-reader-probe-policy", expression="return True")
    PolicyBinding.objects.create(target=target, policy=policy, order=0, enabled=True)
    seen = call("get", f"/api/v3/policies/bindings/?target={target.pk}&enabled=true")
    check(seen.json()["pagination"]["count"] == APP_BINDINGS["migallery"] + 1, "a binding added after the grant is seen")
    # The same on a flow and on a stage binding: the grants are global, so a policy put on the
    # login tomorrow is counted, never read as none.
    flow = target.get_provider().authorization_flow
    PolicyBinding.objects.create(target=flow, policy=policy, order=0, enabled=True)
    on_flow = call("get", f"/api/v3/policies/bindings/?target_in={flow.pbm_uuid}&enabled=true")
    check(on_flow.json()["pagination"]["count"] == 1, "a binding added on the authorization flow is seen")
    login = target.get_provider().authentication_flow
    stage_binding = FlowStageBinding.objects.filter(target=login).first()
    check(stage_binding is not None, "the authentication flow has a stage binding to probe")
    PolicyBinding.objects.create(target=stage_binding, policy=policy, order=0, enabled=True)
    on_stage = call("get", f"/api/v3/policies/bindings/?target_in={stage_binding.pbm_uuid}&enabled=true")
    check(on_stage.json()["pagination"]["count"] == 1, "a binding added on a stage of the login flow is seen")

    settings = call("get", "/api/v3/admin/settings/")
    check(settings.status_code == 200, "the reader reads the tenant settings")
    # authentik 2026.8's settings serializer OMITS a flag never set, and the flag's default is true
    # (core/apps.py, AppAccessWithoutBindings) - so the mint reads "absent" as that default and only
    # an explicit false as a refusal. Production reads absent (2026-11-11).
    check(settings.json()["flags"].get("core_default_app_access", True) is True, "core_default_app_access is unset or true")

    patched = call("patch", f"/api/v3/core/users/{probe.pk}/", {"name": "hijacked"})
    check(patched.status_code == 403, f"the reader may NOT change a user (got {patched.status_code})")
    created = call("post", "/api/v3/core/users/", {"username": "miconnect-reader-intruder", "name": "x"})
    check(created.status_code == 403, f"the reader may NOT create a user (got {created.status_code})")
    deleted = call("delete", f"/api/v3/core/users/{probe.pk}/")
    check(deleted.status_code == 403, f"the reader may NOT delete a user (got {deleted.status_code})")
    app_patch = call("patch", "/api/v3/core/applications/migallery/", {"name": "hijacked"})
    check(app_patch.status_code == 403, f"the reader may NOT change an application (got {app_patch.status_code})")
    binding_post = call("post", "/api/v3/policies/bindings/", {"target": str(target.pk), "policy": str(policy.pk), "order": 1})
    check(binding_post.status_code == 403, f"the reader may NOT bind a policy (got {binding_post.status_code})")
    flow_patch = call("patch", f"/api/v3/flows/instances/{flow.slug}/", {"title": "hijacked"})
    check(flow_patch.status_code == 403, f"the reader may NOT change a flow (got {flow_patch.status_code})")
    stage_patch = call("patch", f"/api/v3/flows/bindings/{stage_binding.pk}/", {"order": 99})
    check(stage_patch.status_code == 403, f"the reader may NOT change a stage binding (got {stage_patch.status_code})")
    settings_patch = call("patch", "/api/v3/admin/settings/", {"flags": {"core_default_app_access": False}})
    check(settings_patch.status_code == 403, f"the reader may NOT change the settings (got {settings_patch.status_code})")
    # The connection grant is a VIEW grant: the reader may not unlink a person, nor rewrite the link.
    connection_patch = call("patch", f"/api/v3/sources/user_connections/all/{connection.pk}/", {"identifier": "hijacked"})
    check(connection_patch.status_code == 403, f"the reader may NOT change an Alumni connection (got {connection_patch.status_code})")
    connection_delete = call("delete", f"/api/v3/sources/user_connections/all/{connection.pk}/")
    check(connection_delete.status_code == 403, f"the reader may NOT delete an Alumni connection (got {connection_delete.status_code})")
    group_join = call("post", f"/api/v3/core/groups/{Group.objects.get(name='acces-cercle').pk}/add_user/", {"pk": probe.pk})
    check(group_join.status_code in (403, 404), f"the reader may NOT put a user in an access group (got {group_join.status_code})")
    probe.refresh_from_db()
    check(probe.name == "Probe" and User.objects.filter(pk=probe.pk).exists(), "the user is untouched")
    check(not User.objects.filter(username="miconnect-reader-intruder").exists(), "no user was created")
    check(Application.objects.get(slug="migallery").name == "MiGallery", "the application is untouched")
    connection.refresh_from_db()
    check(connection.identifier == "reader-probe-1", "the Alumni connection is untouched")
    check(not probe.groups.filter(name="acces-cercle").exists(), "the user's groups are untouched")
finally:
    PolicyBinding.objects.filter(policy__name="miconnect-reader-probe-policy").delete()
    if policy is not None:
        policy.delete()
    probe.delete()

print("HANDOFF-READER-OK")
