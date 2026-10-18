### Changed - the rig's sign-in answers the MiConnect terms page

`login.mjs` recognises the terms page that blueprint `45-consent.yaml` will add after the password and ticks its one box, so a harness login no longer stalls on it; the stage logic moved to `tools/cross-client-harness/idpform.mjs` with a self-test ([backlog](docs/wiki/backlog.md#p1---the-miconnect-terms-stage-reaches-production-with-the-next-stable-three-things-come-first-2026-10-16)).
