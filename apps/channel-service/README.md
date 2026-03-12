# channel-service

Service NestJS pour canaux communautaires avec priorite aux permissions.

## Objectif MVP

- ACL claire (roles + permissions) avant toute logique avancee
- Chiffrement applicatif soft (AES-256-GCM, cle derivee)
- Join/leave/kick avec acces UI immediatement coupe pour les exclus
- Nouveaux membres: historique visible

## Permissions prises en charge

- `channel.read`
- `channel.write`
- `channel.manage`
- `member.invite`
- `member.kick`
- `role.manage`

## Endpoints MVP

- `POST /channels/workspaces`
- `POST /channels/roles`
- `POST /channels`
- `GET /channels/workspace/:workspaceId/user/:userId`
- `POST /channels/:channelId/members/join`
- `POST /channels/:channelId/members/leave`
- `POST /channels/:channelId/members/kick`
- `POST /channels/:channelId/messages`
- `GET /channels/:channelId/messages?userId=...&limit=...`

## Variables d'environnement

- `PORT` (defaut `3004`)
- `CHANNELS_MONGO_URI` (defaut `mongodb://localhost:27017/channel_db`)
- `CHANNELS_ENCRYPTION_SECRET` (obligatoire en prod)

## Notes securite

- Ce service n'utilise pas MLS.
- Le contenu message est chiffre/dechiffre cote service (soft E2EE pragmatique).
- Le serveur ne stocke que `ciphertext`, `nonce`, `keyVersion`.
- Policy demandee: pas de rotation obligatoire de cle a chaque kick.
