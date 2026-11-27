# Mino access: who may enter the wiki, and who may do what on it

`mino.emse.fr` (Wiki.js, the application `mino-wiki`) signs in through MiConnect (Authentik). Access
is managed in ONE place: **Authentik groups**, mapped to a role on the wiki (administrator, editor,
student or guest). The archives (`archives.canari-emse.fr`, Omeka S) are retired: Omeka stopped on
2026-11-22, its content now in the wiki, and MiConnect's objects go on 2026-11-27 ([below](#archives-mino-is-retired-2026-11-27)).

The configuration, the local patch of the OIDC module, the traps found and the state of each
platform are operating notes for products that are not Canari, and are kept in the operators'
private notes. Two rules survive here: group names on the Wiki.js side must match the claim, and a
private media must never be reachable by its direct URL (check the file route, not only the page).

## Who may enter: the same cotisant gate as MiGallery and Le Cercle (owner, 2026-11-27)

MinoWiki is gated EXACTLY like MiGallery and Le Cercle (D42-D43,
[profiles-and-access](../profiles-and-access.md)): the application `mino-wiki` carries the SAME
expression policy `miconnect-access-window-post-or-cotisant` (one policy for the three sites, never a
copy), a group of its own `acces-mino-wiki` (the nominative exception an admin grants), and
`policy_engine_mode: any`, in `60-applications.yaml`. A person enters within five years of their entry
year, with a post (EMSE, ME, ALUMNI), as an Alumni cotisant read this calendar year, as a member of
`acces-mino-wiki`, or **as a member of a `mino-*` group**.

- **The wiki's own roles pass the gate** (lead, 2026-11-27, from the adversarial review). The wiki's
  administrators and editors are the members of the `mino-*` groups (created by hand in production,
  sent to the wiki in the claim `minoGroups`). `acces-mino-wiki` is created EMPTY, so without more one
  of them past the window, with no post and no contribution, would have been locked out of the wiki
  they run on the day the stable applied. A THIRD binding, the expression policy
  `miconnect-mino-wiki-roles` (order 2), admits a person with a DIRECT group named `mino-*` - the same
  predicate as the claim, so whoever the wiki gives a role to can reach it. Deterministic, no hand
  step, and no group named in this public file. It is not a copy of the gate's rule, which stays ONE
  policy; it says nothing when it refuses, so a refused person reads the gate's message.

- **What a refused person sees.** The gate decides at `/application/o/authorize/`, before any page of
  the wiki: authentik's own "access denied" page, carrying the policy's message, *"Après tes cinq
  premières années, ce service est réservé aux cotisants de l'association des Alumni. Si tu as cotisé
  cette année, connecte-toi une fois à MiConnect avec ton compte Alumni pour qu'il le sache."* It says
  "ce service", so it is true of the wiki as written: no new text, and no Canari string (Canari opens
  no link to the wiki, and its sign-in handoff does not serve it).
- **No refresh grant.** authentik's refresh grant evaluates no application binding, so the provider
  `miconnect-mino-wiki` lists `authorization_code` alone since the same change, as every gated provider
  must ([authentik](authentik.md#the-refresh-grant-is-closed-on-gated-providers-181)). Nothing is lost:
  it carries no `offline_access` mapping, so no refresh token could be minted before either.
- **core-service's handoff gate does NOT recognise the wiki's shape** (three bindings): its allowlist
  (`ALUMNI_GATED_APPLICATIONS`) stays MiGallery and Le Cercle, and a mint for the wiki would be refused
  `policy_bound` - the safe direction, and moot, since the wiki is in no handoff registry
  (`handoff-access.spec.ts` asserts that refusal).
- **Tests:** `test-consent-flow.py` runs every case of `libs/contracts/alumni-access.json` on the
  three applications through authentik's policy engine, and proves a `mino-*` member past the window
  enters the wiki and neither of the two others, while a group that merely contains `mino` admits
  nobody; `test-refresh-gate.py` requires the wiki among the gated providers.

## Archives MINO is retired (2026-11-27)

The owner retired Archives MINO (Omeka S, application slug `archives`, provider `miconnect-archives`):
its content now lives in MinoWiki, and Omeka itself has been gone since 2026-11-22 (what answers on its
name is a container that redirects `301`). **An entry merely removed from a blueprint deletes nothing
in authentik**, so the blueprints carry `state: absent` entries, applied by the next stable like any
other:

| Object | Where | Effect |
| --- | --- | --- |
| application `archives` | `60-applications.yaml` | `state: absent`: deleted, with its tile |
| OAuth2 provider `miconnect-archives` | `50-providers.yaml` | `state: absent`: deleted, so its client id and secret stop working |
| redirect stage `miconnect-logout-redirect-archives` | `40-authentication.yaml` | RENAMED in place to `miconnect-logout-redirect-mino`, its target `https://mino.emse.fr/` |

**MinoWiki's sign-out depended on the archives' name.** The provider `miconnect-mino-wiki` signs out
through the flow `miconnect-invalidation-mino`, whose ONE stage (order 10) redirected to
`archives.canari-emse.fr/s/memoires-des-mines/`: signing out of the WIKI ended on the archives. The
stage is renamed by the repository's rename shape (an entry found by its PK while the old name exists,
then the entry that describes it by the new name), so the SAME object, and the binding that points at
it, are kept and repointed. A new name in `identifiers` alone would have created a second stage and a
second binding at order 10 beside the old one. `test-blueprints.sh` asserts after the apply that the
application and the provider are gone, no object carries the archives name, and the flow runs exactly
that one stage with that target; its upgraded leg (main's blueprints first) is the one that proves the
deletion and the rename on an instance that had them.

**The removal order:**

1. **The stable applies these blueprints** (`apply-blueprints.sh apply`, no hand step on MiConnect):
   MinoWiki's sign-out returns to the wiki, the application `archives` and its provider are absent.
2. **Then** the operators remove the `301` container and the tunnel route of `archives.canari-emse.fr`
   (private notes). Not before: until the stable, MinoWiki's sign-out still lands on that name.

The MiConnect terms (`/legal/miconnect`) were revised the same day: the archives are gone from them and
the cotisant rule names the wiki. A minor revision, so nobody is asked to accept again (owner,
[decisions](../decisions/owner-decisions-of-2026-11-27.md)).

## The provider's callbacks follow the wiki's version (2026-11-13)

`infrastructure/authentik/blueprints/50-providers.yaml` is what every STABLE deploy writes to the
production identity provider (`serve-prod.yml`, `apply-blueprints.sh apply`), so a callback changed by
hand on the live provider is overwritten at the next stable. Wiki.js 3 calls back on
`/_api/auth/<strategy id>/callback` and returns to the site root after a sign-out; when MinoWiki moved
to it on 2026-11-13 the live provider was edited but the blueprint still named the Wiki.js 2 callbacks,
and the `1.6.11` deploy put them back: `mino.emse.fr`'s sign-in answered 400 until they were restored.
**Changing a callback is a pull request on that file**, never only an edit in the admin interface.

The same apply also detached `miconnect-claim-mino-groups` (claim `minoGroups`, created by hand in
production for Wiki.js 3) from the provider, since the blueprint's `property_mappings` list did not
name it: the wiki received no group and its admins lost their rights. The mapping now lives in
`10-mappings.yaml` (copied from production) and the provider's list names it.
