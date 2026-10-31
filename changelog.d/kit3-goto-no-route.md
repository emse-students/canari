### Fixed - a link to a page this build lacks leads somewhere again

Under SvelteKit 3 `goto` rejects a path no route matches, so a form's Back, a sign-in's return and a saved form's exit did nothing (or said the sign-in failed); destinations built by code are now typed against the route table and the rest are matched first and loaded as a document when no route has them ([architecture](docs/wiki/frontend/architecture.md#a-path-no-route-matches---apppath-for-code-gotoapppath-for-the-rest)).
