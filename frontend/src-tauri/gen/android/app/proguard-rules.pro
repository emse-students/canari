# ─── DIAGNOSTIC ────────────────────────────────────────────────────────────────
# Conserve noms de fichiers et numéros de ligne pour déchiffrer les stack traces.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ─── TAURI 2.11 / TAO 0.35 — CHAMPS ACCÉDÉS PAR JNI ───────────────────────────
# tao accède aux champs `id` via env.get_field() / env.set_field() par nom
# littéral. R8 renomme ces champs en release → NoSuchFieldError → JavaException
# → SIGABRT dans Java_fr_emse_canari_Rust_onActivityCreate.
-keepclassmembers class fr.emse.canari.WryActivity {
    public int id;
}
-keepclassmembers class fr.emse.canari.RustWebView {
    public java.lang.String id;
}

# ─── LIFECYCLE OBSERVERS (nouveaux dans Tauri 2.11) ────────────────────────────
# WryLifecycleObserver et TauriLifecycleObserver sont des Kotlin `object`
# (singletons) enregistrés sur ProcessLifecycleOwner. AndroidX dispatch leurs
# callbacks par nom de méthode : si R8 les renomme, les callbacks ne se déclenchent plus.
-keep class fr.emse.canari.WryLifecycleObserver { *; }
-keep class fr.emse.canari.TauriLifecycleObserver { *; }

# ─── APP.TAURI — PLUGIN MANAGER ────────────────────────────────────────────────
# PluginManager est un singleton Kotlin dans tauri-android ; ses méthodes sont
# appelées par réflexion depuis les plugins et depuis le bridge Rust.
-keep class app.tauri.** { *; }
-keep interface app.tauri.** { *; }
-dontwarn app.tauri.**

# ─── NOTRE APPLICATION ─────────────────────────────────────────────────────────
-keep class fr.emse.canari.CanariApplication { *; }
-keep class fr.emse.canari.MainActivity { *; }
-keep class fr.emse.canari.CanariFirebaseMessagingService { *; }
-keep class fr.emse.canari.PushSecretKeystore { *; }

# ─── FIREBASE / FCM ────────────────────────────────────────────────────────────
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**

# ─── SQLITE (tauri-plugin-sql) ─────────────────────────────────────────────────
# tauri-plugin-sql embarque org.sqlite.database (repackage de SQLite pour Android).
-keep class org.sqlite.** { *; }
-keep class org.sqlite.database.** { *; }
-dontwarn org.sqlite.**
