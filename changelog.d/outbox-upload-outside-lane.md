### Fixed - a text sent after a big attachment no longer waits for its upload

The attachment's upload now runs outside its conversation's send lane; only its small MLS send takes the lane, and it still displays at its compose time ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#138-wp-off-9-built-the-upload-runs-outside-the-lane-2026-10-18)).
