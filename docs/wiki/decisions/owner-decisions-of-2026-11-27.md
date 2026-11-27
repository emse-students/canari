## The owner's decisions of 2026-11-27

Recorded so no question answered here is asked again. All three ship in `1.8.3`, in one pull request
(the MinoWiki gate and the retirement of Archives MINO, [mino-access](../infrastructure/mino-access.md)).

1. **MinoWiki is gated exactly like MiGallery and Le Cercle** (owner, 2026-11-27): the same policy
   `miconnect-access-window-post-or-cotisant`, a group `acces-mino-wiki`, `policy_engine_mode: any` -
   D43's shape, one policy for the three sites. The lead added a third binding so the wiki's own
   administrators and editors (the `mino-*` groups) are never locked out by it
   (`miconnect-mino-wiki-roles`; [profiles-and-access](../profiles-and-access.md),
   [mino-access](../infrastructure/mino-access.md#who-may-enter-the-same-cotisant-gate-as-migallery-and-le-cercle-owner-2026-11-27)).

2. **Archives MINO is retired** (owner, 2026-11-27): its content is in MinoWiki. Its application and
   provider are deleted by `state: absent` entries; the logout redirect MinoWiki shared with it is
   renamed and pointed at the wiki; the `301` container and the public name go after the stable
   ([mino-access](../infrastructure/mino-access.md#archives-mino-is-retired-2026-11-27)).

3. **A minor change to the MiConnect terms asks nobody again, and the notice is the minimum** (owner,
   verbatim: *"Nouvelle version en 1.8.3. Pas la peine de faire réaccepter les modifications mineures,
   et tu peux réduire le texte au minimum (tout en gardant le lien pour avoir le détail complet), ça
   rajoute une étape qui ajoute de la friction pour rien"*). Charter principle 7, *simple, léger,
   agréable* ([principes](../../principes.md)): a page shown again for a correction is friction with no
   information the person needs; principle 1 is untouched, since nothing here is about messages and
   the full text stays one tap away.
   - **Two dates, two meanings.** `/legal/miconnect` carries `updated`, the date of the text's last
     revision, and `acceptedVersion`, the version a person accepts. A MATERIAL change (a new kind of
     data, a new purpose) moves both, and the version literal of `45-consent.yaml`, so every account
     is asked once; a MINOR revision (a service retired, a wording made precise, a recipient added
     under rules the text already describes) moves `updated` alone. `check-consent-version.sh` pins
     `acceptedVersion` to the other four places and refuses an `updated` earlier than it.
   - **The lead's reading of "minor"** (lead, 2026-11-27, reversible): adding a RECIPIENT that receives
     data ONLY for the people who themselves sign in to it (the MDE network console, a new site behind
     MiConnect) counts as minor - it adds no data and no purpose for anyone who does not use it.
     Section 8 of the page says so in its examples. A new kind of data or a new purpose stays material.
   - **This revision is minor**: the version stays `2026-11-24`. The full text now names the wiki
     among the sites the cotisant rule opens, drops the archives, and names the MDE network console
     and what it receives; the notice is two sentences and the link. **An existing account that
     accepted `2026-11-24` sees nothing at its next sign-in**; an account that has not accepted it
     yet meets the shorter notice. Shrinking the notice needs no version to take effect: the notice
     is read at every display of the stage.
   - **Where it is written:** the register of processing (MiConnect, section 3) and the page itself
     (sections 6 and 8); Canari's own privacy policy does not describe MiConnect's terms and is
     unchanged.

## The lead's decisions of 2026-11-27 - what an Alumni duplicate is, for the admins' queue

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
3. **A notice is durable and ONCE PER DUPLICATE.** `announcedAt` is written only after social-service
   accepted the notice; a refused or failed call leaves it null and the next reading - or the next
   sign-in, which flushes the owed notices one batch at most - tells again, in batches of at most 200.
   A backlog found at once is ONE push and ONE bell row per batch, never one row per duplicate. The
   bell row lists its batch in `meta.duplicateUuids` and stays while ANY of them still waits. The
   guarantee is a PER-DUPLICATE ledger in social (`alumni_duplicate_announcements`, migration 188):
   a call CLAIMS its duplicates (one `INSERT ... ON CONFLICT DO NOTHING RETURNING`) BEFORE it notifies
   and announces ONLY the newly claimed. A lost answer replayed, a set that grew ({A} lost, then
   {A,B} tells B alone) and two flushes at once never tell a duplicate twice; a notice that throws
   releases exactly the rows it claimed, so the retry tells. A ledger row is swept by the next announce
   once its flag is gone (a completed merge, an erased account), so it never outgrows the flags.
4. **What the badge counts.** The flags still waiting (found, not dismissed, no merge marked or
   completed), which is what the page lists as duplicates, PLUS a merge only requested whose mark was
   interrupted (its row stays on the page under the open merges, "Reprendre"): both need an admin.
5. **"Pas un doublon" refuses what it must not hide, and survives erasure.** The dismissal is refused
   (409, `ALUMNI_MERGE_IN_PROGRESS`) for a duplicate an OPEN merge names, (409,
   `ALUMNI_MERGE_ALREADY_MERGED`) for one a COMPLETED merge names, and (404 `ALUMNI_MERGE_NOT_FOUND` /
   409 `ALUMNI_MERGE_NOT_DUPLICATE`) for an account MiConnect lacks or that is not duplicate-shaped; each
   refusal is logged. The check and the write are ONE step: under the duplicate's advisory lock, the
   one a mark takes before it writes its row, so a mark and a dismissal of the same duplicate never
   both land. A DISMISSED flag is not deleted by an erasure (it holds a MiConnect uuid and a time;
   deleting it would put the account back in the queue), [register M1](../compliance/register-of-processing.md).

## A reading the lead can take is taken, not left owed (owner, 2026-11-27)

*"Et les lectures, qu'est-ce que tu attends pour les faire ? Avoir des lectures en attente est
foncièrement mauvais si tu as le pouvoir de les faire (ce qui est quasi tout le temps le cas). Note le"*

- **A reading owed is a defect of the plan, not a state.** The bench phones (the Mi 9T and the
  iPhone 12), every test account and its PIN, dev, the web and production read-only are the lead's:
  a reading they can take is taken as soon as the build it reads is installed - the same day as the
  pre-release, by agents working in parallel (one per phone, one for the web and the servers).
- **Only a reading that truly needs what the lead does not hold stays owed**: the owner's own phone
  or account, a person's real hand where no test account can stand in, hardware the bench lacks. Its
  entry says which, in one line.
- **A pre-release is followed by its readings, not by a wait.** The plan's "Readings owed" checklist
  is emptied before the next pre-release is cut whenever the bench can do it.
