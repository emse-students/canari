## Audiences of associations, lists and institutions - built, in production since `v1.2.0`

target: 1.8.0

WP-A (#1582), WP-B (#1584), the star reading its audience (#1593), the nominative read grants WP-C (#1606) and their write-boundary fixes (#1608) are built. Decisions and as-built: [profiles-and-access](../profiles-and-access.md#the-audiences-chantier---the-decisions-user-2026-10-07-moved-from-the-backlog-2026-10-08). **Owed:**

- **The on-device look** at the Audience tab, the profile campus prompt and the `/admin/read-access` grid.
- **The 8 dev checks of the read grants PASSED on 2026-10-09** ([verdicts](../profiles-and-access.md#the-eight-dev-checks-2026-10-09-devcanari-emsefr-on-121-alpha1-same-code-as-v121)). Check 2 (no personal post) passed on the predicate only; an end-to-end reading needs a personal post by a gardanne account, and `canari-test-epsilon`'s credentials are NOT in `<harness-dir>/test-accounts.json`. **User:** add them there (never on a command line).
- **User decision:** let the directory be widened for grantees? (not widened now; only posts, comments, reactions and events are).
- **Ambiguity to answer:** what "an institution of another campus" means for a reader (the grant reaches it today).
- The document-reviewer rows were NOT moved into the grants table (a separate capability on the same page).
