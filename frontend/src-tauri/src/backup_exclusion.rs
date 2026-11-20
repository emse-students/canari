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
//! **WHAT IT COVERS**, measured on the bench iPhone's backup manifest of 2026-11-20 (mobile wiki,
//! "Nothing local travels to another phone"): `Library/Application Support` (Tauri's data dir - the
//! SQLite stores, `mls.bin`, the at-rest markers, the identity and push files - plus Firebase's),
//! `Library/WebKit` (IndexedDB, LocalStorage, CacheStorage: 254 MB on that phone), `Library/Preferences`
//! (the notification-id map names conversations), `Library/Cookies` and `Library/HTTPStorages`
//! (empty there, the system's network stores), and the App Group container shared with the two
//! extensions, whose root holds `mls.bin`, `push_secret.txt` and the identity copies. NOT covered, on
//! purpose: `Documents` (only files the member saved there himself - Apple: never exclude user
//! documents) and `Library/Caches` / `tmp` (never backed up). The extensions' own containers held
//! nothing in that manifest.
//!
//! **A FLAG IS GUIDANCE, NOT A GUARANTEE** - Apple's words: "it's not a mechanism to guarantee those
//! items never appear in a backup or on a restored device". A backup taken BEFORE this build still
//! carries everything, and Apple documents nothing about the device-to-device transfer. So the app
//! must still recognise a copied install by itself (the at-rest key proven absent); this pass only
//! stops new backups from carrying the data.

use std::path::{Path, PathBuf};

/// The directories of the app container the pass excludes, relative to its home. Each is created
/// when absent, so it carries the flag before anything writes into it.
pub(crate) const CONTAINER_DIRS: [&str; 5] = [
    "Library/Application Support",
    "Library/WebKit",
    "Library/Preferences",
    "Library/Cookies",
    "Library/HTTPStorages",
];

/// The label the App Group container is logged under: its path carries a container id, the label
/// does not.
pub(crate) const APP_GROUP_LABEL: &str = "AppGroup(group.fr.emse.canari)";

/// One directory the launch pass excludes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExcludedDir {
    /// What the log names it by - never the absolute path.
    pub(crate) label: &'static str,
    pub(crate) path: PathBuf,
}

/// Every directory to exclude: the container's [`CONTAINER_DIRS`] under `home`, then the App Group
/// container's ROOT when it is known (its files sit at the root, written by three processes, so
/// no subdirectory would hold them all).
pub(crate) fn excluded_dirs(home: &Path, app_group: Option<&Path>) -> Vec<ExcludedDir> {
    let mut dirs: Vec<ExcludedDir> = CONTAINER_DIRS
        .iter()
        .map(|rel| ExcludedDir {
            label: rel,
            path: home.join(rel),
        })
        .collect();
    if let Some(group) = app_group {
        dirs.push(ExcludedDir {
            label: APP_GROUP_LABEL,
            path: group.to_path_buf(),
        });
    }
    dirs
}

/// Whether `data_dir` (Tauri's `app_data_dir`) lies inside one of `dirs` - the check that the home
/// the pass was handed is the one Tauri derived its data directory from. A `false` is said at ERROR:
/// the SQLite stores and `mls.bin` would then sit outside every excluded directory.
pub(crate) fn covers(dirs: &[ExcludedDir], data_dir: &Path) -> bool {
    dirs.iter().any(|d| data_dir.starts_with(&d.path))
}

