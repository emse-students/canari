### Fixed - a ringing call no longer reads as "checking encryption", and an answer connects sooner

The ring shows its status alone; the callee's setup runs its independent steps side by side without awaiting the "answered" notice; the caller gathers ICE candidates during the ring; `[CALL_REPORT]` splits `setup_ms` into `ring_ms` and `connect_ms`; and the Media Session and reachability probe noise is gone ([calls](docs/wiki/frontend/modules/calls.md#it-stays-a-long-time-on-encryption-before-the-call-owner-android-153-2026-10-31)).
