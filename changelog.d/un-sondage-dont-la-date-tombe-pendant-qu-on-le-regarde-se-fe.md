### Fixed - un sondage dont la date tombe pendant qu'on le regarde se ferme enfin tout seul

`Date.now()` n'est pas reactif : la fermeture etait vraie de l'instant ou la carte avait ete
dessinee et rien ne la rejouait, donc le formulaire de vote restait ouvert et le tap suivant
prenait un 403 - apprendre par l'echec ce qu'un fait disait deja, `endsAt` etant dans la charge
utile. UN seul `setTimeout` par carte, pose sur la plus proche echeance encore devant, calcule
depuis la date que le SERVEUR a envoyee ; le basculement est a sens unique et n'ajoute jamais
que de la fermeture. Les deux fonctions pures prennent l'instant en PARAMETRE, donc aucun test
ne lit une horloge.
[posts](docs/wiki/frontend/modules/posts.md#a-deadline-that-arrives-while-the-card-is-on-screen-2026-09-24)
