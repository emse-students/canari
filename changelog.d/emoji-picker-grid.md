### Changed - le selecteur d'emojis est une grille maison, dessinee avec les images Noto

emoji-picker-element dessinait avec une police, donc en Apple sur WebKit : il est remplace par
une grille sur le meme jeu de donnees, avec recherche tolerante (le contrat de recherche) et un
ton de peau memorise. Les emojis les plus recents ne dependent plus de la version d'Unicode du
navigateur ([emoji](docs/wiki/frontend/emoji.md)).
