### Fixed - the build stamp is computed once per build, so main builds again

#1476 stamped `kit.version.name` at every load of `svelte.config.js`, giving one output two build ids and failing the bundle check in every release build. See [testing-methodology](docs/wiki/testing-methodology.md).
