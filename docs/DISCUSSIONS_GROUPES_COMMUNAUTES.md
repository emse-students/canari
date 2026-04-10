# Discussions, Groupes et Communautés

## Objectif du document

Ce document décrit :

1. Le fonctionnement actuel des discussions **1v1** et des **groupes** (basés sur MLS).
2. Le fonctionnement cible des **communautés/channels** :
   - messages stockés côté serveur pour conserver l'historique,
   - distribution (et rotation) des clés de channel via **messages MLS**.

Le but est d'avoir une base claire pour l'implémentation et les revues techniques.

---

## 1) Périmètre et composants

### Composants principaux

- **Frontend (Svelte + Tauri)**
  - Chiffrement MLS côté client via wasm.
  - Stockage local des états de conversations et de l'état MLS (autosave chiffré).
- **Chat Gateway (Rust)**
  - Transport temps réel WebSocket.
- **Chat Delivery Service (NestJS)**
  - API MLS (groupes, membres, key packages, welcomes, messages en attente, historique chiffré).
- **Social Service (NestJS)**
  - API communautés/channels et événements métier channel.

### Distinction fonctionnelle

- **Discussions 1v1 + Groupes**: sécurité et membership pilotés par MLS.
- **Communautés/Channels**: aujourd'hui chiffrées différemment (clé symétrique channel), demain clé distribuée par MLS tout en conservant un historique serveur.

---

## 2) État actuel: 1v1 et groupes (MLS)

## 2.1 Principes MLS utilisés

- Un groupe MLS a un **epoch**.
- Toute modification de membership (add/remove) produit un **commit** et avance l'epoch.
- Un appareil rejoint via **Welcome**.
- Les messages applicatifs MLS sont chiffrés dans l'epoch courant.

Résumé des effets :

| Opération                       | Effet epoch                |
| ------------------------------- | -------------------------- |
| createGroup                     | initialise (epoch 0)       |
| addMember / addMembersBulk      | +1                         |
| removeMember                    | +1                         |
| processWelcome                  | rejoint l'epoch du Welcome |
| processIncomingMessage (commit) | +1 côté receveur           |
| sendMessage (applicatif)        | pas de changement          |

## 2.2 Cycle de session (frontend)

Au login :

