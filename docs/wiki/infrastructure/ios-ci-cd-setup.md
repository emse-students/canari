# Mettre en place la CI/CD iOS de Canari (guide pas-à-pas)

> **Public visé :** Léon, qui va reprendre la partie iOS. Ce document part du principe
> que tu n'as **jamais** fait de signature/déploiement iOS. On explique chaque terme.
> Aujourd'hui l'app iOS se compile "à la main" sur ton Mac quand ça veut bien marcher :
> ce n'est pas reproductible ni pérenne. L'objectif est que **GitHub compile et signe
> l'app tout seul**, sans ton Mac, à partir de secrets stockés une bonne fois pour toutes.

---

## 1. La vue d'ensemble (à lire en entier, c'est le plus important)

Compiler une app iOS "pour de vrai" (pas juste dans le simulateur), Apple impose 3 choses :

1. **Un compte Apple Developer payant** (99 $/an). C'est lui qui a le droit de signer des apps.
2. **Un certificat de signature** : un fichier cryptographique qui prouve "c'est bien
   l'équipe Canari qui a produit ce binaire". Sans lui, l'iPhone refuse d'installer l'app.
3. **Un provisioning profile** : un fichier qui dit "ce certificat a le droit d'installer
   *cette* app précise (`fr.emse.canari`), avec *ces* capacités (notifications push,
   liens universels), sur *ces* appareils / via TestFlight".

Sur ton Mac, Xcode fait tout ça **automatiquement** en arrière-plan (« Automatically manage
signing »). C'est pour ça que ça "marche parfois" : Xcode va chercher/regénère ces fichiers
tout seul. Le problème : un serveur GitHub n'a pas ton Mac, pas ton trousseau (Keychain),
pas ton compte Apple connecté. Il faut donc lui **fournir manuellement**, sous forme de
*secrets GitHub*, l'équivalent de ce que Xcode gère pour toi.

**Un "secret GitHub"** = une variable chiffrée stockée dans le dépôt
(`Settings → Secrets and variables → Actions`). La CI y a accès pendant le build, mais
personne ne peut la relire. C'est là qu'on met certificats, mots de passe, clés.

Le workflow qui fait le build existe déjà : [`.github/workflows/ios-release.yml`](../../../.github/workflows/ios-release.yml).
Il est **désactivé** pour l'instant (il ne se lance que si on le déclenche à la main avec
`force = true`). Ton travail : **remplir les secrets**, puis on l'activera ensemble.

### Ce que le workflow fait, étape par étape (pour comprendre où chaque secret sert)

