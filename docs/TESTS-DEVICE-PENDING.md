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

## Garde-fou general (a chaque session)
Apres plusieurs echanges croises sur 2 comptes : **0 message manquant**, **0 doublon**, notifications
fiables, aucun gel. Si un message manque, capturer les logs **serveur + mobile** du meme creneau.
