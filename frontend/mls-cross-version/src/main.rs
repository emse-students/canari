//! ONE SIDE OF A CONVERSATION HELD BETWEEN TWO VERSIONS OF THIS CRATE.
//!
//! `mls-core/tests/cross_version_state.rs` proves today's code opens what v0.14.14 WROTE, and says
//! so itself: *"It says nothing about whether today's code writes something v0.14.14 could read,
//! which is the other direction and matters when a fleet is mixed; that needs the old binary, not
//! an old fixture."* This is that old binary, and the reason it cannot be a fixture is that MLS
//! encryption is not deterministic - there is no frozen ciphertext to re-derive and compare, the
//! way `cross_version_push.rs` closes the same question for a raw AEAD.
//!
//! SO THE OLD CODE IS RUN, NOT IMITATED. `mls-forward-compat.sh` checks the old tag out into a
//! worktree, copies THIS directory into it, and builds it there - where `path = "../mls-core"`
//! resolves to the old library instead of this one. One source, two binaries, and no version
//! juggling in a manifest: if the two APIs ever diverge, the old build fails to compile and says
//! exactly which call it was.
//!
//! EACH STEP IS ITS OWN PROCESS, and that is the point rather than an inconvenience. A shared
//! process could pass an in-memory `MlsManager` between the two halves and prove nothing; here
//! every step ends by serialising its state to disk and the next one loads it back, so the only
//! things that ever cross between the versions are BYTES - a key package, a welcome, a ratchet
//! tree, a frame. Exactly what crosses between two phones.
//!
//! State files never cross versions: each side loads only what it wrote. That direction is the
//! backward test's subject, and mixing the two would make one failure report answer for both.

use mls_core::MlsManager;
use std::path::Path;
use std::process::exit;

/// Loads the side's state if it has one, else mints a fresh identity.
///
/// A missing file is NOT an error: the first step of each side is the one that creates it.
fn open(state: &Path, user: &str) -> MlsManager {
    let blob = std::fs::read(state).ok();
    MlsManager::load_or_create(user, "dev1", blob)
        .unwrap_or_else(|e| fail(&format!("load_or_create({user}) failed: {e:?}")))
}

/// Writes the side's state back. Every command ends here, including the read-only-looking ones:
/// decrypting ADVANCES A RATCHET, and a step that forgot to persist would leave the next one
/// replaying a generation that is already spent.
fn save(mgr: &MlsManager, state: &Path) {
    let bytes = mgr
        .save_state()
        .unwrap_or_else(|e| fail(&format!("save_state failed: {e:?}")));
    std::fs::write(state, bytes).unwrap_or_else(|e| fail(&format!("writing state failed: {e}")));
}

fn read_file(p: &str) -> Vec<u8> {
    std::fs::read(p).unwrap_or_else(|e| fail(&format!("reading {p} failed: {e}")))
}

fn write_file(p: &str, bytes: &[u8]) {
    std::fs::write(p, bytes).unwrap_or_else(|e| fail(&format!("writing {p} failed: {e}")));
}

