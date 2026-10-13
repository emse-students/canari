/// WHAT ONE CHECKPOINT COSTS ON A HEAVY STATE, AND WHETHER IT SCALES WITH THE ONE GROUP THAT MOVED.
///
/// The 2026-10-12 console audit counted one encrypted checkpoint per inbound application message
/// (39 in 197 s, median 348 ms) and the backlog owes "a trace splitting the WASM export from the
/// IndexedDB write" before deciding anything (`docs/wiki/backlog.md`, `docs/wiki/frontend/performance-audit-2026-10-12.md`). This
/// file answers the half that does not need a browser: the export (`save_state`, CBOR of the whole
/// provider storage) and its encryption (`save_encrypted_with_key`), on states shaped like a heavy
/// account - many groups, each with a real tree, past epochs and several senders whose ratchets
/// moved - after ONE application message decrypted in ONE group.
///
/// A MEASUREMENT, NOT AN ASSERTION, so it is ignored and prints a table:
///
///   cargo test --release --test heavy_state_checkpoint -- --ignored --nocapture
///
/// Every figure is a FLOOR for a real device (see `state_weight.rs`'s first warning): synthetic
/// groups accumulate less ratchet history than a campaign-aged phone.
use std::time::Instant;

use mls_core::MlsManager;

const KEY: [u8; 32] = [7u8; 32];

fn device(user: &str, dev: &str) -> MlsManager {
    MlsManager::load_or_create(user, dev, None).unwrap_or_else(|e| panic!("{user}:{dev}: {e}"))
}

/// One group: `inert` members who never send, `senders` who join by Welcome and each send
/// `messages` frames the measured device decrypts, and `epochs` extra single-member adds.
fn build_group(
    me: &mut MlsManager,
    gid: &str,
    inert_pool: &[MlsManager],
    senders: &mut [MlsManager],
    epochs: usize,
    messages: usize,
) {
    me.create_group(gid.to_string()).expect("create_group");
    let bulk = inert_pool.len() - epochs;
    let kps: Vec<Vec<u8>> = inert_pool[..bulk]
        .iter()
        .map(|m| m.generate_key_package().expect("kp"))
        .collect();
    let refs: Vec<&[u8]> = kps.iter().map(|k| k.as_slice()).collect();
    me.add_members_bulk(gid, &refs).expect("bulk add");
    me.merge_pending_commit_for(gid).expect("merge bulk");

    let skps: Vec<Vec<u8>> = senders
        .iter()
        .map(|m| m.generate_key_package().expect("sender kp"))
        .collect();
    let srefs: Vec<&[u8]> = skps.iter().map(|k| k.as_slice()).collect();
    let (_commit, welcome, _, _) = me.add_members_bulk(gid, &srefs).expect("sender add");
    me.merge_pending_commit_for(gid).expect("merge senders");
    let tree = me.export_ratchet_tree_for(gid).expect("tree");
    for s in senders.iter_mut() {
        s.process_welcome(welcome.as_deref().expect("welcome"), Some(&tree))
            .expect("welcome");
    }

    for m in &inert_pool[bulk..] {
        let kp = m.generate_key_package().expect("epoch kp");
        let (commit, _, _, _) = me.add_members_bulk(gid, &[&kp]).expect("epoch add");
        me.merge_pending_commit_for(gid).expect("merge epoch");
        for s in senders.iter_mut() {
            s.process_incoming_message(gid, &commit)
                .expect("sender commit");
        }
    }

    for i in 0..messages {
        for s in senders.iter_mut() {
            let ct = s
                .send_message(gid, format!("m{i}").as_bytes())
                .expect("send");
            me.process_incoming_message(gid, &ct).expect("decrypt");
        }
    }
}

