## P3 - a live that seemed to stay up after "Terminer" (`v1.6.8-alpha.3` reading, 2026-11-08)

The follower tab's "Hors-ligne" header and its lost conversation on a leadership change, and the
paid-forms banner's dangling full stop, were filed by the same readings and fixed apart. One is left.

**After "Terminer" on a live on the iPhone, the live screen seemed to stay up, and about five minutes
later an alert read "Live terminé - Le live s'est arrêté pendant que la caméra était en pause".**
Low certainty: it was seen once, and the code does not reproduce it.

What the code shows ([live](../frontend/modules/live.md)): the alert is `server-while-away`, which
only the phase `away` produces (`reacquire` finding the live ended, or the uploader hearing the
server's end while away), so it cannot come from the End path (phase `ending`, cause `broadcaster`).
The one defect found on the End path was an await on the server's answer before the screen
settled, which kept the screen in "ending" for as long as a backgrounded iPhone held the request.
The member's tap is now the decision: the screen settles at once, and the end is delivered after
(`#deliverEnd`, idempotent on the server, retried on the link coming back until ANSWERED - a status
code is an answer, only a transport failure retries; lost with the page, where the server ends the
live by absence).

What would decide it, if it is seen again: the line `[LIVE-SCREEN] end asked in <phase>` and the
line `[LIVE-SCREEN] end returned in <phase> (<cause>)`. An `end asked in away` followed by no
`returned` line means the confirmation never resolved (the tap did not reach `broadcast.end()`);
`returned in ending` is impossible now; `returned in ended (broadcaster)` followed later
by `ended (server-while-away)` would mean a second live. Until then it needs a reproduction.
