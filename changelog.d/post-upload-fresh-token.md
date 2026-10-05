### Fixed - posting or commenting with an image no longer fails as "session expired" after 15 minutes

The post, edit and comment forms uploaded media with a copy of the access token taken when the page opened; each now reads a live one at upload time ([posts](docs/wiki/frontend/modules/posts.md)).
