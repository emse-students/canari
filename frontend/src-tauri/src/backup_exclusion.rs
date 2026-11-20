//! Keeps every byte the iOS app stores out of iCloud backup, computer backup and the device-to-device
//! transfer of a new phone (iOS only; Android refuses both channels in `data_extraction_rules.xml`).
//!
//! **WHY NOTHING MAY TRAVEL.** The local stores are sealed under the at-rest key, a Keychain item that
//! is `ThisDeviceOnly` and never leaves the phone. A copy of the stores on a new phone is therefore
//! unreadable there - the PIN screen then calls the data damaged (reported 2026-11-20, a member who
//! moved to a new iPhone). And even WITH the key, a copied install would be a second holder of the
//! same MLS device identity, which MLS forbids. A new phone enrols as a new device
//! (`frontend/src/lib/backup.ts`); what it must receive from the old one is nothing.
//!
//! **DIRECTORIES, NOT FILES, AND AT EVERY LAUNCH.** `NSURLIsExcludedFromBackupKey` on a directory
//! excludes what it holds (Apple, "Optimizing your app's data for iCloud backup": "move those files
//! into a directory and update the directory's isExcludedFromBackup resource value"). A per-file flag
//! is lost on every atomic rewrite, a directory flag is not - but a directory something deletes and
//! recreates loses it, so the pass runs at every launch, in `setup`, BEFORE the WebView exists: each
//! directory is created when absent (WebKit creates `Library/WebKit` lazily, on the page's first
//! storage access), flagged, and the flag READ BACK, so the log says what the file system holds and
//! not what was asked. The flag sits on parents nothing of ours deletes: `clear_app_data` removes the
//! app's own `fr.emse.canari` directory, never `Library/Application Support`.
//!
//! **THE APP GROUP: A STORE DIRECTORY, NEVER THE ROOT** (1.7.2). The App Group container's ROOT
//! refuses the flag (read on the bench iPhone, `1.7.2-alpha.1`: "setResourceValue refused", at every
//! launch), and a full backup then carried 35 App Group files - `mls.bin`, the push credential, the
//! names, the avatars. The container belongs to the system, not to the app. So EVERYTHING the app
//! and its two extensions share lives in [`APP_GROUP_STORE`], a directory of ours inside it: every
//! process resolves the App Group to that directory and to nothing else (Rust's
//! `app_group::app_group_dir`, which the app's Objective-C and the notification extension reach
//! through `canari_app_group_store_dir`; the share extension's `ShareCapture.storeDir`, which links
//! no Rust). Each resolver, at its process's first use, creates the directory when absent, FLAGS IT
//! (created or found: one call per process), then moves into it every entry of ours an older build
//! left at the root ([`open_store`], [`migrate_root`]). Why no write of this build lands unflagged:
//! a file written into the store is under a flagged parent from its first byte, whoever writes it
//! and whenever, and no process of this build writes at the root.
//!
//! **What the move may touch is an ALLOWLIST** ([`OURS_STEMS`], [`OURS_PREFIXES`]): the names our
//! builds write. A name nobody listed is counted, left where it is, and fails the verdict - it is
//! either a writer this list missed (fix the list) or not ours (never move it).
//!
//! **A CONFLICT HAS ONE CAUSE, AND THE ROOT COPY WINS.** The moves run under an exclusive lock on the
//! store, so two processes of this build never race one name. A name both at the root and in the
//! store therefore means an OLDER build wrote the root AFTER a move - a downgrade, then this build
//! again - and the root copy is the newer one. The store's copy goes to ONE quarantine generation,
//! [`SUPERSEDED_DIR`] inside the flagged store (a previous quarantined copy of that name is replaced,
//! so it never grows, and nothing is deleted outright that was current), and the root copy moves in.
//! The launch verdict says it once, at WARN.
//!
//! **WHAT IT COVERS**, measured on the bench iPhone's backup manifest of 2026-11-20 (mobile wiki,
//! "Nothing local travels to another phone"): `Library/Application Support` (Tauri's data dir - the
//! SQLite stores, `mls.bin`, the at-rest markers, the identity and push files - plus Firebase's),
//! `Library/WebKit` (IndexedDB, LocalStorage, CacheStorage: 254 MB on that phone), `Library/Preferences`
//! (the notification-id map names conversations), `Library/Cookies` and `Library/HTTPStorages`
//! (empty there, the system's network stores), and the App Group's store. NOT covered, on purpose:
//! `Documents` (only files the member saved there himself - Apple: never exclude user documents),
//! `Library/Caches` / `tmp` (never backed up), and the App Group root's system entries
//! ([`RootEntry::System`]). The extensions' own containers held nothing in that manifest.
//!
//! **A FLAG IS GUIDANCE, NOT A GUARANTEE** - Apple's words: "it's not a mechanism to guarantee those
//! items never appear in a backup or on a restored device". A backup taken BEFORE this build still
//! carries everything, and Apple documents nothing about the device-to-device transfer. So the app
//! must still recognise a copied install by itself (the at-rest key proven absent); this pass only
//! stops new backups from carrying the data.

use std::path::{Path, PathBuf};

/// The directories of the app container the pass excludes, relative to its home. Each is created
/// when absent, so it carries the flag before anything writes into it - which is why the two the
/// system's network stack creates on demand (`Cookies`, `HTTPStorages`, absent on the bench phone)
/// are listed too: whatever lands there is covered from its first byte.
pub(crate) const CONTAINER_DIRS: [&str; 5] = [
    "Library/Application Support",
    "Library/WebKit",
    "Library/Preferences",
    "Library/Cookies",
    "Library/HTTPStorages",
];

/// The directory inside the App Group container that holds everything the app and its extensions
/// share - the ONE name, mirrored by the share extension's `ShareCapture.storeDirName` (a source
/// test holds the two equal).
pub(crate) const APP_GROUP_STORE: &str = "store";

