### Changed - le tunnel de l'hote cible existe et ne peut pas joindre Cloudflare, et c'est le port 7844

Le connecteur est installe dans la bonne forme des le depart - jeton dans un `EnvironmentFile` 0600,
rien sur `ExecStart` - mais il ne s'enregistre pas. Mesure depuis la machine : le 443 sortant passe,
le 7844 est bloque EN AMONT, en UDP comme en TCP, et la politique de sortie de la machine est
`ACCEPT`. `http2` n'est pas un contournement, il compose le meme 7844. L'unite reste installee et
DESACTIVEE, l'ouverture rejoint la demande DSI, et comme la phase 2 retire Cloudflare de tout chemin
public, sauter le tunnel devient une option a part entiere.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
