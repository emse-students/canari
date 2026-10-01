//! What the cross-client rig can ask a BENCH build about its own native stores - and nothing a
//! store build carries.
//!
//! **WHY THE APP ANSWERS AND NOT THE RIG.** On Android the harness reads the app's files itself
//! (`run-as` on a debuggable APK). On the iPhone nothing outside the app can: the native stores sit
//! in the app's data container and in the App Group container `group.fr.emse.canari`, and no
//! lockdown service vends the App Group. So the app reports on them through its own WebView, which
//! the rig reaches over the WebKit inspector bridge (docs/wiki/cross-client-ios.md, O5 and O15).
//!
//! **GATED AT COMPILE TIME, NEVER AT RUN TIME.** The command and everything that touches a device
//! exist only under the `bench-observables` Cargo feature, which `ios.yml` enables for a `local_url`
//! build and for nothing else - the same mode that adds `tauri/devtools`, refuses `publish` and is
//! never signed for a store. A store binary does not contain a refusing stub: it contains nothing,
//! and `.github/scripts/bench-observables.sh` asserts that on every store archive (and the
//! opposite on every bench one, so the absence check cannot pass by looking at the wrong file).
//!
//! The pure halves below (`list_relative`, `footprint`, `graine_sessions`, the MLS snapshot and
//! damage) are also compiled under `cfg(test)`, so the host `cargo test` CI runs pins them without
//! the feature.
//!
//! **COUNTS AND NAMES, NEVER CONTENTS.** Seeds, the refresh credential and the MLS state are secrets;
//! what crosses the WebView is a count, a size, a truncated digest or a file NAME - the same rule as
//! `nativeResidue` on Android, whose output is read into a public repository.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The MLS state the app loads at start (`commands::storage`).
const MLS_BIN: &str = "mls.bin";
/// The Graine seed mirror (`commands::push::with_graine_mirror`), in each container that has one.
const GRAINE_SEEDS: &str = "graine_seeds.json";
/// The lock every writer of [`GRAINE_SEEDS`] takes, in the same directory.
const GRAINE_LOCK: &str = "graine_seeds.lock";
/// Where the rig's MLS snapshot is kept: inside the app data directory, so a wipe takes it too.
const SNAPSHOT_DIR: &str = "bench";
const SNAPSHOT_FILE: &str = "mls.bin.snapshot";

/// Every path under `root` down to `depth` levels, relative and `/`-separated, directories
/// included - what Android's `find -maxdepth 2` hands `classifyNativePaths`. Sorted, so two reads
/// of an unchanged tree are equal. A missing root is an empty list: there is nothing under it.
pub(crate) fn list_relative(root: &Path, depth: usize) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    walk(root, root, depth, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) -> Result<(), String> {
    if depth == 0 {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        out.push(rel);
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            walk(root, &path, depth - 1, out)?;
        }
    }
    Ok(())
}

/// How many files `root` holds, and how many bytes, recursively. A missing root is `(0, 0)`.
pub(crate) fn footprint(root: &Path) -> Result<(u64, u64), String> {
    if !root.exists() {
        return Ok((0, 0));
    }
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries =
            std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                files += 1;
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok((files, bytes))
}

/// How many Graine sessions the mirror in `dir` holds for `channel_id`: `None` when there is no
/// mirror at all, which is a different fact from a mirror holding none for this channel.
pub(crate) fn graine_sessions(dir: &Path, channel_id: &str) -> Result<Option<usize>, String> {
    let text = match std::fs::read_to_string(dir.join(GRAINE_SEEDS)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {GRAINE_SEEDS}: {e}")),
    };
    let root: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{GRAINE_SEEDS} unparsable: {e}"))?;
    Ok(Some(
        root.get(channel_id)
            .and_then(|c| c.as_object())
            .map_or(0, |c| c.len()),
    ))
}

