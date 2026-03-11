# CHANNELS_SERVICE_ROADMAP.md

## 1. But et contexte

Objectif: ajouter un systeme de canaux type Discord/Slack pour les promotions, assos et communautes, sans casser les flux DM/groupes MLS existants.

Contrainte cle: les canaux communautaires doivent pouvoir etre rejoints/quittes a tout moment, avec historique persistant, moderation et recherche. Cela est difficile a tenir avec MLS pur pour des groupes tres dynamiques.

**Modele de securite CHOISI (Zero-Trust E2EE par derivation de cles):**
- L'hypothese cle: un attaquant qui compromise le serveur channel-service ne doit PAS pouvoir lire les messages ou fichiers
- Solution: chiffrement E2EE par derivation HKDF des cles utilisateur (jamais exposees en clair serveur)
- Les messages sont AES-256-GCM ; les cles sont versionnees pour supporter expulsion/key rotation
- Un nouveau membre qui rejoint CAN lire l'historique complet (cles d'archives distribuees securisees)
- Un ancien membre qui est expulse CAN'T lire les nouveaux messages post-kick (nouvelle version de cle qu'il ne reçoit pas)

Decision:
- DM + groupes prives sensibles: MLS E2E (existant)
- Canaux communautaires: Zero-Trust E2EE (nouveau) par derivation de cles

## 2. Perimetre fonctionnel (Discord-like)

MVP (phase 1):
- Espaces (workspaces) pour promo/asso
- Categories de canaux
- Canaux texte publics/prives
- Rejoindre/quitter canal (avec secure key distribution)
- Historique persistant pagine (avec support acces ancien et nouveau membres)
- Mentions @user / @role (base)
- Roles et permissions (admin/modo/membre) + ACL
- Badges non-lus par canal
- **Zero-Trust: messages E2EE par derivation de cles, jamais en clair serveur**

Phase 2:
- Threads
- Recherche plein texte
- Reactions persistees
- Pin de messages
- Invitations par lien

Phase 3:
- Mod tools avances (mute, slowmode, audit log)
- Webhooks bots internes
- Federation eventuelle inter-espaces

Hors scope initial:
- Canaux vocaux temps reel
- E2EE de masse sur canaux communautaires

## 3. Nouveau micro-service propose

Nom: channel-service

Responsabilites:
- Gestion des espaces (workspace)
- Gestion des canaux, categories, roles, permissions
- Gestion des memberships (join/leave/kick/ban)
- API lecture/ecriture messages de canaux (ou delegation au chat-delivery)
- Emission d'evenements de domaine sur Kafka

Techno proposee:
- NestJS (coherence avec services Node existants)
- PostgreSQL (model relationnel ACL/roles/memberships)
- Redis (cache ACL + presence canal + fanout hints)
- Kafka (events: channel.*)

## 4. Modeles de donnees (minimum viable)

Tables coeur:
- workspaces(id, slug, name, visibility, created_by, created_at)
- workspace_members(user_id, workspace_id, role_id, status, joined_at, left_at)
- roles(id, workspace_id, name, priority)
- role_permissions(role_id, permission)
- categories(id, workspace_id, name, position)
- channels(id, workspace_id, category_id, type, name, visibility, topic, position, current_key_version INT, archived)
- channel_members(channel_id, user_id, role_override, joined_at, left_at, last_read_message_id, keys_granted_up_to_version INT)
- channel_messages(id, channel_id, sender_id, ciphertext BLOB, nonce BYTEA, key_version INT, metadata_json, created_at, edited_at, deleted_at)
- channel_key_archive(id, workspace_id, channel_id, version INT, encrypted_key_for_user BYTEA, created_at) [historique des clés]
- channel_reactions(message_id, emoji, user_id, created_at)
- audit_logs(id, workspace_id, actor_id, action, target_type, target_id, encrypted_payload, created_at)

Index importants:
- channel_messages(channel_id, created_at desc)
- channel_members(user_id, joined_at desc)
- workspace_members(user_id, workspace_id)
- channels(workspace_id, position)

## 5. APIs et contrats

REST (admin/config):
- POST /workspaces
- POST /workspaces/{id}/channels
- PATCH /channels/{id}
- POST /channels/{id}/members/join
- POST /channels/{id}/members/leave
- POST /channels/{id}/moderation/kick

Realtime (gateway):
- ws event channel.message.send
- ws event channel.message.update
- ws event channel.message.delete
- ws event channel.reaction.add
- ws event channel.read.update

