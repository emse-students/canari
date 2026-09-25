### Fixed - un emoji choisi ou colle pouvait ajouter un retour a la ligne indelogeable au message

Le `<br>` que le navigateur laisse en fin de champ (apres un glisser, ou un champ vide) etait lu
comme un vrai retour a la ligne, puis redessine comme tel a chaque emoji
([emoji](docs/wiki/frontend/emoji.md)).
