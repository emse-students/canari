# Notifications Push

## 1. Portée actuelle

L'implémentation actuelle des notifications push Canari est partielle.

- Push remote réellement implémentées : application mobile Tauri sur Android
- Web / desktop : pas de push remote ; seulement des notifications locales si l'application est déjà ouverte
- iOS : chemin partiellement préparé côté backend, mais pas fonctionnel côté client
- Cas couverts : messages hors-ligne
- Cas non couverts proprement : welcome / commit MLS, et plus largement les événements dont le contenu n'est pas extrait en texte côté Android natif

En pratique, le pipeline aujourd'hui est pensé pour un message chiffré MLS reçu pendant que le device Android destinataire est hors ligne.

---

## 2. Flux actuel de bout en bout

## 2.1 Récupération et enregistrement du token

Au lancement Android :

1. L'application native récupère un token FCM via `FirebaseMessaging.getInstance().token`.
2. Le token est stocké localement côté Android.
3. Le service FCM Android écrit aussi le token dans `fcm_token.txt` lors de `onNewToken()`.
4. Au login chat, le frontend appelle `startPushService()`.
5. `startPushService()` lit le token via la commande Tauri `get_fcm_token`.
6. Le frontend envoie ensuite `POST /api/mls-api/push/register` avec `{ token, deviceId, platform }`.

Le token est enregistré dans la table `push_tokens` du `chat-delivery-service`.

---

## 2.2 Contexte local nécessaire au déchiffrement d'une push

Sur Android, l'application prépare deux fichiers locaux pour que le service FCM puisse travailler même si l'UI n'est pas ouverte :

- `push_context.json` : contient `pin`, `userId`, `deviceId`, `baseUrl`
- `mls_push.bin` : contient l'état MLS chiffré

Ces fichiers sont alimentés par les commandes Tauri suivantes :

- `store_push_context`
- `save_mls_state_for_push`

Le service FCM Android s'appuie sur ces fichiers pour récupérer et déchiffrer le message ciblé.

---

## 2.3 Décision backend : temps réel ou push

Quand `POST /api/mls-api/send` est appelé :

1. Le backend persiste d'abord tous les messages dans `queued_message`.
2. Pour chaque destinataire device, il teste la présence Redis :
   - clé : `user:online:{userId}:{deviceId}`
3. Si le device est vu `online` :
   - le backend publie sur Redis `chat:messages`
   - aucune push n'est envoyée
4. Si le device est vu `offline` et que le payload n'est ni `welcome` ni `commit` :
   - le backend envoie une push FCM data-only

Payload envoyé actuellement :

```json
{
  "type": "message",
  "groupId": "...",
  "queuedMessageId": "...",
  "senderId": "..."
}
```

Caractéristiques importantes :

- il n'y a pas de clé `notification` dans le payload FCM
- le backend s'appuie donc sur `onMessageReceived()` côté Android
- le contenu affiché est reconstruit côté client après récupération du message en attente

---

## 2.4 Réception Android

Le service `CanariFirebaseMessagingService` :

1. reçoit le payload data-only
2. lit `push_context.json`
3. lit `mls_push.bin`
4. appelle `GET /api/mls-api/messages/:userId/:deviceId`
5. retrouve le message par `queuedMessageId`
6. appelle `nativeDecryptMessage(...)` côté Rust/JNI
7. extrait un texte utilisateur si possible
8. affiche une notification locale Android

Extraction de contenu actuellement supportée côté Rust :

- `TextMsg`
- `ReplyMsg`
- `MediaMsg` avec fallback `📎 Pièce jointe`

Si le déchiffrement ou l'extraction échoue, le fallback affiché est :

`Ouvrir l'application pour voir le contenu du message`

---

## 3. Ce qui est réellement implémenté aujourd'hui

## 3.1 Android / Tauri

Implémenté :

- récupération du token FCM
- enregistrement backend du token
- réception d'une push data-only
- récupération du message en file d'attente
- déchiffrement MLS local via Rust
- affichage d'une notification Android locale

Limites :

