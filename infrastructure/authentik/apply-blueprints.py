# Applies MiConnect's blueprints (infrastructure/authentik/blueprints/) to the authentik it runs in,
# and says exactly what changed.
#
# NOT run directly: `apply-blueprints.sh` pipes this file into `ak shell`, PREFIXED with the two
# names it reads - MODE and BLUEPRINTS (a list of (file name, YAML text)). The blueprints travel on
# stdin with the program, so nothing is mounted into or copied onto the authentik host.
#
# Modes:
#   dry-run   applies everything inside ONE transaction, prints the difference, and ROLLS BACK.
#   apply     the same, and commits.
#   snapshot  prints the normalized state of every object the blueprints name, and changes nothing.
#
# Why not `ak apply_blueprint`: it ignores the return value of `Importer.apply()`, so a blueprint
# that fails to apply exits 0 (read in authentik 2026.8's own command, 2026-09-30). Here a failure
# exits non-zero, with authentik's own log lines.
#
# Why not the worker's discovery: it applies a file only when its hash changes, concurrently with
# anything else that applies it. Every blueprint here carries `instantiate: false`, so this script
# is the ONE thing that applies them, and each release re-applies them all - which is also what
# reverts an edit made by hand in the admin UI.
import hashlib
import json
import sys

from django.apps import apps
from django.db import transaction
from structlog.testing import capture_logs

from authentik.blueprints.v1.common import BlueprintEntry, Env, Find
from authentik.blueprints.v1.importer import Importer
from authentik.brands.models import Brand
from authentik.core.models import PropertyMapping
from authentik.flows.models import Flow, FlowStageBinding
from authentik.policies.models import PolicyBinding, PolicyBindingModel
from authentik.tenants.models import Tenant

# Compared by digest and NEVER printed - a changed secret still shows up as a change.
SECRETS = {"client_secret", "consumer_secret"}
# Not compared at all: a cache of the CAS keys, which authentik refreshes itself from its URL.
CACHES = {"oidc_jwks"}


class Rollback(Exception):
    """Raised on purpose to undo a dry run."""


def log(message):
    print(f"[miconnect-blueprints] {message}", flush=True)


def concrete(obj):
    manager = obj.__class__.objects
    return manager.get_subclass(pk=obj.pk) if hasattr(manager, "get_subclass") else obj


def natural(obj):
    """How an object is named on ANY instance: its slug, its managed id, or its name."""
    obj = concrete(obj)
    if isinstance(obj, PolicyBindingModel) and not isinstance(obj, (Flow, FlowStageBinding)):
        for child in ("flow", "flowstagebinding"):
            if hasattr(obj, child):
                return natural(getattr(obj, child))
    if isinstance(obj, FlowStageBinding):
        return f"binding({natural(obj.target)} #{obj.order} {natural(obj.stage)})"
    if isinstance(obj, PolicyBinding):
        return f"policy-binding({natural(obj.target)} #{obj.order} {natural(obj.policy)})"
    if isinstance(obj, PropertyMapping) and obj.managed:
        return f"managed:{obj.managed}"
    if isinstance(obj, Brand):
        return f"brand:{obj.domain}"
    for key in ("slug", "name"):
        if hasattr(obj, key):
            return f"{obj._meta.label_lower}:{getattr(obj, key)}"
    return f"{obj._meta.label_lower}:{obj.pk}"


def normalized(obj):
    """An object's attributes with every relation replaced by its natural name."""
    obj = concrete(obj)
    out = {}
    for name, value in BlueprintEntry.from_model(obj).attrs.items():
        if name in CACHES or name == "pbm_uuid":
            continue
        if name in SECRETS:
            out[name] = "secret:" + hashlib.sha256(str(value or "").encode()).hexdigest() if value else None
            continue
        try:
            field = obj._meta.get_field(name)
        except Exception:
            field = None
        # Relations are read from the OBJECT, never re-looked-up from the serialized value: a policy
        # binding's serializer renders its target with the CHILD's pk, which is not the pk the
        # target column holds (pbm_uuid).
        if field is not None and field.is_relation:
            if getattr(field.remote_field, "parent_link", False):
                continue
            if field.many_to_many or field.one_to_many:
                value = sorted(natural(o) for o in getattr(obj, name).all())
            else:
                related = getattr(obj, name)
                value = natural(related) if related is not None else None
        out[name] = value
    return out


