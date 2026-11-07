## P3 - `push_context.json` follows every edit into the App Group: built, one reading owed

It was copied to the App Group only at activation and resignation, so an account switch in the
foreground followed by a foreground kill paired account B's state with A's push context. Since
2026-11-06 every edit goes through `write_push_context_file` (`push.rs`), which copies it under
`PUSH_CONTEXT_LOCK`, and the activation mirror copies it through Rust under the same lock
([mobile](../frontend/mobile.md#the-extensions-copy-of-the-state-follows-every-write-2026-11-05)).

**Owed on the iPhone 12:** sign in as A, switch to B in the foreground, `ios.mjs terminate`, push a DM
to B - the banner carries its text and the extension's `outcome=decrypted`. Closes when read.
