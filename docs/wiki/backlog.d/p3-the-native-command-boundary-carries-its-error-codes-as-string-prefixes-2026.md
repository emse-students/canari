## P3 - The native command boundary carries its error codes as string prefixes (2026-10-28)

target: 1.10.0

Tauri can serialise an error object instead of a string: one `{ code, message }` type, decoded into
typed errors at the one `invoke` boundary. The 2026-10-28 decision moved every code in one pull
request; **the owner amended it on 2026-10-29 (amended, the entry stays open): two steps, each
separately reviewed.**

- **Step 1 - PR #2596:** the `STATE_*` load codes and `KEYSTORE_KEY_UNAVAILABLE`, the ones that unblock
  CORRUPT-1/2 (a damaged state called a PIN rotation).
- **Step 2 - its own MLS-critical pull request, NOT BUILT:** everything still carried as a string
  prefix. `MLS_MANAGER_ABSENT` (81 call sites through `live_manager` / `live_manager_mut` in `state.rs`,
  across `commands/mls.rs`, `storage.rs`, `concurrency.rs`, `mobile/background.rs`,
  `mobile/key_group_join.rs`; read by `isMlsManagerAbsent`); `EVICTED:` and `ALREADY_MEMBER:` (the
  `MlsError` Display in `mls-core/src/lib.rs`, crossing both Tauri and WASM, read in
  `mlsDecryptError.ts`, `mlsSendError.ts` and `utils/chat/actions.ts`); `GAP_QUEUED:`,
  `GAP_DB_INSERT_FAILED:` and `UNRECOVERABLE:` (the decrypt commands in `commands/mls.rs`).
  **The riskiest part is the decode order:** `classifyIncomingDecryptError` depends on the ORDER of the
  markers it tests and drives re-add and heal decisions, so a typed decode must reproduce that order
  exactly, with a test per marker pair, before any code moves.
- **The interim has TWO conventions, deliberately:** typed `{ code, message }` for step 1's codes,
  string prefixes for step 2's. Each reader knows which shape its code has. **It ends when step 2 is
  merged**, and not before.

([mls-protocol](../protocols/mls-protocol.md#the-native-manager-does-not-outlive-its-account-2026-10-27)).

**Brief for an agent (batch 15, 2026-11-12; MLS and native - opus, adversarial review before each merge, every PR born `--draft`).** Step 2 only, one pull request. Before moving any code: a test per marker PAIR of `classifyIncomingDecryptError` pinning today's decode order (`mlsDecryptError.ts`), green on main. Then move `MLS_MANAGER_ABSENT`, `EVICTED:`, `ALREADY_MEMBER:`, `GAP_QUEUED:`, `GAP_DB_INSERT_FAILED:` and `UNRECOVERABLE:` to the typed `{ code, message }` of step 1, on BOTH crossings (Tauri and WASM, the `MlsError` Display in `mls-core/src/lib.rs`), decoded at the one `invoke` boundary; delete `isMlsManagerAbsent`'s prefix read and every `startsWith` on these markers. The interim two-convention note is deleted with it.
