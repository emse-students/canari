### Fixed - an upload finishing after the account erasure no longer keeps the erased owner

media-service now records the erasure (a keyed pseudonym of the id and the time of the latest pass, kept 24 h) before it deletes, and every path that registers an object refuses a credential or session from before it with `410 OWNER_ERASED`, which the app treats as final, deleting what it had stored; a person who signs in again is not refused ([media-service](docs/wiki/services/media-service.md#an-erased-owner-registers-nothing-2026-11-24)).
