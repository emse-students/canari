### Fixed - a dialog keeps its rounded bottom corners

The new-post window drew square bottom corners because its action bar painted over the rounded panel; the panel now clips its content to its own corners ([design-reference](docs/wiki/frontend/design-reference.md)).
