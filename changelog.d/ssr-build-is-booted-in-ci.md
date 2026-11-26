### Added - CI boots the server-rendered frontend it builds

The web build was compiled and never started. `checks.sh frontend-build` now starts `build/index.js`, asks it for each kind of page with no backend reachable, and fails on a wrong status or an unsubstituted `/login` head ([cicd](docs/wiki/cicd.md#package-1-opening-a-pull-request-ciyml)).
