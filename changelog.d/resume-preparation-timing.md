### Changed - a foreground resume logs what the reconnect waited for

One `[LIFECYCLE] Resume prepared` line names each step's duration. It showed that a warm notification tap's reply waits on the landing's render, not on a late foreground signal ([notification-to-conversation-latency](docs/wiki/frontend/notification-to-conversation-latency.md#f5---the-warm-diagnosis-was-wrong-and-the-fix-it-suggested-measured-to-nothing)).