/// Every failure leaves through here, so the script above reads one shape whichever side broke.
fn fail(msg: &str) -> ! {
    eprintln!("mls-cross-version: {msg}");
    exit(1)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        fail("usage: <state-file> <user-id> <command> [args...]");
    }
    let state = Path::new(&args[0]);
    let user = &args[1];
    let cmd = args[2].as_str();
    let rest = &args[3..];

    match cmd {
        // Mints the identity and opens the group. Only the OLD side runs this, so the group this
        // conversation happens in is one the old version built.
        "create-group" => {
            let mut mgr = open(state, user);
            mgr.create_group(rest[0].clone())
                .unwrap_or_else(|e| fail(&format!("create_group failed: {e:?}")));
            save(&mgr, state);
        }
        // The joiner's half. The key package carries private material into the provider's storage,
        // so this MUST persist - a key package published from state that was never saved is one
        // whose Welcome can never be opened.
        "gen-kp" => {
            let mgr = open(state, user);
            let kp = mgr
                .generate_key_package()
                .unwrap_or_else(|e| fail(&format!("generate_key_package failed: {e:?}")));
            write_file(&rest[0], &kp);
            save(&mgr, state);
        }
        // Adds the joiner and MERGES - this driver has no server to validate against, so it stands
        // in for one that accepted. [[C7]] Option A's ordering is still respected: the merge comes
        // after the decision, and the ratchet tree is exported AFTER the merge so it describes the
        // epoch the joiner is about to land in rather than the one before it.
        "add-member" => {
            let mut mgr = open(state, user);
            let (gid, kp_in, welcome_out, tree_out) = (&rest[0], &rest[1], &rest[2], &rest[3]);
            let kp = read_file(kp_in);
            let (_commit, welcome, _added, skipped) = mgr
                .add_members_bulk(gid, &[&kp])
                .unwrap_or_else(|e| fail(&format!("add_members_bulk failed: {e:?}")));
            if !skipped.is_empty() {
                fail(
                    "the other version's key package was SKIPPED, not added - it did not validate",
                );
            }
            mgr.merge_pending_commit_for(gid)
                .unwrap_or_else(|e| fail(&format!("merge_pending_commit_for failed: {e:?}")));
            let welcome = welcome.unwrap_or_else(|| fail("no Welcome was produced for the joiner"));
            let tree = mgr
                .export_ratchet_tree_for(gid)
                .unwrap_or_else(|e| fail(&format!("export_ratchet_tree_for failed: {e:?}")));
            write_file(welcome_out, &welcome);
            write_file(tree_out, &tree);
            save(&mgr, state);
        }
        // Opens the other version's Welcome. Prints the group id it landed in, which the script
        // feeds back as an argument rather than assuming - the id is the group's, not ours.
        "join" => {
            let mut mgr = open(state, user);
            let (welcome, tree) = (read_file(&rest[0]), read_file(&rest[1]));
            let gid = mgr
                .process_welcome(&welcome, Some(&tree))
                .unwrap_or_else(|e| fail(&format!("process_welcome failed: {e:?}")));
            save(&mgr, state);
            println!("{gid}");
        }
        "send" => {
            let mut mgr = open(state, user);
            let (gid, text, out) = (&rest[0], &rest[1], &rest[2]);
            let frame = mgr
                .send_message(gid, text.as_bytes())
                .unwrap_or_else(|e| fail(&format!("send_message failed: {e:?}")));
            write_file(out, &frame);
            save(&mgr, state);
        }
        // THE ASSERTION, and it is made HERE rather than by the script: comparing plaintext inside
        // the process that decrypted it means the script is never trusted with a comparison it
        // could get subtly wrong - an encoding, or a trailing newline from a shell capture.
        "read" => {
            let mut mgr = open(state, user);
            let (gid, frame, expect) = (&rest[0], read_file(&rest[1]), &rest[2]);
            let out = mgr
                .process_incoming_message(gid, &frame)
                .unwrap_or_else(|e| {
                    fail(&format!(
                    "process_incoming_message REFUSED a frame minted by the other version: {e:?}. \
                     This is the failure this gate exists for - a wire format moved."
                ))
                });
            let got = out.unwrap_or_else(|| {
                fail("the frame decrypted to NO application payload, so it was read as a handshake")
            });
            let got = String::from_utf8_lossy(&got).to_string();
            if got != *expect {
                fail(&format!("decrypted {got:?}, expected {expect:?}"));
            }
            save(&mgr, state);
            println!("{got}");
        }
        // Prints the epoch, so the script can state that both sides agree on where they are.
        "epoch" => {
            let mgr = open(state, user);
            let epoch = mgr
                .get_epoch(&rest[0])
                .unwrap_or_else(|e| fail(&format!("get_epoch failed: {e:?}")));
            println!("{epoch}");
        }
        other => fail(&format!("unknown command {other:?}")),
    }
}
