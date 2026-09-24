### Changed - le balayage de l'estate dit enfin ce qu'il ne regarde PAS

`cleanup.mjs` possede trois magasins - communautes, salons, groupes - et son "nothing to sweep" se
lisait "l'estate est propre" pendant qu'une file de livraison de 13 275 lignes dormait a cote
(2026-09-08). Chaque passage imprime desormais les magasins hors de sa portee avec un compte VIVANT.
Aucun des deux n'est un balayage en attente : re-mesure le 2026-09-24, la file locale tient 4 lignes
d'UN SEUL device vivant, donc une clause detruirait des messages non delivres sans rien gagner.
[README](tools/cross-client-harness/README.md).
