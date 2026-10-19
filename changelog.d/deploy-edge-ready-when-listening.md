### Fixed - a deploy no longer believes the edge before it listens

The edge gets a healthcheck on its listener, so a deploy (and the flaky `deploy-rolling` CI case it broke 3 times in 62) waits for port 80 to be open; the first deploy carrying it recreates the edge once ([cicd](docs/wiki/cicd.md#the-edge-is-ready-when-it-listens-not-when-it-runs)).
