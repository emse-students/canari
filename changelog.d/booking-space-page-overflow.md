### Fixed - the page of a bookable space no longer spills past a phone's right edge, and a free day reads 00:00 - 23:59

The booker's grid sized its single phone column by its widest unbreakable text (a truncated name in "Vos réservations ici"), so the whole week was wider than the screen; the column is now `minmax(0,1fr)`. An end at the following midnight is shown as 23:59, a label only ([design-reference](docs/wiki/frontend/design-reference.md)).
