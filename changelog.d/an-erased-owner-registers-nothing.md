### Fixed - an upload finishing after the account erasure no longer keeps the erased owner

media-service now records the erasure (a digest of the id, kept 24 h after the latest pass) before it deletes, and every path that registers an object refuses that owner with `410 OWNER_ERASED`, deleting what it had stored ([media-service](docs/wiki/services/media-service.md#an-erased-owner-registers-nothing-2026-11-24)).
