"""Proves the account Canari's handoff mint reads MiConnect through can read what the mint needs - and
nothing more (55-handoff-reader.yaml).

Run through `ak shell` by test-blueprints.sh, after the blueprints applied. It calls authentik's REAL
API in-process with the token the blueprint wrote, the reads core-service makes
(apps/core-service/src/auth/handoff/miconnect-reader.client.ts): a user by uuid (with its `uid`), a
handoff application by slug (with its provider's two flows), each flow and its stage bindings, the
policy bindings on all of them, and the tenant's `core_default_app_access` flag. Then the limits: no other application, no write of any kind, and -
the reason the design reads the INPUTS rather than the answer - `check_access?for_user` answers for
the CALLER, not for the user named. It prints `HANDOFF-READER-OK` when every assertion held.

WHY THE API AND NOT `user.has_perm`: the role says what was GRANTED; the API is what a stolen token
could DO.
"""
import json
import os

from django.test import Client

from authentik.core.models import Application, Token, User
from authentik.flows.models import Flow, FlowStageBinding
from authentik.policies.expression.models import ExpressionPolicy
from authentik.policies.models import PolicyBinding

TOKEN = os.environ["MICONNECT_READER_TOKEN"]
USERNAME = "miconnect-canari-handoff-reader"
PROBE = "miconnect-reader-probe"
HANDOFF_APPS = ("migallery", "sky", "cercle")


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
policy = None
try:
    found = call("get", f"/api/v3/core/users/?uuid={probe.uuid}")
    check(found.status_code == 200, "the reader reads a user by uuid")
    results = found.json()["results"]
    check(len(results) == 1 and results[0]["pk"] == probe.pk, "the uuid addresses exactly one user")
    check(results[0]["is_active"] is True, "the read carries is_active")
    check(results[0]["uid"] == probe.uid, "the read carries the uid the mint compares with the account id")

    for slug in HANDOFF_APPS:
        app = call("get", f"/api/v3/core/applications/{slug}/")
        check(app.status_code == 200, f"the reader sees the handoff application {slug}")
        pk = app.json()["pk"]
        bindings = call("get", f"/api/v3/policies/bindings/?target={pk}&enabled=true")
        check(bindings.status_code == 200, f"the reader lists {slug}'s bindings")
        check(bindings.json()["pagination"]["count"] == 0, f"{slug} has no binding on a fresh instance")
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
            counted = call("get", f"/api/v3/policies/bindings/?{query}&enabled=true")
            check(counted.status_code == 200 and counted.json()["pagination"]["count"] == 0, f"nothing is bound on {slug}'s {kind} or its stages")

    other = call("get", "/api/v3/core/applications/canari/")
    check(other.status_code in (403, 404), f"the reader may NOT see another application (got {other.status_code})")

    # A binding added later is SEEN - the grant on bindings is global, so a new one cannot read as none.
    target = Application.objects.get(slug="migallery")
    policy = ExpressionPolicy.objects.create(name="miconnect-reader-probe-policy", expression="return True")
    PolicyBinding.objects.create(target=target, policy=policy, order=0, enabled=True)
    seen = call("get", f"/api/v3/policies/bindings/?target={target.pk}&enabled=true")
    check(seen.json()["pagination"]["count"] == 1, "a binding added after the grant is seen")
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
    probe.refresh_from_db()
    check(probe.name == "Probe" and User.objects.filter(pk=probe.pk).exists(), "the user is untouched")
    check(not User.objects.filter(username="miconnect-reader-intruder").exists(), "no user was created")
    check(Application.objects.get(slug="migallery").name == "MiGallery", "the application is untouched")
finally:
    PolicyBinding.objects.filter(policy__name="miconnect-reader-probe-policy").delete()
    if policy is not None:
        policy.delete()
    probe.delete()

print("HANDOFF-READER-OK")
