## Reading owed - a post push tapped with the session dead lands on `/login?returnTo=` the post

target: 1.7.0

**What is built:** a post push tapped with the session dead lands on `/login?returnTo=` the post (2026-10-09)

**The reading that closes it:** check H step 4 on the Mi 9T, killed app AND backgrounded ([device-verification](../device-verification.md#h-deep-link-from-an-os-notification-tap---re-opened-on-android)); a bare `/login` with no `[hooks] Processing URL` means the intent never reached the JS
