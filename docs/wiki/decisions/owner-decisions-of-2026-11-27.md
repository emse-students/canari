## Decisions of 2026-11-27 - what an Alumni duplicate is, for the admins' queue

Taken by the LEAD under the absence rule (reversible), from the owner's request of 2026-11-26 that an
Alumni duplicate notify the admins like every other admin queue ("Quand il y a une fusion d'alumni, je
devrais recevoir une notif, comme toutes les autres fonctionnalites de la console admin non ?").
The mechanism is [admin](../frontend/modules/admin.md#pending-counts-and-the-admin-notices-owner-2026-11-18);
the charter principle that bounds it is the third, "your attention is not for sale"
([principes](../../principes.md)): admins only, one notice per duplicate, never a repeat.

1. **The lead's reading of D55: an Alumni-created account is a duplicate for the queue ONLY when a
   search by its name finds at least ONE eligible CAS account** - a person, active, not a superuser,
   holding a CAS link and no Alumni link, named by no open merge. Homonyms are included: that is the
   manual case of D55 (the admin decides identity). **An alumnus nobody on the CAS side matches is not
   a duplicate: it is never flagged, never announced, never counted, never listed.** Reversible: it is
   the one predicate `AlumniMergeService.hasCandidate`, and the page lists exactly what the queue holds.
   Nothing is ever merged by itself: the flag only puts the account in front of the admins.
2. **"Pas un doublon" is a terminal admin action.** An admin who sees that a flagged account is not a
   duplicate closes it for every admin, for good: `alumni_duplicate_flags.dismissedAt` is durable state,
   never cleared, so no later reading and no later sign-in flags the account again (it is state, not a
   clock). Reversible only by a migration, deliberately: a "maybe later" would be the repeat the charter
   forbids.
3. **A notice is durable.** `announcedAt` is written only after social-service accepted the notice; a
   refused or failed call leaves it null and the next reading tells again, in batches of at most 200.
   A backlog found at once is ONE push and ONE bell row per batch, never one row per duplicate: the
   badge carries the count, the bell is not flooded.
4. **What the badge counts.** The flags still waiting (found, not dismissed, no merge marked or
   completed), which is what the page lists as duplicates, PLUS a merge only requested whose mark was
   interrupted (its row stays on the page under the open merges, "Reprendre"): both need an admin.
