### Changed - the dependency audit blocks a pull request and a stable only on what we ship

A picomatch ReDoS with no fixed release froze every pull request through build tools. The pull-request audit and a new stable gate now read each tree's production closure, the nightly keeps the full audit, and picomatch is ignored where an asserted premise shows it unreachable ([cicd](docs/wiki/cicd.md#the-audit-blocks-on-what-we-ship-2026-11-17)).