/// The label the App Group store is logged under: its path carries a container id, the label does
/// not.
pub(crate) const APP_GROUP_LABEL: &str = "AppGroup(group.fr.emse.canari)/store";

/// One directory the launch pass excludes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExcludedDir {
    /// What the log names it by - never the absolute path.
    pub(crate) label: &'static str,
    pub(crate) path: PathBuf,
}

/// Every directory to exclude: the container's [`CONTAINER_DIRS`] under `home`, then the App
/// Group's STORE ([`APP_GROUP_STORE`]) when it is known - never the container root, which refuses
/// the flag.
pub(crate) fn excluded_dirs(home: &Path, app_group_store: Option<&Path>) -> Vec<ExcludedDir> {
    let mut dirs: Vec<ExcludedDir> = CONTAINER_DIRS
        .iter()
        .map(|rel| ExcludedDir {
            label: rel,
            path: home.join(rel),
        })
        .collect();
    if let Some(store) = app_group_store {
        dirs.push(ExcludedDir {
            label: APP_GROUP_LABEL,
            path: store.to_path_buf(),
        });
    }
    dirs
}

/// Whether `data_dir` (Tauri's `app_data_dir`) lies inside one of `dirs` - the check that the home
/// the pass was handed is the one Tauri derived its data directory from. A `false` makes the launch
/// a failure ([`summary`]): the SQLite stores and `mls.bin` would sit outside every excluded
/// directory.
pub(crate) fn covers(dirs: &[ExcludedDir], data_dir: &Path) -> bool {
    dirs.iter().any(|d| data_dir.starts_with(&d.path))
}

/// The parts of a Foundation `NSError` the verdict carries: its domain and code, and those of its
/// `NSUnderlyingErrorKey` error. Read where the call answers (`native_cache::ns_error_parts`) and
/// classified from them alone ([`NsErrorParts::refusal`]). NEVER the `localizedDescription`: it can
/// quote a path (the rule `CanariErrorReason` keeps on the Objective-C side).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NsErrorParts {
    pub(crate) domain: String,
    pub(crate) code: i64,
    pub(crate) underlying: Option<(String, i64)>,
}

/// `NSPOSIXErrorDomain`'s value: its codes are `errno` values.
const POSIX_DOMAIN: &str = "NSPOSIXErrorDomain";
/// `NSCocoaErrorDomain`'s value: the Foundation file errors.
const COCOA_DOMAIN: &str = "NSCocoaErrorDomain";

/// What kind of refusal an `NSError` is - the distinction a reader of the verdict acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The process may not change that item: `NSFileReadNoPermissionError` (257),
    /// `NSFileWriteNoPermissionError` (513), `EPERM` or `EACCES`, at the top or underneath. What a
    /// directory the app does not own answers.
    NoPermission,
    /// Anything else - the domain and code in the line say which.
    Other,
}

impl NsErrorParts {
    /// The `errno` this error carries - its own code in `NSPOSIXErrorDomain`, else its underlying
    /// error's when that one is - for a caller that turns it into an `io::Error`.
    pub(crate) fn posix_code(&self) -> Option<i32> {
        std::iter::once((self.domain.as_str(), self.code))
            .chain(self.underlying.iter().map(|(d, c)| (d.as_str(), *c)))
            .find(|(domain, _)| *domain == POSIX_DOMAIN)
            .and_then(|(_, code)| i32::try_from(code).ok())
    }

    /// The classification, from the domains and codes only.
    pub(crate) fn refusal(&self) -> Refusal {
        const EPERM: i64 = 1;
        const EACCES: i64 = 13;
        let no_permission = |domain: &str, code: i64| match domain {
            COCOA_DOMAIN => code == 257 || code == 513,
            POSIX_DOMAIN => code == EPERM || code == EACCES,
            _ => false,
        };
        let underlying = self
            .underlying
            .as_ref()
            .is_some_and(|(d, c)| no_permission(d, *c));
        if no_permission(&self.domain, self.code) || underlying {
            Refusal::NoPermission
        } else {
            Refusal::Other
        }
    }
}

/// Why one directory does not hold the flag - a TYPE, built where each step fails, so the verdict
/// line and any reader branch on the variant and never on a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FlagError {
    /// Nothing could be asked: the container is unknown, a Foundation class is not loaded, the
    /// path is not representable.
    Unavailable(String),
    /// The directory did not exist and could not be created (the `io::Error`'s text).
    NotCreated(String),
    /// Foundation answered NO to `call`, with the `NSError` it gave - `None` when it gave none.
    Refused {
        call: &'static str,
        error: Option<NsErrorParts>,
    },
    /// The set was accepted and the flag reads back unset.
    ReadsBackUnset,
}

impl std::fmt::Display for FlagError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(why) => write!(f, "unavailable: {why}"),
            Self::NotCreated(why) => write!(f, "not created: {why}"),
            Self::Refused { call, error: None } => write!(f, "{call} refused, with no NSError"),
            Self::Refused {
                call,
                error: Some(e),
            } => {
                let kind = match e.refusal() {
                    Refusal::NoPermission => "no permission",
                    Refusal::Other => "other",
                };
                write!(f, "{call} refused ({kind}): {} {}", e.domain, e.code)?;
                if let Some((domain, code)) = &e.underlying {
                    write!(f, ", underlying {domain} {code}")?;
                }
                Ok(())
            }
            Self::ReadsBackUnset => write!(f, "set, but reads back unset"),
        }
    }
}

/// How loud a line is: the launch verdict and the store's opening report
/// ([`StoreOpening::report`]) are logged at this level - and the notification extension, which
/// has no Rust logger, receives it as an integer (`canari_app_group_store_report`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Severity {
    Info = 0,
    Warn = 1,
    Error = 2,
}