/// Removes the seed mirror in `dir` under the lock its writers take, so a push writing a seed at
/// the same instant lands entirely before or entirely after. Returns whether a file was there.
///
/// The lock is opened only when the mirror exists: creating `graine_seeds.lock` in a container that
/// never had a mirror would leave a file this call invented.
pub(crate) fn remove_graine_mirror(dir: &Path) -> Result<bool, String> {
    let path = dir.join(GRAINE_SEEDS);
    if !path.exists() {
        return Ok(false);
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(GRAINE_LOCK))
        .map_err(|e| format!("open {GRAINE_LOCK}: {e}"))?;
    // Released when `lock` drops, on every return path.
    crate::commands::push::lock_exclusive(&lock).map_err(|e| format!("lock {GRAINE_LOCK}: {e}"))?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("remove {GRAINE_SEEDS}: {e}")),
    }
}

/// The size of `mls.bin` in `data_dir` and the first 16 hex digits of its SHA-256 - enough for a
/// row to prove the file it damaged or restored is the one the app now holds, and nothing of the
/// state itself. `None` when there is no state.
pub(crate) fn mls_identity(data_dir: &Path) -> Result<Option<(u64, String)>, String> {
    let bytes = match std::fs::read(data_dir.join(MLS_BIN)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {MLS_BIN}: {e}")),
    };
    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok(Some((bytes.len() as u64, hex)))
}

fn snapshot_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SNAPSHOT_DIR).join(SNAPSHOT_FILE)
}

/// Writes `data` over `path` through a temporary file renamed into place, as every `mls.bin`
/// writer does: a reader never sees half of it.
fn write_atomically(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("bench.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename onto {}: {e}", path.display()))
}

/// Copies `mls.bin` aside. The caller holds the `mls.bin` write lock.
pub(crate) fn snapshot_mls(data_dir: &Path) -> Result<u64, String> {
    let bytes =
        std::fs::read(data_dir.join(MLS_BIN)).map_err(|e| format!("read {MLS_BIN}: {e}"))?;
    std::fs::create_dir_all(data_dir.join(SNAPSHOT_DIR)).map_err(|e| e.to_string())?;
    write_atomically(&snapshot_path(data_dir), &bytes)?;
    Ok(bytes.len() as u64)
}

/// Puts the snapshot back over `mls.bin`. The caller holds the `mls.bin` write lock.
pub(crate) fn restore_mls(data_dir: &Path) -> Result<u64, String> {
    let bytes = std::fs::read(snapshot_path(data_dir))
        .map_err(|e| format!("no snapshot to restore ({e}) - take one first"))?;
    write_atomically(&data_dir.join(MLS_BIN), &bytes)?;
    Ok(bytes.len() as u64)
}

/// The two damages the CORRUPT rows apply to the web store, applied to `mls.bin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Damage {
    /// Cut to HALF its length - what an interrupted flush or a full disk leaves (CORRUPT-1).
    Truncate,
    /// One byte XORed at the midpoint, length untouched, so the failure lands on the AEAD tag
    /// rather than on any structural check (CORRUPT-2).
    Flip,
}

impl Damage {
    pub(crate) fn parse(mode: &str) -> Result<Self, String> {
        match mode {
            "truncate" => Ok(Self::Truncate),
            "flip" => Ok(Self::Flip),
            other => Err(format!("unknown damage mode {other:?} - truncate or flip")),
        }
    }
}