1. Initialisation MLS (restauration éventuelle de l'état).
2. Chargement du stockage local et des conversations.
3. Connexion WS.
4. Récupération des Welcome/messages en attente.
5. Publication d'un KeyPackage.
6. Traitement des invitations pending multi-appareils.
7. Découverte des groupes manquants.

À la reconnexion :

- retry avec backoff,
- fetch des pending messages,
- reprise du traitement des invitations,
- publication d'un KeyPackage frais.

## 2.3 Flux actuel d'une discussion 1v1

Création logique :

1. Vérifier les appareils du contact (évite un groupe orphelin).
2. Créer le groupe côté serveur (isGroup=false).
3. Créer le groupe MLS local.
4. Ajouter les appareils du contact en bulk (commit + welcome).
5. Envoyer les welcomes au contact.
6. Diffuser le commit.
7. Ajouter les autres appareils de l'émetteur (deuxième bulk).
8. Envoyer welcomes/commit puis sauvegarder l'état.

Conséquence : la création d'un 1v1 comporte typiquement deux transitions d'epoch (contact puis autres devices propres).

## 2.4 Flux actuel d'un groupe

Création :

1. Créer le groupe côté serveur (isGroup=true).
2. Créer le groupe MLS local.
3. Ajouter les autres appareils du créateur.
4. Envoyer welcomes + commit.

Invitation de membres :

1. Collecter tous les appareils des utilisateurs ciblés.
2. Faire un **addMembersBulk unique** pour éviter les erreurs d'epoch.
3. Enregistrer les membres côté serveur.
4. Envoyer welcomes puis commit.
5. Envoyer un message système (memberAdded).

Retrait de membre :

1. removeMember MLS (commit, epoch +1).
2. Notification système memberRemoved.
3. Nettoyage membership serveur.

Renommage :

- Pas de modification de l'arbre MLS.
- Mise à jour HTTP + message système.

## 2.5 Réception et file de traitement

- Les messages entrants sont traités séquentiellement.
- Les Welcome sont prioritaires.
- Les messages d'un groupe en attente de Welcome sont bufferisés.
- Cette stratégie limite les erreurs de type WrongEpoch en présence de latence.

## 2.6 Synchronisation multi-appareils

Le modèle actuel est "any member bootstraps" :

- N'importe quel appareil déjà membre peut traiter des invitations pending.
- Chaque ajout fait un commit MLS et envoie un Welcome.
- Un verrou par groupe limite les collisions concurrentes.

Ce mécanisme réduit les blocages lorsqu'un utilisateur a plusieurs appareils connectés de façon intermittente.

---

## 3) État actuel: communautés/channels

## 3.1 Comportement actuel

- Les channels utilisent une clé symétrique (AES-GCM) côté frontend.
- Les messages channel sont stockés côté social-service.
- Les événements channel transitent en temps réel (WS/Redis).
- Le nouvel arrivant peut lire l'historique si la clé est disponible.

## 3.2 Limite principale actuelle

La clé de channel est actuellement bootstrapée via une dérivation déterministe (placeholder), ce qui n'est pas le modèle de sécurité final attendu.

---

## 4) Cible produit: communautés avec historique serveur + distribution de clés via MLS

## 4.1 Objectif

Conserver les avantages des channels (historique serveur complet) tout en supprimant la distribution faible de clé :

1. Les messages restent stockés côté serveur (source d'historique).
2. Les clés de chiffrement de channel sont distribuées via des **messages MLS**.
3. La rotation des clés est pilotée et traçable.

## 4.2 Modèle cible

### A. Historique serveur (inchangé dans le principe)

- Les messages chiffrés de channel sont persistés côté backend.
- L'API d'historique fournit ciphertext + métadonnées (nonce, keyVersion, sender, timestamp).
- Le client reconstitue la timeline en déchiffrant localement avec la bonne version de clé.

### B. Distribution des clés via MLS (nouveau)

- Chaque utilisateur possède déjà un canal MLS (1v1 ou groupe de service) permettant l'envoi sécurisé de payloads de contrôle.
- Lorsqu'un utilisateur rejoint un channel, un membre autorisé envoie un message MLS contenant :
  - channelId,
  - keyVersion,
  - clé de channel chiffrée pour le destinataire MLS,
  - métadonnées anti-rejeu (timestamp, id de distribution).
- Le receveur accuse réception (message MLS d'ack).

### C. Rotation de clé

- Rotation déclenchée à l'invitation, à l'expulsion, ou périodiquement.
- Une nouvelle keyVersion est générée.
- La nouvelle clé est redistribuée via MLS aux membres autorisés.
- Les messages anciens restent lisibles via les anciennes clés conservées localement (vault versionné).

## 4.3 États métier cibles pour une distribution de clé

Proposition d'états par membre/channel :

- `pending_key_distribution`
- `key_sent`
- `key_received`
- `key_acked`
- `failed` (avec retry)

Ces états permettent d'opérer des retries idempotents et d'éviter des trous d'accès à l'historique.

## 4.4 Séquence cible: arrivée d'un nouveau membre

1. Le backend valide les permissions d'invitation.
2. Le membre est ajouté au channel (métadonnées serveur).
3. Le backend (ou un orchestrateur) déclenche une rotation de clé optionnelle.
4. Un membre autorisé distribue la clé (ou la nouvelle clé) via MLS.
5. Le nouvel utilisateur stocke la clé dans son vault local.
6. Le client charge l'historique serveur et déchiffre avec la keyVersion adéquate.

## 4.5 Séquence cible: envoi/réception de message channel

Envoi :

1. Lire la clé active du channel (keyVersion courante).
2. Chiffrer le payload (AES-GCM).
3. Envoyer au social-service (ciphertext + nonce + keyVersion).
4. Persister serveur puis publication événement temps réel.

Réception :

1. Lire keyVersion du message.
2. Résoudre la clé correspondante depuis le vault local.
3. Déchiffrer et afficher.
4. Si clé absente: demander re-distribution MLS ou attendre réception MLS en retard.

---

## 5) Contrat technique recommandé pour la cible communautés

## 5.1 Payload MLS de distribution de clé (exemple)

```json
{
  "type": "channel_key_distribution",
  "channelId": "...",
  "keyVersion": 12,
  "encryptedChannelKey": "base64...",
  "distributionId": "uuid...",
  "issuedAt": "2026-04-10T12:00:00Z"
}
```

## 5.2 Contraintes de sécurité

- Contrôle strict des permissions d'invitation et de rotation.
- Protection anti-rejeu sur les messages de distribution de clé.
- Journal d'audit (qui a distribué quelle version, à qui, quand).
- Rotation obligatoire à l'expulsion d'un membre.

## 5.3 Tolérance aux pannes

- Distribution MLS avec retry et idempotence (distributionId unique).
- Cache local des clés versionnées.
- Déchiffrement différé quand clé non encore reçue.

---

## 6) Ce qui reste MLS vs non-MLS

- **Reste MLS**:
  - identité cryptographique des appareils,
  - distribution et rotation des clés de channel,
  - messages de contrôle sensibles.

- **Reste non-MLS (channels)**:
  - stockage historique des messages côté serveur,
  - transport événementiel channel,
  - chiffrement des contenus avec clé symétrique de channel versionnée.

---

## 7) Risques et points d'attention

1. **Désynchronisation de keyVersion** entre émetteur et receveur.
2. **Retard de distribution MLS** qui bloque le déchiffrement immédiat de l'historique récent.
3. **Complexité de rotation** en cas de membres multi-appareils partiellement offline.
4. **Migrations** depuis le modèle de dérivation actuelle vers distribution MLS explicite.

Mitigations recommandées :

- retries idempotents,
- ack explicite,
- monitoring des états de distribution,
- outils d'admin pour rediffuser une clé à un membre/appareil.

---

## 8) Résumé exécutif

- Les **1v1 et groupes** reposent déjà sur un flux MLS complet (Welcome/Commit/epochs) et constituent la base robuste du système de messagerie privée.
- Les **communautés** doivent conserver l'historique serveur mais migrer vers une **distribution de clés par messages MLS** pour atteindre le niveau de sécurité attendu.
- La cible repose sur un vault de clés versionnées, une distribution MLS fiable (avec ack/retry) et une rotation maîtrisée.
