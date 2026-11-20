## P3 - a native app asks for a refresh carrying no credential at all, and nothing says why its store is empty

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

core-service logs `Refresh refused for the NATIVE app: no canari_refresh cookie. cookies=[]
x-canari-refresh=absent client=<version> origin=<native origin>` at WARN. Since the header transport
shipped ([sessions](../sessions.md#the-credential-a-client-carries-itself)), a client on
`tauri://localhost` carries its own credential, so `absent` from a recent build means the app believed
it had a session while its credential store came back empty - the one cause the comment in
`auth.controller.ts` calls a defect - and the user is sent back to the sign-in.

**Seen twice, unexplained both times.** On dev at the `1.7.0-alpha.1` deploy (2026-11-15), from an
Android device on `1.7.0-alpha.1`, twice ([device-verification](../device-verification.md), the
`alpha.1` rolling-deploy table). On production two minutes after the `1.7.0` deploy (2026-11-18), once,
from an iPhone on `1.6.6` (iOS 17) with an empty cookie list - see the reading of that day in
[device-verification](../device-verification.md#the-production-reading-of-2026-11-18-the-170-stable-deploy).
Both landed right after a deploy, which may or may not matter.

**What is missing is the report that separates the causes** (CLAUDE.md: a correct mechanism with no
report is found by hand). The server cannot tell "the store write failed", "the store was cleared by
the OS" and "the app signed out locally but still asked"; the client can. The fix starts by making the
client state, when it asks for a refresh with nothing to carry, why it holds nothing (never written,
read failed, cleared) - so the next occurrence names its cause instead of being a note.