/// Damages `mls.bin`, and REFUSES unless a snapshot exists: a destructive control is gated on the
/// way back being in hand, so a run that proves a defect never also destroys the device's state.
/// The caller holds the `mls.bin` write lock. Returns the length before and after.
pub(crate) fn damage_mls(data_dir: &Path, damage: Damage) -> Result<(u64, u64), String> {
    if !snapshot_path(data_dir).exists() {
        return Err(
            "refused: no snapshot of mls.bin - take one first, so the state can be given back"
                .into(),
        );
    }
    let mut bytes =
        std::fs::read(data_dir.join(MLS_BIN)).map_err(|e| format!("read {MLS_BIN}: {e}"))?;
    let before = bytes.len() as u64;
    if bytes.is_empty() {
        return Err(format!("{MLS_BIN} is empty - nothing to damage"));
    }
    match damage {
        Damage::Truncate => bytes.truncate(bytes.len() / 2),
        Damage::Flip => {
            let mid = bytes.len() / 2;
            bytes[mid] ^= 0xFF;
        }
    }
    write_atomically(&data_dir.join(MLS_BIN), &bytes)?;
    Ok((before, bytes.len() as u64))
}

/// The App Group container's path, asked of Foundation - the only API that knows it.
///
/// Through the Objective-C runtime rather than a function of ours in `canari_push.mm`: `libapp.a`
/// is linked into the notification extension too, and a Rust reference to an app-only symbol would
/// leave the extension's link with an undefined one. Foundation is linked into both.
#[cfg(all(feature = "bench-observables", target_os = "ios"))]
fn app_group_dir() -> Result<PathBuf, String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::{c_char, CStr};

    objc2::rc::autoreleasepool(|_| {
        let fm_class = AnyClass::get(c"NSFileManager").ok_or("NSFileManager is not loaded")?;
        let str_class = AnyClass::get(c"NSString").ok_or("NSString is not loaded")?;
        // SAFETY: plain Foundation messages with the argument and return types their headers
        // declare; every object returned is autoreleased into the pool around this block.
        unsafe {
            let fm: *mut AnyObject = msg_send![fm_class, defaultManager];
            let ident: *mut AnyObject =
                msg_send![str_class, stringWithUTF8String: c"group.fr.emse.canari".as_ptr()];
            let url: *mut AnyObject =
                msg_send![fm, containerURLForSecurityApplicationGroupIdentifier: ident];
            if url.is_null() {
                return Err("the App Group container is unavailable (entitlement missing?)".into());
            }
            let path: *mut AnyObject = msg_send![url, path];
            let utf8: *const c_char = msg_send![path, UTF8String];
            if utf8.is_null() {
                return Err("the App Group URL has no path".into());
            }
            Ok(PathBuf::from(
                CStr::from_ptr(utf8).to_string_lossy().into_owned(),
            ))
        }
    })
}

/// No App Group exists off iOS; the answer says so rather than inventing a directory.
#[cfg(all(feature = "bench-observables", not(target_os = "ios")))]
fn app_group_dir() -> Result<PathBuf, String> {
    Err("no App Group container on this platform".into())
}

