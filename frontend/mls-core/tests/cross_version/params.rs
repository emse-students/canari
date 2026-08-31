//! The parameters the fixture GENERATOR and the cross-version TEST both read.
//!
//! It lives here, included by path from two targets, so neither can drift from the other: a
//! constant copied into both would let a regenerated fixture disagree with the assertion that
//! reads it, and the test would then be measuring nothing.
//!
//! Included as:
//!   test    - `#[path = "cross_version/params.rs"] mod params;`
//!   example - `#[path = "../tests/cross_version/params.rs"] mod params;`
//!
//! Not every constant is read by both, and `dead_code` is allowed for that reason rather than
//! because anything here is unused.
#![allow(dead_code)]

/// Stamped into every fixture filename. **Bump it only when generating a NEW set beside the old
/// one**, never when regenerating in place - the whole value of these files is that they were
/// written by a version that is no longer the one under test, and overwriting them with today's
/// output turns the test into a round-trip that proves nothing.
pub const FIXTURE_VERSION: &str = "v0.14.14";

/// The device whose state is frozen. It is the JOINER, not the creator: a member restored from a
/// Welcome is the state shape every ordinary device is in, and it is the one that must still be
/// able to read traffic after an upgrade.
pub const PEER_USER: &str = "bob";
pub const PEER_DEVICE: &str = "dev1";

/// The device that creates the group and sends the frozen frame.
pub const OWNER_USER: &str = "alice";
pub const OWNER_DEVICE: &str = "dev1";

pub const GROUP_ID: &str = "cross-version-fixture-group";

/// The epoch the frozen state sits at. Asserted by the generator, so a change to how the fixture
/// group is built fails at generation time rather than silently moving what the test checks.
pub const EXPECTED_EPOCH: u64 = 1;

/// The plaintext sealed inside the frozen application frame.
pub const MESSAGE: &[u8] = b"a frame written by a previous version of this crate";

/// The PIN behind the legacy at-rest envelope. Derivation parameters live in `argon2`; a change to
/// them makes this key different and the fixture unopenable.
pub const PIN: &str = "1234";

/// The device key behind the current at-rest envelope. Fixed rather than derived, so that this
/// fixture isolates the AEAD (`chacha20poly1305`) from the derivation (`argon2`) - two crates that
/// would otherwise fail as one, with nothing saying which moved.
pub const DEVICE_KEY: [u8; 32] = [7u8; 32];

/// The plaintext sealed inside both at-rest envelopes.
pub const SEALED_PLAINTEXT: &[u8] = b"cbor-mls-snapshot";

/// Where the generator writes and the test reads. Relative to the crate root.
pub const FIXTURE_DIR: &str = "tests/fixtures";

/// The four frozen artefacts, by suffix.
pub const PEER_STATE: &str = "peer-state.bin";
pub const APPLICATION_FRAME: &str = "application-frame.bin";
pub const PIN_ENVELOPE: &str = "pin-envelope.bin";
pub const DEVICE_KEY_ENVELOPE: &str = "device-key-envelope.bin";
