### Fixed - a native checkpoint no longer freezes the screen of an Android phone

The MLS state is released as soon as a checkpoint has copied it, and checkpoints still land on disk one at a time and in order. A send, a commit, or a membership or epoch read no longer waits for the encryption and the file write. On the Mi 9T, those waits had frozen the WebView for 1.6-3.2 s per call ([performance audit](docs/wiki/frontend/performance-audit-2026-10-12.md#finding-12---the-manager-lock-released-at-the-export-2026-10-13)).
