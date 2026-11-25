### Fixed - the cross-client rig passes the Alumni-link reminder and boots every web seat in French

`login.mjs` now answers the D44 reminder stage (`authentik-continue`) instead of reporting a blank page, and `launch.mjs` starts every seat with `--lang=fr` ([authentik](docs/wiki/infrastructure/authentik.md#the-terms-of-use-are-a-stage-of-the-authorization-flow-2026-10-16)). The Svelte regression note now names 5.58.1 and the upstream issue ([architecture](docs/wiki/frontend/architecture.md)).
