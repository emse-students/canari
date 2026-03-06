# Implémentation du support Multi-Appareils (Multi-Leaves) pour OpenMLS

Ce document trace la feuille de route pour faire évoluer l'architecture actuelle (où un utilisateur ne peut posséder qu'une seule et unique session E2E active) vers un modèle **1:N** (comme Signal ou WhatsApp), où un utilisateur peut être connecté simultanément sur le Web, sur l'application Tauri sur son PC, et sur Mobile.

Dans ce modèle, plutôt que de synchroniser les clés privées entre les appareils, **chaque appareil génère sa propre paire de clés cryptographiques** et toutes les clés de l'utilisateur sont ajoutées au même "Group ID" de la conversation de façon transparente.

## Phase 1 : Différenciation des identités (`ClientId` vs `UserId`)

Actuellement, l'identité avec laquelle on s'annonce sur la gateway et sur Svelte est l'`userId` (`"alice"`, `"bob"`). Si Web et Tauri utilisent ce même ID, l'un écrase l'autre dans le magasin de clés publiques du serveur.

**Action requise Frontend (`+page.svelte` et `mlsService.ts`) :**

1. Au lancement, détecter l'environnement (Web Wasm vs Desktop Tauri).
2. Dériver un `clientId` unique. Exemple : `"alice-web"` ou `"alice-desktop"`. Voire `"alice-" + crypto.randomUUID()`.
3. Initialiser le Wasm WebMlsService **avec ce `clientId`** : `await mls.init(clientId, pin, ...)` de façon à ce que le local storage porte le nom du `clientId` : `mls_autosave_alice-web`.
4. Transmettre tout de même l'alias métier (l'`userId` parent) au Gateway lors de la connexion pour le routage.

## Phase 2 : Stockage List/Set des KeyPackages dans Redis (Gateway Rust)

Actuellement, le Gateway `chat-gateway` stocke une clé unique 1:1 pour chaque utilisateur.

**Action requise Backend (`apps/chat-gateway/src/main.rs`) :**

1. Quand on reçoit un message `WebSocketMessage::KeyPackagePublish { payload }` :
   - Au lieu de faire un `redis.set("key_package:{user_id}")` (qui écrase tout).
   - Faire un `redis.sadd("key_packages:{user_id}", payload)` pour ajouter la clé dans un _Set_ (Ensemble).
2. Sur la route API `/keys/{user_id}` :
   - Au lieu de répondre par une string brute en Base64...
   - Faire un `SMEMBERS` sur Redis pour récupérer tous les _KeyPackages_.
   - Renvoyer un tableau JSON : `["cle_base64_bureau", "cle_base64_navigateur"]`.
3. Implémenter un système de TTL (Time To Live) sur les membres du Set ou une commande de "Déconnexion" pour expurger les appareils inactifs.

## Phase 3 : Inviter tous les clients simultanément (Svelte Frontend)

Quand Alice (`alice-desktop`) souhaite ouvrir une conversation avec Bob (`bob`).

**Action requise dans `startNewConversation` (`+page.svelte`) :**

1. La commande `mls.fetchKeyPackage("bob")` devra être renommée en `fetchKeyPackages("bob")` et retourner un tableau (`Uint8Array[]`).
2. Lors de la récupération :

   ```typescript
   const bobsKeyPackages = await mls.fetchKeyPackages("bob");

   // Boucler sur tous les appareils de Bob pour les ajouter au Ratchet Tree
   for (const kp of bobsKeyPackages) {
     const result = await mls.addMember(groupId, kp);

     // Sauvegarder le profil local
     await mls.saveState(pin);

     // Pousser le Welcome individuellement ! (Idéalement en ciblant le clientId)
     // Si c'est juste "bob", le Gateway redistribuera à tous, ils ignoreront
     // ceux qui ne peuvent pas les déchiffrer.
     await mls.sendWelcome(result.welcome!, "bob");
   }
   ```

## Phase 4 : Distribution (Fan-out) des messages

C'est la partie la plus facile car c'est **déjà partiellement implémenté** !
Quand `alice-desktop` envoie _"Bonjour"_, le message est chiffré **1 fois** pour le groupe OpenMLS de la discussion, qui inclut le client `alice-web`, `bob-web`, et `bob-desktop`.

1. Le Gateway reçoit le flux.
2. Le Gateway Push via `chat_events` (Redis PubSub).
3. Le Gateway stocke le flux dans la liste Redis pour l'historique asynchrone offline (`history:{group_id}`).
4. `bob-desktop` le reçoit _en live_.
5. Si `bob-web` l'a manqué, à sa prochaine connexion, `loadHistoryForConversation` téléchargera la liste, déchiffrera avec la clé secrète de `bob-web` et réaffichera le tout.

**⚠️ Précision importante** : Un système complet de "Client ID" impliquera de réviser un peu la structure des messages pour que l'interface ne s'affiche pas _"alice-web a dit"_ mais bien _"alice a dit"_. Il faudra dissocier la "Leaf ID" (appareil) de la "Credential ID" (identité de l'utilisateur métier métier authentifié par JWT/Spring Boot).
