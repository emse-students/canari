### Fixed - MinoWiki sign-in survives a stable deploy

MiConnect's blueprint now carries MinoWiki's Wiki.js 3 callbacks and its `minoGroups` claim. The
`1.6.11` deploy re-applied the Wiki.js 2 callbacks over the live provider, so `mino.emse.fr` refused
sign-ins (400) and the wiki lost its groups until both were restored by hand
([mino-access](docs/wiki/infrastructure/mino-access.md)).
