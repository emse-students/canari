### Fixed - "Synchronisation en attente" no longer appears with the app open

The Android background sweep counted every deferral to the open app as a failed attempt and asked to open the app after three; it now asks only after three real failures in a row ([mobile](docs/wiki/frontend/mobile.md#the-pending-db-sweep-raises-its-notice-on-real-failures-only-2026-11-26)).
