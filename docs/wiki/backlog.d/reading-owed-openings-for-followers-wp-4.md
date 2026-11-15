## Reading owed - openings for followers, WP-4

target: 1.7.0

**What is built:** openings for followers, WP-4 (#3188, first stable `v1.6.9`, migration 152 approved; [engagement](../engagement.md#wp-4---openings-for-followers-built))

**The reading that closes it:** on the Mi 9T and the iPhone 12: a followed association's form opening in ten minutes - "Formulaire ouvert !" at the opening and no heads-up; "Me prévenir" on it too - the heads-up and still ONE opening push; a listed booking space - "<asso> ouvre les réservations"; a validated event - "<asso> publie un événement"; the bell at "Rien" - the bell row, no push

**Triage 2026-11-14: Mi 9T about 20 min, iPhone about 20 min** (a form opening in ten minutes is staged on dev with a web seat as the association).

**Mi 9T, 2026-11-15 (dev, alpha.2 release build, app killed, FCM delivering): form rows READ.** Form A (no ask): ONE opening push, "Formulaire ouvert !", no heads-up. Form B ("Me prévenir" asked): the heads-up at 05:41:00 and ONE opening push at 05:46:00. **Left:** the booking-space push ("<asso> ouvre les réservations") did not arrive within 3 min on the Mi 9T and is unexplained (not read, not a verdict); the validated-event push is not staged (validation is 403 for the test accounts); the iPhone half.
