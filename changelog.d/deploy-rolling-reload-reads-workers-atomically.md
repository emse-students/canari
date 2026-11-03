### Fixed - a deploy no longer stops on "had no worker to read" when a proxy reload meets a retiring worker

`rolling.sh` read the workers' uid after listing them, from a worker an earlier reload could already have retired, so a reload under load failed the deploy (seen as a CI flake, `deploy-rolling.test.sh`, zero lost requests). Each worker is now read once, whole, and a vanished one is not listed ([cicd](docs/wiki/cicd.md)).
