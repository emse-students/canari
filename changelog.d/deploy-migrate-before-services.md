### Fixed - a deploy migrates the database before the services restart

Production logged `relation "spaces" does not exist` for a second during the 1.1.0 deploy: services started on the old schema. Only postgres comes up first now, then the migrations, then the rest ([cicd](docs/wiki/cicd.md)).
