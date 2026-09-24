### Fixed - le nom pointe deja sur l'hote cible, et la moitie des questions posees n'existait pas

"ne sera pas reaffecte" a ete lu comme "on ne nous donnera pas ce nom" au lieu de "ce nom ne bougera
pas", et quatre questions ont ete construites dessus - nouveau nom de prod, issuer OIDC, deep links,
deux fiches de store. Mesure : `canari.emse.fr` resout deja vers l'hote cible sur SA propre adresse,
avec un certificat deja emis par l'ecole, et sert simplement le mauvais `root`. Il ne reste qu'un
vhost nginx. La regle qui en sort : c'est la lecture qui AGRANDIT le travail qui doit la sonde.
[estate-migration](docs/wiki/infrastructure/estate-migration.md), [durable-rules](docs/wiki/durable-rules.md).