Kafka events (source of truth de domaine):
- channel.workspace.created
- channel.created
- channel.member.joined
- channel.member.left
- channel.message.created
- channel.message.edited
- channel.message.deleted
- channel.role.updated

Schema contracts:
- Ajouter protobuf/avro dans libs/event-contracts/channel-events
- Versionner les schemas (v1, v2...) pour compat backward

## 6. Securite - Architecture Zero-Trust E2EE

### Principe fondamental
**Hypothèse d'adversaire:** un attaquant peut compromettre le serveur channel-service dans sa totalité (DB, API, Redis). **Objectif:** l'attaquant ne peut toujours pas lire les messages ou fichiers des canaux.

### Mécanisme de chiffrement par dérivation de clé

**Clé maître utilisateur (KMS root):**
- Stockée dans auth-service/KMS (HSM ou secret manager sécurisé)
- Jamais exposée en clair ; dérivée = unique par user+workspace
- Nécessite authentification forte (JWT + MFA) pour accès

**Dérivation de clé de canal (client-side):**
```
channel_key_version_N = HKDF(
  ikm=user_kms_root,
  salt=SHA256(workspace_id || channel_id || version_number),
  info="channel-encryption-v1",
  L=32 bytes (AES-256)
)
```
- **Chaque client calcule indépendamment** la même clé
- **Serveur ne stocke jamais** la clé
- Version = integer incrémenté à chaque rotation (join/leave de membres)

**Chiffrement des messages:**
- Plaintext: `{sender_id, timestamp, content, attachments}`
- Cipher: `AES-256-GCM(plaintext, channel_key_version_N, nonce)` + AEAD authentification
- Serveur stocke : `{ciphertext, version_number, nonce, sender_id, timestamp, message_id}`
- Serveur NE peut PAS lire : contenu, fichiers, édits historiques

### Accès à l'historique pour nouveaux membres

**Question critique:** un nouveau membre qui rejoint peut-il lire les anciens messages ?
**Réponse:** OUI, via distribution de clés d'archives.

**Workflow détaillé:**

1. **Nouveau membre demande à rejoindre canal** (via join endpoint)
   - ACL vérifie les permissions (public vs private)
   - Channel-service valide l'accès

2. **Serveur prépare le paquet de clés d'historique**
   - Requête : `GET /channels/{id}/key-archive?user_id=X`
   - Retour : liste de `(version_number, encrypted_key_for_user_X)`
   - Les clés sont chiffrées avec la clé publique du nouvel utilisateur (RSA-4096, ou key transport via auth-service)
   - OU : clés envoyées via secure forward-secrecy (OPAQUE/DH)

3. **Client déchiffre les clés d'historique**
   - Client a la clé privée correspondante
   - Déchiffre la clé de chaque version
   - Stocke localement (Tauri secret storage / browser localStorage chiffré)

4. **Historique devient lisible**
   - Client fetch messages par version: `GET /channels/{id}/messages?version=1,2,3`
   - Client reçoit le ciphertext avec métadonnées
   - Client déchiffre localement avec les clés d'historique

**Exemple:**
- Messages 1-100: version=1 (original 10 membres)
- Membre #3 quitte → key rotation
- Messages 101-200: version=2 (9 membres)
- Nouveau membre rejoint → reçoit clé_v1 + clé_v2 → lit tout
- Ancien membre #3 → ne reçoit PAS clé_v2 → ne peut lire que messages 1-100

### Expulsion et rotation de clé

**Scenario: Admin kick membre #3 du canal**

1. Serveur delète `channel_members.channel_id={id}, user_id=3`
2. Serveur envoie évènement Kafka: `channel.member.kicked` avec timestamp
3. Serveur publie signal WebSocket: `{type: 'key.rotated', channel_id, new_version: 3}`
4. **Tous les clients existants (sauf le kicked)**
   - Dérivent la nouvelle clé: `channel_key_version_3 = HKDF(..., version_number=3)`
   - Les anciens ciphertexts (v1, v2) restent lisibles (ont les clés)
   - Les messages POST-kick (version_3+) sont sous une nouvelle clé
5. **Ancien membre kicked**
   - Reçoit le signal WebSocket mais ne peut pas dériver la v3
   - Ne peut pas rejoindre (ACL le refuse)
   - Ses anciennes messages (v1, v2) restent lisibles localement (cache)
   - Les nouveaux messages (v3+) : ciphertext stocké localement, clé manquante = non-lisible

