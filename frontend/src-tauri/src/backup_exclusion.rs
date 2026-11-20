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
//! no Rust). Each resolver, at its process's first use, creates the directory when absent and FLAGS
//! IT AT ONCE ([`open_store`]), then moves into it every entry of ours an older build left at the
//! root ([`migrate_root`]). Why no write can land unflagged: a file written into the store is under
//! a flagged parent from its first byte, whoever writes it and whenever; and no process of this
//! build writes at the root at all. Why no data is lost by the move: every process moves the root
//! BEFORE its first use of the store, with an exclusive rename, so the store cannot hold a name the
//! root still holds - a conflict is impossible by construction, and if one is ever met the root
//! entry is left and the launch verdict fails ([`ours_at_root`]).
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

/// The parts of a Foundation `NSError` the verdict carries: its domain, code and
/// `localizedDescription`, and the domain and code of its `NSUnderlyingErrorKey` error. Read where
/// the call answers (`native_cache::ns_error_parts`) and classified from the domain and code alone
/// ([`NsErrorParts::refusal`]) - never from the description, which is for the reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NsErrorParts {
    pub(crate) domain: String,
    pub(crate) code: i64,
    pub(crate) description: String,
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
                write!(
                    f,
                    "{call} refused ({kind}): {} {} \"{}\"",
                    e.domain, e.code, e.description
                )?;
                if let Some((domain, code)) = &e.underlying {
                    write!(f, ", underlying {domain} {code}")?;
                }
                Ok(())
            }
            Self::ReadsBackUnset => write!(f, "set, but reads back unset"),
        }
    }
}

/// What an entry at the App Group container's root is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RootEntry {
    /// [`APP_GROUP_STORE`] itself.
    Store,
    /// The system's: the container manager's `.com.apple.*` metadata, and the `Library` directory
    /// iOS creates in every container. Never moved.
    System,
    /// Ours, written there by a build before the store - moved into it.
    Ours,
}

/// Classifies one name at the App Group root. `Ours` is the default on purpose: the root holds the
/// system's two kinds of entry and what our own builds wrote, and the move is a rename within one
/// directory tree - nothing is deleted.
pub(crate) fn classify_root_entry(name: &std::ffi::OsStr) -> RootEntry {
    let name = name.to_string_lossy();
    if name == APP_GROUP_STORE {
        RootEntry::Store
    } else if name == "Library" || name.starts_with(".com.apple.") {
        RootEntry::System
    } else {
        RootEntry::Ours
    }
}

/// What one pass of [`migrate_root`] did - counts only: a root entry's name is ours, but the log
/// names no file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Migration {
    /// Entries moved into the store.
    pub(crate) moved: usize,
    /// Entries another process of this build moved first (the rename found nothing).
    pub(crate) absent: usize,
    /// Entries the store already holds under the same name - impossible by construction (module
    /// doc), left at the root and reported.
    pub(crate) kept: usize,
    /// Entries a rename refused for another reason, left at the root and reported.
    pub(crate) failures: usize,
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

/// Moves every [`RootEntry::Ours`] entry of the App Group `root` into `store`, each with
/// `rename` ([`rename_exclusive`] on a device): moved, absent (another process moved it first),
/// kept (the store holds the name: a conflict) or a failure. Idempotent from the file system
/// itself: a root holding nothing of ours moves nothing. An unreadable root is an error.
pub(crate) fn migrate_root(
    root: &Path,
    store: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<Migration> {
    let mut migration = Migration::default();
    for entry in std::fs::read_dir(root)? {
        let name = entry?.file_name();
        if classify_root_entry(&name) != RootEntry::Ours {
            continue;
        }
        match rename(&root.join(&name), &store.join(&name)) {
            Ok(()) => migration.moved += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => migration.absent += 1,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                migration.kept += 1;
            }
            Err(e) => {
                log::error!(
                    "[BACKUP_EXCLUSION] an App Group root entry was not moved into the store: {:?}",
                    e.kind()
                );
                migration.failures += 1;
            }
        }
    }
    Ok(migration)
}

/// How many [`RootEntry::Ours`] entries the App Group `root` holds NOW - read by the launch verdict
/// after the move, so the line says what the file system holds. Anything but 0 is outside every
/// excluded directory.
pub(crate) fn ours_at_root(root: &Path) -> std::io::Result<usize> {
    let mut count = 0;
    for entry in std::fs::read_dir(root)? {
        if classify_root_entry(&entry?.file_name()) == RootEntry::Ours {
            count += 1;
        }
    }
    Ok(count)
}

