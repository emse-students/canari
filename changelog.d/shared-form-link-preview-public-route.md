### Fixed - a shared form's link preview carries the form's title, description and image

The server-side preview read the member route, which answered 401 to the renderer, so every shared form link showed the generic card. It now reads the public route, which serves public forms only ([seo](docs/wiki/frontend/seo.md)).
