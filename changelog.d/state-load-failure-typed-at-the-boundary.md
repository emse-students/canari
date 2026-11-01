### Changed - a failed MLS state load is classified by type, never by its message

`initialiser_mls` and the WASM client constructor now reject with `{ code, message }`, typed at the boundary; the web's v2 opener throws the type itself, and `classifyStateLoadFailure` no longer matches any text ([mls-protocol](docs/wiki/protocols/mls-protocol.md#failing-to-load-a-saved-state)).

A hardening of the recovery contract, with no behaviour change observed in production (the one caller already passes `noFreshStart` whenever a state exists): an untyped failure or a keystore refusal never rotates the device identity, whatever the caller passes. A cancelled biometric sheet and an old-PIN refusal no longer warn natively.
