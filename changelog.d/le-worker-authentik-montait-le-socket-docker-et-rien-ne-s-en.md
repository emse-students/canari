### Security - le worker Authentik montait le socket Docker, et rien ne s'en servait

Sur sa propre VM c'est contenu ; sur l'hote partage ou cette stack demenage, c'est un controle
equivalent-root sur tout le demon, conteneurs des autres locataires compris. Le seul outpost declare
est l'Embedded Outpost, qui tourne dans le conteneur serveur - verifie en base AVANT de retirer la
ligne. Le port `9443` part aussi : l'ingress du tunnel atteint la stack en clair sur `9000`, lu sur
le connecteur. [authentik](infrastructure/authentik/README.md).
