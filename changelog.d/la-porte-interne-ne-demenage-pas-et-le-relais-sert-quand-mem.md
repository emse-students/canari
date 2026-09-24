### Changed - la porte interne ne demenage pas, et le relais sert quand meme: la phase 1 en depend

Decision de l'utilisateur : dev et les interfaces d'admin restent sur l'ancienne VM, dont le tunnel
marche deja ; la nouvelle machine ne porte que la production, et le connecteur installe la-bas a ete
SUPPRIME le jour meme. Mais le tunnel avait un SECOND consommateur : toute la phase 1 passe par lui
(l'etape 4 pointe son ingress, le rollback le repointe). Conclure du premier que le relais etait
inutile etait faux, et corrige le jour meme. Le relais reste donc, cote ANCIENNE VM - et ce n'est pas
un mecanisme neuf : mesure, l'ingress de prod nomme DEJA une adresse distante, la VM qui sert cercle
n'ayant aucun connecteur. Ce qui change au deplacement n'est pas l'ingress mais l'adresse de
publication, inoffensive sur un reseau prive et exposee aux co-locataires sur l'hote partage.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