def entry_model(entry, blueprint):
    return apps.get_model(*entry.get_model(blueprint).split("."))


def rename_of(entry, blueprint):
    """(model, key, old, new) when the entry is a RENAME - conditioned, found by `pk: !Find [model,
    [key, old]]`, and giving that key a new value (the blueprints' RENAMES blocks) - else None. By pk
    because authentik merges the identifiers back into the attributes: an entry found by `key: old`
    would write the old value straight back."""
    identifiers = entry.identifiers or {}
    find = identifiers.get("pk")
    if not entry.conditions or len(identifiers) != 1 or not isinstance(find, Find) or len(find.conditions) != 1:
        return None
    key, old = find.conditions[0]
    new = (entry.attrs or {}).get(key)
    if not isinstance(old, str) or not isinstance(new, str) or old == new:
        return None
    return entry_model(entry, blueprint)._meta.label_lower, key, old, new


def entry_object(entry, blueprint, renames):
    """The object an entry names, or None when it does not exist (yet). An object still under the
    name a RENAME entry gives away is found by that old name, so the rename reads as a change."""
    identifiers = entry.get_identifiers(blueprint)
    # Before the renames run, a !Find on a NEW name finds nothing - a binding to a renamed stage
    # would read as created. Such a reference is looked up again under the old names.
    olds = {new: old for (_, _, new), old in renames.items()}
    for key, value in list(identifiers.items()):
        raw = (entry.identifiers or {}).get(key)
        if value is None and isinstance(raw, Find) and olds:
            found = apps.get_model(*raw.model_name.split(".")).objects.filter(**{k: olds.get(v, v) for k, v in raw.conditions}).first()
            identifiers[key] = found.pk if found else None
    if any(value is None for value in identifiers.values()):
        return None
    model = entry_model(entry, blueprint)
    obj = model.objects.filter(**identifiers).first()
    if obj is None and len(identifiers) == 1:
        ((key, value),) = identifiers.items()
        old = renames.get((model._meta.label_lower, key, value))
        if old is not None:
            obj = model.objects.filter(**{key: old}).first()
    return obj


def importers():
    for file_name, text in BLUEPRINTS:  # noqa: F821 - prefixed by apply-blueprints.sh
        yield file_name, Importer.from_string(text)


def snapshot():
    state = {}
    loaded = list(importers())
    renames = {}
    for _, importer in loaded:
        for entry in importer.blueprint.iter_entries():
            rename = rename_of(entry, importer.blueprint)
            if rename:
                renames[rename[0], rename[1], rename[3]] = rename[2]
    for file_name, importer in loaded:
        # Keyed by POSITION, so a renamed object reads as a change rather than as one gone and one new.
        for index, entry in enumerate(importer.blueprint.iter_entries()):
            if rename_of(entry, importer.blueprint):
                continue
            obj = entry_object(entry, importer.blueprint, renames)
            key = f"{file_name}#{index:02d} {entry_model(entry, importer.blueprint)._meta.label_lower}"
            state[key] = {"_is": natural(obj), **normalized(obj)} if obj else None
    return state


