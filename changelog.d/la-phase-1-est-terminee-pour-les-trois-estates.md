### Changed - la phase 1 est terminee pour les trois estates

Le runner et le crontab de l'ancienne boite ont bascule le 2026-09-24 : le runner `canari` de la
cible repond `online`, celui du depot sur l'ancienne boite `offline`, et son crontab est vide. Les
trois lignes qu'il portait tournent desormais depuis la cible sous `gha-runner`. La phase 2, non
reversible, est ouverte et cadree par l'utilisateur a `canari-emse.fr` -> `canari.emse.fr` seul
([estate-migration](docs/wiki/infrastructure/estate-migration.md#10-the-ordered-list---written-2026-09-24-data-and-traffic-now-done-for-all-three-estates)).
