### Added - quel conteneur publie quoi, et un port que Canari ne pourra pas garder

La table de loopback de la cible disait ce qui etait pris, jamais ce qui etait demande. Mesure des
quatre machines : la pile de production Canari n'expose qu'UN port sur le chemin public, et c'est
`8080`, deja tenu sur la cible par un agent que ce projet n'administre pas. Deux points restent
ouverts, le `9443` d'Authentik et la paire publiee par garage.
[estate-migration](docs/wiki/infrastructure/estate-migration.md#5-the-target-shape-and-the-one-thing-it-forces).
