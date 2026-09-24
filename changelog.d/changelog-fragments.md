### Changed - une entree de changelog est un fichier, et deux PR ne se battent plus pour une ligne

`merge=union` ne servait qu'en local : GitHub ignore les pilotes de fusion de `.gitattributes`, et
toute PR ecrivant sous `[Unreleased]` entrait en conflit avec la voisine. Chaque entree est
desormais un fichier de `changelog.d/`, verse sous sa version par le bump stable
([cicd](docs/wiki/cicd.md), [changelog.d](changelog.d/README.md)).
