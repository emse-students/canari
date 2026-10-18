### Changed - the five calls switches are asserted against `CALLS_COMPILED`, and calls no longer reopen the Android silent-push decrypt

One test now checks that the Kotlin, ObjC, `voip`, `USE_FULL_SCREEN_INTENT` and microphone-string switches agree with `CALLS_COMPILED`. The Android silent-frame guard no longer reads the calls switch, so turning calls on would not bring back a decrypt behind every read receipt ([calls](docs/wiki/frontend/modules/calls.md#the-switches-agree-and-a-silent-frame-stays-unread)).
