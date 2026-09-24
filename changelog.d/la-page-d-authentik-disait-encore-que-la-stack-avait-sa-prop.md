### Fixed - la page d Authentik disait encore que la stack avait sa propre VM

Elle a demenage le matin meme. Corrige avec ce qui en decoule : l ancienne VM garde une copie
FIGEE et un relais, la derive entre ce depot et la machine est fermee, et la ligne "prendre un
dump a la main" de la table due a l utilisateur est retiree - c est fait, et la commande qu elle
donnait viserait desormais la base morte. [authentik](infrastructure/authentik/README.md).
