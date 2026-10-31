### Security - glob 14 and minimatch 11 in the four NestJS services and the frontend

The `glob` override moves to `^14.0.2` and `minimatch` gains one at `^11.0.1`, clearing GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249, which every audit refused; both reach only build and test tooling (`protobufjs-cli` in the frontend, which calls only `glob.sync` and `glob.hasMagic`) ([cicd](docs/wiki/cicd.md)).
