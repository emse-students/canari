### Security - le jeton du tunnel Cloudflare se lit sans aucun droit, sur les deux boites de prod

L'unite `cloudflared` porte le jeton sur sa ligne de commande. Elle avait ete passee en `600` apres
une premiere fuite, ce qui ferme `systemctl cat` - mais `systemctl show -p ExecStart` lit l'etat
interne de systemd par D-Bus, qu'aucun mode de fichier ne protege, et rend la ligne entiere a un
compte ordinaire. Mesure sur `canari` et `miconnect` le 2026-09-24. Le jeton doit passer par un
`EnvironmentFile`, et une rotation est due ensuite : elle coupe le chemin public une minute, donc
elle se fait avec l'utilisateur.
[cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md), [backlog](docs/wiki/backlog.md).
