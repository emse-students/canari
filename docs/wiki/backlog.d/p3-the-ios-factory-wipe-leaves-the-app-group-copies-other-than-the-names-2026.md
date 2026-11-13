## P3 - the iOS factory wipe leaves the App Group copies other than the names (2026-10-19)

target: 1.8.0

**Re-read 2026-11-11: still true, and the list is longer.** On iOS, `wipe_native_app_data`
(`storage.rs`) removes only two things from the App Group: the names copy (`wipe_group_names`) and the
Share Extension's files (`wipe_group_share`). Its own doc comment says the other copies are not its
job. It does not remove these, which the container can hold:
- the account files the deletion sweeps there (`push::extension_account_files`): `push_context.json`
  with its bearer, `fcm_message_cache.ndjson`, the outbox and watermark files;
- the seed mirror's copy (`graine_seeds.json`);
- the device-notice ledger (`device_notices/`).

**Not fixed in the triage, on purpose.** A list of those names would break the durable rule: a total
wipe's allowlist names what SURVIVES, and its default is delete
([durable-rules](../durable-rules.md)). What else lives in the container (shared preferences, caches,
the extensions' own files) has never been read.

**Owed:** list the container on the iPhone 12 (`bench_native_store list`). Then name what must
survive, and make the wipe delete the rest, with a test against a real directory like
`wipe_app_data`'s.
