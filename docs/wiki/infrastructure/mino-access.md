# Mino access: who may do what on the wiki and the archives

`mino.emse.fr` (Wiki.js) and `archives.canari-emse.fr` (Omeka S) sign in through MiConnect
(Authentik). Access is managed in ONE place: **Authentik groups**, mapped to a role on each platform
(administrator, editor, student or guest, and one private group per archive collection).

The configuration, the local patch of the OIDC module, the traps found and the state of each
platform are operating notes for products that are not Canari, and are kept in the operators'
private notes. Two rules survive here: group names on the Wiki.js side must match the claim, and a
private media must never be reachable by its direct URL (check the file route, not only the page).

## The provider's callbacks follow the wiki's version (2026-11-13)

`infrastructure/authentik/blueprints/50-providers.yaml` is what every STABLE deploy writes to the
production identity provider (`serve-prod.yml`, `apply-blueprints.sh apply`), so a callback changed by
hand on the live provider is overwritten at the next stable. Wiki.js 3 calls back on
`/_api/auth/<strategy id>/callback` and returns to the site root after a sign-out; when MinoWiki moved
to it on 2026-11-13 the live provider was edited but the blueprint still named the Wiki.js 2 callbacks,
and the `1.6.11` deploy put them back: `mino.emse.fr`'s sign-in answered 400 until they were restored.
**Changing a callback is a pull request on that file**, never only an edit in the admin interface.
