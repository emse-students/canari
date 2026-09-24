### Fixed - ce sont trois conteneurs LXC, pas trois VM, et la question de capacite a une reponse

`systemd-detect-virt` repond `lxc` sur les trois. Le signe qui a declenche la verification : leur
`/proc/loadavg` est identique a deux decimales et bouge ensemble, la charge n'etant pas cloisonnee.
Les chiffres du plan sont donc de l'allocation, pas du materiel. Mesure : 8 vCPU et 20 G alloues,
environ 2 G reellement residents ; la cible offre 11 G dont 10 libres. La question d'arbitrage que la
section 9 disait indecidable l'est - mais c'est une lecture au repos, pas une preuve de marge.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
