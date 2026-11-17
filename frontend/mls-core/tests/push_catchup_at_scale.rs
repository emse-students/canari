//! WHAT A SALON PUSH'S SEED-FRAME CATCH-UP COSTS AGAINST A KEY GROUP OF PRODUCTION SIZE.
//!
//! The bench of channel-encryption section 27 reached the seed frame's commit catch-up only with a
//! key group of a few devices at epochs 6 to 9. Production key groups hold up to ~150-400 active
//! devices and gain commits daily, and a shut phone's `mls.bin` re-applies EVERY commit since the
//! app last ran, in memory, on every salon push - nothing in the background persists a commit
//! (`decrypt_push_message_with_commits_with_key`, `src-tauri/src/mobile/background.rs`). That path
//! runs under `MlsStateLock` (`tryLock(5 s)` on Android), after `POST mls/push/commits` (5 s read
//! timeout on both platforms), and on iOS inside the notification extension's memory and time
//! limits. This file measures the three quantities those budgets are spent on - wall time, peak
//! heap, bytes on the wire - against the shape of a real key group, on this workstation:
//!
//! - every member entered by its OWN external commit, as a key group is entered (section 4.4,
//!   section 20), so the tree's parent nodes are filled the way production's are, not left blank
//!   by one bulk add;
//! - the measured device's sealed state is taken at epoch E, then K further device joins land
//!   (each one commit, as `newdevice.mjs` makes on the rig), then a member seals an application
//!   frame at E + K - the seed frame;
//! - the catch-up is the push path's own sequence: `load_with_key` of the sealed bytes, `K` x
//!   `process_incoming_message`, one `process_incoming_message_with_sender` of the frame.
//!
//! Run it in release (debug crypto is an order of magnitude slower and measures nothing real):
//!
//!   cargo test --release --test push_catchup_at_scale -- --ignored --nocapture
//!
//! Workstation figures are a FLOOR for a phone: a 2019 mid-range SoC (the Mi 9T) runs this kind of
//! code roughly 3-5x slower than a desktop core. The table carries enough to scale either way.
//! The non-ignored test pins the mechanism (a device hundreds of commits behind in a group of
//! production size still opens the frame) at a size debug builds finish quickly.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use mls_core::MlsManager;

/// Counts live heap bytes and the high-water mark, so the extension's memory question is
/// answered by a number rather than an estimate. Process-wide: the measurement resets the peak
/// to the live count right before the sequence it weighs.
struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let now = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

const KEY: [u8; 32] = [11u8; 32];
const GID: &str = "key-group";

fn device(user: &str, dev: &str) -> MlsManager {
    MlsManager::load_or_create(user, dev, None).unwrap_or_else(|e| panic!("{user}:{dev}: {e}"))
}

/// One device enters the key group by its own external commit from the creator's current
/// GroupInfo, and the creator merges it. Returns the commit as the server's log would store it.
fn external_join(creator: &mut MlsManager, joiner: &mut MlsManager) -> Vec<u8> {
    let info = creator.export_group_info(GID).expect("export_group_info");
    let (gid, commit) = joiner
        .join_by_external_commit(&info)
        .expect("join_by_external_commit");
    assert_eq!(gid, GID);
    joiner.merge_pending_commit_for(GID).expect("joiner merge");
    creator
        .process_incoming_message(GID, &commit)
        .expect("creator applies the join");
    commit
}

/// A key group of `members` devices, each entered by external commit, with the measured device
/// joining LAST so the setup never makes it apply the build. Returns (creator, measured device).
///
/// `departed` more devices join and are then removed, every other leaf, in commits of 20: the
/// blank nodes a real key group's departures leave behind. They are what makes a production commit
/// heavy - every blank on a joiner's copath is resolved to the nodes under it, each sealed to
/// separately. On production on 2026-11-17 the largest key group stood at epoch 403 with 206
/// active devices, and its commits of the past week averaged 6.2 KB in the log; a tree with no
/// departure gives commits of ~0.9 KB and would understate the wire and the work.
fn key_group(members: usize, departed: usize, tag: &str) -> (MlsManager, MlsManager) {
    let mut creator = device(&format!("{tag}-creator"), "d");
    creator.create_group(GID.to_string()).expect("create_group");
    let total = members.saturating_sub(2) + departed;
    let mut leaving: Vec<String> = Vec::with_capacity(departed);
    for i in 0..total {
        let user = format!("{tag}-member-{i}");
        let mut m = device(&user, "d");
        external_join(&mut creator, &mut m);
        if i % 2 == 1 && leaving.len() < departed {
            leaving.push(format!("{user}:d"));
        }
    }
    // An odd count of joiners leaves fewer odd leaves than asked for: take the rest from the even.
    let mut i = 0;
    while leaving.len() < departed {
        leaving.push(format!("{tag}-member-{i}:d"));
        i += 2;
    }
    for batch in leaving.chunks(20) {
        let refs: Vec<&str> = batch.iter().map(String::as_str).collect();
        creator
            .remove_members_for_devices(GID, &refs)
            .expect("remove departed devices");
        creator
            .merge_pending_commit_for(GID)
            .expect("merge removal");
    }
    let mut me = device(&format!("{tag}-me"), "d");
    external_join(&mut creator, &mut me);
    (creator, me)
}

/// What one catch-up cost: the push path's sequence, timed in its three phases.
struct Reading {
    load_ms: f64,
    apply_ms: f64,
    decrypt_ms: f64,
    peak_heap: usize,
}

