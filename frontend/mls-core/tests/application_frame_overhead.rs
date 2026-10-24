/// What MLS adds to an application message, measured rather than estimated.
///
/// A Graine history answer is paged so that THREE pages fit one pending-queue page
/// (`PENDING_PAGE_MAX_BYTES`, 1 048 576 base64 characters) - `GRAINE_BUNDLE_PAGE_MAX_BYTES`,
/// channel-encryption section 4.4. Three base64 frames fit when each is at most 349 525 characters,
/// so when each MLS frame is at most 262 143 bytes (4 x ceil(262 143 / 3) = 349 524). The page is
/// 255 KiB = 261 120 bytes of plaintext, which leaves 1 023 bytes for MLS framing. This pins that the
/// framing - group id, epoch, sender data, signature, AEAD tags, no padding configured - stays
/// inside it: measured at 165-170 bytes on 2026-10-22.
use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

/// `GRAINE_BUNDLE_PAGE_MAX_BYTES` (frontend/src/lib/crypto/graineConstants.ts).
const GRAINE_PAGE_BYTES: usize = 255 * 1024;
/// The largest MLS frame of which three, as base64, fit one 1 MiB pending page.
const THREE_PER_PENDING_PAGE_FRAME_BYTES: usize = 262_143;

#[test]
fn a_full_graine_page_still_fits_three_to_a_pending_page_once_mls_frames_it() {
    // A real group id is a UUID, the longest the delivery service issues.
    let gid = "0b1f6a3e-7c2d-4e59-9a8b-1c2d3e4f5a6b";
    let mut alice = make_device("alice", "dev1");
    let bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    alice.add_members_bulk(gid, &[&kp_bob]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add bob");

    for plaintext_len in [0usize, 1_000, GRAINE_PAGE_BYTES] {
        let frame = alice
            .send_message(gid, &vec![7u8; plaintext_len])
            .expect("encrypt");
        println!(
            "plaintext {plaintext_len} B -> frame {} B, framing {} B",
            frame.len(),
            frame.len() - plaintext_len
        );
        assert!(
            frame.len() - plaintext_len <= THREE_PER_PENDING_PAGE_FRAME_BYTES - GRAINE_PAGE_BYTES,
            "MLS framing of {} B exceeds the {} B a Graine page leaves for it",
            frame.len() - plaintext_len,
            THREE_PER_PENDING_PAGE_FRAME_BYTES - GRAINE_PAGE_BYTES
        );
    }
    let base64_chars = |n: usize| 4 * n.div_ceil(3);
    assert!(3 * base64_chars(THREE_PER_PENDING_PAGE_FRAME_BYTES) <= 1_048_576);
}
