## P2 - the Android background answer to a `welcome_request` retries the add lock on a clock (2026-11-18)

target: 1.8.6

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

`processWelcomeRequestBackground` (`CanariFirebaseMessagingService.kt`) asks for the group's add
lock up to three times with `Thread.sleep(2_000)` between the attempts, and gives up after the third.
That is a retry on a clock: it waits on a guess while the server already states when the holder's
lock ends (`retryAfterMs`, the `PTTL` of the key), and it holds an FCM thread for up to four seconds
for an answer the foreground may serve anyway. Found in the review of #3799, which made every
foreground taker take the lock only once its Add is decided and made a member's first invitation
that meets another device's lock OWED, re-planned at the lock's server-stated end
([chat](../frontend/modules/chat.md#nothing-takes-the-add-lock-it-does-not-commit-under-2026-11-17)).

**The fix is the same shape, and needs a native build:** one acquire; a refusal leaves the
`welcome_request` to the foreground's next load or to another member (the path the service already
documents for a busy lock at commit time), with no sleep.

**Closes with:** a JVM test in `android-tests/.../BackgroundWelcomeAnswerTest.kt` (the lock step
extracted into `BackgroundWelcomeAnswer`, as the settle step is) asserting that a refused acquire
makes exactly one request, sleeps nothing and stages nothing; and the Android build green.
