### Changed - a failed MLS state load is classified by type, never by its message

`initialiser_mls` and the WASM client constructor now reject with `{ code, message }`, typed at the boundary; the web's v2 opener throws the type itself, and `classifyStateLoadFailure` no longer matches any text ([mls-protocol](docs/wiki/protocols/mls-protocol.md#failing-to-load-a-saved-state)).
