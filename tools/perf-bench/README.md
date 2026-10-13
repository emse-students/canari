# Performance bench - what one MLS checkpoint costs, part by part

**What it answers:** on a state shaped like a heavy account (N groups of 44 leaves, 10 past epochs,
3 senders whose ratchets moved), how long ONE encrypted checkpoint takes after ONE application
message, split into the WASM export (`save_state`), the copy, the seal and the IndexedDB put - for
BOTH at-rest formats: the unframed legacy blob every web client writes today (WASM
ChaCha20-Poly1305 - the output's `v1` columns, which are NOT the framed `state_blob` v1) and v2 (the app's own WebCrypto
`mlsStateSeal.ts`, which `serve.ts` transpiles per request), with the main thread's longest stall
during the v2 seal and what loading each format costs at cold start. The app writes such a
checkpoint after every drain
([performance-audit-2026-10-12](../../docs/wiki/frontend/performance-audit-2026-10-12.md#the-webcrypto-seal-v2---measured-2026-10-12)).

```sh
cd frontend && bun run generate && cd ..       # the WASM the app ships
bun tools/perf-bench/serve.ts                  # then open http://localhost:5199/
```

On a phone: `adb reverse tcp:5199 tcp:5199` and open the same URL in its Chrome. The page prints a
table and keeps it on `window.__bench`. The native half of the same question, with no browser:

```sh
cd frontend/mls-core && cargo test --release --test heavy_state_checkpoint -- --ignored --nocapture
```

Every figure is a FLOOR for a real device: synthetic groups hold less ratchet history than a phone
that has lived (see `frontend/mls-core/tests/state_weight.rs`).
