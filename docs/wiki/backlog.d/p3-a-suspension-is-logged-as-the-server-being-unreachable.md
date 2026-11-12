## P3 - On Android, work cut by the OS suspension is logged as the server being unreachable (1.6.8 logs, 2026-11-09)

About 5 s after `App in background - connection paused`, requests still in flight are cut by the OS
suspension and fail in transport. Each is then reported as if the server had been the problem, in one
log: `[CONNECTIVITY] server unreachable` (33), `[PENDING] ... UNDRAINED` (28), `[SYNC] user group list
got no answer` (40), `[ROSTER] batch ... Failed to fetch` (12), `[KP] Publication failed` (6).

Not fixed in the noise batch because it is a design, not a line: the pause (`pauseConnectionImpl`,
`composables/session/sessionConnection.ts`) closes the socket but nothing aborts HTTP work, and the
failures land in `notifyServerUnreachable` (`stores/connectivity.svelte.ts`) and in five unrelated
catch sites. Two candidate shapes, to choose after measuring how many of the 33 follow a pause by
under ~10 s:

1. Abort in-flight work on pause with ONE typed abort (`SuspendedError`), logged once, and have the
   five sites treat it as an outcome rather than a failure.
2. Stamp every transport failure at the throw (`trackedFetch`) with a suspension epoch captured at
   request start (bumped on every foreground -> background edge, `utils/appForeground.ts`); a failure
   whose epoch moved is `suspended`, never feeds the connectivity store, and each site reads the type.

Shape 2 is the smaller one and needs no per-site abort wiring; it must not hide a real outage that
merely overlaps a pause (the epoch only covers requests that STRADDLE the edge).
