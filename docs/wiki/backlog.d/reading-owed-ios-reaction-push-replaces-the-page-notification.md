## Reading owed - on an iPhone, a reaction's push and the page's notification of it are ONE entry, and neither erases the other (2026-11-17)

target: 1.7.0

**What is built** (review of #3792, rounds 2 and 3): the page posts a reaction to my message through
the notification plugin under the identifier `reactionCollapseId` (a hash of the reacted-to message,
the reactor and the reaction's instant), and the server sends the reaction's push with
`apns-collapse-id` = the same decimal, on the full push and on the content-free wake alike
([mobile](../frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17)). While the app is ACTIVE,
`willPresent` (`canari_push.mm`) reads the delivered notifications: the page's twin delivered -> it
answers `List`, none -> `None`. That iOS replaces a delivered LOCAL request by a remote one with the
same identifier (and the reverse) is what a post's local twin already relies on, and no test here can
prove it: Objective-C compiles only on the macOS runner and nothing runs it.

**The reading that closes it**, on the `1.7.0` pre-release, iPhone 12 bench, a second seat reacting to
a message the iPhone wrote:

1. App open on ANOTHER conversation: Notification Center then shows exactly ONE entry for that
   reaction (two is a tolerated double, written here with the syslog; ZERO is a FAIL - the loss the
   `List` answer exists to prevent). `python -m pymobiledevice3 syslog live` shows
   `reaction push while active: the page's twin delivered - kept in the list`.
2. App open under Control Center (inactive): ONE entry; a second sound on the replacement is
   acceptable.
3. App open ON the reacted-to conversation: no entry, and the syslog line says `absent - not
   presented`.

A double in step 1 is not a defect to fix by answering `None`: it would mean iOS keeps both requests,
and the answer then is to drop the page's post, measured, never to guess.