#[test]
#[ignore = "measurement - prints a table, asserts nothing"]
fn checkpoint_cost_scales_with_the_whole_state() {
    const INERT: usize = 40; // members who never send (one identity each)
    const EPOCHS: usize = 10; // single adds after the bulk one, so the tree has past epochs
    const MESSAGES: usize = 20; // frames per sender per group
    let inert_pool: Vec<MlsManager> = (0..INERT)
        .map(|i| device(&format!("inert-{i}"), "d"))
        .collect();
    let mut senders: Vec<MlsManager> = (0..3)
        .map(|i| device(&format!("sender-{i}"), "d"))
        .collect();

    println!();
    println!(
        "{:>7} {:>8} {:>12} {:>14} {:>14} {:>14}",
        "groups", "leaves", "state bytes", "1 decrypt ms", "save_state ms", "encrypted ms"
    );
    let mut me = device("me", "d");
    let mut built = 0;
    for target in [5usize, 20, 40, 80] {
        while built < target {
            build_group(
                &mut me,
                &format!("g-{built}"),
                &inert_pool,
                &mut senders,
                EPOCHS,
                MESSAGES,
            );
            built += 1;
        }
        // Warm: one checkpoint so the cache is filled, as on a running device.
        me.save_state().expect("warm");

        // ONE application message in ONE group, then the checkpoint the drain would write.
        let ct = senders[0].send_message("g-0", b"one more").expect("send");
        let t = Instant::now();
        me.process_incoming_message("g-0", &ct).expect("decrypt");
        let decrypt_ms = t.elapsed().as_secs_f64() * 1e3;

        let t = Instant::now();
        let plain = me.save_state().expect("save_state");
        let save_ms = t.elapsed().as_secs_f64() * 1e3;

        // A second message, so the encrypted path rebuilds too instead of reading the cache.
        let ct = senders[1]
            .send_message("g-0", b"and another")
            .expect("send");
        me.process_incoming_message("g-0", &ct).expect("decrypt");
        let t = Instant::now();
        let sealed = me.save_encrypted_with_key(&KEY).expect("encrypted");
        let enc_ms = t.elapsed().as_secs_f64() * 1e3;
        assert!(!sealed.is_empty());

        println!(
            "{:>7} {:>8} {:>12} {:>14.2} {:>14.1} {:>14.1}",
            target,
            INERT + 4,
            plain.len(),
            decrypt_ms,
            save_ms,
            enc_ms
        );
    }
}

/// THE KEYPACKAGE SHARE OF ONE CHECKPOINT (2026-10-13). A store Pixel 6a held 15.5 MB of state, 6 MB
/// of it 2535 KeyPackage bundles, and every checkpoint rewrites all of it. A bundle never changes
/// once minted - it is written at `build_key_package` and only ever deleted - so this measures what
/// the unchanged pile costs each save: the same 80-group state, checkpointed before and after
/// minting `KEY_PACKAGES` bundles on the measured device.
///
///   cargo test --release --test heavy_state_checkpoint -- --ignored --nocapture key_package_share
#[test]
#[ignore = "measurement - prints a table, asserts nothing"]
fn key_package_share_of_a_checkpoint() {
    const GROUPS: usize = 80;
    const KEY_PACKAGES: usize = 2535;
    let inert_pool: Vec<MlsManager> = (0..40)
        .map(|i| device(&format!("inert-{i}"), "d"))
        .collect();
    let mut senders: Vec<MlsManager> = (0..3)
        .map(|i| device(&format!("sender-{i}"), "d"))
        .collect();
    let mut me = device("me", "d");
    for g in 0..GROUPS {
        build_group(
            &mut me,
            &format!("g-{g}"),
            &inert_pool,
            &mut senders,
            10,
            20,
        );
    }

    // One application message, then the checkpoint a drain writes - the encrypted path rebuilds.
    let mut measure = |me: &mut MlsManager, label: &str, sender: usize| {
        let ct = senders[sender]
            .send_message("g-0", b"one more")
            .expect("send");
        me.process_incoming_message("g-0", &ct).expect("decrypt");
        let t = Instant::now();
        let sealed = me.save_encrypted_with_key(&KEY).expect("encrypted");
        let ms = t.elapsed().as_secs_f64() * 1e3;
        println!("{label:>22} {:>12} B {ms:>10.1} ms", sealed.len());
    };

    println!();
    measure(&mut me, "80 groups", 0);
    measure(&mut me, "80 groups (again)", 1);
    for _ in 0..KEY_PACKAGES {
        me.generate_key_package().expect("kp");
    }
    measure(&mut me, "+ 2535 KeyPackages", 2);
    measure(&mut me, "+ 2535 KP (again)", 0);
}
