## P2 - An unclean kill of a browser inside ~30 s of a rotation signs the user out (KILL-2, 2026-10-25; design after the stable)

target: 1.9.0

A browser or app killed without a clean shutdown (a crash, an OS kill, power lost) inside about
30 s of a refresh rotation, or inside the window of two rotations close together, relaunches
signed out. A desktop browser commits its cookie store lazily, about every 30 s, and has no flush
the page can ask for (Android's `CookieManager.flush()` closes the same hole on the phone -
[sessions](../sessions.md#the-rotation-has-to-reach-disk-and-on-android-nothing-guarantees-that)).
Every start is a refresh and every refresh rotates, so the relaunch presents a superseded token.
The server's rules then decide it, in `apps/core-service/src/auth/auth-sessions.service.ts`:

- `:26-37` (`isPreviousTokenInGrace`) accepts only the ONE previous `jti`, for 60 s after the
  rotation;
- `:218-224` a grace hit reissues the CURRENT `jti` without rotating, and that reissued
  `Set-Cookie` can be lost in the same flush window - which leaves the next start two generations
  behind;
- `:227-246` anything older is a replay: the session row and its push registration are deleted.
  The server cannot tell this from a stolen cookie, and its own comment says so.

**Reproduced on dev with a test-rig Chrome, hard-killed and relaunched each time:**

1. 70 s idle after the last rotation: the cookie on disk is current; the user stays signed in.
2. Rotation forced by a reload, kill about 5 s later: the previous token is presented inside the
   grace window and reissued; the user stays signed in.
3. Straight after case 2, a second rotation and a kill about 5 s later: neither the rotation nor
   the reissue had reached disk. The token presented is two generations old, `Refresh token replay
   detected … presented=older rotatedAgo=12s - session revoked`, and the user is signed out.
   This reproduces at will.
4. Rotation forced, kill 40 s later: current, signed in.

**Candidate fix, to design AFTER the stable, server side, shipped with a stable:** do not rotate
when the last rotation is younger than the grace window. A refresh inside the window returns the
current token unchanged, so a client can never fall two generations behind. Weigh it against how
strict replay detection is, since the window then also widens what a stolen cookie gets. It needs
an Opus security review. The test rig's KILL-2 row waits for the cookie to reach disk before its
kill, because its subject is a commit in flight, not this.

**Production data point, 2026-11-08 (read from the production log, owner-approved): the hole bites without a kill.** A desktop browser with several tabs open, about 28 page loads in 3.7 days, was signed out at 16:33Z by `Refresh token replay detected ... presented=previous rotatedAgo=5095s - session revoked`: it presented the token from BEFORE the rotation of 15:08Z (that browser's last refresh), 85 minutes later. So a superseded token is not only presented by a relaunch inside a 30 s flush window: a multi-tab browser can present one an hour and a half after the rotation (which tab held the stale copy is not read). **The candidate server-side fix above is now the item to build**, not a design for later; it still needs its security review. Sessions and accounts are deliberately unnamed.

**Open observation, unexplained.** The first KILL-2 failure was not a replay: the relaunched
browser presented a refresh cookie for a DIFFERENT session, refused as `no such session`. That
session was absent from `auth_sessions` and from every server line since the service last
restarted, hours earlier, while the seat's live session had rotated three minutes before the kill.
The 401 cleared the cookie before it could be read. A cookie store that had failed to commit since
an earlier kill that morning would explain it, but nothing proves it.
Re-read 2026-11-11: still real - `ROTATION_GRACE_SECONDS` is 60 and `isPreviousTokenInGrace` still accepts the ONE previous `jti` (`auth-sessions.service.ts`, the line numbers above have moved); every refresh still rotates. Re-read again 2026-12-11.
