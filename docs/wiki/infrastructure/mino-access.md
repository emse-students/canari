# Mino access: who may do what on the wiki and the archives

`mino.emse.fr` (Wiki.js) and `archives.canari-emse.fr` (Omeka S) sign in through MiConnect
(Authentik). Access is managed in ONE place: **Authentik groups**, mapped to a role on each platform
(administrator, editor, student or guest, and one private group per archive collection).

The configuration, the local patch of the OIDC module, the traps found and the state of each
platform are operating notes for products that are not Canari, and are kept in the operators'
private notes. Two rules survive here: group names on the Wiki.js side must match the claim, and a
private media must never be reachable by its direct URL (check the file route, not only the page).
