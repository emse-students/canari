### Changed - miconnect prepare, et Authentik tient dans un dixieme de sa VM

Aucun pipeline ne deploie cette stack, contrairement a ce que son README decrivait; son compose de
reference etait epingle six versions en arriere de ce qui tourne. Les deux sont corriges, et la
stack a ete montee a vide sur l'hote cible puis redescendue : 907 Mo pour les trois conteneurs,
sante a 200 sur la loopback, refusee depuis l'IP publique, et la liaison loopback s'obtient par le
`.env` sans toucher au compose.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
