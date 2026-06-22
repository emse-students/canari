# Tests device en attente (MLS / FCM / recovery)

Changements livres mais **non testes sur device** (un seul compte Canari disponible au moment du
dev). Pour chaque scenario : etapes, resultat attendu, et **commits a revoir si KO** pour corriger
vite. Mis a jour au fil des passes de l'audit (`docs/AUDIT-MLS-2026-06.md`).

Pre-requis a chaque session de test : **backend redeploye** + **app Android rebuildee** + **front/Tauri
rebuilds** (les changements touchent serveur, Kotlin, TS et Tauri/SQLite selon les cas).

---

## T1 - Livraison push en arriere-plan (le bug d'origine)
**But** : un destinataire mobile (app fermee) recoit les messages + notifications.
**Etapes** :
1. Compte A (PC) + compte B (mobile, **app tuee**) dans un meme groupe.
2. A envoie 2-3 messages pendant que l'app de B est fermee.
3. Ouvrir l'app de B.
**Attendu** :
- B recoit une **notification** par message (avant ouverture).
- Logs serveur : `[SEND] recipient=...:tauri-...` (le mobile EST destinataire) + `[MEMBERSHIP_ACTIVE] device=B:tauri-...` au join background.
- A l'ouverture : messages **affiches**, plus de `[WARN] Echec replay historique ... database is locked`.
**Commits si KO** :
- Pas de notif / mobile absent des destinataires -> `92029137` (FCM1, membership active background) + `9b234252` (FCM0).
- Messages recus mais pas affiches a l'ouverture -> `05eeeb26` (DB1, busy_timeout SQLite).

## T2 - Activation membership au retour foreground (FCM0)
**But** : un device joint en background devient routable apres ouverture.
**Etapes** :
1. B rejoint un groupe **en background** (notif Welcome), puis **ouvre l'app**, puis re-background.
2. A envoie un message.
**Attendu** : B recoit le message. Logs serveur : pas de `FALLBACK_MEMBERS_CACHE count=1` excluant le mobile.
**Commits si KO** : `9b234252` (chemin Welcome idempotent -> updateInvitationStatus('active')).

## T3 - Rotation de token FCM (FCM2)
**But** : un token rotate app fermee est pousse au backend sans reouverture.
**Etapes** :
1. Sur B : **effacer les donnees** de l'app (ou reinstaller) -> nouveau token FCM ; se reconnecter une fois.
2. **Sans rouvrir l'app**, A envoie un message.
**Attendu** : notification recue. Logs serveur : `[PUSH_REFRESH] user=B device=...`, pas de `No push token`.
**Commits si KO** : `92029137` (FCM2, onNewToken -> /mls/push/refresh-token).