def unresolved_tags(value, entry, blueprint, path="attrs"):
    """Every !Find that matches NOTHING and every !Env that is unset. authentik resolves both to null
    and carries on, so a mistyped name would silently clear a nullable reference and a missing
    variable would blank a secret - both are refused here."""
    if isinstance(value, Find):
        if value.resolve(entry, blueprint) is None:
            yield f"{path}: !Find {value.model_name} {value.conditions}"
    elif isinstance(value, Env):
        if not value.resolve(entry, blueprint):
            yield f"{path}: !Env {value.key} is unset"
    elif isinstance(value, dict):
        for key, inner in value.items():
            yield from unresolved_tags(inner, entry, blueprint, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, inner in enumerate(value):
            yield from unresolved_tags(inner, entry, blueprint, f"{path}[{index}]")


def diff(before, after):
    changes = []
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key), after.get(key)
        if old == new:
            continue
        if old is None:
            changes.append(f"CREATED  {key}")
            continue
        if new is None:
            changes.append(f"DELETED  {key} ({old.get('_is')})")
            continue
        for field in sorted(set(old or {}) | set(new or {})):
            if field in SECRETS and (old or {}).get(field) != (new or {}).get(field):
                changes.append(f"CHANGED  {key} .{field}: (a secret - value not shown)")
                continue
            if (old or {}).get(field) != (new or {}).get(field):
                changes.append(f"CHANGED  {key} .{field}: {json.dumps((old or {}).get(field), ensure_ascii=False, default=str)[:300]} -> {json.dumps((new or {}).get(field), ensure_ascii=False, default=str)[:300]}")
    return changes


def run():
    if MODE == "snapshot":  # noqa: F821
        state = snapshot()
        for attrs in state.values():
            for field in SECRETS & set(attrs or {}):
                attrs[field] = "<set>" if attrs[field] else "<empty>"
        print(json.dumps(state, ensure_ascii=False, sort_keys=True, indent=1, default=str))
        return 0
    try:
        with transaction.atomic():
            before = snapshot()
            for file_name, importer in importers():
                with capture_logs() as logs:
                    valid, validation_logs = importer.validate()
                    applied = valid and importer.apply()
                if not applied:
                    log(f"FAILED to apply {file_name}")
                    for line in list(validation_logs) + list(logs):
                        log(f"  {line}")
                    raise RuntimeError(f"{file_name} did not apply")
                log(f"applied {file_name}")
            missing = []
            for file_name, importer in importers():
                for entry in importer.blueprint.iter_entries():
                    # A rename's own !Find names the OLD object, which is gone once it has run.
                    if rename_of(entry, importer.blueprint):
                        continue
                    missing.extend(f"{file_name} {m}" for m in unresolved_tags(entry.attrs, entry, importer.blueprint))
                    missing.extend(f"{file_name} {m}" for m in unresolved_tags(entry.identifiers, entry, importer.blueprint, "identifiers"))
            if missing:
                for line in missing:
                    log(f"UNRESOLVED {line}")
                raise RuntimeError(f"{len(missing)} tag(s) resolved to nothing")
            # A rename that did not run leaves the old object AND a new one built beside it.
            left = []
            for file_name, importer in importers():
                for entry in importer.blueprint.iter_entries():
                    rename = rename_of(entry, importer.blueprint)
                    if rename and entry_model(entry, importer.blueprint).objects.filter(**{rename[1]: rename[2]}).exists():
                        left.append(f"{file_name} {rename[0]} {rename[1]}={rename[2]!r} still exists beside {rename[3]!r}")
            if left:
                for line in left:
                    log(f"NOT RENAMED {line}")
                raise RuntimeError(f"{len(left)} rename(s) left the old object")
            changes = diff(before, snapshot())
            for line in changes:
                log(line)
            log(f"{len(changes)} change(s)")
            if MODE == "dry-run":  # noqa: F821
                raise Rollback()
    except Rollback:
        log("dry run: rolled back, nothing was written")
    return 0


tenants = list(Tenant.objects.filter(ready=True))
if len(tenants) != 1:
    log(f"expected exactly one ready tenant, found {len(tenants)}")
    sys.exit(2)
with tenants[0]:
    try:
        sys.exit(run())
    except RuntimeError as exc:
        log(f"ERROR {exc}")
        sys.exit(1)
