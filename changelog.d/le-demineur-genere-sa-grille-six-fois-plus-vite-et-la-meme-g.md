### Changed - le demineur genere sa grille six fois plus vite, et la meme grille

Le solveur enumerait les 2^n combinaisons de chaque bloc de la bordure ; une recherche en
profondeur qui coupe des qu'une equation est impossible, plus une table de voisins, ramene le pire
cas mesure de 1438 ms a 125 ms, sur 1276 grilles toutes identiques. La case cliquee s'affiche
enfoncee pendant l'attente ([minesweeper](docs/wiki/frontend/modules/minesweeper.md)).
