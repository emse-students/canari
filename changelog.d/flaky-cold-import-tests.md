### Fixed - two frontend tests failed under load because the cold compile of the paraglide barrel was charged to a case's timer

`PushNotificationService.permission` and `appVersionCheck.importIsQuiet` paid the first-import transform (about 10 s, past 30 s on a busy machine) inside the first case, which timed out and leaked into the next one. The import is now done once at collection, where no per-case budget applies, and the 30 s timeouts are gone.
