# Performance bench - what one MLS checkpoint costs, part by part

**What it answers:** on a state shaped like a heavy account (N groups of 44 leaves, 10 past epochs,
3 senders whose ratchets moved), how long ONE encrypted checkpoint takes after ONE application
message, split into the WASM export (`save_state`), the copy, the ChaCha20-Poly1305 seal and the
IndexedDB put. The app writes such a checkpoint after every drain
([performance-audit-2026-10-12](../../docs/wiki/frontend/performance-audit-2026-10-12.md)).

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