/// The bench's one question, answered by the app about its own native stores.
///
/// `op`:
/// - `list` - relative paths under the app data directory (`app`) and the App Group (`group`),
///   two levels deep, for `nativeResidue` to classify
/// - `footprint` - files and bytes of the app's whole data container (`HOME`) and of the App Group
/// - `graine` (`channelId`) - the Graine sessions each mirror holds for one channel
/// - `forget_graine` - removes both mirrors, the state of a phone whose seed push never arrived
/// - `mls` - size and truncated digest of `mls.bin`
/// - `snapshot`, `restore` - `mls.bin` aside and back
/// - `damage` (`mode`: `truncate` | `flip`) - refused without a snapshot
/// - `clear_refresh` - erases the native refresh credential (`auth-native.json`) through the store
///   plugin's live instance, so the running app reads its absence (TAB-6 on the iPhone, O15)
///
/// The App Group half of an answer may carry `groupError` while the app half stands: an unreadable
/// container is reported, never read as an empty one.
#[cfg(feature = "bench-observables")]
#[tauri::command]
pub(crate) async fn bench_native_store(
    app: tauri::AppHandle,
    op: String,
    channel_id: Option<String>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    use serde_json::json;
    use tauri::Manager;

    log::debug!("[BENCH] bench_native_store op={op}");
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let group = app_group_dir();
    let group_error = group.as_ref().err().cloned();
    if let Some(e) = &group_error {
        log::warn!("[BENCH] App Group unreadable: {e}");
    }

    let answer = match op.as_str() {
        "list" => {
            let app_paths = list_relative(&data_dir, 2)?;
            let group_paths = match &group {
                Ok(g) => Some(list_relative(g, 2)?),
                Err(_) => None,
            };
            json!({ "app": app_paths, "group": group_paths, "groupError": group_error })
        }
        "footprint" => {
            let home = app.path().home_dir().map_err(|e| e.to_string())?;
            let (files, bytes) = footprint(&home)?;
            let group_fp = match &group {
                Ok(g) => {
                    let (f, b) = footprint(g)?;
                    Some(json!({ "files": f, "bytes": b }))
                }
                Err(_) => None,
            };
            json!({ "files": files, "bytes": bytes, "appGroup": group_fp, "groupError": group_error })
        }
        "graine" => {
            let channel = channel_id.ok_or("graine needs channelId")?;
            let group_count = match &group {
                Ok(g) => graine_sessions(g, &channel)?,
                Err(_) => None,
            };
            json!({
                "app": graine_sessions(&data_dir, &channel)?,
                "group": group_count,
                "groupError": group_error,
            })
        }
        "forget_graine" => {
            let app_had = remove_graine_mirror(&data_dir)?;
            let group_had = match &group {
                Ok(g) => Some(remove_graine_mirror(g)?),
                Err(_) => None,
            };
            let left = data_dir.join(GRAINE_SEEDS).exists()
                || group
                    .as_ref()
                    .map(|g| g.join(GRAINE_SEEDS).exists())
                    .unwrap_or(false);
            log::info!("[BENCH] graine mirror forgotten app={app_had} group={group_had:?}");
            json!({
                "removed": !left && group_error.is_none(),
                "appHad": app_had,
                "groupHad": group_had,
                "groupError": group_error,
            })
        }
        "mls" => match mls_identity(&data_dir)? {
            Some((bytes, sha)) => json!({ "bytes": bytes, "sha256_16": sha }),
            None => json!({ "bytes": null }),
        },
        "snapshot" | "restore" | "damage" => {
            // The lock every `mls.bin` writer takes, so the copy is never of a half-written file
            // and a write of ours never interleaves with the app's own.
            let _guard = crate::concurrency::mls_bin_write_lock()
                .lock()
                .map_err(|_| "mls_bin write lock poisoned".to_string())?;
            match op.as_str() {
                "snapshot" => json!({ "bytes": snapshot_mls(&data_dir)? }),
                "restore" => json!({ "bytes": restore_mls(&data_dir)? }),
                _ => {
                    let damage = Damage::parse(mode.as_deref().unwrap_or(""))?;
                    let (before, after) = damage_mls(&data_dir, damage)?;
                    log::warn!("[BENCH] mls.bin damaged ({damage:?}) {before} -> {after} bytes");
                    json!({ "before": before, "after": after })
                }
            }
        }
        "clear_refresh" => {
            use tauri_plugin_store::StoreExt;
            // `nativeRefreshToken.ts`'s file and key. The LIVE instance, when the app has loaded it,
            // is the one to edit: the plugin caches a store, so deleting the file under it would
            // leave the running app reading the credential from memory.
            let store = match app.get_store("auth-native.json") {
                Some(s) => s,
                None => app
                    .store_builder("auth-native.json")
                    .disable_auto_save()
                    .build()
                    .map_err(|e| e.to_string())?,
            };
            let had = store.has("refresh_token");
            store.delete("refresh_token");
            store.save().map_err(|e| e.to_string())?;
            log::info!("[BENCH] refresh credential cleared (had={had})");
            json!({ "had": had, "present": store.has("refresh_token") })
        }
        other => return Err(format!("unknown bench op {other:?}")),
    };
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("canari-bench-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_is_relative_two_deep_and_sorted() {
        let d = scratch("list");
        std::fs::write(d.join("mls.bin"), b"x").unwrap();
        std::fs::create_dir_all(d.join("files/deep/deeper")).unwrap();
        std::fs::write(d.join("files/avatar_1.jpg"), b"x").unwrap();
        let got = list_relative(&d, 2).unwrap();
        assert_eq!(
            got,
            vec!["files", "files/avatar_1.jpg", "files/deep", "mls.bin"]
        );
        assert!(list_relative(&d.join("absent"), 2).unwrap().is_empty());
    }

    #[test]
    fn footprint_counts_files_and_bytes() {
        let d = scratch("fp");
        std::fs::write(d.join("a"), b"abc").unwrap();
        std::fs::create_dir_all(d.join("s")).unwrap();
        std::fs::write(d.join("s/b"), b"de").unwrap();
        assert_eq!(footprint(&d).unwrap(), (2, 5));
        assert_eq!(footprint(&d.join("absent")).unwrap(), (0, 0));
    }

    #[test]
    fn graine_sessions_separates_no_mirror_from_none_for_the_channel() {
        let d = scratch("graine");
        assert_eq!(graine_sessions(&d, "c1").unwrap(), None);
        std::fs::write(d.join(GRAINE_SEEDS), r#"{"c1":{"s1":{},"s2":{}}}"#).unwrap();
        assert_eq!(graine_sessions(&d, "c1").unwrap(), Some(2));
        assert_eq!(graine_sessions(&d, "c2").unwrap(), Some(0));
        assert!(remove_graine_mirror(&d).unwrap());
        assert_eq!(graine_sessions(&d, "c1").unwrap(), None);
        assert!(!remove_graine_mirror(&d).unwrap());
    }

    #[test]
    fn a_mirror_that_never_existed_leaves_no_lock_behind() {
        let d = scratch("nolock");
        assert!(!remove_graine_mirror(&d).unwrap());
        assert!(!d.join(GRAINE_LOCK).exists());
    }

    #[test]
    fn damage_is_refused_without_a_snapshot_and_restore_gives_the_state_back() {
        let d = scratch("mls");
        let state: Vec<u8> = (0..=255u8).collect();
        std::fs::write(d.join(MLS_BIN), &state).unwrap();
        let original = mls_identity(&d).unwrap().unwrap();

        assert!(damage_mls(&d, Damage::Flip)
            .unwrap_err()
            .starts_with("refused"));
        assert_eq!(mls_identity(&d).unwrap().unwrap(), original);

        assert_eq!(snapshot_mls(&d).unwrap(), 256);
        assert_eq!(damage_mls(&d, Damage::Flip).unwrap(), (256, 256));
        let flipped = std::fs::read(d.join(MLS_BIN)).unwrap();
        assert_eq!(
            flipped.iter().zip(&state).filter(|(a, b)| a != b).count(),
            1
        );
        assert_eq!(flipped[128], state[128] ^ 0xFF);

        assert_eq!(restore_mls(&d).unwrap(), 256);
        assert_eq!(damage_mls(&d, Damage::Truncate).unwrap(), (256, 128));
        assert_eq!(restore_mls(&d).unwrap(), 256);
        assert_eq!(mls_identity(&d).unwrap().unwrap(), original);
    }

    #[test]
    fn damage_modes_parse_and_an_unknown_one_is_refused() {
        assert_eq!(Damage::parse("truncate").unwrap(), Damage::Truncate);
        assert_eq!(Damage::parse("flip").unwrap(), Damage::Flip);
        assert!(Damage::parse("random").is_err());
    }

    #[test]
    fn no_state_is_none_not_an_error() {
        let d = scratch("none");
        assert_eq!(mls_identity(&d).unwrap(), None);
        assert!(restore_mls(&d).is_err());
    }
}
