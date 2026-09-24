### Changed - le port refuse bloque la porte interne, pas la migration, et l'ancienne machine peut relayer

La parade proposee la veille remettait Cloudflare dans le chemin public, ce que la section 4 du plan
interdit depuis le 2026-09-23 : elle est marquee REFUTEE plutot que supprimee. La relecture deplace
le blocage - le public n'a jamais eu besoin du 7844 puisqu'il n'a jamais eu besoin de Cloudflare.
Mesure ensuite : l'ancienne machine joint l'hote cible et joint l'edge, elle relaie deja SSH, et
l'hote voit son adresse PRIVEE preservee - de quoi epingler une regle sur une adresse non routable.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
