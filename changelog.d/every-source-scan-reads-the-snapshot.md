### Changed - every source-scan test reads the run's snapshot, none walks the disk

The last scans that walked or read `src` from disk (the markup gates, `avatarUrl`, `openEcosystemSite`, `deviceListClaims`, `pendingCallAccept`, the import-cycle and anchor scans) now filter the once-per-run snapshot, so they stop timing out on a loaded Windows disk without a raised timeout ([test-suite-reform](docs/wiki/test-suite-reform.md#wp-t9-s---one-walk-of-the-source-tree-for-every-scan-2026-10-19)).
