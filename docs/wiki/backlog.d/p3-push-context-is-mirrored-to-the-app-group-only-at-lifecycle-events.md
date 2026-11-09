## P3 - `push_context.json` follows every edit into the App Group: built, one reading owed

It was copied to the App Group only at activation and resignation, so an account switch in the
foreground followed by a foreground kill paired account B's state with A's push context. Since
2026-11-06 every edit goes through `write_push_context_file` (`push.rs`), which copies it under
`PUSH_CONTEXT_LOCK`, and the activation mirror copies it through Rust under the same lock
([mobile](../frontend/mobile.md#the-extensions-copy-of-the-state-follows-every-write-2026-11-05)).

**Owed on the iPhone 12, on any build `>= 1.6.6-alpha.2`:** row R2 of
[device-verification](../device-verification.md#ios-3075-the-ios-follow-ups-of-3075---owed-on-the-iphone-12)
(an account switch in the foreground, a foreground kill, a DM to B). Closes when read.
