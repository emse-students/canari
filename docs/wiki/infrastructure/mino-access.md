# Mino access: who may do what on the wiki and the archives (2026-10-08)

`mino.emse.fr` (Wiki.js) and `archives.canari-emse.fr` (Omeka S 4.2.0, PHP 8.4) both sign in through
MiConnect (Authentik). Access is managed in ONE place: **Authentik groups**. Both live on `mitv`
(`/opt/mino`, `ssh mitv`).

## The groups, and what each platform does with them

| Authentik group | Wiki.js | Omeka S |
| --- | --- | --- |
| `mino-admin` | `Administrators` | `global_admin` |
| `mino-editeurs` | `Éditeurs` | `editor` |
| (any other account) | `Étudiants` | `guest` |
| `archives-<name>` | - | Group-module group `archives-<name>` (private level) |

Day to day: Authentik admin, `miconnect.emse.fr/if/admin/` -> Directory -> Groups. Canari has no screen
for this and does not need one while the groups stay few.

**Wiki.js** reads the claim `wikiGroups` (a custom scope mapping `miconnect-claim-wiki-groups` on the
`mino-wiki` provider, which translates the groups above into Wiki.js group names). `mapGroups` is on:
at EACH sign-in the user's Wiki.js groups are aligned on the claim, any group absent from it removed.
A claim that is absent changes nothing (`server/models/users.js`).

**Omeka S** has a LOCAL PATCH in `OIDC/src/Controller/OIDCController.php`
(`syncAccessFromGroups`, called after `getUser`): at each sign-in it sets the role from the standard
`groups` claim and aligns the memberships of the `archives-*` groups, creating a group when it does not
exist. **A module update erases it**: re-run `python3 /opt/mino/backups/permissions-2026-10-08/patch_oidc.py <path to OIDCController.php>`
(idempotent; the original is `OIDCController.php.before` in the same folder). New accounts get
`oidc_role = guest`.

## The three levels of an archive document

Modules Common 3.4.93, Group 3.4.8, Guest 3.4.44 and Access 3.4.48 are installed (all constraints
`^4`). Guests have no admin area.

| Level | How to set it | Anonymous | Any signed-in account | Member of the group |
| --- | --- | --- | --- | --- |
| **Public** | item public, access level `free` | everything | everything | everything |
| **Restricted** | item public, file level `reserved` (Access, advanced tab of the media) | title, placeholder PDF | the real PDF | the real PDF |
| **Private** | item (and media) private + the group `archives-<name>` on the item | 404 | 404 | item and PDF |

`access_modes = ["auth_any"]`: any signed-in account opens `reserved` files. Visibility (public/private)
and access level are evaluated separately. Individuals are put in a private level by a group of one.

## Traps found

- **Before 2026-10-08 the PDFs were not protected at all**: a private media answered `200` to anyone
  holding its direct URL. The rule `RewriteRule "^files/(original|large)/(.*)$" "access/files/$1/$2"`
  in `/srv/.../mino/omeka.htaccess` (line 4, BEFORE the file-exists rule) closes it. It is a
  single-file bind mount: edit it in place (`python open(p, "w")`), never `sed -i`.
- The Guest module forces an accept-terms redirect; `guest_terms_skip=true`, `guest_terms_force_agree=false`.
- `researcher` does NOT see private resources (only `reviewer` and above have `view-all`); `author`
  sees only its own.
- The email claim is `<username>@canari.emse.fr`: the `@rootz-emse.fr` accounts are LOCAL break-glass
  accounts, untouched by the sync.
- Modules install as an admin through `Omeka\ModuleManager`, in TWO PHP processes (Common first).
- Wiki.js group names must match the claim: do not rename `Administrators`, `Éditeurs`, `Étudiants`.

## State on 2026-10-08

Seven documents, all media private, no status: nothing is public yet. Item 2 (an empty duplicate of
item 14) was deleted. Backups: `/opt/mino/backups/permissions-2026-10-08/`. The sandbox
`/opt/mino-test` (port 18081, localhost) is a throwaway copy and can be removed.