- dépend d'un contexte local valide (`push_context.json`, `mls_push.bin`)
- dépend d'un PIN encore utilisable pour déchiffrer l'état MLS
- dépend de la permission Android de notification
- dépend du statut Redis hors ligne du device

## 3.2 Web / desktop

Pas de push remote.

L'application peut seulement afficher des notifications système locales quand elle tourne déjà, via :

- API Web Notifications dans le navigateur
- plugin Tauri notification quand l'application est ouverte

Comportement actuel côté navigateur :

- la permission est demandée au montage du service de fond chat
- si le navigateur exige un geste utilisateur, une nouvelle tentative est rebranchée sur la prochaine interaction
- une notification locale est envoyée dès qu'un message arrive alors que l'onglet n'est pas visible ou n'a pas le focus, y compris si la conversation concernée est déjà ouverte

## 3.3 iOS

Non finalisé.

Le backend accepte `platform = ios` et ajoute un bloc `apns` au message Firebase, mais :

- `get_fcm_token()` retourne `null` hors Android
- aucun service natif iOS équivalent à `CanariFirebaseMessagingService` n'est présent ici
- aucun chemin iOS de lecture / déchiffrement / affichage n'est documenté ni visible dans ce dépôt

Conclusion : iOS ne doit pas être considéré fonctionnel aujourd'hui pour les push chat.

---

## 4. Limitations et incohérences actuelles

## 4.1 Le backend cible maintenant le device offline concerné

Dans `POST /api/mls-api/send`, quand un device destinataire est offline, le backend cherche désormais le token avec :

- `userId = recipientId`
- `deviceId = queued.deviceId`

Cela évite les envois vers d'autres devices du même utilisateur.

## 4.2 Les tokens invalides sont supprimés au retour Firebase

Si Firebase retourne une erreur terminale de type token invalide ou token non enregistré, l'entrée correspondante est supprimée de `push_tokens`.

Cela réduit les erreurs répétées et assainit l'état backend.

## 4.3 La permission de notification Android est nécessaire mais pas garantie

Le manifeste déclare `POST_NOTIFICATIONS`, mais l'affichage réel dépend encore du consentement runtime Android 13+.

L'application appelle bien une demande de permission via le plugin notification Tauri au montage du service de fond chat, mais si l'utilisateur refuse, aucun affichage système n'est possible.

## 4.4 Le backend n'envoie une push que si Redis considère le device hors ligne

Si la clé Redis `user:online:{userId}:{deviceId}` existe encore, le backend publie seulement sur `chat:messages` et n'envoie pas de push.

Un faux positif de présence suffit donc à supprimer toute notification push.

## 4.5 Le pipeline dépend d'un état MLS local à jour

Si `mls_push.bin` est absent, obsolète, ou chiffré avec un PIN qui ne correspond plus, la notification peut encore arriver mais sans contenu exploitable.

Le fallback utilisateur sera alors générique.

## 4.6 Le contenu extrait n'est pas général

L'extraction native actuelle sait lire :

- message texte
- réponse
- média

Elle ne reconstruit pas explicitement :

- réactions
- événements système
- autres types applicatifs futurs

---

## 5. Pourquoi les push peuvent ne pas fonctionner

Voici les causes probables les plus crédibles dans l'état actuel du code.

## 5.1 Firebase Admin n'est pas initialisé côté backend

Le backend désactive les pushs si `FIREBASE_SERVICE_ACCOUNT_JSON` est absent ou invalide.

Symptôme :

- aucun envoi FCM
- logs backend avec `push disabled` ou erreur d'initialisation Firebase

## 5.2 Le token push n'est jamais enregistré côté backend

Le flux dépend de :

- récupération du token Android
- appel `POST /api/mls-api/push/register`

Si l'un des deux échoue, la table `push_tokens` reste vide.

Symptôme :

- pas de ligne `PUSH_REGISTER`
- aucune ligne dans `push_tokens` pour le device

## 5.3 Le device est considéré online alors qu'il ne devrait plus l'être

Le backend n'envoie la push que si le device ciblé est offline selon Redis.

Symptôme :