/// Runs the background push path's sequence on `sealed` and returns what it cost. Panics unless
/// the frame opens to `expected`: a catch-up that is fast because it failed measures nothing.
fn catch_up(
    sealed: &[u8],
    me_user: &str,
    commits: &[Vec<u8>],
    frame: &[u8],
    expected: &[u8],
) -> Reading {
    let floor = LIVE.load(Ordering::Relaxed);
    PEAK.store(floor, Ordering::Relaxed);

    let t = Instant::now();
    let mut manager = MlsManager::load_with_key(me_user, "d", Some(sealed.to_vec()), &KEY)
        .expect("load_with_key");
    let load_ms = t.elapsed().as_secs_f64() * 1e3;

    let t = Instant::now();
    for (i, c) in commits.iter().enumerate() {
        manager
            .process_incoming_message(GID, c)
            .unwrap_or_else(|e| panic!("commit {i} of {} refused: {e}", commits.len()));
    }
    let apply_ms = t.elapsed().as_secs_f64() * 1e3;

    let t = Instant::now();
    let app = manager
        .process_incoming_message_with_sender(GID, frame)
        .expect("frame decrypt")
        .expect("an application message");
    let decrypt_ms = t.elapsed().as_secs_f64() * 1e3;
    assert_eq!(
        app.plaintext.as_slice(),
        expected,
        "the frame opened to the wrong bytes"
    );

    let peak_heap = PEAK.load(Ordering::Relaxed).saturating_sub(floor);
    drop(manager);
    Reading {
        load_ms,
        apply_ms,
        decrypt_ms,
        peak_heap,
    }
}

/// Builds the group, seals the measured device at epoch E, lands `max(behind)` device joins, and
/// for each K in `behind` seals a frame at E + K and measures the catch-up from E. `ballast` is a
/// number of KeyPackages minted on the measured device before it is sealed - a store phone carried
/// 2535 of them (6 of its 15.5 MB, `heavy_state_checkpoint.rs`), and the push path loads them all.
fn run(
    members: usize,
    departed: usize,
    behind: &[usize],
    ballast: usize,
    tag: &str,
) -> Vec<(usize, usize, Reading)> {
    let (mut creator, me) = key_group(members, departed, tag);
    if ballast > 0 {
        me.generate_key_packages(ballast)
            .expect("ballast key packages");
    }
    let sealed = me.save_encrypted_with_key(&KEY).expect("seal at epoch E");
    let me_user = format!("{tag}-me");

    let max_k = behind.iter().copied().max().unwrap_or(0);
    let mut commits = Vec::with_capacity(max_k);
    let mut frames = Vec::new();
    for k in 1..=max_k {
        let mut newcomer = device(&format!("{tag}-new-{k}"), "d");
        commits.push(external_join(&mut creator, &mut newcomer));
        if behind.contains(&k) {
            let text = format!("seed at +{k}").into_bytes();
            let frame = creator.send_message(GID, &text).expect("seal the frame");
            frames.push((k, frame, text));
        }
    }

    frames
        .into_iter()
        .map(|(k, frame, text)| {
            // As `POST mls/push/commits` carries them: base64, a third heavier than the bytes.
            let wire: usize = commits[..k].iter().map(|c| c.len().div_ceil(3) * 4).sum();
            let reading = catch_up(&sealed, &me_user, &commits[..k], &frame, &text);
            (k, wire, reading)
        })
        .collect()
}

fn mb(bytes: usize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

/// The pin, small enough that a debug build finishes it in seconds on every CI run: a device
/// sealed in a key group whose tree carries departures, then a dozen device joins behind, still
/// opens the frame through the push path's sequence. The production sizes are the measurement
/// below, run by hand in release.
#[test]
fn a_device_commits_behind_a_key_group_with_departures_opens_the_frame() {
    let readings = run(16, 8, &[12], 0, "pin");
    assert_eq!(readings.len(), 1);
    assert_eq!(readings[0].0, 12);
}

#[test]
#[ignore = "measurement - prints a table; run in release"]
fn seed_frame_catch_up_at_production_key_group_size() {
    println!();
    println!(
        "{:>7} {:>8} {:>7} {:>8} {:>10} {:>8} {:>9} {:>10} {:>9} {:>9}",
        "members",
        "departed",
        "behind",
        "ballast",
        "wire KiB",
        "load ms",
        "apply ms",
        "ms/commit",
        "frame ms",
        "peak MiB"
    );
    // 206 active devices behind 200 departures: production's largest key group on 2026-11-17
    // (epoch 403). 400: the top of the range the entry names. Behind 30 / 150 / 400: about a week,
    // a month and the most a year of that group's commits would be (28, 148 and ~400 measured).
    for (members, departed, ballast) in [
        (206usize, 200usize, 0usize),
        (400, 200, 0),
        (400, 200, 2535),
    ] {
        let tag = format!("m{members}-d{departed}-b{ballast}");
        for (k, wire, r) in run(members, departed, &[30, 150, 400], ballast, &tag) {
            println!(
                "{:>7} {:>8} {:>7} {:>8} {:>10.1} {:>8.1} {:>9.1} {:>10.2} {:>9.2} {:>9.2}",
                members,
                departed,
                k,
                ballast,
                wire as f64 / 1024.0,
                r.load_ms,
                r.apply_ms,
                r.apply_ms / k as f64,
                r.decrypt_ms,
                mb(r.peak_heap)
            );
        }
    }
}
