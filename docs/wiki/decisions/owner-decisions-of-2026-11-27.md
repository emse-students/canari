## Decisions of 2026-11-27 - what an Alumni duplicate is, for the admins' queue

Taken by the LEAD under the absence rule (reversible), from the owner's request of 2026-11-26 that an
Alumni duplicate notify the admins like every other admin queue ("Quand il y a une fusion d'alumni, je
devrais recevoir une notif, comme toutes les autres fonctionnalites de la console admin non ?").
The mechanism is [admin](../frontend/modules/admin.md#pending-counts-and-the-admin-notices-owner-2026-11-18);
the charter principle that bounds it is the third, "your attention is not for sale"
([principes](../../principes.md)): admins only, one notice per duplicate, never a repeat.

1. **The lead's reading of D55 (revised the same day): LISTED is not FLAGGED.** The admin page lists every
   Alumni-created account that is duplicate-shaped, not dismissed and in no open merge - one with a
   name-and-promo match first, then the ones "to attach by hand" - with "Rattacher" and "Pas un
   doublon" on each, so an admin can always act on an alumnus the base spelled differently. **Only an
   account for which a search by its name finds at least ONE eligible CAS account** (a person, active,
   not a superuser, holding a CAS link and no Alumni link, named by no open merge; homonyms included -
   the manual case of D55) **is FLAGGED: announced, pushed, bell-rowed and counted in the badge.** An
   alumnus nobody matches is on the page but is never pushed, never bell-rowed and never counted.
   Reversible: it is `AlumniMergeService.eligibleAmong` (the ONE rule of an eligible target, shared by
   the manual search and the queue, one name search per duplicate) and `listDuplicates().flaggable`.
   The candidate check reads at most 25 target-shaped homonyms: a candidate past the 25th is missed by
   the check, and the admin's own search with a narrower query still reaches it. Nothing is ever merged
   by itself: the flag only puts the account in front of the admins.
2. **"Pas un doublon" is a terminal admin action.** An admin who sees that a flagged account is not a
   duplicate closes it for every admin, for good: `alumni_duplicate_flags.dismissedAt` is durable state,
   never cleared, so no later reading and no later sign-in flags the account again (it is state, not a
   clock). Reversible only by a migration, deliberately: a "maybe later" would be the repeat the charter
   forbids.
3. **A notice is durable, once, and idempotent.** `announcedAt` is written only after social-service
   accepted the notice; a refused or failed call leaves it null and the next reading - or the next
   sign-in, which flushes the owed notices one batch at most - tells again, in batches of at most 200.
   A backlog found at once is ONE push and ONE bell row per batch, never one row per duplicate. The
   bell row lists its batch in `meta.duplicateUuids` and stays while ANY of them still waits. Each
   batch carries an id (a digest of its sorted uuids) that social records in
   `alumni_duplicate_announcements` AFTER it told it: a batch already there is not told again, so an
   answer lost on the way never rings the admins' phones twice (a crash between the notice and the
   record tells again rather than never; a batch that changed in between is another batch).
4. **What the badge counts.** The flags still waiting (found, not dismissed, no merge marked or
   completed), which is what the page lists as duplicates, PLUS a merge only requested whose mark was
   interrupted (its row stays on the page under the open merges, "Reprendre"): both need an admin.
5. **"Pas un doublon" refuses what it must not hide, and survives erasure.** The dismissal is refused
   (409, `ALUMNI_MERGE_IN_PROGRESS`) for a duplicate a merge that is not cancelled names, and (404
   `ALUMNI_MERGE_NOT_FOUND` / 409 `ALUMNI_MERGE_NOT_DUPLICATE`) for an account MiConnect lacks or that
   is not duplicate-shaped; each refusal is logged. A DISMISSED flag is not deleted by an erasure
   (it holds a MiConnect uuid and a time; deleting it would put the account back in the queue),
   [register M1](../compliance/register-of-processing.md).