/// The names our builds write at the App Group root, as STEMS: a stem covers the name itself and
/// every name that continues it after a dot (`mls` covers `mls.bin` and `mls.bin.tmp`,
/// `nse_outcomes` its `.ndjson`, `.1.ndjson` and `.lock`). Mirrored by the share extension
/// (`ShareCapture.rootStems`); a source test holds the two equal.
pub(crate) const OURS_STEMS: [&str; 15] = [
    "mls",
    "push_context",
    "push_secret",
    "display_names",
    "conversation_nicknames",
    "graine_seeds",
    "device_notices",
    "fcm_message_cache",
    "nse_outcomes",
    "nse_inflight",
    "nse_done",
    "shared_inbox",
    "pending_share",
    "share_epoch",
    "app_in_foreground",
];

/// The names our builds write at the App Group root by PREFIX: the extension's avatar and logo
/// caches (`avatar_<sanitised id>.jpg`, `assologo_<id>.jpg`). Mirrored by
/// `ShareCapture.rootPrefixes`.
pub(crate) const OURS_PREFIXES: [&str; 2] = ["avatar_", "assologo_"];

/// The one quarantine generation inside the store: what a conflict displaced (module doc).
pub(crate) const SUPERSEDED_DIR: &str = ".superseded";

/// What an entry at the App Group container's root is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RootEntry {
    /// [`APP_GROUP_STORE`] itself.
    Store,
    /// The system's: the container manager's `.com.apple.*` metadata, and the `Library` directory
    /// iOS creates in every container. Never moved.
    System,
    /// A name our builds write ([`OURS_STEMS`], [`OURS_PREFIXES`]) - moved into the store.
    Ours,
    /// Anything else: never moved, counted, and the verdict fails on it.
    Unknown,
}

/// Classifies one name at the App Group root.
pub(crate) fn classify_root_entry(name: &std::ffi::OsStr) -> RootEntry {
    let name = name.to_string_lossy();
    let stem_of = |stem: &str| {
        name == stem
            || name
                .strip_prefix(stem)
                .is_some_and(|rest| rest.starts_with('.'))
    };
    if name == APP_GROUP_STORE {
        RootEntry::Store
    } else if name == "Library" || name.starts_with(".com.apple.") {
        RootEntry::System
    } else if OURS_STEMS.iter().any(|s| stem_of(s))
        || OURS_PREFIXES.iter().any(|p| name.starts_with(p))
    {
        RootEntry::Ours
    } else {
        RootEntry::Unknown
    }
}

/// What one pass of [`migrate_root`] did - counts only: the log names no file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Migration {
    /// Entries moved into the store.
    pub(crate) moved: usize,
    /// Entries gone between the listing and the rename.
    pub(crate) absent: usize,
    /// Entries an older build wrote after a move: the root copy moved in, the store's copy put in
    /// [`SUPERSEDED_DIR`].
    pub(crate) superseded: usize,
    /// Entries a rename refused, left at the root.
    pub(crate) failures: usize,
    /// Root names on no allowlist, left at the root.
    pub(crate) unknown: usize,
    /// The root could not be listed, or the store not locked: nothing was moved.
    pub(crate) unreadable: bool,
}

impl Migration {
    /// The severity this pass alone deserves.
    pub(crate) fn severity(&self) -> Severity {
        if self.failures > 0 || self.unknown > 0 || self.unreadable {
            Severity::Error
        } else if self.superseded > 0 {
            Severity::Warn
        } else {
            Severity::Info
        }
    }
}

/// Renames `from` to `to` unless `to` exists - atomically on Apple platforms (`renamex_np` with
/// `RENAME_EXCL`), answering `AlreadyExists` then.
#[cfg(target_vendor = "apple")]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| {
        std::ffi::CString::new(p.as_os_str().as_bytes())
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))
    };
    let (from, to) = (c(from)?, c(to)?);
    // SAFETY: two NUL-terminated paths that outlive the call.
    match unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } {
        0 => Ok(()),
        _ => Err(std::io::Error::last_os_error()),
    }
}

/// The host-test stand-in for the Apple `rename_exclusive`: this module compiles off Apple only
/// under `cfg(test)`, where nothing races the check.
#[cfg(not(target_vendor = "apple"))]
pub(crate) fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    std::fs::rename(from, to)
}

/// The exclusive lock the moves run under: a `flock` on the store directory itself, so no file is
/// created for it. Released when the handle drops. Held for the milliseconds of the move only - a
/// process suspended while it holds a lock in a shared container is killed (`0xdead10cc`).
#[cfg(unix)]
fn lock_store(store: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::io::AsRawFd;
    let dir = std::fs::File::open(store)?;
    // SAFETY: a live descriptor, owned by `dir` for the whole call.
    match unsafe { libc::flock(dir.as_raw_fd(), libc::LOCK_EX) } {
        0 => Ok(dir),
        _ => Err(std::io::Error::last_os_error()),
    }
}

