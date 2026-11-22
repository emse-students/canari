### Fixed - the in-app log keeps the lines that explain a crash, and says when the last session ended abruptly

The log was written to disk only by batch, on leaving the screen or on export, so an app killed
during a call lost the whole call from its log. An error is now written at once, the call
lifecycle writes the batch at its milestones, and a boot that finds the previous session ended while
on screen says so in one line
([in-app log](docs/wiki/frontend/mobile.md#the-in-app-log)).
