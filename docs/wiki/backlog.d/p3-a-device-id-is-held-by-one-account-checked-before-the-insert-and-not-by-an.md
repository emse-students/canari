## P3 - A device id is held by one account, checked before the insert and not by an index (2026-10-22)

target: 1.9.0

Registration refuses a device id another account holds (`device_id_taken`) by a read before its write; `key_package` is unique on the pair only, so two concurrent registrations of one id by two accounts could both pass. Production held 0 shared ids on 2026-10-22, and a client mints its id per account. The fix is a unique index on `key_package."deviceId"`, a migration of its own. Re-read 2026-11-11: still no such index (`key-package.entity.ts` is unique on the pair); before the migration, the shared-id count is re-read on production, since a unique index fails to build on one duplicate.
