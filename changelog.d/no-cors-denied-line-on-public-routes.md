### Fixed - the services no longer log `CORS DENIED` for `/api/public/*`, where nginx answers CORS with `*`

A public read from `portail-etu.emse.fr` logged a refusal that never happened; the line is now skipped for the paths nginx owns and still fires on every credentialed route ([nginx](docs/wiki/infrastructure/nginx.md)).
