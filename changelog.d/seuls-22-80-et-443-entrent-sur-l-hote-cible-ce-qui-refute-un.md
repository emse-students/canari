### Fixed - seuls 22, 80 et 443 entrent sur l'hote cible, ce qui refute un mecanisme deja choisi

Les regles disaient le contraire : `DOCKER-USER` est un `RETURN` nu et la chaine `DOCKER` accepte
directement, la forme classique de Docker qui perce le pare-feu. Sonde : le port publie est lu par
l'hote lui-meme (le temoin) et par personne d'autre - ni l'internet, ni les deux anciennes machines
sur le reseau prive. Le filtre est le reseau de l'ecole, pas l'hote. Lier un port et le restreindre a
la source est donc mort, et l'architecture de la section 5 se trouve validee par un pare-feu plutot
que par un argument. La premiere sonde, sans temoin, ne valait rien.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