/// The host-test stand-in: off unix this module compiles only under `cfg(test)`, single-process.
#[cfg(not(unix))]
fn lock_store(_store: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Removes `path` whatever it is (a file, or a directory with its contents); absent is fine.
fn remove_any(path: &Path) -> std::io::Result<()> {
    let result = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) => Err(e),
    };
    match result {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// The conflict of `name` (module doc): the store's copy replaces the previous quarantined one in
/// [`SUPERSEDED_DIR`], then the root's moves in with `rename`. `Ok(true)` when the root copy moved
/// in, `Ok(false)` when it was gone meanwhile.
fn supersede(
    root: &Path,
    store: &Path,
    name: &std::ffi::OsStr,
    rename: &impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<bool> {
    let quarantine = store.join(SUPERSEDED_DIR);
    std::fs::create_dir_all(&quarantine)?;
    let previous = quarantine.join(name);
    remove_any(&previous)?;
    match std::fs::rename(store.join(name), &previous) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    match rename(&root.join(name), &store.join(name)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Moves every [`RootEntry::Ours`] entry of the App Group `root` into `store`, each with `rename`
/// ([`rename_exclusive`] on a device), a conflict settled by [`supersede`]. Never fails: an
/// unreadable root, a refused rename and an unknown name are COUNTED (and said at ERROR, for the
/// processes that have a logger) - the store stays usable, and the verdict reads the root back.
/// Idempotent from the file system itself: a root holding nothing of ours moves nothing.
pub(crate) fn migrate_root(
    root: &Path,
    store: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Migration {
    let mut migration = Migration::default();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) => {
            log::error!("[BACKUP_EXCLUSION] the App Group root is unreadable - nothing moved: {e}");
            migration.unreadable = true;
            return migration;
        }
    };
    for entry in entries {
        let name = match entry {
            Ok(entry) => entry.file_name(),
            Err(e) => {
                log::error!("[BACKUP_EXCLUSION] an App Group root entry is unreadable: {e}");
                migration.failures += 1;
                continue;
            }
        };
        match classify_root_entry(&name) {
            RootEntry::Store | RootEntry::System => continue,
            RootEntry::Unknown => {
                migration.unknown += 1;
                continue;
            }
            RootEntry::Ours => {}
        }
        match rename(&root.join(&name), &store.join(&name)) {
            Ok(()) => migration.moved += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => migration.absent += 1,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                match supersede(root, store, &name, &rename) {
                    Ok(true) => migration.superseded += 1,
                    Ok(false) => migration.absent += 1,
                    Err(e) => {
                        log::error!(
                            "[BACKUP_EXCLUSION] an App Group root entry that came back was not moved in: {e}"
                        );
                        migration.failures += 1;
                    }
                }
            }
            Err(e) => {
                log::error!(
                    "[BACKUP_EXCLUSION] an App Group root entry was not moved into the store: {e}"
                );
                migration.failures += 1;
            }
        }
    }
    migration
}

/// What the App Group root holds NOW, read back by the launch verdict after the move.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RootState {
    /// Entries of ours still there: outside every excluded directory.
    pub(crate) ours: usize,
    /// Entries on no allowlist.
    pub(crate) unknown: usize,
}

/// Reads the App Group `root` back ([`RootState`]).
pub(crate) fn root_state(root: &Path) -> std::io::Result<RootState> {
    let mut state = RootState::default();
    for entry in std::fs::read_dir(root)? {
        match classify_root_entry(&entry?.file_name()) {
            RootEntry::Ours => state.ours += 1,
            RootEntry::Unknown => state.unknown += 1,
            RootEntry::Store | RootEntry::System => {}
        }
    }
    Ok(state)
}

/// How a process's first resolution of the App Group went ([`open_store`]): kept for the life of
/// the process (`app_group::store_opening`), so the launch verdict - and the notification
/// extension, through `canari_app_group_store_report` - can say what the move did even when it ran
/// before any logger existed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoreOpening {
    pub(crate) path: PathBuf,
    /// Whether this process created the store.
    pub(crate) created: bool,
    /// The flag this process set on it.
    pub(crate) flag: Result<(), FlagError>,
    pub(crate) migration: Migration,
}

impl StoreOpening {
    /// One line and its severity: the flag's outcome and the move's counts.
    pub(crate) fn report(&self) -> (Severity, String) {
        let m = &self.migration;
        let mut line = format!(
            "{APP_GROUP_LABEL} {}, flag ",
            if self.created { "created" } else { "opened" }
        );
        match &self.flag {
            Ok(()) => line.push_str("set"),
            Err(e) => line.push_str(&format!("NOT set ({e})")),
        }
        line.push_str(&format!(
            "; root: {} moved, {} absent, {} came back from an older build, {} refused, {} unknown",
            m.moved, m.absent, m.superseded, m.failures, m.unknown
        ));
        if m.unreadable {
            line.push_str(", the root unreadable or the store not locked");
        }
        let severity = if self.flag.is_err() {
            Severity::Error
        } else {
            m.severity()
        };
        (severity, line)
    }
}

/// Opens the App Group's store under `root`: creates it when absent, FLAGS it with `flag` (created
/// or found - every process, once), then, under [`lock_store`], moves the root's entries of ours
/// into it ([`migrate_root`]). Every process runs it before its first use of the store
/// (`app_group::app_group_dir`). Fails only when the store cannot be created: a refused flag, an
/// unreadable root or a refused move is in the answer and its [`StoreOpening::report`], and the
/// store is still returned - the notification extension decrypts from it either way.
pub(crate) fn open_store(
    root: &Path,
    flag: impl FnOnce(&Path) -> Result<(), FlagError>,
) -> std::io::Result<StoreOpening> {
    let path = root.join(APP_GROUP_STORE);
    let created = match std::fs::create_dir(&path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(e),
    };
    let flag = flag(&path);
    let migration = match lock_store(&path) {
        Ok(_held) => migrate_root(root, &path, rename_exclusive),
        Err(e) => {
            log::error!(
                "[BACKUP_EXCLUSION] the App Group store could not be locked - nothing moved: {e}"
            );
            Migration {
                unreadable: true,
                ..Migration::default()
            }
        }
    };
    let opening = StoreOpening {
        path,
        created,
        flag,
        migration,
    };
    let (severity, verdict) = opening.report();
    match severity {
        Severity::Info => log::info!("[BACKUP_EXCLUSION] {verdict}"),
        Severity::Warn => log::warn!("[BACKUP_EXCLUSION] {verdict}"),
        Severity::Error => log::error!("[BACKUP_EXCLUSION] {verdict}"),
    }
    Ok(opening)
}

