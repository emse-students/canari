### Changed - la question des certificats ne bloque plus, et la demande DSI est ecrite

Les deux certificats que l'ecole sert deja portent UN SEUL nom chacun, emis par GEANT TCS pour ~6,5
mois : un certificat par nom, aucun ACME, donc rien ici ne peut renouveler. `canari.emse.fr` est
vivant, sert le Portail Etudiant ICM depuis une AUTRE machine que portail-etu.emse.fr, et son
certificat a ete reemis le 22/09 - la reaffectation demandee prend un nom a un site qui tourne. La
demande DSI est desormais ecrite mot pour mot, la question du certificat en moins.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
