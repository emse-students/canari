### Fixed - container logs are bounded and survive the deploy that recreates the container

Every service now rotates its log (3 x 10 MB) and the deploy archives each container log before replacing it ([logging](docs/wiki/infrastructure/logging.md)). Takes effect at the next deploy of each estate.
