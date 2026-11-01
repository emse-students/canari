## P3 - Whose is the deep-link manifest diff found in the main checkout? (2026-10-28)

The main checkout held an uncommitted
`frontend/src-tauri/gen/android/app/src/main/AndroidManifest.xml` diff, restored before an A1 build:
`org.chromium.arc.intent.action.VIEW` added to the `signed-out` deep-link filter, and
`android:path` entries (`/chat`, `/communities`, `/notifications`, `/calendar`, `/shop`,
`/bookings`, ...) added under the `canari-emse.fr` host filter. The ARC action is already on `main`
in the other filters (`git log -S`), and the paths are in `tauri.conf.json`'s deep-link config. This
file is the one that `tauri android build` regenerates from that config (`REGENERATED_MANIFEST`,
`tools/cross-client-harness/a1apk.mjs`). The diff was already in the checkout when the session
started, before any build of it. An `a1apk.mjs` build of `5c362c0e1` then left the tree CLEAN,
although neither the config nor the committed manifest differs between `fb7994232` and
`5c362c0e1`. So which build wrote the diff, and why the same config regenerates differently, are
both unanswered. Owed: reproduce it from a clean tree. If a build regenerates a manifest that
differs from the committed one, the committed copy is stale and is regenerated in a pull request.