**Implication:** suppression d'accès **immédiate** à la suite, mais l'historique passé reste chez ceux qui l'ont vu.

### Gestion des fichiers et blobs

- Fichiers uploadés = chiffrés avec la clé du canal (`channel_blob = AES-256-GCM(file, channel_key_version)`)
- Stockage: S3/GCS avec bucket chiffré à repos (double-layer)
- Métadonnées (filename, size, MIME) : stockées NON-chiffrées pour rendre le UI fonctionnel
- Modération: admin peut voir filename/size mais pas contenu

### Métadonnées accessibles au serveur

Pour assurer la functonalité (unread badges, modération, audit):
- **Visible serveur :** senteur, timestamp, message_id, reaction metadata (qui a cliqué), deleted_flag, edited_flag
- **POST-kick :** le server voit le kick event ; ancien membre n'apparaît plus dans `channel_members`
- **Moderation :** admin peut flaguer un message (non-readable) ou supprimer la trace (delete_flag=true) sans accès au contenu

### Recherche et indexation

**Problème:** serveur ne peut pas indexer le contenu (il est chiffré).

**Solutions envisagées:**
- **Phase 1 MVP:** Recherche client-side uniquement (decrypt localement, regex sur contenu)
- **Phase 2+:** Searchable encryption (DPE/order-preserving) = complexe, low priority
- **Alternatif:** indexation sélective de mots clés choisis par l'admin (non chiffré) = dégrade privacy

### Audit et conformité

**Trace d'audit (immutable, tamper-proof):**
- Serveur enregistre : `audit_log.action = 'message.created', target_id, actor_id, timestamp`
- N'enregistre PAS le contenu (chiffré)
- Chiffre le log lui-même avec une clé d'audit (rotation rare = une par workspace)
- Seulement les admins/auditeurs ont accès à la clé d'audit

**Compliance (GDPR):**
- User demande le droit à l'oubli : suppression de tous les messages (même passés)
- Workflow: archive all keys locally, nuke DB rows, rehash passwords old references
- Possible car contexte E2EE (contenu jamais exposé serveur)

### Transport et authentification

- **TLS 1.3 obligatoire** en transit (client ↔ serveur, service ↔ service)
- **JWT + PKCE + MFA** pour auth (auth-service)
- **Rate-limiting** par user + par canal (brute-force protection)
- **Session pinning** : une session = device ID + jeton, impossible de partager entre devices sans re-auth

### Trade-offs acceptés

| Contrainte | Impact | Mitigation |
|-----------|--------|----------|
| Historique ≠ supprimable | Ancien membre conserve vue locale | Vrai pour tous les chats E2EE (Signal, Matrix) |
| Résilience clés | Perte KMS root = messages non-lisibles | Backup HSM + recovery phrase 256-bit (offline) |
| Key rotation cost | O(N) clients doivent dériver + fetch | Versioning incrément → O(1) calcul derive |
| Modération limitée | Admin voit métadonnées, pas contenu | Modération par hashes/signatures optionnels phase 2 |

**Posture sécurité:** compromise serveur = lecteur ne peut toujours pas accéder aux données. Zero-Trust sur le plan du chiffrement.

## 7. Integration avec systeme actuel

Services impactes:
- chat-gateway (routage ws canaux)
- chat-delivery-service (persistance channel messages si mutualisee)
- auth-service (claims roles/tenants)
- user-service (profil + avatar + display)
- frontend (nouveau domaine canaux)

Strategie recommandee:
- Introduire channel-service sans casser le flux MLS existant
- Garder deux plans:
  - Plan A: conversations MLS (DM/groupes prives)
  - Plan B: canaux communautaires

## 8. Plan de migration (roadmap execution)

Phase 0 - Cadrage (1 semaine)
- RFC technique + ADR formel
- Domain boundaries et ownership
- Definition des KPIs MVP

Phase 1 - Foundations backend (3 semaines)
- Scaffold channel-service
- DB schema v1 + migrations (y.c. channel_key_archive, key_version)
- KMS integration avec auth-service (HSM ou secret manager)
- HKDF key derivation + AES-256-GCM cipher impl (NestJS crypto module)
- ACL engine v1 + key distribution logic (qui reçoit quelles clés)
- POST /workspaces/{id}/channels (create + init key_version=1)
- POST /channels/{id}/members/join (ACL check + send key-archive)
- POST /channels/{id}/members/leave (trigger key rotation)
- POST /channels/{id}/moderation/kick (ACL check + force rotation)
- GET /channels/{id}/messages?version=1,2,3 (return ciphertext + metadata)
- GET /channels/{id}/key-archive?user_id=X (secure key delivery, RSA/DH encrypted)

