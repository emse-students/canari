### Fixed - un rebase classait du travail non livre sous une version deja sortie

Toute entree s'ecrit sous `## [Unreleased]`, la ligne exacte ou un bump de version insere
`## [X.Y.Z]` : une branche rebasee par-dessus une release voit donc ses entrees classees sous une
version coupee avant qu'elles existent, par une union sans conflit. `docsMergeArtefacts.test.ts`
assure desormais la forme du fichier - `[Unreleased]` en tete, chaque version nommee une fois,
versions decroissantes - chaque moitie prouvee en reintroduisant l'artefact.
[durable-rules](docs/wiki/durable-rules.md).
