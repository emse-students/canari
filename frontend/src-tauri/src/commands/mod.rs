// The bench build's observables, absent from every store build; the pure halves also compile for
// the host test run so CI pins them without the feature (see the module's own comment).
pub mod at_rest_key;
#[cfg(any(feature = "bench-observables", test))]
pub mod bench;
// The iOS Share Extension's share, carried out of the App Group; the pure halves compile for the
// host test run so CI pins the replacement rules without a device.
#[cfg(any(target_os = "ios", test))]
pub mod app_group_share;
pub mod cookies;
pub mod display_names;
pub mod handoff;
pub mod mls;
// One MLS state per account on a shared install: the slot, the parked states, the switch.
pub mod mls_account_state;
pub mod notifications;
// The iOS notification extension's outcome log, carried into the app log (2026-11-01).
pub mod nse_outcomes;
pub mod picked_files;
pub mod push;
pub mod push_registration;
pub mod storage;