/// The one line a launch logs, and its severity. INFO when every label held, the data directory is
/// covered ([`covers`]) and the App Group root holds nothing of ours and nothing unknown (`root`:
/// `None` when the container is unknown - its store already fails in `outcomes`); WARN when, on top
/// of that, this process's move ([`Migration`], `None` when this process opened no store) took back
/// entries an older build wrote; else ERROR, with the count, each label that did not hold WITH ITS
/// REASON, what the root still holds and what the move refused. One verdict per launch, never an
/// ERROR followed by "6/6".
pub(crate) fn summary(
    outcomes: &[(&'static str, Result<(), FlagError>)],
    data_dir_covered: bool,
    root: Option<Result<RootState, String>>,
    migration: Option<&Migration>,
) -> (Severity, String) {
    let failed: Vec<String> = outcomes
        .iter()
        .filter_map(|(l, r)| r.as_ref().err().map(|e| format!("{l} ({e})")))
        .collect();
    let total = outcomes.len();
    let root_clean = matches!(
        root,
        None | Some(Ok(RootState {
            ours: 0,
            unknown: 0
        }))
    );
    let moved_cleanly = migration.is_none_or(|m| m.severity() != Severity::Error);
    let came_back = migration.map_or(0, |m| m.superseded);
    if failed.is_empty() && data_dir_covered && root_clean && moved_cleanly {
        let labels: Vec<&str> = outcomes.iter().map(|(l, _)| *l).collect();
        let mut line = format!(
            "{total}/{total} directories excluded from backups, flag read back: {}",
            labels.join(", ")
        );
        if came_back == 0 {
            return (Severity::Info, line);
        }
        line.push_str(&format!(
            " - {came_back} entries came back from an older build: the root copies moved in, the previous ones superseded"
        ));
        return (Severity::Warn, line);
    }
    let mut line = format!("{}/{total} directories excluded", total - failed.len());
    if !failed.is_empty() {
        line.push_str(&format!(" - NOT excluded: {}", failed.join("; ")));
    }
    match root {
        None => {}
        Some(Ok(state)) => {
            if state.ours > 0 {
                line.push_str(&format!(
                    " - {} entries of ours left at the App Group root",
                    state.ours
                ));
            }
            if state.unknown > 0 {
                line.push_str(&format!(
                    " - {} unknown entries at the App Group root, not moved",
                    state.unknown
                ));
            }
        }
        Some(Err(e)) => line.push_str(&format!(" - the App Group root is unreadable: {e}")),
    }
    if let Some(m) = migration {
        if m.failures > 0 {
            line.push_str(&format!(" - {} moves refused", m.failures));
        }
        if m.unreadable {
            line.push_str(" - the move did not run (root unreadable or store not locked)");
        }
        if came_back > 0 {
            line.push_str(&format!(
                " - {came_back} entries came back from an older build"
            ));
        }
    }
    if !data_dir_covered {
        line.push_str(" - the app data directory lies outside every excluded directory");
    }
    (Severity::Error, line)
}

/// Creates the directory when absent, sets the flag, and reads it back.
#[cfg(target_os = "ios")]
fn exclude_one(path: &Path) -> Result<(), FlagError> {
    std::fs::create_dir_all(path).map_err(|e| FlagError::NotCreated(e.to_string()))?;
    crate::native_cache::ios_exclude_from_backup(path)?;
    match crate::native_cache::ios_is_excluded_from_backup(path)? {
        true => Ok(()),
        false => Err(FlagError::ReadsBackUnset),
    }
}

/// The launch pass: every directory of [`excluded_dirs`], the App Group root read back and what
/// this process's move did, said in ONE line at the [`summary`]'s severity. Runs in `setup`, before
/// the WebView is built - possibly AFTER the native bootstrap opened the store, which is why the
/// move's result is read from where the opening kept it rather than from a log line.
#[cfg(target_os = "ios")]
pub(crate) fn exclude_install_from_backup(home: &Path, data_dir: &Path) {
    log::debug!("[BACKUP_EXCLUSION] launch pass");
    // The store first: resolving it moves the root's entries of ours into it.
    let store = crate::app_group::app_group_dir();
    let root = crate::app_group::app_group_container()
        .ok()
        .map(|root| root_state(&root).map_err(|e| e.to_string()));
    let dirs = excluded_dirs(home, store.as_deref().ok());
    let mut outcomes: Vec<(&'static str, Result<(), FlagError>)> = dirs
        .iter()
        .map(|d| (d.label, exclude_one(&d.path)))
        .collect();
    if let Err(e) = store {
        outcomes.push((APP_GROUP_LABEL, Err(FlagError::Unavailable(e))));
    }
    let migration = crate::app_group::store_opening().map(|o| &o.migration);
    match summary(&outcomes, covers(&dirs, data_dir), root, migration) {
        (Severity::Info, verdict) => log::info!("[BACKUP_EXCLUSION] {verdict}"),
        (Severity::Warn, verdict) => log::warn!("[BACKUP_EXCLUSION] {verdict}"),
        (Severity::Error, verdict) => log::error!("[BACKUP_EXCLUSION] {verdict}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn home() -> PathBuf {
        PathBuf::from("/var/mobile/Containers/Data/Application/HOME")
    }

    fn group() -> PathBuf {
        PathBuf::from("/private/var/mobile/Containers/Shared/AppGroup/GROUP")
    }

    /// A fresh directory under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "canari-backup-exclusion-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("readable")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn refused(domain: &str, code: i64, underlying: Option<(&str, i64)>) -> NsErrorParts {
        NsErrorParts {
            domain: domain.to_string(),
            code,
            underlying: underlying.map(|(d, c)| (d.to_string(), c)),
        }
    }

    fn flagged(_: &Path) -> Result<(), FlagError> {
        Ok(())
    }

    #[test]
    fn the_container_directories_sit_under_its_library_and_the_group_store_comes_last() {
        let store = group().join(APP_GROUP_STORE);
        let dirs = excluded_dirs(&home(), Some(&store));
        let paths: Vec<PathBuf> = dirs.iter().map(|d| d.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                home().join("Library/Application Support"),
                home().join("Library/WebKit"),
                home().join("Library/Preferences"),
                home().join("Library/Cookies"),
                home().join("Library/HTTPStorages"),
                group().join("store"),
            ]
        );
        assert_eq!(dirs.last().map(|d| d.label), Some(APP_GROUP_LABEL));
    }

    #[test]
    fn the_app_group_root_itself_is_never_a_flagged_directory() {
        let dirs = excluded_dirs(&home(), Some(&group().join(APP_GROUP_STORE)));
        assert!(dirs.iter().all(|d| d.path != group()), "{dirs:?}");
    }

    #[test]
    fn an_unknown_app_group_leaves_only_the_container_directories() {
        let dirs = excluded_dirs(&home(), None);
        assert_eq!(dirs.len(), CONTAINER_DIRS.len());
        assert!(dirs
            .iter()
            .all(|d| d.path.starts_with(home().join("Library"))));
    }

    #[test]
    fn neither_documents_nor_the_purgeable_directories_are_touched() {
        for d in excluded_dirs(&home(), None) {
            assert!(!d.path.starts_with(home().join("Documents")), "{d:?}");
            assert!(!d.path.starts_with(home().join("Library/Caches")), "{d:?}");
            assert!(!d.path.starts_with(home().join("tmp")), "{d:?}");
        }
    }

    #[test]
    fn the_tauri_data_directory_and_the_sqlite_stores_are_covered() {
        let dirs = excluded_dirs(&home(), None);
        // Tauri's `app_data_dir` (and `app_config_dir`, where tauri-plugin-sql opens
        // `canari_<user>.db`) on iOS: `dirs::data_dir()` = `$HOME/Library/Application Support`.
        let data_dir = home().join("Library/Application Support/fr.emse.canari");
        assert!(covers(&dirs, &data_dir));
        assert!(covers(&dirs, &data_dir.join("canari_user.db")));
        assert!(covers(
            &dirs,
            &home().join("Library/WebKit/WebsiteData/Default")
        ));
    }

    #[test]
    fn a_data_directory_under_another_home_is_not_covered() {
        let dirs = excluded_dirs(&home(), None);
        let elsewhere =
            PathBuf::from("/var/mobile/OTHER/Library/Application Support/fr.emse.canari");
        assert!(!covers(&dirs, &elsewhere));
    }

    #[test]
    fn the_root_entries_are_classified_against_the_allowlist() {
        let class = |n: &str| classify_root_entry(OsStr::new(n));
        assert_eq!(class("store"), RootEntry::Store);
        assert_eq!(class("Library"), RootEntry::System);
        assert_eq!(
            class(".com.apple.mobile_container_manager.metadata.plist"),
            RootEntry::System
        );
        // What the bench iPhone's backup of 2026-11-20 held at the root, and the writers' own names.
        for ours in [
            "mls.bin",
            "mls.bin.tmp",
            "push_secret.txt",
            "push_context.json",
            "display_names.json",
            "conversation_nicknames.json.tmp",
            "device_notices",
            "graine_seeds.json",
            "graine_seeds.lock",
            "fcm_message_cache.ndjson",
            "nse_outcomes.1.ndjson",
            "nse_inflight.123.4.json",
            "nse_done.123.4.json",
            "shared_inbox",
            "shared_inbox.lock",
            "pending_share.json.replacing",
            "share_epoch",
            "app_in_foreground",
            "avatar_abc.jpg",
            "assologo_42.jpg",
        ] {
            assert_eq!(class(ours), RootEntry::Ours, "{ours}");
        }
        // A stem is a whole name or a name continued after a dot - never a longer word.
        for unknown in ["mlsx", "push_contexts.json", "notes.txt", "storehouse"] {
            assert_eq!(class(unknown), RootEntry::Unknown, "{unknown}");
        }
    }

    #[test]
    fn opening_the_store_creates_and_flags_it_then_moves_the_root_into_it() {
        let root = TempDir::new("open");
        std::fs::write(root.0.join("mls.bin"), b"state").expect("write");
        std::fs::create_dir(root.0.join("device_notices")).expect("dir");
        std::fs::write(root.0.join("device_notices/k"), b"n").expect("write");
        std::fs::create_dir(root.0.join("Library")).expect("dir");
        std::fs::write(
            root.0
                .join(".com.apple.mobile_container_manager.metadata.plist"),
            b"",
        )
        .expect("write");
        let seen = std::cell::RefCell::new(Vec::new());
        let opening = open_store(&root.0, |p| {
            // Flagged while still empty: nothing of ours was in it yet.
            assert!(names(p).is_empty());
            seen.borrow_mut().push(p.to_path_buf());
            Ok(())
        })
        .expect("opened");
        let store = opening.path.clone();
        assert_eq!(store, root.0.join(APP_GROUP_STORE));
        assert!(opening.created);
        assert_eq!(seen.into_inner(), vec![store.clone()]);
        assert_eq!(
            opening.migration,
            Migration {
                moved: 2,
                ..Migration::default()
            }
        );
        assert_eq!(names(&store), vec!["device_notices", "mls.bin"]);
        assert_eq!(
            std::fs::read(store.join("device_notices/k")).expect("moved"),
            b"n"
        );
        assert_eq!(
            names(&root.0),
            vec![
                ".com.apple.mobile_container_manager.metadata.plist",
                "Library",
                "store"
            ]
        );
        assert_eq!(root_state(&root.0).expect("readable"), RootState::default());
        assert_eq!(opening.report().0, Severity::Info);
    }

    #[test]
    fn an_existing_store_is_flagged_again_and_a_second_open_moves_nothing() {
        let root = TempDir::new("reopen");
        open_store(&root.0, flagged).expect("first");
        std::fs::write(
            root.0.join(APP_GROUP_STORE).join("push_context.json"),
            b"{}",
        )
        .expect("write");
        let calls = std::cell::Cell::new(0);
        let opening = open_store(&root.0, |_| {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .expect("second");
        assert_eq!(calls.get(), 1, "every process flags the store it finds");
        assert!(!opening.created);
        assert_eq!(opening.migration, Migration::default());
        assert_eq!(names(&opening.path), vec!["push_context.json"]);
    }

    #[test]
    fn an_older_build_writing_the_root_again_wins_and_the_store_copy_is_superseded_once() {
        let root = TempDir::new("downgrade");
        std::fs::write(root.0.join("mls.bin"), b"v1").expect("write");
        std::fs::create_dir(root.0.join("device_notices")).expect("dir");
        std::fs::write(root.0.join("device_notices/a"), b"v1").expect("write");
        let store = open_store(&root.0, flagged).expect("first").path;

        // A downgrade: the older build writes at the root again, after the move.
        std::fs::write(root.0.join("mls.bin"), b"v2").expect("write");
        std::fs::create_dir(root.0.join("device_notices")).expect("dir");
        std::fs::write(root.0.join("device_notices/b"), b"v2").expect("write");
        let opening = open_store(&root.0, flagged).expect("upgrade again");
        assert_eq!(
            opening.migration,
            Migration {
                superseded: 2,
                ..Migration::default()
            }
        );
        assert_eq!(opening.report().0, Severity::Warn);
        assert_eq!(
            std::fs::read(store.join("mls.bin")).expect("root won"),
            b"v2"
        );
        assert_eq!(names(&store.join("device_notices")), vec!["b"]);
        let quarantine = store.join(SUPERSEDED_DIR);
        assert_eq!(
            std::fs::read(quarantine.join("mls.bin")).expect("kept"),
            b"v1"
        );
        assert_eq!(names(&quarantine.join("device_notices")), vec!["a"]);
        assert_eq!(root_state(&root.0).expect("readable"), RootState::default());

        // Settled: a second reopen moves nothing and the quarantine is unchanged.
        let again = open_store(&root.0, flagged).expect("reopen");
        assert_eq!(again.migration, Migration::default());
        assert_eq!(
            std::fs::read(quarantine.join("mls.bin")).expect("kept"),
            b"v1"
        );

        // A second downgrade replaces the quarantined generation: it never grows.
        std::fs::write(root.0.join("mls.bin"), b"v3").expect("write");
        open_store(&root.0, flagged).expect("third upgrade");
        assert_eq!(
            std::fs::read(store.join("mls.bin")).expect("root won"),
            b"v3"
        );
        assert_eq!(
            std::fs::read(quarantine.join("mls.bin")).expect("one"),
            b"v2"
        );
        assert_eq!(names(&quarantine), vec!["device_notices", "mls.bin"]);
    }

    #[test]
    fn an_unknown_root_name_is_counted_and_never_moved() {
        let root = TempDir::new("unknown");
        std::fs::write(root.0.join("notes.txt"), b"x").expect("write");
        let opening = open_store(&root.0, flagged).expect("opened");
        assert_eq!(opening.migration.unknown, 1);
        assert!(root.0.join("notes.txt").exists());
        assert_eq!(opening.report().0, Severity::Error);
        assert_eq!(
            root_state(&root.0).expect("readable"),
            RootState {
                ours: 0,
                unknown: 1
            }
        );
    }

    #[test]
    fn an_unreadable_root_is_counted_and_the_store_still_opens() {
        let root = TempDir::new("unreadable");
        let missing = root.0.join("missing");
        let migration = migrate_root(&missing, &root.0, rename_exclusive);
        assert!(migration.unreadable);
        assert_eq!(migration.severity(), Severity::Error);
    }

    #[test]
    fn an_entry_gone_before_its_rename_is_absent_not_failed() {
        let root = TempDir::new("gone");
        let store = root.0.join(APP_GROUP_STORE);
        std::fs::create_dir(&store).expect("dir");
        std::fs::write(root.0.join("push_secret.txt"), b"s").expect("write");
        let migration = migrate_root(&root.0, &store, |_, _| {
            Err(std::io::ErrorKind::NotFound.into())
        });
        assert_eq!(
            migration,
            Migration {
                absent: 1,
                ..Migration::default()
            }
        );
    }

    #[test]
    fn a_refused_rename_is_counted_and_left_at_the_root() {
        let root = TempDir::new("refused");
        let store = root.0.join(APP_GROUP_STORE);
        std::fs::create_dir(&store).expect("dir");
        std::fs::write(root.0.join("push_secret.txt"), b"s").expect("write");
        let migration = migrate_root(&root.0, &store, |_, _| {
            Err(std::io::ErrorKind::PermissionDenied.into())
        });
        assert_eq!(migration.failures, 1);
        assert_eq!(
            root_state(&root.0).expect("readable"),
            RootState {
                ours: 1,
                unknown: 0
            }
        );
    }

    #[test]
    fn a_refusal_is_classified_from_its_domain_and_code() {
        assert_eq!(
            refused("NSCocoaErrorDomain", 513, None).refusal(),
            Refusal::NoPermission
        );
        assert_eq!(
            refused("NSCocoaErrorDomain", 257, None).refusal(),
            Refusal::NoPermission
        );
        assert_eq!(
            refused("NSPOSIXErrorDomain", 1, None).refusal(),
            Refusal::NoPermission
        );
        assert_eq!(
            refused("NSCocoaErrorDomain", 512, Some(("NSPOSIXErrorDomain", 13))).refusal(),
            Refusal::NoPermission
        );
        assert_eq!(
            refused("NSCocoaErrorDomain", 512, Some(("NSPOSIXErrorDomain", 28))).refusal(),
            Refusal::Other
        );
        assert_eq!(
            refused("NSCocoaErrorDomain", 4, None).refusal(),
            Refusal::Other
        );
    }

    #[test]
    fn the_posix_code_is_read_at_the_top_or_underneath() {
        assert_eq!(refused("NSPOSIXErrorDomain", 1, None).posix_code(), Some(1));
        assert_eq!(
            refused("NSCocoaErrorDomain", 513, Some(("NSPOSIXErrorDomain", 13))).posix_code(),
            Some(13)
        );
        assert_eq!(refused("NSCocoaErrorDomain", 513, None).posix_code(), None);
    }

    #[test]
    fn the_summary_lists_every_label_when_all_held() {
        let (severity, line) = summary(
            &[("Library/WebKit", Ok(())), (APP_GROUP_LABEL, Ok(()))],
            true,
            Some(Ok(RootState::default())),
            Some(&Migration::default()),
        );
        assert_eq!(severity, Severity::Info);
        assert_eq!(
            line,
            "2/2 directories excluded from backups, flag read back: \
             Library/WebKit, AppGroup(group.fr.emse.canari)/store"
        );
    }

    #[test]
    fn entries_that_came_back_are_one_warning_not_an_error() {
        let (severity, line) = summary(
            &[(APP_GROUP_LABEL, Ok(()))],
            true,
            Some(Ok(RootState::default())),
            Some(&Migration {
                superseded: 3,
                ..Migration::default()
            }),
        );
        assert_eq!(severity, Severity::Warn);
        assert_eq!(
            line,
            "1/1 directories excluded from backups, flag read back: \
             AppGroup(group.fr.emse.canari)/store - 3 entries came back from an older build: \
             the root copies moved in, the previous ones superseded"
        );
    }

    #[test]
    fn the_summary_names_what_did_not_hold_with_the_nserror_and_never_its_text() {
        let (severity, line) = summary(
            &[
                ("Library/WebKit", Ok(())),
                (
                    APP_GROUP_LABEL,
                    Err(FlagError::Refused {
                        call: "setResourceValue",
                        error: Some(refused(
                            "NSCocoaErrorDomain",
                            513,
                            Some(("NSPOSIXErrorDomain", 1)),
                        )),
                    }),
                ),
            ],
            true,
            Some(Ok(RootState::default())),
            None,
        );
        assert_eq!(severity, Severity::Error);
        assert_eq!(
            line,
            "1/2 directories excluded - NOT excluded: AppGroup(group.fr.emse.canari)/store \
             (setResourceValue refused (no permission): NSCocoaErrorDomain 513, \
             underlying NSPOSIXErrorDomain 1)"
        );
    }

    #[test]
    fn every_flag_error_names_its_step() {
        let error = FlagError::Refused {
            call: "setResourceValue",
            error: None,
        };
        assert_eq!(
            error.to_string(),
            "setResourceValue refused, with no NSError"
        );
        assert_eq!(
            FlagError::Unavailable("NSURL is not loaded".into()).to_string(),
            "unavailable: NSURL is not loaded"
        );
        assert_eq!(
            FlagError::NotCreated("denied".into()).to_string(),
            "not created: denied"
        );
        assert_eq!(
            FlagError::ReadsBackUnset.to_string(),
            "set, but reads back unset"
        );
    }

    #[test]
    fn what_the_root_still_holds_and_what_the_move_refused_fail_the_launch() {
        let (severity, line) = summary(
            &[(APP_GROUP_LABEL, Ok(()))],
            true,
            Some(Ok(RootState {
                ours: 2,
                unknown: 1,
            })),
            Some(&Migration {
                failures: 2,
                unknown: 1,
                ..Migration::default()
            }),
        );
        assert_eq!(severity, Severity::Error);
        assert_eq!(
            line,
            "1/1 directories excluded - 2 entries of ours left at the App Group root - \
             1 unknown entries at the App Group root, not moved - 2 moves refused"
        );
        let (severity, line) = summary(
            &[(APP_GROUP_LABEL, Ok(()))],
            true,
            Some(Err("denied".into())),
            None,
        );
        assert_eq!(severity, Severity::Error);
        assert_eq!(
            line,
            "1/1 directories excluded - the App Group root is unreadable: denied"
        );
    }

    #[test]
    fn the_opening_report_carries_a_refused_flag_at_error() {
        let opening = StoreOpening {
            path: group().join(APP_GROUP_STORE),
            created: true,
            flag: Err(FlagError::Refused {
                call: "setResourceValue",
                error: None,
            }),
            migration: Migration {
                moved: 4,
                ..Migration::default()
            },
        };
        assert_eq!(
            opening.report(),
            (
                Severity::Error,
                "AppGroup(group.fr.emse.canari)/store created, flag NOT set (setResourceValue \
                 refused, with no NSError); root: 4 moved, 0 absent, 0 came back from an older \
                 build, 0 refused, 0 unknown"
                    .to_string()
            )
        );
    }

    #[test]
    fn an_uncovered_data_directory_fails_the_launch_even_when_every_flag_held() {
        let (severity, line) = summary(&[("Library/WebKit", Ok(()))], false, None, None);
        assert_eq!(severity, Severity::Error);
        assert_eq!(
            line,
            "1/1 directories excluded - the app data directory lies outside every excluded directory"
        );
    }
}
