## P3 - iOS: an answer on the locked CallKit screen is lost if the app is opened after the ring deadline

target: 1.9.0

**Seen 2026-11-15 on the iPhone 12** (TestFlight `1.6.12-alpha.2`, dev, app killed, phone locked).
The member slid to answer at 04:17:30, about 13 s into the ring. CallKit showed the call answered and
counting. The app was opened through "More > Open in Canari" 42 s later, and the PIN was entered.
By then the ring's deadline (about 59 s after the push) had passed:

- the caller's seat had already filed "Appel sans réponse";
- the phone logged `[CanariCallKit] an answer waits - the page was told`;
- the app landed on the feed, with no call.

When the same steps were done within 30 s, the call joined (K8 READ).

**Why:** the answer stays on the phone until the page takes it past the PIN gate. The server keeps
ringing toward its deadline, so a member who answered on time still loses the call if the unlock is
slow. CallKit meanwhile shows a call that is "in progress" and connected to nothing. The answer should
reach the server when it is given: the native layer already holds the call id and the credential the
decline uses. The server would then hold the ring as "answered, joining" past its deadline, until a
bounded join window. Pin it with a test of a late join after an early native answer.
