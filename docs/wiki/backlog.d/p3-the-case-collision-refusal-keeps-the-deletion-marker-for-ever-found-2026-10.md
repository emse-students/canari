## P3 - The case-collision refusal keeps the deletion marker for ever (found 2026-10-18, fourth review of #2023)

target: 1.8.0

**Re-read 2026-11-11: unchanged** (`accountLocalWipe.ts`, "a human must decide").
`wipeDeletedAccountLocalData` refuses an id that differs from another stored id only by letter case and keeps the wipe OWED, reported once per start, "until a human looks" - but nothing ever asks a human, so the marker lives until the subject signs in again. It was the main precondition of scenario A of that review (a resume wiping the NEW account), now closed by the callback dropping the marker and every login refusing a deleted account; what is left is an owed wipe that never completes and is never surfaced. **Owed**: a decision on what a collision does (wipe the parts not shared by case, and surface the rest to the user), and a test ([auth](../frontend/modules/auth.md#an-account-deletion-wipes-that-accounts-local-database-and-vault-slot-wp-del-local-2026-10-18)).
