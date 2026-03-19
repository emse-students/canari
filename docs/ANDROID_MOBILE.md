## Android / APK

Le frontend mobile repose sur Tauri 2 mobile.

### Ce qui est deja en place

- Plugin de notifications Tauri ajoute.
- Scripts npm Android ajoutes dans `frontend/package.json`.
- Configuration Tauri compatible mobile conservee dans `frontend/src-tauri`.

### Prerequis machine

- Android SDK
- Android NDK
- Java 17+
- Variables d'environnement configurees :
  - `ANDROID_HOME`
  - `JAVA_HOME`
  - `NDK_HOME` ou NDK detecte par la toolchain Android

### Commandes

Depuis `frontend/` :

```powershell
npm run android:init
npm run android:dev
npm run android:build
```

### Sortie attendue

Une fois l'environnement Android configure, Tauri genere le projet Android et permet de produire une APK de debug puis de release.

### Etat actuel sur cette machine

L'initialisation Android posait problème avec l'installation du NDK. Le `sdkmanager` a été déclenché pour installer `ndk-29.0.13846066` et les variables nécessaires ont été utilisées pour contourner l'erreur de version Java :

- `$env:SKIP_JDK_VERSION_CHECK="true"`
- `$env:NDK_HOME="<chemin...>\Sdk\ndk\29.0.13846066"`

Le `npm run android:init` est désormais généré avec succès ! Le projet Android Studio se situe dans `frontend/src-tauri/gen/android/canari`.
