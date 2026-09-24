### Fixed - le Cercle n'avait aucune sauvegarde programmee

Un audit de la couverture de sauvegarde sur la machine partagee a trouve que la base SQLite de Le
Cercle n'etait sauvegardee qu'a la main, sans planification. `infrastructure/backup/backup.sh`
existe maintenant dans ce depot, sur le meme schema que celui de Canari (VACUUM INTO, manifeste
derive de ce qui est produit, retention locale), deploye sur la cible et planifie sous `gha-runner`
a 04h15. Le miroir offsite reste volontairement non fait pour l'instant
([MR](https://gitlab.emse.fr/aurel.dautry/le-cercle/-/merge_requests/15)).