1. Récupère le code, installe Bun + Rust (les toolchains du projet).
2. Installe les dépendances frontend et génère les bindings protobuf.
3. **Vérifie que tous les secrets requis sont présents** (sinon il s'arrête avec une erreur claire).
4. **Installe le certificat de signature** dans un trousseau temporaire du runner macOS.
5. **Installe le provisioning profile** au bon endroit.
6. **Écrit `GoogleService-Info.plist`** (config Firebase iOS) — déjà en place, voir §4.6.
7. Écrit le fichier `.env` frontend (URLs backend, secret JWT).
8. Lance `bun tauri ios build --export-method app-store-connect` → produit un `.ipa`
   (le paquet installable iOS, l'équivalent de l'`.apk` Android).
9. Met le `.ipa` en artefact téléchargeable.

> **Important :** aujourd'hui le workflow **s'arrête à la production du `.ipa`**. Il ne
> l'**envoie pas encore** sur TestFlight / l'App Store. Ajouter l'envoi automatique
> demande un secret supplémentaire (la *clé API App Store Connect*, voir §5). En attendant,
> l'`.ipa` peut être uploadé à la main via l'app **Transporter** (gratuite sur le Mac App Store).

---

## 2. Prérequis côté Apple (à régler AVANT les secrets)

Rien de ce qui suit ne marche sans ces deux points :

### 2.1 Un compte Apple Developer Program actif

- Aller sur <https://developer.apple.com/account> et vérifier que l'adhésion (99 $/an)
  est **active**. Si l'école / l'asso a déjà un compte, se faire ajouter dessus comme
  **Admin** (le rôle "Developer" ne suffit pas pour créer des certificats de distribution).
- Note quelque part le **Team ID** : il est affiché sur la page *Membership*
  (10 caractères, ex. `AB12CD34EF`). On en aura besoin (secret `APPLE_TEAM_ID`).

### 2.2 L'App ID `fr.emse.canari` doit être enregistré avec les bonnes capacités

L'identifiant de l'app est **`fr.emse.canari`** (défini dans
[`frontend/src-tauri/tauri.conf.json`](../../../frontend/src-tauri/tauri.conf.json)).
Sur <https://developer.apple.com/account/resources/identifiers/list> :

1. Vérifie qu'un **App ID** `fr.emse.canari` existe (sinon, crée-le : *+ → App IDs → App*).
2. Dans ses **Capabilities**, coche impérativement :
   - **Push Notifications** (sinon les notifs FCM→APNs ne partiront jamais).
   - **Associated Domains** (pour les liens universels `applinks:canari-emse.fr`, voir
     [`canari_iOS.entitlements`](../../../frontend/src-tauri/gen/apple/canari_iOS/canari_iOS.entitlements)).
3. La clé d'authentification APNs (`.p8`) est **déjà** chargée côté Firebase (c'est ce qui
   permet à FCM de relayer vers Apple). **Tu n'as PAS à la remettre ici** : elle vit dans la
   console Firebase, pas dans le dépôt. Voir [chat-delivery.md](../services/chat-delivery.md#transport--single-gateway-fcm).

> ⚠️ Le provisioning profile (§4.4) doit être généré **après** avoir coché ces capacités,
> sinon il ne les contiendra pas et les notifs seront muettes.

---

## 3. Comment ajouter un secret sur GitHub (deux méthodes)

**Méthode clic (recommandée pour débuter) :**
`https://github.com/emse-students/canari` → onglet **Settings** → menu de gauche
**Secrets and variables → Actions** → bouton **New repository secret** → tu mets le
**Name** (exactement, en MAJUSCULES) et la **valeur** → **Add secret**.

**Méthode ligne de commande** (si tu as installé `gh` et que tu es loggé) :

```bash
# Valeur courte (tapée directement) :
gh secret set APPLE_TEAM_ID --repo emse-students/canari

# Valeur = contenu d'un fichier (certificat, profil…) :
gh secret set APPLE_CERTIFICATE_BASE64 --repo emse-students/canari < certificat.b64
```

> Un secret **ne peut jamais être relu** après coup, seulement écrasé. Si tu as un doute
> sur une valeur, réécris-la, ne cherche pas à l'afficher.

**Encoder un fichier en base64** (obligatoire pour les fichiers binaires comme le `.p12`
et le `.mobileprovision`, parce qu'un secret GitHub ne stocke que du texte) :

```bash
# Sur macOS :
base64 -i certificat.p12 -o certificat.b64      # -> le contenu de certificat.b64 va dans le secret
base64 -i canari.mobileprovision -o profile.b64
```

---

## 4. Les secrets à créer, un par un

Tableau récapitulatif, puis le détail de chacun.

| Secret GitHub | Quoi | Où c'est utilisé dans le workflow | Statut |
|---|---|---|---|
| `APPLE_TEAM_ID` | Ton Team ID (10 car.) | build, signature | **à fournir** |
| `APPLE_SIGNING_IDENTITY` | Nom exact du certificat | signature du binaire | **à fournir** |
| `APPLE_CERTIFICATE_BASE64` | Certificat distribution `.p12` (base64) | installé dans le trousseau | **à fournir** |
| `APPLE_CERTIFICATE_PASSWORD` | Mot de passe du `.p12` | import du certificat | **à fournir** |
| `APPLE_PROVISIONING_PROFILE` | `.mobileprovision` (base64) | autorise l'app + capacités | **à fournir** |
| `GOOGLE_SERVICE_INFO_PLIST` | Config Firebase iOS | écrit avant le build | ✅ déjà en place |
| `JWT_SECRET` | Secret JWT backend | `.env` frontend | ✅ (partagé avec les autres CI) |
| `BASE_URL` | URL de l'API prod | `.env` frontend | ✅ (partagé) |
| `KLIPY_API_KEY` | Clé GIF Klipy (optionnel) | `.env` frontend | optionnel |

### 4.1 `APPLE_TEAM_ID`

- **C'est quoi :** l'identifiant de ton équipe Apple (10 caractères).
- **Où le trouver :** <https://developer.apple.com/account> → *Membership* → *Team ID*.
- **Comment le mettre :** `gh secret set APPLE_TEAM_ID` puis colle la valeur, ou via l'UI.

### 4.2 `APPLE_CERTIFICATE_BASE64` + `APPLE_CERTIFICATE_PASSWORD` (le certificat de distribution)

C'est la pièce maîtresse : le certificat qui signe l'app pour l'App Store / TestFlight.

**Générer le certificat (à faire une fois, sur ton Mac) :**

1. Ouvre l'app **Trousseau d'accès** (Keychain Access) → menu *Trousseau d'accès →
   Assistant de certification → Demander un certificat à une autorité de certification*.
   Renseigne ton email, laisse "Enregistré sur le disque". Ça produit un fichier
   `.certSigningRequest` (CSR).
2. Va sur <https://developer.apple.com/account/resources/certificates/list> → **+** →
   choisis **Apple Distribution** → uploade ton `.certSigningRequest` → télécharge le
   `.cer` généré.
3. Double-clique le `.cer` : il s'installe dans ton Trousseau.
4. Dans le Trousseau, déplie le certificat pour voir la **clé privée** associée →
   clic droit sur le certificat → **Exporter** → format **Personal Information Exchange (.p12)**.
   Il te demande un **mot de passe** : c'est lui qui devient `APPLE_CERTIFICATE_PASSWORD`
   (choisis-en un et note-le).
5. Encode le `.p12` en base64 et mets-le dans `APPLE_CERTIFICATE_BASE64` :
   ```bash
   base64 -i Canari_Distribution.p12 -o cert.b64
   gh secret set APPLE_CERTIFICATE_BASE64 --repo emse-students/canari < cert.b64
   gh secret set APPLE_CERTIFICATE_PASSWORD --repo emse-students/canari   # colle le mot de passe
   ```

> Le workflow décode ce `.p12` et l'importe dans un trousseau temporaire du runner
> (étape *Install Apple signing certificate*). Le mot de passe sert à cet import.

### 4.3 `APPLE_SIGNING_IDENTITY`

- **C'est quoi :** le **nom exact** du certificat, tel qu'il apparaît dans le trousseau.
  Format : `Apple Distribution: Nom De L'Equipe (TEAMID)`.
- **Où le trouver :** dans le Trousseau, clique sur ton certificat, le nom en haut est
  l'identité. Ou en ligne de commande sur le Mac :
  ```bash
  security find-identity -v -p codesigning
  ```
  Copie **exactement** la chaîne entre guillemets (ex. `Apple Distribution: EMSE Students (AB12CD34EF)`).
- **Comment le mettre :** `gh secret set APPLE_SIGNING_IDENTITY`.

### 4.4 `APPLE_PROVISIONING_PROFILE`

- **C'est quoi :** le fichier `.mobileprovision` qui lie *le certificat* + *l'App ID
  `fr.emse.canari`* + *les capacités (Push, Associated Domains)* + *le mode de
  distribution (App Store)*.
- **Le générer :** <https://developer.apple.com/account/resources/profiles/list> → **+** →
  type **App Store Connect** (distribution) → choisis l'App ID `fr.emse.canari` → choisis
  ton certificat *Apple Distribution* → nomme-le (ex. `Canari App Store`) → télécharge le
  `.mobileprovision`.
- **Le mettre en secret** (base64) :
  ```bash
  base64 -i Canari_App_Store.mobileprovision -o profile.b64
  gh secret set APPLE_PROVISIONING_PROFILE --repo emse-students/canari < profile.b64
  ```

> ⚠️ Refais ce profil **à chaque fois** que tu ajoutes une capacité à l'App ID (ex. quand
> on ajoutera l'extension de notification, §6), sinon la nouvelle capacité manquera.

### 4.5 `JWT_SECRET`, `BASE_URL`, `KLIPY_API_KEY`

Ce sont les mêmes que pour les autres CI du projet (Android, etc.). Normalement **déjà
présents** dans les secrets du dépôt. Vérifie leur présence ; sinon récupère leurs valeurs
auprès de Jolan. `KLIPY_API_KEY` est optionnel (juste les GIF).

### 4.6 `GOOGLE_SERVICE_INFO_PLIST` — ✅ déjà fait

Ce secret contient la config Firebase iOS (`GoogleService-Info.plist`). Il a **déjà été
posé**. Le workflow l'écrit dans `frontend/src-tauri/gen/apple/canari_iOS/GoogleService-Info.plist`
avant le build. **Tu n'as rien à faire ici**, c'est documenté pour que tu comprennes le tableau.

---

## 5. (Plus tard) Envoyer automatiquement sur TestFlight

Le workflow s'arrête aujourd'hui au `.ipa`. Pour que GitHub **pousse** directement la build
sur TestFlight, il faudra une **clé API App Store Connect** (différente de la clé APNs !) :

1. <https://appstoreconnect.apple.com/access/integrations/api> → **+** → génère une clé de
   rôle *App Manager*. Tu obtiens :
   - un fichier **`.p8`** (téléchargeable **une seule fois** — garde-le),
   - un **Key ID**,
   - un **Issuer ID** (en haut de la page).
2. On ajoutera alors 3 secrets (`APP_STORE_CONNECT_API_KEY_P8` en base64,
   `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`) et une étape d'upload
   (via `xcrun altool`/`Transporter`) à la fin du workflow.

> On fait ça **dans un second temps**, une fois que le build signé passe déjà. Ne t'en
> occupe pas maintenant.

---

## 6. (Contexte) L'extension de notification — pourquoi les notifs iOS sont "muettes" pour l'instant

Sur Android, un service en arrière-plan **déchiffre** le message et affiche le vrai texte
dans la notif. Sur iOS, ça demande un composant séparé appelé **Notification Service
Extension** (une petite app dans l'app), qui n'existe **pas encore**. En attendant, iOS
affichera une notif générique (« Nouveau message ») sans le contenu déchiffré. La livraison
et le "ping" fonctionnent ; seul le **texte déchiffré** manque. C'est un chantier à part
(voir le backlog iOS dans `CLAUDE.md`). Quand on l'ajoutera, il faudra **régénérer le
provisioning profile** (§4.4) car l'extension a besoin d'un *App Group* et de sa propre
capacité.

---

## 7. Activer et lancer le workflow (une fois les secrets remplis)

1. Assure-toi que **tous** les secrets du tableau §4 sont posés (le workflow te dira
   précisément lequel manque : étape *Validate iOS release secrets*).
2. Réactivation : dans [`.github/workflows/ios-release.yml`](../../../.github/workflows/ios-release.yml),
   le job ne tourne que si on le déclenche manuellement avec `force = true`. Pour le lancer :
   GitHub → onglet **Actions** → *iOS Release* → **Run workflow** → mets `force` = `true` → **Run**.
3. Si tout est bon, l'onglet *Actions* affichera un artefact `ios-release-ipa` téléchargeable.
   Sinon, lis le message d'erreur : il pointe l'étape et le secret fautif.

---

## 8. Petit glossaire

| Terme | Traduction mentale |
|---|---|
| **Certificat (Apple Distribution)** | "Carte d'identité" cryptographique de l'équipe qui signe l'app |
| **`.p12`** | Le certificat **+ sa clé privée**, exportés dans un fichier protégé par mot de passe |
| **Provisioning profile / `.mobileprovision`** | "Autorisation" : ce certif peut installer *cette* app avec *ces* droits |
| **Signing identity** | Le nom exact du certificat à utiliser pour signer |
| **Team ID** | Identifiant de ton équipe Apple |
| **`.ipa`** | Le paquet installable iOS (équivalent de l'`.apk` Android) |
| **TestFlight** | Le système Apple pour distribuer des builds de test aux beta-testeurs |
| **App Store Connect** | Le portail Apple pour gérer l'app, TestFlight, les clés API |
| **APNs** | Le service de notifications d'Apple (Firebase lui relaie nos pushs) |
| **NSE (Notification Service Extension)** | Le bout de code iOS qui déchiffrerait le texte des notifs (pas encore fait) |

---

## 9. En cas de blocage — la checklist

- **"Missing required GitHub secret: X"** → le secret `X` n'est pas posé (ou faute de frappe
  dans le nom, qui doit être en MAJUSCULES exactes). Reprends §4.
- **Erreur de signature / "no signing certificate"** → le `.p12`, le mot de passe ou la
  signing identity ne correspondent pas. Vérifie que les trois viennent bien du **même**
  certificat *Apple Distribution*.
- **Erreur "provisioning profile doesn't match"** → le profil ne cible pas `fr.emse.canari`,
  ou ne contient pas le bon certificat, ou une capacité manque. Régénère-le (§4.4).
- **Le build passe mais pas de notifs push** → capacité *Push Notifications* non cochée sur
  l'App ID, ou profil régénéré sans elle, ou `aps-environment` pas en `production`
  (il l'est déjà dans `canari_iOS.entitlements`).
- **Pour toute question Apple Developer** (rôles, accès) → il faut être **Admin** de l'équipe,
  demande à Jolan.
