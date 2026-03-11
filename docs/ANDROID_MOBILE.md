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

L'initialisation Android a ete tentee mais a ete bloquee par l'absence de la toolchain Android complete (SDK/NDK installes localement).