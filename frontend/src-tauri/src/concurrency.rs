//! Concurrency primitives for multi-engine MLS state (`mls.bin`) coordination.
//!
//! On Android, three MLS engines coexist in the SAME process (same .so Rust):
//! foreground (MlsManager via Tauri commands), FCM JNI and Worker JNI.
//! Only FCM<->Worker shared a lock (Kotlin `MlsStateLock`); the foreground didn't
//! participate and never reloaded `mls.bin`. Result: a background advance
//! (Welcome/send/worker) was overwritten on foreground return (lost-update -> SecretReuse).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

/// Verrou process-global serialisant les ECRITURES de `mls.bin` entre les trois moteurs. Tenu
/// brievement, juste autour de l'ecriture atomique. `nativeDecryptMessage` n'ecrit pas (manager
/// ephemere) -> non concerne. (C1)
pub(crate) fn mls_bin_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Echeance (ms depuis epoch) jusqu'a laquelle le foreground est repute actif. Tant que
/// `now < echeance`, les ecritures background JNI ABANDONNENT pour ne pas ecraser l'etat que le
/// foreground detient en memoire et n'a pas encore recharge. Rafraichie par heartbeat tant que la
/// WebView est visible ; expire seule si le foreground meurt/gele -> AUCUN stuck-true qui tuerait
/// la livraison background (regression FCM1/FCM2). (C1 / FCM3)
fn foreground_active_until() -> &'static AtomicI64 {
    static UNTIL: AtomicI64 = AtomicI64::new(0);
    &UNTIL
}

/// Marge du heartbeat foreground : doit depasser confortablement sa cadence (10 s) pour ne pas
/// expirer a tort pendant une app reellement au premier plan.
const FOREGROUND_GRACE_MS: i64 = 30_000;

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Rafraichit la garde foreground (heartbeat, resume, ou ecriture foreground).
pub(crate) fn mark_foreground_active() {
    foreground_active_until().store(now_ms() + FOREGROUND_GRACE_MS, Ordering::SeqCst);
}

/// Libere la garde foreground (passage en arriere-plan).
pub(crate) fn mark_foreground_inactive() {
    foreground_active_until().store(0, Ordering::SeqCst);
}

/// Vrai tant que la garde foreground n'a pas expire (le background doit alors s'abstenir d'ecrire).
/// Mobile uniquement : les ecrivains background (`background_write_mls_bin`) y vivent.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn foreground_is_active() -> bool {
    now_ms() < foreground_active_until().load(Ordering::SeqCst)
}

/// Ecrit `mls.bin` cote background sous le verrou global, SAUF si le foreground est actif (auquel
/// cas on abandonne : le foreground detient l'etat a jour en memoire et l'ecraserait - C1/FCM3).
/// L'erreur "foreground actif" laisse le travail en attente, repris au prochain passage foreground.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn background_write_mls_bin(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    if foreground_is_active() {
        return Err(
            "foreground actif - ecriture mls.bin background abandonnee (C1/FCM3)".to_string(),
        );
    }
    write_mls_bin_atomically(path, data)
}

/// Ecrit `data` dans `path` de facon atomique : ecriture dans un fichier temporaire
/// suivi d'un `rename(2)`, qui est atomique sur Linux/Android au sein du meme filesystem.
/// Garantit que le lecteur ne voit jamais un fichier partiellement ecrit.
pub(crate) fn write_mls_bin_atomically(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("write mls.bin.tmp: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename mls.bin.tmp -> mls.bin: {e}"))
}

/// Ecrit l'etat MLS dans `{app_data_dir}/mls.bin` sous le verrou global, en rafraichissant
/// la garde foreground.
pub(crate) fn write_mls_state_blob(app: &tauri::AppHandle, data: &[u8]) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    // Une ecriture foreground prouve que le foreground est vivant : rafraichir la garde pour que
    // les moteurs background s'abstiennent d'ecrire en parallele (C1/FCM3). Verrou global tenu
    // brievement autour de l'ecriture atomique.
    mark_foreground_active();
    let _guard = mls_bin_write_lock()
        .lock()
        .map_err(|_| "mls_bin write lock poisoned".to_string())?;
    write_mls_bin_atomically(&data_dir.join("mls.bin"), data)
}
