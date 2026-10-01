# WP3 of the profile reform (docs/wiki/profiles-and-access.md): prints, for every account that has an
# `attributes.profile`, the three facts Canari stores - the `sub` it knows the person by, the
# authentik uuid, and the profile - one `PROFILE <json>` line each.
#
# NOT run directly: `backfill-canari-profiles.sh` pipes it into `ak shell`. READ-ONLY.
#
# `user.uid` is authentik's `hashed_user_id`, which is what Canari's three providers emit as `sub`
# and what `users.id` holds; `user.uuid` is the `miconnect_uuid` claim. Accounts with no profile
# (AnonymousUser, outpost service accounts) are skipped, as WP1 skipped them.
import json

from authentik.core.models import User
from authentik.tenants.models import Tenant

with Tenant.objects.get(ready=True):
    count = 0
    for user in User.objects.all().order_by("pk").iterator():
        profile = (user.attributes or {}).get("profile")
        if not profile:
            continue
        print("PROFILE " + json.dumps({"uid": user.uid, "uuid": str(user.uuid), "profile": profile}, ensure_ascii=False))
        count += 1
    print(f"EXPORTED {count}")
