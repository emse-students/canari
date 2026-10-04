# WP1 of the profile reform (docs/wiki/profiles-and-access.md): writes `attributes.profile` for every
# account that has none, from what enrolment recorded (school_status, formation, promo, name).
#
# NOT run directly: `migrate-profile.sh dry-run|apply` pipes it into `ak shell`, prefixed with MODE.
#
# Idempotent by construction: an account that already HAS a profile is never touched - it was written
# by enrolment or by an admin, both newer than what this reads - and is only counted. So it can be
# re-run at any time, and the dry run of a second pass reports 0 writes. The old keys (promo,
# formation, school_status) are left in place until WP9.
#
# The rules are the user's decisions:
#   D4  formations ICM / ISMIN / FSSS / Autre - "Master" becomes "Autre" (2026-09-30)
#   D26 campus deduced: ISMIN -> gardanne, everyone else -> saint-etienne
#   D27 "Personnel de l'ecole" and the account with no status become an EMSE post
# The explicit names are the split the `miconnect-claim-name` mapping made until WP1 (a word in
# capitals is the last name) - the same values every application already received.
import json
import sys
from collections import Counter

from django.db import transaction

from authentik.core.models import User
from authentik.tenants.models import Tenant

FORMATIONS = {"ICM": "ICM", "ISMIN": "ISMIN", "FSSS": "FSSS", "Master": "Autre"}
STUDENT = "Elève"
# authentik's own accounts, which never sign in to an application: the placeholder for an anonymous
# request, and the service accounts of its outposts.
SKIPPED_USERNAMES = {"AnonymousUser"}
SKIPPED_TYPES = {"internal_service_account", "service_account"}


class Rollback(Exception):
    """Raised on purpose to undo a dry run."""


def log(message):
    print(f"[miconnect-profile] {message}", flush=True)


def split_name(name):
    """(first, last) as the name mapping split it before WP1: all-capitals words are the last name."""
    parts = (name or "").strip().split()
    if not parts:
        return "", ""
    last = [part for part in parts if part == part.upper() and len(part) > 1]
    first = [part for part in parts if not (part == part.upper() and len(part) > 1)]
    return " ".join(first) or parts[0], " ".join(last)


def profile_of(user):
    """The version-1 profile of an account, and the anomalies that make it worth a look."""
    attributes = user.attributes or {}
    status = attributes.get("school_status")
    formation = attributes.get("formation")
    promo = attributes.get("promo")
    anomalies = []
    cursus, posts = [], []
    if status == STUDENT:
        if formation in FORMATIONS and isinstance(promo, int):
            cursus.append({"formation": FORMATIONS[formation], "promo": promo})
        else:
            anomalies.append(f"student without a usable cursus (formation={formation!r}, promo={promo!r})")
    else:
        posts.append("EMSE")
        if status is None:
            anomalies.append("no status at all -> EMSE post (D27)")
    first, last = split_name(user.name)
    if not last:
        anomalies.append(f"no last name in {user.name!r}")
    if not cursus and not posts:
        anomalies.append("neither a cursus nor a post")
    profile = {
        "version": 1,
        "campus": "gardanne" if formation == "ISMIN" else "saint-etienne",
        "cursus": cursus,
        "posts": posts,
        "firstName": first,
        "lastName": last,
    }
    return profile, anomalies


def run():
    written, kept, skipped = 0, 0, 0
    shape = Counter()
    try:
        with transaction.atomic():
            for user in User.objects.order_by("date_joined"):
                if user.username in SKIPPED_USERNAMES or user.type in SKIPPED_TYPES:
                    skipped += 1
                    continue
                if (user.attributes or {}).get("profile") is not None:
                    kept += 1
                    continue
                profile, anomalies = profile_of(user)
                cursus = profile["cursus"][0]["formation"] if profile["cursus"] else "-"
                shape[(profile["campus"], cursus, ",".join(profile["posts"]) or "-")] += 1
                for anomaly in anomalies:
                    log(f"LOOK {user.username}: {anomaly}")
                user.attributes = {**(user.attributes or {}), "profile": profile}
                user.save(update_fields=["attributes"])
                written += 1
            for (campus, formation, posts), count in sorted(shape.items()):
                log(f"SHAPE campus={campus} cursus={formation} posts={posts}: {count}")
            log(f"{written} profile(s) written, {kept} already had one, {skipped} skipped")
            if MODE == "dry-run":  # noqa: F821 - prefixed by migrate-profile.sh
                raise Rollback()
    except Rollback:
        log("dry run: rolled back, nothing was written")
    return 0


if MODE not in ("dry-run", "apply"):  # noqa: F821
    log(f"unknown mode {MODE!r}")  # noqa: F821
    sys.exit(2)
tenants = list(Tenant.objects.filter(ready=True))
if len(tenants) != 1:
    log(f"expected exactly one ready tenant, found {len(tenants)}")
    sys.exit(2)
with tenants[0]:
    sys.exit(run())
