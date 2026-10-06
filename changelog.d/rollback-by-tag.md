### Changed - rolling back production is re-running an old release's deploy

Production is deployed by the release's own `v<version>` image tag instead of `latest`, so a rerun puts THAT release back ([cicd](docs/wiki/cicd.md)).
