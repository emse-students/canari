## P2 - Native push: an unresolvable host reads as `Redis lock not acquired`, and the FCM token registration is retried into HTTP 429 (1.6.8 logs, 2026-11-09)

Android native Kotlin, so not touched in the noise batch
(`frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt`):

- `acquireAddLock` (~L4136) catches the exception (`Unable to resolve host`, logged at ~L4165 as
  `acquireAddLock: exception`) and returns null; the caller (~L4010-4012) then warns `Redis lock not
  acquired (attempt n/3)`. A DNS failure is "no answer", not "the lock is held", and retrying three
  times at once on a link that cannot resolve is load for nothing. The caller needs the discriminator
  (held versus no answer) from `acquireAddLock` as a type, and should stop retrying on no answer.
- `FCM token registration failed HTTP 429` appeared three times within 5 s at one boot: the
  registration is re-sent without honouring the 429 (`Retry-After`) or collapsing concurrent callers.
  Find the call sites by `registration failed` in the same file; the server's rate limit is the
  answer, so the client should send once and wait for the next trigger, not retry on a clock.
