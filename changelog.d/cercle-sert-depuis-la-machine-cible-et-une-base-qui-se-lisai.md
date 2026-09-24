### Changed - cercle sert depuis la machine cible, et une base qui se lisait ne s'ecrivait pas

Le nom public passe par un relais sur l'ancienne VM, puisqu'un tunnel ne peut pas sortir de l'hote
cible. Donnees prouvees identiques table par table, empreintes de contenu et non comptes de lignes.
Le defaut trouve au passage : le repertoire du volume appartenait a root, donc SQLite ne pouvait
creer ni WAL ni SHM, et `/api/health` repondait `ok` pendant ce temps parce qu'il ne fait que lire.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
