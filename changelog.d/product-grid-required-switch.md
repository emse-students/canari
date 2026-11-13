### Changed - each priced grid has its own "Obligatoire" switch, off by default; no rule spans the order

A grid switched on demands one unit of its own, held on its card; the rule over the whole order is
gone, so a form whose grids are all optional is sent with no article. Migration 164 turns every stored
grid off ([forms](docs/wiki/frontend/modules/forms.md), [legacy](docs/wiki/legacy-compatibility.md)).
