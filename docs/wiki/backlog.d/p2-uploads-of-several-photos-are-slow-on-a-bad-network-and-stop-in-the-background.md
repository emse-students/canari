## P2 - sending several photos or videos is slow on a bad network, and the send stops when the app goes to the background

Owner report, 2026-11-06 (a heavy evening). The server side is not the cost: the 2026-11-05 evening
read of the production frontend log shows 110 `POST /api/media/upload` at 0.08 s on average (0.25 s
at most) and 2 chunked completions at 0.4 s, so the time is the client's uplink and the work done
before it (encoding, encryption). Nothing in the app lets a send outlive the webview: a backgrounded
app is suspended and the upload dies with it.

Open design questions (to ask the owner, four at a time): what survives a backgrounding (a native
Android foreground service / WorkManager and an iOS background `URLSession`, versus a resumable
chunked upload that restarts on return), whether several files go in parallel or one after the
other on a weak link, and whether a send in progress is shown as a persistent row with a retry.

The chunked path already exists (`/api/media/upload/chunk/*`); a resumable client over it is the
smallest step and needs no native code.
