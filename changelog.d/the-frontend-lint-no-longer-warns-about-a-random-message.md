### Fixed - the frontend lint no longer warns about a random, existing message key on every run

`import/namespace` raced on the Paraglide barrel; TypeScript already checks every message key ([development](docs/wiki/development.md#package-manager)).
