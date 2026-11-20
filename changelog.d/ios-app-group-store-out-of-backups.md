### Fixed - iOS: the files shared with the notification and share extensions no longer go into a backup

The App Group container's root refused the backup flag, so `mls.bin` and the push credential still
travelled. They now live in a `store/` directory of ours, flagged at creation, older files moved in
at first launch, and a refusal logs its cause
([mobile](docs/wiki/frontend/mobile.md#the-app-group-a-store-directory-never-the-root-172)).
