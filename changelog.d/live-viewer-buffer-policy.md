### Fixed - a live viewer no longer freezes every few seconds behind an Android broadcaster

The viewer sat a fixed 2 s behind a recorder that delivers its fragments in pairs every 4 s, and read its own seek's `waiting` as a stall, so it re-seeked at every delivery; the target now follows the measured delivery cadence and a seek's wait is not a stall ([live](docs/wiki/frontend/modules/live.md#the-buffer-policy-l-f1-2026-10-27)).
