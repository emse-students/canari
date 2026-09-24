### Fixed - le plafond d'envoi vient du serveur, et non plus du build

Le client refusait a 100 Mo (`VITE_MEDIA_MAX_SIZE_MB`, fige au BUILD et ecrit par aucun job CI)
pendant que les deux estates tournent a `MEDIA_MAX_SIZE_MB=50` : une video de 90 Mo montait en
entier avant d'etre refusee. `GET /api/media/limits` publie desormais le chiffre, le client le
demande une fois par origine, et le tag AES-GCM de 16 octets est compte du bon cote.
[media-service](docs/wiki/services/media-service.md)
