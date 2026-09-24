### Changed - l'entree "un aller-retour origine a chaque boot" n'avait plus de moitie ouverte

Les deux mecanismes sont verifies en place : l'origine annonce `public, max-age=0, s-maxage=60`
(`Dockerfile.frontend`) et `serve-prod.yml` purge la zone apres le health check. Ce qui n'avait pas
encore de maison hors de la file y entre - le couple controle HIT ~54 ms / MISS ~96 ms qui prouve
que le bord SERT, le plafond honnete de ~80 ms plutot qu'un cold start sous la seconde, et la
refutation mesuree du seul argument pour `no-cache` : ici `no-store` ne coute pas le bfcache
([cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md#the-shell-is-cached-at-the-edge-and-nowhere-else-and-the-deploy-says-when-it-expired)).
