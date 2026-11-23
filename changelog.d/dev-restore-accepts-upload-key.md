### Changed - dev accepts the Android upload-key origin for account restore

A bench APK installed by hand (upload key) can now register a restore key on dev, through the dev-only `ANDROID_UPLOAD_KEY_SHA256`; production keeps the Play key only ([account-restore](docs/wiki/account-restore.md)).
