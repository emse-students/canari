### Changed - "@Prenom NOM" finds someone, in either order and without accents, and the @ answers at once on a large population

The mention query may hold spaces while somebody still matches it; names are folded once per picker instead of per keystroke (5,000 people: about 25 ms down to under 4 ms a key), and the name search runs one request at a time with no 250 ms wait, an earlier answer dropped ([chat](docs/wiki/frontend/modules/chat.md)).