Phase 2 - Realtime et persistence messages (2 semaines)
- WS events canaux dans chat-gateway
- Persistance messages canal
- Read cursors et unread counters

Phase 3 - Frontend MVP (2 semaines)
- Sidebar Canaux data-driven (plus statique)
- Ecran workspace/channel
- Join/leave + lecture/ecriture
- Badges non-lus fiables

Phase 4 - Moderation et roles (1-2 semaines)
- UI roles/permissions
- Kicks/bans/archives
- Audit logs

Phase 5 - Search et qualite (2 semaines)
- Recherche paginee
- Tests charge + soak tests
- SLO dashboards + alerting

Phase 6 - Hardening prod (1 semaine)
- Security review
- Runbooks incident
- Backups + restore drills

## 9. Qualite et observabilite

Tests obligatoires:
- unit ACL
- integration API + DB migrations
- contract tests Kafka schemas
- e2e ws (join/send/read/leave)
- tests concurrence (messages burst)

SLO initiaux:
- p95 send message < 250 ms
- p95 fetch history page < 300 ms
- delivery success > 99.9%
- event lag Kafka < 2 s

Metriques:
- joins/leaves per channel
- unread lag
- fanout queue depth
- moderation actions

## 10. Risques et mitigations

Risque: duplication de logique entre MLS groups et channels
- Mitigation: domaine explicite + API facade cote frontend

Risque: explosion ACL cost
- Mitigation: cache + precompute permissions snapshots

Risque: migration de donnees confuse
- Mitigation: scripts idempotents + feature flags + rollback plan

Risque: compromise du KMS root ⚠️ CRITIQUE
- Impact: tous les canaux dechifyrable par l'attaquant
- Mitigation: HSM physique ou secret manager (AWS KMS, Vault) avec audit trails ; MFA pour acces KMS ; key rotation schedule 90j ; offline backup recovery phrases

Risque: key version chaos (quand faire rotation ?)
- Impact: des clients arrieres ne peuvent pas joindre canoniquement
- Mitigation: versioning strict (increment seul) + client grace period (30j pour mettre a jour) + replay protection

Risque: ancien membre qui conserve local cache de messages
- Impact: ne peut pas really "oublier" l'historique
- Mitigation: transparent (tous les E2EE chats ont ce probleme) ; on accepte ; si sensitive: demander suppression client apres kick

Risque: moderation limitee (admins ne peuvent pas lire contenu flagged)
- Impact: abuse hard a prouver
- Mitigation: signature optionnelle des messages (phase 2) ; trust sur metadata ; rate-limiting + automoderation regles

Risque: recherche imposible serveur-side
- Impact: UX degrade pour gros canaux
- Mitigation: client-side search OK pour MVP ; phase 2 explorer searchable encryption ou client-index sync

## 11. Checklist pre-kickoff

- [ ] ADR validee (Zero-Trust E2EE par derivation de cles + key versioning)
- [ ] Threat model documente (compromise serveur vs compromise KMS vs compromise client)
- [ ] KMS architecture definie (HSM vs managed secret service vs envelope encryption)
- [ ] HKDF + AES-256-GCM implementation testee (crypto review)
- [ ] Key archive & distribution protocol (RSA/DH flow avec auth-service)
- [ ] Key version lifecycle documente (rotation triggers, client grace periods)
- [ ] Contrats event versionnes (y.c. key.rotated event Kafka)
- [ ] Schéma DB relu (ciphertext BLOB, key_version INT, channel_key_archive table)
- [ ] Plan de charge et tests KMS throughput defini
- [ ] Feature flags et rollback documentes
- [ ] Ownership equipe par composant defini
- [ ] Recovery procedure (KMS failure, backup keys, disaster recovery)

## 12. Livrables attendus

- docs/CHANNELS_SERVICE_ROADMAP.md (ce document)
- ADR dedie dans docs/architecture decisions
- Spec API OpenAPI channel-service
- Schemas event-contracts channel-events v1
- Dashboard observabilite et alertes
- Plan de migration + runbook incidents
