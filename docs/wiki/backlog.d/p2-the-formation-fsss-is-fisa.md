## P2 - the formation FSSS is FISA: the production steps around the 1.8.3 deploy

target: 1.8.3

The owner settled on 2026-11-26 that FSSS and FISA are the same population (the apprentices,
"Formation d'Ingenieur Sous statut d'Apprenti"), that its name is FISA, and that ISTP is mentioned
nowhere ([profiles-and-access, D4](../profiles-and-access.md)). Canari's code, its three lists, the
MiConnect enrolment prompt and every stored value move in one release: migration 187
(`apps/social-service/src/migrations/187_formation_fsss_is_fisa.sql`, HELD - its approval line is
merged by hand), shipped in `1.8.3`. What the repository cannot do is below, IN THIS ORDER; the lead
does it, and the entry is deleted once the last line is measured at zero.

**Why MiConnect goes first.** Every sign-in re-copies the cursus from the MiConnect claim
(`parseProfileClaims`), and a formation no list names is KEPT and opens no space, with a
`[UNKNOWN_FORMATION]` warning. Rewritten AFTER the deploy, each FSSS profile would bring FSSS back
at its next sign-in and lose its spaces until a sign-in after the MiConnect rewrite - weeks, for a
long session. Rewritten BEFORE, the only window is the minutes until the deploy, during which a
sign-in stores FISA (unknown to the old code: warned, no space) and 187 leaves it as it is. No
normalisation is written in the code for it: the order makes it unnecessary.

1. **The pre-release.** Merge the approval line of 187 after the adversarial review, cut
   `1.8.3-alpha.N`; dev runs 187 with its backup. Measure on dev, read-only, the counts in 187's
   header: all zero after.
2. **MiConnect, before the stable** (production authentik): 14 users' `attributes.profile.cursus`
   entries and 12 legacy `attributes.formation` values from FSSS to FISA. Re-count: zero FSSS.
3. **The stable `1.8.3`.** The deploy takes its backup and applies 187; `apply-blueprints.sh` gives
   the enrolment prompt its new list.
4. **After the deploy, read-only.** Canari: 187's header counts, all zero. MiConnect: zero FSSS again
   - an enrolment between steps 2 and 3 went through the OLD prompt. The `[UNKNOWN_FORMATION]` lines
   of core-service name no `FSSS`.
5. **The other estates**, independent of Canari's deploy: MiGallery, 41 `album_permissions` rows;
   Le Cercle, 3503 legacy ISTP rows and 3 FSSS rows. Each repository's own formation list, if it
   has one, changes with them.
6. **The store floor.** An app build older than `1.8.3` does not know FISA: its audience editor
   reads a FISA pair as nothing, so SAVING an association's audience from it drops that pair (the
   web is current from the deploy). Raise `minClientVersion` to `1.8.3` once both stores serve it.

**Links that stop working, and why that is accepted.** `?space=FSSS:<campus>` on
`/api/public/associations` and `/api/public/carte` answers the typed 400 `PUBLIC_SPACE_INVALID`: the
one consumer, the portail-etu showcase, names `ICM:saint-etienne`. A legacy `sig` agenda link of an
FSSS pair ([legacy-compatibility](../legacy-compatibility.md)) answers a 400 (`Unknown formation`,
`parseSpaceSelection`); its holder subscribes again and gets a token link. No shim either way: a
second spelling accepted for ever is the fallback the rules refuse, for a population of a few links. A token link is rewritten by 187 and keeps serving.
