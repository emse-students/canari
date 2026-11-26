### Removed - the per-file iOS backup exclusion passes, redundant since the directories are flagged at every launch

The iPhone reading of `1.7.3-alpha.5` proved the directory flag holds (6/6 directories, a full backup holding no file of ours), so `native_cache::exclude_from_backup`, `CanariExcludeNativeCacheFilesFromBackup`, the NSE's `excludeFromBackup` and the share manifest's per-file call are gone ([mobile](docs/wiki/frontend/mobile.md#the-native-caches-are-sealed-at-rest-and-kept-out-of-backups-2026-10-22)).
