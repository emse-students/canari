# Publication sur les stores — marche à suivre (FR)

> **Exception langue** : ce document est en français **volontairement** (le reste du wiki
> reste en anglais). C'est une checklist d'actions **pour toi (Jolan)**, pas de la doc LLM.
> But : lister **exactement** quoi faire, quoi me fournir, où le mettre, le nom des secrets,
> et les commandes. Quand tout est en place, une simple Release GitHub publie sur les deux
> stores automatiquement.

---

## Vue d'ensemble

Tout est **déjà câblé** dans la CI. Il ne manque **que des secrets** + quelques réglages
one-time côté consoles Apple/Google. Une fois posés, le flux est :

```
Tu crées une Release GitHub  vX.Y.Z
        │
        ▼
"Bump version on release"  → sync la version (package.json, tauri.conf, pbxproj NSE)
        │
        ├── Android Release  → build AAB signé  → publie sur Google Play (piste "internal")
        └── iOS Release      → build IPA signé  → upload sur TestFlight / App Store Connect
```

Tant que les secrets ne sont pas là, les étapes d'upload **se sautent proprement**
(warning, pas d'échec) : les builds restent verts. Dès que tu poses les secrets, l'upload
s'active tout seul à la prochaine Release.

**Où poser les secrets** : `Settings → Secrets and variables → Actions` du dépôt
`emse-students/canari`, OU en ligne de commande `gh secret set` (voir plus bas). Toutes les
commandes `gh secret set` doivent être lancées **depuis le dossier du dépôt canari** pour
qu'elles ciblent le bon repo.

---

## Partie A — iOS (TestFlight / App Store Connect)

### Pourquoi c'est obligatoire

Un `.ipa` **ne peut pas** être installé « à la main » depuis un asset de Release GitHub
(contrairement à l'`.apk` Android). Apple n'accepte **aucun** upload d'`.ipa` via le site web
d'App Store Connect. La **seule** voie de distribution est un upload programmatique
(`xcrun altool`) vers App Store Connect, qui atterrit dans TestFlight puis (optionnel) sur
l'App Store. C'est ce que fait maintenant l'étape « Upload to TestFlight / App Store Connect ».

### A.1 — Réglages one-time dans App Store Connect (web, ~10 min)

1. Va sur https://appstoreconnect.apple.com (compte de l'équipe **« Les Rootz »**, Team ID
   `4CLNB8SR6L`).
2. **Créer la fiche app** si elle n'existe pas encore : `Apps → (+) → New App`.
   - Platform : **iOS**
   - Bundle ID : **`fr.emse.canari`** (doit apparaître dans la liste ; il est déjà
     enregistré côté Developer portal puisque les profils existent).
   - SKU : au choix (ex. `canari`).
   - Nom : `Canari`.
   - > Sans cette fiche, l'upload est refusé (« No suitable application record found »).

### A.2 — Générer la clé API App Store Connect (web, ~2 min)

1. App Store Connect → `Users and Access` → onglet **`Integrations`** (ou `Keys` selon la
   version de l'UI) → section **App Store Connect API**.
2. Clique **`Generate API Key`** (ou le `+`).
   - Name : `Canari CI`
   - Access / Role : **`App Manager`** (suffisant pour uploader ; ne pas prendre
     `Developer` qui ne peut pas gérer les builds).
3. Après création tu obtiens **3 choses** :
   - Un fichier **`AuthKey_XXXXXXXXXX.p8`** → **télécharge-le tout de suite**, Apple ne le
     laisse télécharger **qu'une seule fois**.
   - Le **Key ID** (les `XXXXXXXXXX` du nom de fichier, ~10 caractères).
   - L'**Issuer ID** (un UUID affiché en haut de la page, ex.
     `69a6de70-1234-47e3-e053-5b8c7c11a4d1`), **commun à toutes les clés**.

### A.3 — Poser les 3 secrets iOS

Depuis le dossier du dépôt `canari`, dans **PowerShell** (remplace les valeurs) :

```powershell
# Encode le .p8 en base64 (chemin = là où tu l'as téléchargé)
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\AuthKey_XXXXXXXXXX.p8"))

gh secret set APP_STORE_CONNECT_API_KEY_P8 --body $b64
gh secret set APP_STORE_CONNECT_KEY_ID     --body "XXXXXXXXXX"
gh secret set APP_STORE_CONNECT_ISSUER_ID  --body "69a6de70-1234-47e3-e053-5b8c7c11a4d1"
```

> Si tu préfères l'interface web : `Settings → Secrets and variables → Actions →
> New repository secret`, et pour le `.p8` colle la **chaîne base64** (pas le fichier brut).

### A.4 — Ce qui se passe ensuite (automatique)

- À la prochaine Release, l'IPA est uploadé sur App Store Connect.
- Apple « traite » le build ~5-30 min (tu reçois un mail). Il apparaît ensuite dans
  **TestFlight**.
- Pour tester : App Store Connect → `TestFlight` → ajoute-toi comme testeur interne
  (Internal Testing), installe l'app **TestFlight** sur l'iPhone, et le build s'y télécharge.
- Pour publier sur l'App Store public : c'est une soumission manuelle séparée (revue Apple),
  non couverte ici — TestFlight suffit pour l'usage interne EMSE.

---

## Partie B — Android (Google Play)

### B.1 — Créer un compte de service Google Play (web, ~10 min)

1. **Play Console** → `Setup` → **`API access`** (ou `Users and permissions` selon l'UI).
2. Lie un projet Google Cloud si demandé, puis **`Create new service account`** → ça ouvre
   la **Google Cloud Console**.
3. Dans GCP : `Create service account` → nom `canari-ci` → **crée une clé de type JSON**
   (`Keys → Add key → JSON`) → télécharge le fichier `.json`.
4. Reviens dans Play Console → `API access` → le compte de service apparaît → **`Grant
   access / Manage permissions`** → donne au minimum le rôle **`Release manager`** (ou
   « Admin » pour simplifier), scope : l'app Canari.

### B.2 — Premier upload MANUEL (obligatoire, une seule fois)

Google **refuse** tout upload par l'API tant que **le tout premier AAB** n'a pas été
publié à la main :

1. Récupère l'`.aab` produit par la CI (asset de la Release GitHub, ou artefact du
   workflow « Android Release »).
2. Play Console → `Test and release → Testing → Internal testing → Create new release` →
   uploade cet `.aab` manuellement une fois.
3. Ensuite l'API prend le relais pour toutes les Releases suivantes.

> Prérequis annexe : l'app `fr.emse.canari` doit exister dans la Play Console (fiche créée),
> et le programme **Internal testing** activé avec au moins un testeur.

### B.3 — Poser le secret Android

Depuis le dossier du dépôt `canari`, PowerShell :

```powershell
gh secret set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON --body (Get-Content -Raw "$HOME\Downloads\canari-ci-xxxxx.json")
```

> Ce secret est peut-être **déjà présent** (il était référencé dans une version antérieure du
> workflow). Vérifie avec `gh secret list` ; si `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` y est déjà,
> tu peux sauter cette commande.

### B.4 — Ce qui se passe ensuite (automatique)

À chaque Release, l'AAB signé est poussé sur la piste **`internal`** de Google Play, statut
`completed`. Les testeurs internes le reçoivent via le lien Internal testing.

---

## Récapitulatif des secrets à créer

| Secret GitHub | Contenu | Où l'obtenir | Plateforme |
|---|---|---|---|
| `APP_STORE_CONNECT_API_KEY_P8` | base64 du fichier `AuthKey_*.p8` | App Store Connect → Users and Access → Integrations | iOS |
| `APP_STORE_CONNECT_KEY_ID` | le Key ID (~10 car.) | idem (nom du fichier `.p8`) | iOS |
| `APP_STORE_CONNECT_ISSUER_ID` | l'Issuer ID (UUID) | idem (haut de la page API) | iOS |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | contenu brut du `.json` du compte de service | Play Console → API access → GCP | Android |

Vérifier ce qui est déjà en place : `gh secret list`.

---

## Déclencher une publication

1. Bump + build + upload sont pilotés par une **Release GitHub** :
   `Releases → Draft a new release → Tag vX.Y.Z → Publish`.
2. Ça lance « Bump version on release », qui déclenche (via `workflow_run`) les workflows
   **Android Release** et **iOS Release**.
3. Résultat : AAB sur Google Play (internal) + IPA sur TestFlight, **sans action manuelle**
   une fois les secrets posés.

> Les 2 workflows acceptent aussi un `workflow_dispatch` manuel (bouton « Run workflow »),
> mais dans ce mode l'upload vers les stores et l'attache à la Release sont **volontairement
> sautés** (build de vérification uniquement).

---

## Ce qu'il te reste à me dire

Rien à me « donner » directement : tu poses les secrets toi-même (web ou `gh secret set`).
Quand c'est fait, préviens-moi — je vérifie `gh secret list`, on déclenche une Release de
test, et on regarde les deux workflows passer au vert avec l'upload actif.
