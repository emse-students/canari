### Security - glob 14 and minimatch 11 in the four NestJS services

The `glob` override moves to `^14.0.2` and `minimatch` gains one at `^11.0.1`, clearing GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249, which every service audit refused; both reach only build and test tooling ([cicd](docs/wiki/cicd.md)).
