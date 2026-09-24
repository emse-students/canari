### Fixed - BEGIN IMMEDIATE ne prouve rien, et l'endpoint de sante avait raison

L'entree precedente disait que `/api/health` repondait `ok` sur une base impossible a ecrire. Le
journal du conteneur la refute en une ligne : il a signale la panne trois secondes apres le
demarrage et renvoye 503. La sonde proposee etait fausse aussi - mesuree contre une reproduction,
`BEGIN IMMEDIATE` passe sur une connexion en lecture seule. Seule une ecriture reelle dans la
transaction refuse. [durable-rules](docs/wiki/durable-rules.md).
