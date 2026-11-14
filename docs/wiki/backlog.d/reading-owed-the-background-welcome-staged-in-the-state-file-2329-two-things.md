## Reading owed - the background Welcome staged in the state file (#2329): the app opened inside its round trip

target: 1.7.0

**#2329, the background Welcome staged in the state file (merged 2026-10-24), owes one Mi 9T
reading:** open the app INSIDE a background Welcome's round trip, between the stage written and the
server's answer; the app's load reports the stage and settles it exactly once - merged on an
acceptance, cleared otherwise - with no second Add and no `ACCEPTED AND NOT HELD`. It is the "app
opened inside the round trip" variant of [the background Welcome reading](../device-verification.md#one-background-welcome-on-the-mi-9t-the-procedure-2026-10-22).

**WAITS, 2026-11-14:** the trigger is a push to a killed phone, and dev has no Firebase sender; owed
in a push sitting on the local estate (or dev once it has a Firebase project).

**The second item, the never-compiled iOS FFI change (the `max_attempts` argument, its header and
its Objective-C caller), is MOOT (checked 2026-11-14):** every release compiles iOS, and the
`v1.6.12` release run's "App Store / Build iOS IPA" job is green with `max_attempts` in
`canari_rust_bridge.h`.