- log `online=true` dans `SEND`
- aucun log `PUSH_SEND`

## 5.4 La permission de notification locale n'est pas accordée

La réception du message peut fonctionner, mais le système bloque l'affichage de la notification locale.

Symptôme :

- token présent
- logs backend OK
- aucune notification visible côté device ou navigateur

## 5.5 Le navigateur n'accorde pas ou n'exécute pas la permission locale

Même avec le correctif actuel, certains navigateurs ne valident `Notification.requestPermission()` qu'après un vrai geste utilisateur.

Symptôme :

- aucun affichage local sur navigateur
- permission toujours `default` ou `denied`

## 5.6 Le service Android ne parvient pas à récupérer ou déchiffrer le message

Causes fréquentes :

- `push_context.json` absent
- `mls_push.bin` absent
- PIN obsolète
- message déjà ACKé ou introuvable dans `queued_message`
- erreur réseau lors de `GET /api/mls-api/messages/:userId/:deviceId`

Symptôme :

- notification générique seulement, ou aucune notification si la permission manque

---

## 6. Pistes de correction prioritaires

## 6.1 Corriger le ciblage backend du token push

Déjà corrigé.

## 6.2 Supprimer automatiquement les tokens invalides

Déjà corrigé.

## 6.3 Instrumenter le flux de bout en bout

Ajouter des logs plus explicites sur :

- obtention du token côté Android
- appel frontend vers `push/register`
- présence Redis au moment du send
- nombre de tokens trouvés pour le device ciblé
- réponse Firebase par token
- succès / échec du déchiffrement côté service Android

## 6.4 Vérifier et fiabiliser la permission de notification

Aujourd'hui, la demande existe et un retry est branché sur la prochaine interaction navigateur si nécessaire.

Améliorations utiles :

- écran ou bannière claire si la permission est refusée
- statut de permission visible dans les paramètres de l'app
- bouton de relance de la demande / lien vers réglages système

## 6.5 Mieux découpler la push du fetch anonyme de messages

Le service Android récupère actuellement les messages via `GET /api/mls-api/messages/:userId/:deviceId` sans auth explicite.

Deux options plus propres :

- garder ce modèle mais le documenter explicitement comme endpoint technique dédié au service push
- ou signer le payload push avec un jeton court de récupération spécifique

## 6.6 Finaliser ou désactiver explicitement iOS

L'état actuel est hybride et peut induire en erreur.

Il faut choisir :

- soit implémenter le vrai chemin iOS de token + réception + déchiffrement
- soit masquer complètement le support iOS côté produit et doc tant qu'il n'existe pas

---

## 7. Checklist de debug rapide

1. Vérifier que `FIREBASE_SERVICE_ACCOUNT_JSON` est configuré côté `chat-delivery-service`.
2. Vérifier qu'une ligne `push_tokens` existe pour le couple `userId + deviceId`.
3. Vérifier les logs backend `PUSH_REGISTER`, `SEND`, `PUSH_SEND`.
4. Vérifier si le backend voit le device `online=true` au lieu de `offline`.
5. Vérifier la permission notification sur Android ou dans le navigateur.
6. Vérifier la présence de `push_context.json`, `mls_push.bin`, `fcm_token.txt` dans le répertoire applicatif Android.
7. Vérifier qu'un message offline existe bien encore dans `queued_message` pour le `queuedMessageId` reçu.
8. Vérifier que le déchiffrement JNI ne tombe pas en fallback systématique.

---

## 8. Références code

- Frontend login / enregistrement token : `frontend/src/lib/composables/useChatSession.svelte.ts`
- Service frontend push : `frontend/src/lib/services/PushNotificationService.ts`
- Préparation du contexte push Tauri : `frontend/src/lib/services/TauriMlsService.ts`
- Commandes Tauri / JNI Rust : `frontend/src-tauri/src/lib.rs`
- Service Android FCM : `frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt`
- Bootstrap Android / token FCM : `frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/MainActivity.kt`
- Backend envoi / push register : `apps/chat-delivery-service/src/app.controller.ts`