/// The one line a launch logs, and whether it is a success: every label when all held, else the
/// count and the labels that did not (each failure is ALSO said with its reason, at ERROR, by the
/// caller).
pub(crate) fn summary(outcomes: &[(&'static str, Result<(), String>)]) -> (bool, String) {
    let failed: Vec<&str> = outcomes
        .iter()
        .filter(|(_, r)| r.is_err())
        .map(|(l, _)| *l)
        .collect();
    let total = outcomes.len();
    if failed.is_empty() {
        let labels: Vec<&str> = outcomes.iter().map(|(l, _)| *l).collect();
        (
            true,
            format!(
                "{total}/{total} directories excluded from backups, flag read back: {}",
                labels.join(", ")
            ),
        )
    } else {
        (
            false,
            format!(
                "{}/{total} directories excluded - NOT excluded: {}",
                total - failed.len(),
                failed.join(", ")
            ),
        )
    }
}

/// Creates the directory when absent, sets the flag, and reads it back.
#[cfg(target_os = "ios")]
fn exclude_one(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("not created: {e}"))?;
    crate::native_cache::ios_exclude_from_backup(path)?;
    match crate::native_cache::ios_is_excluded_from_backup(path)? {
        true => Ok(()),
        false => Err("set, but reads back unset".to_string()),
    }
}

/// The launch pass: every directory of [`excluded_dirs`], said in ONE line at INFO when all held,
/// and at ERROR - each failure with its reason, then the summary - when one did not, as the native
/// caches' per-file pass does (`native_cache::exclude_from_backup`). Runs in `setup`, before the
/// WebView is built.
#[cfg(target_os = "ios")]
pub(crate) fn exclude_install_from_backup(home: &Path, data_dir: &Path) {
    log::debug!("[BACKUP_EXCLUSION] launch pass");
    let group = crate::app_group::app_group_dir();
    let dirs = excluded_dirs(home, group.as_deref().ok());
    if !covers(&dirs, data_dir) {
        log::error!(
            "[BACKUP_EXCLUSION] the app data directory lies outside every excluded directory - the \
             home the pass was handed is not the one Tauri derived it from"
        );
    }
    let mut outcomes: Vec<(&'static str, Result<(), String>)> = dirs
        .iter()
        .map(|d| (d.label, exclude_one(&d.path)))
        .collect();
    if let Err(e) = group {
        outcomes.push((APP_GROUP_LABEL, Err(format!("container unavailable: {e}"))));
    }
    for (label, result) in &outcomes {
        if let Err(e) = result {
            log::error!("[BACKUP_EXCLUSION] {label} not excluded from backups: {e}");
        }
    }
    match summary(&outcomes) {
        (true, verdict) => log::info!("[BACKUP_EXCLUSION] {verdict}"),
        (false, verdict) => log::error!("[BACKUP_EXCLUSION] {verdict}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/var/mobile/Containers/Data/Application/HOME")
    }

    #[test]
    fn the_container_directories_sit_under_its_library_and_the_group_root_comes_last() {
        let group = PathBuf::from("/private/var/mobile/Containers/Shared/AppGroup/GROUP");
        let dirs = excluded_dirs(&home(), Some(&group));
        let paths: Vec<PathBuf> = dirs.iter().map(|d| d.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                home().join("Library/Application Support"),
                home().join("Library/WebKit"),
                home().join("Library/Preferences"),
                home().join("Library/Cookies"),
                home().join("Library/HTTPStorages"),
                group.clone(),
            ]
        );
        assert_eq!(dirs.last().map(|d| d.label), Some(APP_GROUP_LABEL));
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
    fn the_summary_lists_every_label_when_all_held() {
        let (ok, line) = summary(&[("Library/WebKit", Ok(())), (APP_GROUP_LABEL, Ok(()))]);
        assert!(ok);
        assert_eq!(
            line,
            "2/2 directories excluded from backups, flag read back: \
             Library/WebKit, AppGroup(group.fr.emse.canari)"
        );
    }

    #[test]
    fn the_summary_names_what_did_not_hold() {
        let (ok, line) = summary(&[
            ("Library/WebKit", Ok(())),
            (APP_GROUP_LABEL, Err("container unavailable".into())),
        ]);
        assert!(!ok);
        assert_eq!(
            line,
            "1/2 directories excluded - NOT excluded: AppGroup(group.fr.emse.canari)"
        );
    }
}
