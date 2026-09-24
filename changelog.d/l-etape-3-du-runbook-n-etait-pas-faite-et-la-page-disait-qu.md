### Fixed - l'etape 3 du runbook n'etait pas faite, et la page disait qu'elle l'etait

Mesure sur l'hote : `/srv/le-cercle` existe et est VIDE, et le seul conteneur qui y tourne est celui
de Portail-etu. L'affirmation a survecu parce que le repertoire et le volume de donnees existent tous
les deux, ce qui ressemblait a "pret" vu de loin. Ce que demande vraiment la mise en place est
desormais ecrit, avec l'etat des deux runners, des variables et des droits verifie des deux cotes.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
