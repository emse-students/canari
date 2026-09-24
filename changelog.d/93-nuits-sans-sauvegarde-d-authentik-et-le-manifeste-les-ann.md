### Fixed - 93 nuits sans sauvegarde d'Authentik, et le manifeste les annoncait quand meme

La stack Authentik a pris sa propre VM le 2026-06-22 ; `backup.sh` la cherchait toujours sur la
machine applicative, ne la trouvait plus, ecrivait un WARN et continuait - une source configuree et
injoignable etait traitee comme une exclusion. Aucune archive du 2026-06-23 au 2026-09-23 ne
contient `authentik_db.sql.gz`, et le `MANIFEST.txt`, texte constant, l'a promis chaque nuit. La
sauvegarde atteint desormais la boite par SSH avec une cle a commande forcee qui ne sait que lire,
echoue si la source est injoignable, et derive son manifeste des fichiers reellement produits.
[backup](infrastructure/backup/README.md), [authentik](infrastructure/authentik/README.md).
