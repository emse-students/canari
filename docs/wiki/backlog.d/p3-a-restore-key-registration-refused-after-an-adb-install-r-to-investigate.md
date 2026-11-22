## P3 - to investigate: a restore-key registration refused on the first start after an `adb install -r` of a release build

target: 1.8.0

After an `adb install -r` of a release APK, the first start logged `Restore key registration failed ... 403 RESTORE_ORIGIN_NOT_ALLOWED`. Find out whether that is expected for that install path or a defect, and say so in the wiki. If it is expected it must not log at a level that accuses; if it is a defect it is a P2.
