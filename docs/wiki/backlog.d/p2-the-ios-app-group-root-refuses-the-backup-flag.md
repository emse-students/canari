## P2 - the iOS App Group root refuses the backup flag, so `mls.bin` and the push secret still go into an iPhone backup

target: 1.7.2

**Read on the iPhone 12, `1.7.2-alpha.1`, 2026-11-20 (S16, [readings](../device-verification.md#the-readings-of-2026-11-20-s16-172-alpha1-the-birthday-ring-the-composer-gap-the-pin-gate-the-ios-backup-pass-the-rediffusion-switch-the-web-image-drop-miconnect)).**
The launch pass of #3893 (`backup_exclusion.rs`) excludes five of its six directories and fails on the App Group
container's root, at every launch:

```
[BACKUP_EXCLUSION] AppGroup(group.fr.emse.canari) not excluded from backups: setResourceValue refused
[BACKUP_EXCLUSION] 5/6 directories excluded - NOT excluded: AppGroup(group.fr.emse.canari)
```

A full unencrypted `backup2` of the phone, read then deleted, agrees: `AppDomain-fr.emse.canari` holds only
`Documents/` files (the app container passes), while `AppDomainGroup-group.fr.emse.canari` holds 35 files,
`mls.bin`, `push_secret.txt`, `push_context.json`, the display names, the nicknames, avatars and
`device_notices/` among them. So the reported case of 2026-11-20 (a new iPhone receiving the stores) is still
possible for everything the App Group holds.

**What is not known: why the root refuses.** `native_cache::ios_exclude_from_backup` passes `error: NULL` to
`setResourceValue:forKey:error:`, so the `NSError` that names the cause is discarded and the line can only say
"refused". The first step is to keep that error (domain, code, description) in the ERROR line; then decide
between excluding the root's CHILDREN (a per-directory flag on a directory the app owns inside the container,
the stores moved under it) and another route, measured with the same `backup2` read. The entry
[reading-owed-ios-local-data-out-of-backups](reading-owed-ios-local-data-out-of-backups.md) stays open until a
build passes 6/6 and the manifest holds no App Group file.
