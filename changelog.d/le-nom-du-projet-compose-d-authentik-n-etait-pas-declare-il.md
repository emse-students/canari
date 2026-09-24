### Fixed - le nom du projet compose d Authentik n etait pas declare, il etait deduit du dossier

Sans `name:`, Compose prend le nom du dossier, et le volume avec. La stack n a survecu au
demenagement que parce que les deux chemins finissaient par `miconnect` : une restauration dans
un dossier nomme autrement serait remontee sur une base VIDE, saine, en laissant toutes les
identites dans un volume que plus personne ne lit. Declare des deux cotes, verifie par
`--dry-run` (`Running`/`Healthy`, aucune recreation). Le Cercle, lui, declarait deja le sien -
la section 10 du plan disait le contraire et elle est corrigee.
[estate-migration](docs/wiki/infrastructure/estate-migration.md).
