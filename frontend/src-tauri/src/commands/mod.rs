// The bench build's observables, absent from every store build; the pure halves also compile for
// the host test run so CI pins them without the feature (see the module's own comment).
pub mod at_rest_key;
// The page's leave flush held open by an iOS background task (2026-11-02); a no-op elsewhere.
pub mod background_flush;
#[cfg(any(feature = "bench-observables", test))]
pub mod bench;
// The iOS Share Extension's share, carried out of the App Group; the pure halves compile for the
// host test run so CI pins the replacement rules without a device.
#[cfg(any(target_os = "ios", test))]
pub mod app_group_share;
pub mod conversation_nicknames;
pub mod cookies;
pub mod display_names;
pub mod handoff;
// The mail client's native socket: one destination, raw bytes both ways (2026-11-27).
pub mod mail_socket;
// The iOS background refresh flag of the new-mail watcher (lot 4, 2026-11-27).
pub mod mail_push_secret;
pub mod mail_watch;
pub mod mls;
// One MLS state per account on a shared install: the slot, the parked states, the switch.
pub mod mls_account_state;
// The Android push service's warnings and errors, carried into the app log (2026-11-04).
pub mod native_push_log;
pub mod notifications;
// The native outbox mirror: the page writes its own lines, under the native writers' lock (2026-11-21).
pub mod outbox_mirror;
// The iOS notification extension's outcome log, carried into the app log (2026-11-01).
pub mod notification_delivery_state;
pub mod nse_outcomes;
pub mod picked_files;
pub mod push;
pub mod push_registration;
pub mod seen_posts;
pub mod storage;