## T4 - Boucle de purge fantome (groupe absent du serveur)
**But** : un groupe local sans ligne `dm_groups` est purge UNE fois, pas a chaque reload.
**Etapes** :
1. Provoquer un groupe local dont la ligne serveur a disparu (base videe / hard-purge).
2. Recharger l'app plusieurs fois.
**Attendu** : log `[READD] ...absent du serveur (confirme) - fantome purge` **une seule fois**, pas a chaque reload.
**Commits si KO** : `a51c1b4a` (getUserGroups n'expose plus un successorId danglant).

## T5 - Badge Sync sur groupe mort (UI)
**But** : une conversation `removed` n'affiche pas le badge "Sync".
**Etapes** : ouvrir une conversation supprimee par un pair / dont on a ete exclu.
**Attendu** : pas de badge "Sync" dans la liste (la banniere "supprimee" dans la conversation reste).
**Commits si KO** : `5a6946ad` (prop isRemoved sur ConversationTile).

## T6 - Reboot via reseau incertain (S1)
**But** : un blip reseau pendant un reboot ne cree pas de successeur duplique.
**Etapes** : declencher un reboot de groupe avec une connexion instable (couper le reseau au mauvais moment).
**Attendu** : pas de successeur orphelin/duplique ; log `[REBOOT] ... statut serveur incertain (reseau) - report`.
**Commits si KO** : `88e64233` (performReboot via getGroupServerStatus).

## T7 - Invitations non sautees sur erreur reseau (S2)
**But** : un echec reseau ne fait pas conclure "aucun membre" et sauter des invitations legitimes.
**Etapes** : reboot/invitation avec coupure reseau transitoire sur la resolution des membres.
**Attendu** : pas de successeur sans membre ; le filet `epoch=0` du health-check re-invite ensuite.
**Commits si KO** : `a8dfea3a` (getters de liste stricts).

## T8 - Recovery concurrente : atomicite (H2 + H3)
**But** : pas de double migration / messages perdus / boucle welcome_request / gel UI.
**Etapes** :
1. Scenario reboot/succession de groupe (kick + re-ajout, ou groupe passant par un successeur),
   idealement avec un Welcome recu pendant un tick de sync.
**Attendu** :
- Pas de **conversation dupliquee**, pas de **messages disparus** pendant la migration.
- Log `[MIGRATE] Successeur ... pas encore dans le WASM - predecesseur conserve (H2)` est **normal/sain**.
- **Critique (anti-deadlock)** : la messagerie ne **gele jamais** (un Welcome pendant un tick ne bloque pas l'UI).
**Commits si KO** :
- Double migration / messages ecrases -> `3df8e399` (H3, runExclusiveForGroup).
- Boucle welcome_request apres migration -> `3df8e399` (H2, forget gate).
- **Gel/deadlock** -> `3df8e399` (verrou par-groupe ; verifier l'invariant anti-deadlock du module groupMutationQueue).

---

## Passe 2 - Concurrence multi-moteur mls.bin (commit `f656441`)

> **Pre-requis specifique** : le code Rust touche est **android-gated** et n'a PAS pu etre compile
> hors NDK pendant le dev. **Rebuild APK obligatoire** + verifier qu'il **compile** (aucune erreur
> sur `background_write_mls_bin`, le Worker janitor, les 3 sites JNI Welcome/send). Si la compilation
> echoue, c'est le seul vrai risque de regression -> regarder en priorite ces zones de `lib.rs`.

### T9 - Lost-update : envoi/join background puis resume (C2)
**But** : une avancee `mls.bin` faite en arriere-plan n'est PAS ecrasee au retour premier plan.
**Etapes** :
1. A (PC) et B (mobile) dans un groupe. **App de B tuee.**
2. A envoie un message (B le recoit en background -> draine son outbox / ou B avait un message en
   attente envoye en background).
3. Ouvrir l'app de B, echanger encore 2-3 messages des deux cotes.
**Attendu** :
- Logs mobile : `[RESUME] manager foreground recharge depuis mls.bin (C2)` au retour.
- **Aucune** cascade `SecretReuseError` / `epoch_mismatch` cote A ni B apres l'ouverture.
- Conversation complete et coherente des deux cotes, **0 message manquant**.
**Commits si KO** : `f656441` (C2 `recharger_mls_au_resume` ; verifier qu'il est bien appele au
`visible` AVANT la reconnexion WS dans `ChatBackgroundService`).

### T10 - Garde foreground : background non bloque mais pas concurrent (C1/FCM3)
**But** : la garde foreground n'empeche pas la livraison background app tuee, mais bloque bien
l'ecriture background quand l'app est active.
**Etapes** :
1. **App de B tuee** depuis > 1 min : A envoie un message.
   **Attendu** : B recoit notif + message (la garde a expire -> background autorise a ecrire). Logs :
   pas de `foreground actif -> abandon ecriture` en boucle.
2. **App de B au premier plan** : A ajoute un device / declenche un Welcome vers B pendant que B
   chatte. **Attendu** : logs mobile `foreground actif - ecriture mls.bin background abandonnee`
   (le background s'abstient), et le **foreground** traite le Welcome via WS sans clobber.
**Commits si KO** :
- Background qui ne livre plus app tuee (garde stuck-true) -> `f656441` (verifier l'expiration
  `FOREGROUND_GRACE_MS` + le heartbeat `mls_foreground_heartbeat` en pause sur `hidden`).
- Clobber a la transition -> `f656441` (re-check de la garde sous le verrou avant ecriture).

### T11 - Recovery de gap par le foreground seul (option B)
**But** : un message d'epoch en avance (rafale) apparait quand meme dans la conversation a
l'ouverture, sans le drain background du Worker.
**Etapes** :
1. Provoquer un gap : rafale de messages de A pendant/autour d'un changement d'epoch (ajout/retrait
   de membre), B mobile en arriere-plan puis ouvert.
**Attendu** :
- Le(s) message(s) gap **apparaissent dans la conversation** apres ouverture (recuperes par le resync
  serveur foreground sur `GAP_QUEUED`).
- Logs : **plus** de `Background Worker: checkpoint coalesce` (le Worker ne draine plus). La table
  `pending_mls_messages` ne fait que se nettoyer.
- **0 message manquant**, **0 doublon**.
**Commits si KO** : `f656441` (option B : si un message gap manque, c'est que la recuperation
foreground ne le rattrape pas -> rouvrir la question A/B, eventuellement re-activer un drain qui
**cache le plaintext** au lieu de le jeter).

---

## Garde-fou general (a chaque session)
Apres plusieurs echanges croises sur 2 comptes : **0 message manquant**, **0 doublon**, notifications
fiables, aucun gel. Si un message manque, capturer les logs **serveur + mobile** du meme creneau.
