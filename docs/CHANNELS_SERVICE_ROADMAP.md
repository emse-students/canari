# CHANNELS_SERVICE_ROADMAP.md

## 1. But et contexte

Objectif: ajouter un systeme de canaux type Discord/Slack pour les promotions, assos et communautes, sans casser les flux DM/groupes MLS existants.

Contrainte cle: les canaux communautaires doivent pouvoir etre rejoints/quittes a tout moment, avec historique persistant, moderation et recherche. Cela est difficile a tenir avec MLS pur pour des groupes tres dynamiques.

Decision de reference:
- DM + groupes prives sensibles: MLS E2E (existant)
- Canaux communautaires: service centralise (TLS en transit + chiffrement au repos), ACL fines, historique serveur

## 2. Perimetre fonctionnel (Discord-like)

MVP (phase 1):
- Espaces (workspaces) pour promo/asso
- Categories de canaux
- Canaux texte publics/prives
- Rejoindre/quitter canal
- Historique persistant pagine
- Mentions @user / @role (base)
- Roles et permissions (admin/modo/membre)
- Badges non-lus par canal

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
- channels(id, workspace_id, category_id, type, name, visibility, topic, position, archived)
- channel_members(channel_id, user_id, role_override, joined_at, left_at, last_read_message_id)
- channel_messages(id, channel_id, sender_id, content, metadata_json, created_at, edited_at, deleted_at)
- channel_reactions(message_id, emoji, user_id, created_at)
- audit_logs(id, workspace_id, actor_id, action, target_type, target_id, payload_json, created_at)

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

## 6. Securite

Transport et auth:
- JWT obligatoire (auth-service)
- Verification scopes/claims au gateway
- TLS obligatoire inter-services en prod

Authorization:
- ACL base role + overrides canal
- Decision engine centralise dans channel-service
- Cache ACL court TTL dans Redis

Protection donnees:
- Chiffrement au repos DB (disk + secret management)
- Journal d'audit immuable pour actions sensibles
- Rate-limit par user et par canal

Remarque E2EE:
- MLS reste sur DM/groupes fermes
- Canaux communautaires: securite type Discord (pas E2EE generique), mais defense-in-depth serveur + gouvernance clefs secrets

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

Phase 1 - Foundations backend (2 semaines)
- Scaffold channel-service
- DB schema v1 + migrations
- ACL engine v1
- Endpoints workspace/channel/membership

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

Risque: sentiment de securite degradee sur canaux
- Mitigation: communication transparente: "E2EE pour DM/groupes prives, securite serveur renforcee pour canaux communautaires"

## 11. Checklist pre-kickoff

- [ ] ADR validee (modele hybride MLS + channels)
- [ ] Contrats event versionnes
- [ ] Schéma DB relu
- [ ] Threat model documente
- [ ] Plan de charge et tests defini
- [ ] Feature flags et rollback documentes
- [ ] Ownership equipe par composant defini

## 12. Livrables attendus

- docs/CHANNELS_SERVICE_ROADMAP.md (ce document)
- ADR dedie dans docs/architecture decisions
- Spec API OpenAPI channel-service
- Schemas event-contracts channel-events v1
- Dashboard observabilite et alertes
- Plan de migration + runbook incidents
