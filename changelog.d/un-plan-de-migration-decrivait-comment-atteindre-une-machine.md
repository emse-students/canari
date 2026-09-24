### Security - un plan de migration decrivait comment atteindre une machine qu'on ne possede pas

Leon a demande pourquoi un login etait ecrit en dur dans le plan de migration. Il y avait plus que
ca : le compte utilise sur l'hote partage de la DSI, un second compte a cote, lequel des deux
detenait `docker`, les fichiers de cles d'un poste et le second facteur qui en avait ete retire -
une carte d'acces vers la machine d'un tiers, dans un depot PUBLIC. Le scan de secrets ne pouvait
pas le voir : il authentifie les credentials candidats, et un login n'en est pas un. Tout est parti
en memoire locale, la page ne garde que les consequences, et la regle existante a ete elargie -
elle ne nommait que les mesures de production. La reprise a trouve le defaut que le premier cachait :
la copie publique affirmait encore que les droits n'avaient pas suivi le compte, faux depuis le
2026-09-23.
[durable-rules](docs/wiki/durable-rules.md), [estate-migration](docs/wiki/infrastructure/estate-migration.md).
