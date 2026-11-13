## Reading owed - the video ladder dropping 480p30 to 180p15 early in a call, when seen again

target: 1.7.0

Read on dev on the Mi 9T and the iPhone 12; every reading the release owed passed and `1.6.7`
shipped on them. The sign-out and sign-in noise was fixed at its causes (#3149).

**Closed: the `pauseSocket` lines next to "Reconnect request refused" when the app goes to the
background for the file picker.** Both are deliberate lines at `log`, each naming a fact the
pause owes its reader: `TauriMlsService.pausePlatformSocket` says the OS had already closed the
socket (its `send` rejected, so there is nothing to release), and `scheduleReconnectImpl` says a
reconnect request met a paused connection, which only the foreground resume reopens.

**Open, to watch:** the quality ladder drops 480p30 -> 180p15 four seconds into a call, while the
bandwidth estimate is still ramping, and recovers within 30 s. A camera starts on `480p30` precisely
so that a ramping estimate does not read as "bandwidth" ([calls](../frontend/modules/calls.md)), so
an early drop to the bottom rung is the thing to explain when it is seen again. One ICE restart
followed the iPhone camera coming back, and it healed in 5.5 s.
