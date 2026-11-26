## P2 - The Alumni merge, MiConnect side: the merge's Event survives, is pushed to Canari, and a manual mark is honoured

target: 1.8.3

The design is D54, D55 and D57 in [profiles-and-access](../profiles-and-access.md#the-alumni-merge-extended-d52-d58-planned-for-183).
Nothing built. In `infrastructure/authentik/blueprints/30-sources.yaml` (`miconnect-alumni-merge-or-refuse`),
`80-profile-editor.yaml` (the write flow's allowlist) and a new notification blueprint.

**The defect (P2, traceability, shipped in `1.8.0`)**: a merge completed in production on 2026-11-26
and no `custom_alumni_merge` Event exists. The policy journals through `Event.from_http`, which sets
the Event's user to the flow's PENDING user, the duplicate; the duplicate's deletion then fires
authentik's `event_user_pre_delete_cleanup`, and with `gdpr_compliance` on, `gdpr_cleanup` deletes
every Event of that user - the merge's line included (read in the running 2026.8.6 image).

What it builds:

- **D57**: the merge Event built without `from_http`, user = the target, client address from
  `ClientIPMiddleware.get_client_ip`, context adding `duplicate_uuid`, `target_uuid`, `mode`,
  `merge_id`; one save. `gdpr_compliance` stays on.
- **D54**: an expression policy passing `custom_alumni_merge` only; a Notification Rule
  (`destination_event_user`, bound to it) with a webhook transport (`send_once`) to Canari's
  `/api/hooks/miconnect/alumni-merge`, a body mapping `{ duplicateUuid, targetUuid, mergeId }` and a
  header mapping carrying `MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET` (`!Env`, `infrastructure/MIGRATION.md`).
- **D55**: the mark's four new keys in the write flow's allowlist; for `manual`, the name rule becomes
  `alumni_name_changed` and `target_changed`; `manual_mark_incomplete`, `mark_mode_unknown`.

The tests that prove it:

- `test-enrollment-flow.py` step M: after a merge, EXACTLY ONE Event `custom_alumni_merge` exists,
  its user is the target, its context names both uuids - asserted AFTER `gdpr_cleanup` ran for the
  duplicate's pk (called synchronously, so the test does not wait on the worker); a stub HTTP
  receiver in the CI stack gets exactly one POST carrying the duplicate's uuid and the secret, and none
  after a refusal; the manual mark merges despite a different name, and is refused when the asserted
  name or the target's name differs from what the admin saw, and when a key is missing.
- `test-profile-editor.py`: the token writes the four new keys and still nothing else.
- `test-blueprints.sh`: the rule, its one policy, the transport (`send_once`, webhook URL), the
  tenant's `gdpr_compliance` still `true`.