/// Opens the App Group's store under `root`: creates it when absent and FLAGS it at once with
/// `flag`, before anything is written into it, then moves the root's entries of ours into it
/// ([`migrate_root`]). Every process runs it before its first use of the store
/// (`app_group::app_group_dir`). The flag the launch pass reads back is the verdict; a failure here
/// is said at ERROR and does not stop the store from opening - a store that is not flagged still
/// keeps the extension's writes where the launch pass flags them.
pub(crate) fn open_store(
    root: &Path,
    flag: impl FnOnce(&Path) -> Result<(), FlagError>,
) -> std::io::Result<PathBuf> {
    let store = root.join(APP_GROUP_STORE);
    match std::fs::create_dir(&store) {
        Ok(()) => {
            log::info!("[BACKUP_EXCLUSION] {APP_GROUP_LABEL} created");
            if let Err(e) = flag(&store) {
                log::error!(
                    "[BACKUP_EXCLUSION] {APP_GROUP_LABEL} created but not excluded from backups: {e}"
                );
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let migration = migrate_root(root, &store, rename_exclusive)?;
    if migration.moved > 0 || migration.absent > 0 {
        log::info!(
            "[BACKUP_EXCLUSION] App Group root moved into the store: {} moved, {} already moved by another process",
            migration.moved,
            migration.absent
        );
    }
    if migration.kept > 0 || migration.failures > 0 {
        log::error!(
            "[BACKUP_EXCLUSION] App Group root entries left outside the store: {} already in the store, {} refused",
            migration.kept,
            migration.failures
        );
    }
    Ok(store)
}

/// The one line a launch logs, and whether it is a success: every label when all held, the data
/// directory is covered ([`covers`]) and the App Group root holds nothing of ours
/// (`root_left`: `None` when the container is unknown - its store already fails in `outcomes`);
/// else the count, each label that did not hold WITH ITS REASON, what the root still holds, and,
/// when it is so, that the data directory is outside them all. One verdict per launch, never an
/// ERROR followed by "6/6".
pub(crate) fn summary(
    outcomes: &[(&'static str, Result<(), FlagError>)],
    data_dir_covered: bool,
    root_left: Option<Result<usize, String>>,
) -> (bool, String) {
    let failed: Vec<String> = outcomes
        .iter()
        .filter_map(|(l, r)| r.as_ref().err().map(|e| format!("{l} ({e})")))
        .collect();
    let total = outcomes.len();
    let root_clean = matches!(root_left, None | Some(Ok(0)));
    if failed.is_empty() && data_dir_covered && root_clean {
        let labels: Vec<&str> = outcomes.iter().map(|(l, _)| *l).collect();
        (
            true,
            format!(
                "{total}/{total} directories excluded from backups, flag read back: {}",
                labels.join(", ")
            ),
        )
    } else {
        let mut line = format!("{}/{total} directories excluded", total - failed.len());
        if !failed.is_empty() {
            line.push_str(&format!(" - NOT excluded: {}", failed.join("; ")));
        }
        match root_left {
            Some(Ok(0)) | None => {}
            Some(Ok(n)) => line.push_str(&format!(
                " - {n} entries of ours left at the App Group root"
            )),
            Some(Err(e)) => line.push_str(&format!(" - the App Group root is unreadable: {e}")),
        }
        if !data_dir_covered {
            line.push_str(" - the app data directory lies outside every excluded directory");
        }
        (false, line)
    }
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

/// The launch pass: every directory of [`excluded_dirs`] and the App Group root's state, said in
/// ONE line - at INFO when all held, at ERROR with each reason when one did not, as the native
/// caches' per-file pass does (`native_cache::exclude_from_backup`). Runs in `setup`, before the
/// WebView is built.
#[cfg(target_os = "ios")]
pub(crate) fn exclude_install_from_backup(home: &Path, data_dir: &Path) {
    log::debug!("[BACKUP_EXCLUSION] launch pass");
    // The store first: resolving it moves the root's entries of ours into it.
    let store = crate::app_group::app_group_dir();
    let root_left = crate::app_group::app_group_container()
        .ok()
        .map(|root| ours_at_root(&root).map_err(|e| e.to_string()));
    let dirs = excluded_dirs(home, store.as_deref().ok());
    let mut outcomes: Vec<(&'static str, Result<(), FlagError>)> = dirs
        .iter()
        .map(|d| (d.label, exclude_one(&d.path)))
        .collect();
    if let Err(e) = store {
        outcomes.push((APP_GROUP_LABEL, Err(FlagError::Unavailable(e))));
    }
    match summary(&outcomes, covers(&dirs, data_dir), root_left) {
        (true, verdict) => log::info!("[BACKUP_EXCLUSION] {verdict}"),
        (false, verdict) => log::error!("[BACKUP_EXCLUSION] {verdict}"),
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
            description: "described".to_string(),
            underlying: underlying.map(|(d, c)| (d.to_string(), c)),
        }
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
    fn the_root_entries_are_classified_by_name() {
        assert_eq!(classify_root_entry(OsStr::new("store")), RootEntry::Store);
        assert_eq!(
            classify_root_entry(OsStr::new("Library")),
            RootEntry::System
        );
        assert_eq!(
            classify_root_entry(OsStr::new(
                ".com.apple.mobile_container_manager.metadata.plist"
            )),
            RootEntry::System
        );
        // What the bench iPhone's backup of 2026-11-20 held at the root.
        for ours in [
            "mls.bin",
            "push_secret.txt",
            "push_context.json",
            "display_names.json",
            "conversation_nicknames.json",
            "device_notices",
            "graine_seeds.json",
            "graine_seeds.lock",
            "shared_inbox",
            "pending_share.json",
            "app_in_foreground",
        ] {
            assert_eq!(
                classify_root_entry(OsStr::new(ours)),
                RootEntry::Ours,
                "{ours}"
            );
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
        let flagged = std::cell::RefCell::new(Vec::new());
        let store = open_store(&root.0, |p| {
            // Flagged while still empty: nothing of ours was in it yet.
            assert!(names(p).is_empty());
            flagged.borrow_mut().push(p.to_path_buf());
            Ok(())
        })
        .expect("opened");
        assert_eq!(store, root.0.join(APP_GROUP_STORE));
        assert_eq!(flagged.into_inner(), vec![store.clone()]);
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
        assert_eq!(ours_at_root(&root.0).expect("readable"), 0);
    }

    #[test]
    fn an_existing_store_is_not_flagged_again_and_a_second_open_moves_nothing() {
        let root = TempDir::new("reopen");
        open_store(&root.0, |_| Ok(())).expect("first");
        std::fs::write(
            root.0.join(APP_GROUP_STORE).join("push_context.json"),
            b"{}",
        )
        .expect("write");
        let store = open_store(&root.0, |_| {
            panic!("an existing store is not re-flagged here")
        })
        .expect("second");
        assert_eq!(names(&store), vec!["push_context.json"]);
        assert_eq!(
            migrate_root(&root.0, &store, rename_exclusive).expect("readable"),
            Migration::default()
        );
    }

    #[test]
    fn a_name_the_store_already_holds_stays_at_the_root_and_is_counted() {
        let root = TempDir::new("conflict");
        let store = root.0.join(APP_GROUP_STORE);
        std::fs::create_dir(&store).expect("dir");
        std::fs::write(store.join("mls.bin"), b"new").expect("write");
        std::fs::write(root.0.join("mls.bin"), b"old").expect("write");
        let migration = migrate_root(&root.0, &store, rename_exclusive).expect("readable");
        assert_eq!(migration.kept, 1);
        assert_eq!(std::fs::read(store.join("mls.bin")).expect("kept"), b"new");
        assert_eq!(ours_at_root(&root.0).expect("readable"), 1);
    }

    #[test]
    fn an_entry_another_process_moved_first_is_gone_not_failed() {
        let root = TempDir::new("gone");
        let store = root.0.join(APP_GROUP_STORE);
        std::fs::create_dir(&store).expect("dir");
        std::fs::write(root.0.join("push_secret.txt"), b"s").expect("write");
        let migration = migrate_root(&root.0, &store, |_, _| {
            Err(std::io::ErrorKind::NotFound.into())
        })
        .expect("readable");
        assert_eq!(
            migration,
            Migration {
                absent: 1,
                ..Migration::default()
            }
        );
    }

    #[test]
    fn a_refusal_is_classified_from_its_domain_and_code_never_its_text() {
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
        let mut same_text = refused("NSCocoaErrorDomain", 4, None);
        same_text.description = "You don't have permission".to_string();
        assert_eq!(same_text.refusal(), Refusal::Other);
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
        let (ok, line) = summary(
            &[("Library/WebKit", Ok(())), (APP_GROUP_LABEL, Ok(()))],
            true,
            Some(Ok(0)),
        );
        assert!(ok);
        assert_eq!(
            line,
            "2/2 directories excluded from backups, flag read back: \
             Library/WebKit, AppGroup(group.fr.emse.canari)/store"
        );
    }

    #[test]
    fn the_summary_names_what_did_not_hold_with_the_nserror() {
        let (ok, line) = summary(
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
            Some(Ok(0)),
        );
        assert!(!ok);
        assert_eq!(
            line,
            "1/2 directories excluded - NOT excluded: AppGroup(group.fr.emse.canari)/store \
             (setResourceValue refused (no permission): NSCocoaErrorDomain 513 \"described\", \
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
    fn entries_left_at_the_root_fail_the_launch_even_when_every_flag_held() {
        let (ok, line) = summary(&[(APP_GROUP_LABEL, Ok(()))], true, Some(Ok(2)));
        assert!(!ok);
        assert_eq!(
            line,
            "1/1 directories excluded - 2 entries of ours left at the App Group root"
        );
        let (ok, line) = summary(
            &[(APP_GROUP_LABEL, Ok(()))],
            true,
            Some(Err("denied".into())),
        );
        assert!(!ok);
        assert_eq!(
            line,
            "1/1 directories excluded - the App Group root is unreadable: denied"
        );
    }

    #[test]
    fn an_uncovered_data_directory_fails_the_launch_even_when_every_flag_held() {
        let (ok, line) = summary(&[("Library/WebKit", Ok(()))], false, None);
        assert!(!ok);
        assert_eq!(
            line,
            "1/1 directories excluded - the app data directory lies outside every excluded directory"
        );
    }
}
