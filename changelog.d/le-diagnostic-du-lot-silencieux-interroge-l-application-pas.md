### Fixed - le diagnostic du lot silencieux interroge l'application, pas le document

La ligne qui signale un lot ayant ajoute des messages pendant que l'application etait absente sans
rien lever - le seul etat que rien d'autre ne distingue du dehors, entre "que des messages a soi" et
"un vrai message perdu par un predicat" - etait gardee par `document.visibilityState !== 'visible'`.
Cette expression est en permanence fausse dans une WebView Tauri Android en arriere-plan, donc la
ligne ne s'imprimait **jamais** sur mobile : un rapport absent, pas un rapport trompeur, sur la
plateforme ou un rattrapage est le cas courant. Le predicat correct etait deja deux fois dans le
meme fichier ([backlog](docs/wiki/backlog.md)).
