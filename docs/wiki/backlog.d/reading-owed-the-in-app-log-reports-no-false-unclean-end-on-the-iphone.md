## Reading owed - the in-app log reports no false unclean end on the iPhone (2026-11-22)

target: 1.8.0

The unclean-end marker (`canari_applog_on_screen`, [in-app log](../frontend/mobile.md#the-in-app-log)) is
cleared synchronously when the app leaves the screen. WebKit commits `localStorage` asynchronously,
so whether that clear survives a prompt kill is NOT known from the code, and a lost clear would read
as a crash.

Reading, on the bench iPhone, on the next alpha: open the app, send it to the background, wait,
kill it (swipe it away), relaunch, then export the log and confirm there is NO `the previous
session ended while on screen` line. Then repeat with a kill while ON screen (force-quit from the
app switcher after a call setup) and confirm exactly ONE such line, naming a last written line
close to the kill. Both pass: delete this file. A false report: the marker needs a durable home
(the log database) instead.

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** In `1.8.0-alpha.1` (#3976): takeable now on the iPhone 12.
