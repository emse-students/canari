# Refonte du système de permissions des canaux — Document de conception

> **Statut** : Proposition  
> **Auteur** : Zoo (Architecte)  
> **Date** : 2026-07-25
> **Inspiration** : Modèle de permissions RBAC + overrides par canal

---

## Table des matières

1. [Résumé exécutif](#1-résumé-exécutif)
2. [État des lieux](#2-état-des-lieux)
3. [Modèle de données cible](#3-modèle-de-données-cible)
4. [Logique métier](#4-logique-métier)
5. [API](#5-api)
6. [UI/UX](#6-uiux)
7. [Stratégie de migration](#7-stratégie-de-migration)
8. [Plan de mise en œuvre](#8-plan-de-mise-en-œuvre)

---

## 1. Résumé exécutif

Le système de permissions actuel est binaire (`public`/`private`) et ignore complètement les 6 permissions granulaires définies dans [`permissions.ts`](../../apps/social-service/src/channels/permissions.ts). Cette refonte introduit un modèle RBAC où :

- Chaque rôle de workspace possède des **permissions de base** (niveau workspace)
- Chaque canal peut **surcharger** ces permissions par rôle (ALLOW / DENY / NEUTRAL)
- La hiérarchie Admin > Modérateur > Membre est strictement respectée
- Les permissions sont calculées de manière déterministe : workspace → inheritance → channel overrides

---

## 2. État des lieux

### 2.1 Entités existantes

```
┌──────────────────────────────────────────────────────────────────────┐
│                        MODÈLE ACTUEL                                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  channel_workspaces                    channels                       │
│  ┌──────────────────┐                 ┌──────────────────────────┐   │
│  │ id (UUID)        │ 1────────────* │ id (UUID)                │   │
│  │ slug (unique)    │                 │ workspaceId (FK)         │   │
│  │ name             │                 │ name                     │   │
│  │ createdBy        │                 │ isPrivate (bool)         │   │
│  │ imageMediaId     │                 │ allowedRoles (string[])  │ ◄─ NON utilisé dans l'UI
│  │ createdAt        │                 │ allowedUsers (string[])  │   │
│  └──────────────────┘                 │ keyVersion               │   │
│                                        │ masterSecret             │   │
│  channel_roles                         │ archived                 │   │
│  ┌──────────────────────┐             └──────────────────────────┘   │
│  │ id (UUID)            │                                             │
│  │ workspaceId (FK)     │  channel_members                            │
│  │ name                 │  ┌──────────────────────────┐              │
│  │ priority (int)       │  │ id (UUID)                │              │
│  │ permissions (str[])  │  │ workspaceId (FK)         │              │
│  └──────────────────────┘  │ userId                   │              │
│                             │ roleIds (string[])       │              │
│                             │ keys (JSONB)             │              │
│                             │ notifLevels (JSONB)      │              │
│                             │ sortOrder                │              │
│                             └──────────────────────────┘              │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Deux systèmes de permissions cohabitent sans être reliés

| Fichier | Permissions définies | Utilisées ? |
|---|---|---|
| [`permissions.ts`](../../apps/social-service/src/channels/permissions.ts) | `channel.read`, `channel.write`, `channel.manage`, `member.invite`, `member.kick`, `role.manage` | **NON** — définitions mortes |
| [`channel-role.entity.ts`](../../apps/social-service/src/channels/entities/channel-role.entity.ts) | `MANAGE_WORKSPACE`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, `SEND_MESSAGES`, `MODERATE_MESSAGES`, `INVITE_USERS` | **OUI** — vérifiées dans `channel.service.ts` |

### 2.3 `canAccessChannel` actuel (binaire)

```typescript
// channel.service.ts:94-104
private canAccessChannel(channel: Channel, member: ChannelMember, userId?: string): boolean {
  if (!channel.isPrivate) return true;                    // Public = tout le monde
  const allowedUsers = channel.allowedUsers || [];
  if (allowedUsers.length > 0) {
    return !!userId && allowedUsers.includes(userId);     // Allowlist utilisateur
  }
  const allowed = channel.allowedRoles || [];
  if (allowed.length === 0) return true;                  // Pas de restriction = ouvert
  return allowed.some((roleId) => member.roleIds.includes(roleId)); // Allowlist rôle
}
```

**Problèmes :**
- Aucune distinction entre « voir le canal » et « écrire dans le canal »
- `allowedRoles` n'est jamais alimenté par l'UI
- Les permissions granulaires de `permissions.ts` sont ignorées
- `isPrivate` est un booléen, pas un système de surcharge

### 2.4 UI actuelle (ChannelSettingsModal)

L'UI actuelle a 3 onglets :
1. **Vue d'ensemble** : renommer le canal + niveau de notification personnel
2. **Permissions** : toggle public/privé + allowlist d'utilisateurs (pas de rôles !)
3. **Invitations & Rôles** : liste des membres + invitation + lien d'invitation

**Absent :** Aucun réglage de permissions par rôle au niveau du canal. Aucun écran de paramètres de communauté (workspace).

---

## 3. Modèle de données cible

### 3.1 Principe fondamental

On adopte le modèle RBAC : **permissions de base au niveau du rôle workspace + overrides par canal**.

Chaque permission possède 3 états possibles au niveau du canal :
- **ALLOW** (✅) : la permission est explicitement accordée
- **DENY** (❌) : la permission est explicitement refusée (prime sur ALLOW)
- **NEUTRAL** (⬜) : hérite du rôle workspace (comportement par défaut)

### 3.2 Nouvelle entité : `channel_permission_overrides`

```typescript
// Nouveau fichier: apps/social-service/src/channels/entities/channel-permission-override.entity.ts

@Entity('channel_permission_overrides')
@Index(['channelId', 'roleId', 'permission'], { unique: true })
export class ChannelPermissionOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  channelId: string;          // FK → channels.id

  @Column({ type: 'uuid', nullable: true })
  roleId: string | null;      // FK → channel_roles.id (null = @everyone / wildcard)

  @Column({ type: 'varchar' })
  permission: string;         // ex: 'channel.read', 'channel.write', etc.

  @Column({ type: 'varchar' })
  value: 'allow' | 'deny';   // ALLOW ou DENY (pas de ligne = NEUTRAL)

  @CreateDateColumn()
  createdAt: Date;
}
```

**Pourquoi une table séparée plutôt qu'un JSONB dans `channels` ?**
- Requêtage indexé : `WHERE channelId = X AND roleId = Y` est performant
- Contrainte d'unicité : un seul override par (canal, rôle, permission)
- Évolutivité : on peut ajouter `memberId` plus tard pour des overrides par utilisateur
- Audit et traçabilité : chaque override a son propre `createdAt`

### 3.3 Entité `Channel` modifiée

```typescript
// Modifications de channel.entity.ts

@Entity('channels')
export class Channel {
  // ... colonnes existantes conservées ...

  @Column({ default: false })
  isPrivate: boolean;           // ← CONSERVÉ pour la rétrocompatibilité

  @Column('simple-array', { default: '' })
  allowedRoles: string[];       // ← CONSERVÉ, réinterprété comme « rôles pouvant VOIR le canal »

  @Column('simple-array', { default: '' })
  allowedUsers: string[];       // ← CONSERVÉ, rétrocompatibilité

  // ═══ NOUVEAU ═══
  // Quand `true`, le canal utilise le nouveau système d'overrides.
  // Quand `false`, le comportement legacy (isPrivate + allowedUsers) s'applique.
  @Column({ default: false })
  usePermissionOverrides: boolean;
}
```

### 3.4 Unification des permissions

On fusionne les deux ensembles de permissions en un système unique et cohérent :

```typescript
// permissions.ts — RÉÉCRITURE COMPLÈTE

export const CHANNEL_PERMISSIONS = {
  // ── Accès au canal ──
  VIEW_CHANNEL:    'channel.view',     // Voir le canal dans la liste
  READ_MESSAGES:   'channel.read',     // Lire les messages (implicitement : voir le canal)
  SEND_MESSAGES:   'channel.send',     // Écrire des messages
  UPLOAD_FILES:    'channel.upload',   // Envoyer des pièces jointes

  // ── Gestion du canal ──
  MANAGE_CHANNEL:  'channel.manage',   // Renommer, archiver, modifier les overrides
  MANAGE_MESSAGES: 'channel.moderate', // Épingler, supprimer les messages des autres

  // ── Membres ──
  INVITE_MEMBERS:  'member.invite',    // Inviter des utilisateurs
  KICK_MEMBERS:    'member.kick',      // Expulser des membres du canal

  // ── Rôles (workspace uniquement, pas overridable par canal) ──
  MANAGE_ROLES:    'role.manage',      // Créer/modifier/supprimer des rôles
  MANAGE_WORKSPACE:'workspace.manage', // Admin complet : tous les droits + suppression workspace
} as const;

export type ChannelPermission = (typeof CHANNEL_PERMISSIONS)[keyof typeof CHANNEL_PERMISSIONS];

/** Permissions qui NE PEUVENT PAS être surchargées au niveau du canal (réservées au workspace). */
export const WORKSPACE_ONLY_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.MANAGE_ROLES,
  CHANNEL_PERMISSIONS.MANAGE_WORKSPACE,
];

/** Permissions surchargeables au niveau du canal. */
export const CHANNEL_OVERRIDABLE_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.VIEW_CHANNEL,
  CHANNEL_PERMISSIONS.READ_MESSAGES,
  CHANNEL_PERMISSIONS.SEND_MESSAGES,
  CHANNEL_PERMISSIONS.UPLOAD_FILES,
  CHANNEL_PERMISSIONS.MANAGE_CHANNEL,
  CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  CHANNEL_PERMISSIONS.INVITE_MEMBERS,
  CHANNEL_PERMISSIONS.KICK_MEMBERS,
];
```

### 3.5 Permissions par défaut des rôles

```typescript
/** Permissions du rôle Administrateur (priority 100) — toutes les permissions. */
export const DEFAULT_ADMIN_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.VIEW_CHANNEL,
  CHANNEL_PERMISSIONS.READ_MESSAGES,
  CHANNEL_PERMISSIONS.SEND_MESSAGES,
  CHANNEL_PERMISSIONS.UPLOAD_FILES,
  CHANNEL_PERMISSIONS.MANAGE_CHANNEL,
  CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  CHANNEL_PERMISSIONS.INVITE_MEMBERS,
  CHANNEL_PERMISSIONS.KICK_MEMBERS,
  CHANNEL_PERMISSIONS.MANAGE_ROLES,
  CHANNEL_PERMISSIONS.MANAGE_WORKSPACE,
];

/** Permissions du rôle Modérateur (priority 50). */
export const DEFAULT_MODERATOR_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.VIEW_CHANNEL,
  CHANNEL_PERMISSIONS.READ_MESSAGES,
  CHANNEL_PERMISSIONS.SEND_MESSAGES,
  CHANNEL_PERMISSIONS.UPLOAD_FILES,
  CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  CHANNEL_PERMISSIONS.INVITE_MEMBERS,
  CHANNEL_PERMISSIONS.KICK_MEMBERS,
];

/** Permissions du rôle Membre (priority 10). */
export const DEFAULT_MEMBER_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.VIEW_CHANNEL,
  CHANNEL_PERMISSIONS.READ_MESSAGES,
  CHANNEL_PERMISSIONS.SEND_MESSAGES,
  CHANNEL_PERMISSIONS.UPLOAD_FILES,
];
```

### 3.6 Schéma relationnel complet

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        MODÈLE CIBLE                                       │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  channel_workspaces                      channels                         │
│  ┌──────────────────┐                   ┌────────────────────────────┐   │
│  │ id (UUID)        │ 1──────────────* │ id (UUID)                  │   │
│  │ slug (unique)    │                   │ workspaceId (FK)           │   │
│  │ name             │                   │ name                       │   │
│  │ createdBy        │                   │ isPrivate (LEGACY)         │   │
│  │ imageMediaId     │                   │ allowedRoles (LEGACY)      │   │
│  │ createdAt        │                   │ allowedUsers (LEGACY)      │   │
│  └──────────────────┘                   │ usePermissionOverrides NEW │   │
│                                          │ keyVersion                 │   │
│  channel_roles       1──────────────*    │ masterSecret               │   │
│  ┌──────────────────────┐               │ archived                   │   │
│  │ id (UUID)            │               └────────────────────────────┘   │
│  │ workspaceId (FK)     │                         │                       │
│  │ name                 │                         │ 1                     │
│  │ priority (int)       │                         │                       │
│  │ permissions (str[])  │◄── permissions de base  │                       │
│  │ createdAt            │    au niveau workspace  │                       │
│  └──────────────────────┘                         │                       │
│                                                    *                       │
│  channel_members                    channel_permission_overrides NEW       │
│  ┌──────────────────────┐          ┌──────────────────────────────────┐   │
│  │ id (UUID)            │          │ id (UUID)                        │   │
│  │ workspaceId (FK)     │          │ channelId (FK) ──────────────►   │   │
│  │ userId               │          │ roleId (FK, nullable) ────────►  │   │
│  │ roleIds (str[]) ─────┼──►FK     │ permission (varchar)              │   │
│  │ keys (JSONB)         │          │ value: 'allow' | 'deny'          │   │
│  │ notifLevels (JSONB)  │          │ createdAt                         │   │
│  │ sortOrder            │          └──────────────────────────────────┘   │
│  └──────────────────────┘                                                 │
│                                                                           │
│  Légende:                                                                 │
│  ────► FK                                                                │
│  NEW   Nouvelle entité/colonne                                           │
│  LEGACY Conservé pour la migration                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Logique métier

### 4.1 Algorithme de calcul des permissions effectives

```
effectivePermissions(channelId, memberId) → Set<ChannelPermission>

1. Récupérer les rôles du membre (member.roleIds → ChannelRole[])
2. Pour chaque rôle, collecter ses permissions de base (role.permissions[])
3. Fusionner : l'union des permissions de tous les rôles du membre
   → basePermissions = Union(role.permissions for role in memberRoles)
4. Si le membre possède MANAGE_WORKSPACE → retourner TOUTES les permissions
   (un admin workspace a toujours toutes les permissions, aucun override ne peut le restreindre)
5. Récupérer les overrides du canal (channelId → ChannelPermissionOverride[])
6. Pour chaque permission dans CHANNEL_OVERRIDABLE_PERMISSIONS :
   a. Regrouper les overrides par roleId, triés par priorité de rôle décroissante
   b. Pour chaque override, du rôle le plus prioritaire au moins prioritaire :
      - Si DENY → effectivePermissions.delete(permission)
      - Si ALLOW → effectivePermissions.add(permission)
      - Si absent (NEUTRAL) → ne rien faire (hérite de basePermissions)
7. Retourner effectivePermissions
```

**Règle de hiérarchie stricte :**
- Un rôle de priorité supérieure ne peut **jamais** être restreint par un override ciblant un rôle de priorité inférieure
- `MANAGE_WORKSPACE` est la permission administrateur ultime : elle outrepasse tout
- Un modérateur (priority 50) ne peut pas modifier les overrides qui ciblent le rôle Admin (priority 100)

### 4.2 Signature des fonctions principales

```typescript
/**
 * Calcule l'ensemble des permissions effectives d'un membre pour un canal donné.
 * Combine les permissions de base des rôles + les overrides du canal.
 */
async getEffectivePermissions(
  channelId: string,
  userId: string
): Promise<Set<ChannelPermission>>;

/**
 * Retourne true si le membre a une permission spécifique dans le canal.
 * Version optimisée qui peut s'arrêter tôt.
 */
async hasChannelPermission(
  channelId: string,
  userId: string,
  permission: ChannelPermission
): Promise<boolean>;

/**
 * Nouvelle version de canAccessChannel : vérifie VIEW_CHANNEL + READ_MESSAGES.
 * Remplace l'ancienne méthode binaire.
 */
async canAccessChannel(
  channel: Channel,
  member: ChannelMember,
  userId: string
): Promise<boolean>;

/**
 * Vérifie si un membre peut modifier les overrides d'un canal.
 * Requiert MANAGE_CHANNEL ou MANAGE_WORKSPACE.
 * Empêche de modifier les overrides ciblant un rôle plus prioritaire que le sien.
 */
async canManageChannelOverrides(
  channelId: string,
  actorUserId: string
): Promise<boolean>;
```

### 4.3 `canAccessChannel` — nouvelle implémentation

```typescript
private async canAccessChannel(
  channel: Channel,
  member: ChannelMember,
  userId: string
): Promise<boolean> {
  // Si le canal n'utilise pas le nouveau système, fallback legacy
  if (!channel.usePermissionOverrides) {
    return this.canAccessChannelLegacy(channel, member, userId);
  }

  // Vérifier MANAGE_WORKSPACE → accès garanti
  if (await this.memberHasWorkspacePermission(channel.workspaceId, userId, 'workspace.manage')) {
    return true;
  }

  // Vérifier VIEW_CHANNEL via le nouveau système
  return this.hasChannelPermission(channel.id, userId, CHANNEL_PERMISSIONS.VIEW_CHANNEL);
}

// L'ancienne méthode renommée pour la rétrocompatibilité
private canAccessChannelLegacy(channel: Channel, member: ChannelMember, userId?: string): boolean {
  // ... code actuel (lignes 94-104) ...
}
```

### 4.4 Vérification de permission dans `sendMessage`

```typescript
async sendMessage(channelId: string, input: SendChannelMessageDto) {
  // ... validation du canal et du membre ...

  // AVANT : simple canAccessChannel
  // APRÈS : vérification granulaire
  if (!(await this.hasChannelPermission(channelId, input.senderId, CHANNEL_PERMISSIONS.SEND_MESSAGES))) {
    throw new ForbiddenException('Missing SEND_MESSAGES permission for this channel');
  }
  // ... reste de la méthode inchangé ...
}
```

### 4.5 Points de contrôle modifiés

| Fonction | Permission actuelle | Nouvelle permission |
|---|---|---|
| `listChannelsForUser` | `canAccessChannel` | `VIEW_CHANNEL` |
| `getChannelKeyBootstrapForUser` | `canAccessChannel` | `VIEW_CHANNEL` |
| `getChannelHistoryKeysForUser` | `canAccessChannel` | `VIEW_CHANNEL` |
| `sendMessage` | `canAccessChannel` + `keyVersion` | `SEND_MESSAGES` |
| `createChannel` | `MANAGE_CHANNELS` ou `MANAGE_WORKSPACE` | Inchangé (workspace-level) |
| `renameChannel` | `MANAGE_CHANNELS` ou `MANAGE_WORKSPACE` | `MANAGE_CHANNEL` (override possible) |
| `archiveChannel` | `MANAGE_CHANNELS` ou `MANAGE_WORKSPACE` | `MANAGE_CHANNEL` (override possible) |
| `inviteToChannel` | `INVITE_USERS`, `MANAGE_WORKSPACE` ou `MANAGE_CHANNELS` | `INVITE_MEMBERS` (override possible) |
| `kickMember` | `MANAGE_CHANNELS` ou `MANAGE_WORKSPACE` | `KICK_MEMBERS` (override possible) |
| `setMessagePinned` | `canAccessChannel` | `MANAGE_MESSAGES` |
| `closePoll` (non-auteur) | `MODERATE_MESSAGES`, `MANAGE_CHANNELS` ou `MANAGE_WORKSPACE` | `MANAGE_MESSAGES` |
| `createRole` | `MANAGE_ROLES` ou `MANAGE_WORKSPACE` | `MANAGE_ROLES` (workspace only) |
| `updateMemberRole` | `MANAGE_ROLES` ou `MANAGE_WORKSPACE` | `MANAGE_ROLES` (workspace only) |
| `updateWorkspaceImage` | `MANAGE_WORKSPACE` | `MANAGE_WORKSPACE` (inchangé) |

---

## 5. API

### 5.1 Nouveaux endpoints

```
GET    /api/channels/:channelId/permissions
       → Récupère les overrides de permissions du canal
       ← { channelId, overrides: [{ roleId, roleName, permission, value }], roles: [...] }

PUT    /api/channels/:channelId/permissions
       → Remplace tous les overrides du canal (transaction atomique)
       → Body: { overrides: [{ roleId, permission, value: 'allow'|'deny'|'neutral' }] }
       ← { channelId, overrides: [...] }

GET    /api/channels/:channelId/permissions/me
       → Récupère les permissions effectives du membre appelant pour ce canal
       ← { channelId, permissions: ['channel.view', 'channel.read', 'channel.send', ...] }

GET    /api/channels/:channelId/permissions/:userId
       → Récupère les permissions effectives d'un membre spécifique (admin only)
       ← { channelId, userId, permissions: [...] }

GET    /api/workspaces/:workspaceId/roles/:roleId/permissions
       → Récupère les permissions de base d'un rôle au niveau workspace
       ← { roleId, roleName, permissions: [...] }

PUT    /api/workspaces/:workspaceId/roles/:roleId/permissions
       → Met à jour les permissions de base d'un rôle (MANAGE_ROLES requis)
       → Body: { permissions: ['channel.view', 'channel.send', ...] }
       ← { roleId, permissions: [...] }
```

### 5.2 Endpoints modifiés

```
PATCH  /api/channels/:channelId/access
       → AVANT : { isPrivate, allowedUserIds }
       → APRÈS : { isPrivate, allowedUserIds, usePermissionOverrides? }
       ← Ajout de usePermissionOverrides et allowedRoles dans la réponse

GET    /api/channels/:channelId/access
       → AVANT : { channelId, isPrivate, allowedUsers }
       → APRÈS : { channelId, isPrivate, allowedUsers, allowedRoles, usePermissionOverrides }
```

### 5.3 Formats de réponse

**`GET /api/channels/:channelId/permissions` :**
```json
{
  "channelId": "uuid",
  "usePermissionOverrides": true,
  "roles": [
    { "id": "uuid", "name": "Administrateur", "priority": 100 },
    { "id": "uuid", "name": "Modérateur", "priority": 50 },
    { "id": "uuid", "name": "Membre", "priority": 10 }
  ],
  "overrides": [
    { "roleId": "uuid-modérateur", "roleName": "Modérateur", "permission": "channel.manage", "value": "deny" },
    { "roleId": "uuid-membre", "roleName": "Membre", "permission": "channel.send", "value": "deny" }
  ]
}
```

**`GET /api/channels/:channelId/permissions/me` :**
```json
{
  "channelId": "uuid",
  "permissions": [
    "channel.view",
    "channel.read",
    "channel.send",
    "channel.upload",
    "member.invite"
  ]
}
```

### 5.4 Structure DTO

```typescript
// dto/channel-permission.dto.ts — NOUVEAU FICHIER

export interface ChannelPermissionOverrideDto {
  roleId: string;            // UUID du rôle (ou '__everyone__' si applicable)
  permission: string;        // ex: 'channel.send'
  value: 'allow' | 'deny' | 'neutral';  // 'neutral' = supprimer l'override
}

export interface SetChannelPermissionsDto {
  overrides: ChannelPermissionOverrideDto[];
}

export interface ChannelPermissionsResponseDto {
  channelId: string;
  usePermissionOverrides: boolean;
  roles: Array<{ id: string; name: string; priority: number }>;
  overrides: Array<{
    roleId: string;
    roleName: string;
    permission: string;
    value: 'allow' | 'deny';
  }>;
}

export interface EffectivePermissionsResponseDto {
  channelId: string;
  userId?: string;
  permissions: string[];
}
```

### 5.5 Règles d'autorisation des endpoints

| Endpoint | Permission requise |
|---|---|
| `GET .../permissions` | `VIEW_CHANNEL` (tout membre qui voit le canal) |
| `PUT .../permissions` | `MANAGE_CHANNEL` ou `MANAGE_WORKSPACE` |
| `GET .../permissions/me` | `VIEW_CHANNEL` |
| `GET .../permissions/:userId` | `MANAGE_CHANNEL` ou `MANAGE_WORKSPACE` |
| `GET .../roles/:roleId/permissions` | `MANAGE_ROLES` ou `MANAGE_WORKSPACE` |
| `PUT .../roles/:roleId/permissions` | `MANAGE_ROLES` ou `MANAGE_WORKSPACE` |

---

## 6. UI/UX

### 6.1 Principe d'uniformisation

Actuellement, il n'existe **aucun écran de paramètres de communauté**. La refonte introduit deux écrans cohérents visuellement :

```
┌──────────────────────────────────────────────────────────────────┐
│               NAVIGATION DES PARAMÈTRES                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Sidebar gauche (communautés)                                     │
│  ┌─────────────────────────┐                                      │
│  │ ▼ Ma Communauté          │  → clic droit ou icône engrenage   │
│  │   # général              │     ouvre les paramètres            │
│  │   # random               │                                      │
│  │   # privé (icône cadenas)│                                      │
│  └─────────────────────────┘                                      │
│                                                                   │
│  Deux écrans de paramètres cohérents :                            │
│                                                                   │
│  ┌──────────────────────────────┐  ┌────────────────────────────┐ │
│  │ Paramètres de la communauté  │  │ Paramètres du canal        │ │
│  │ (NOUVEAU)                    │  │ (amélioré)                 │ │
│  ├──────────────────────────────┤  ├────────────────────────────┤ │
│  │ ☰ Vue d'ensemble            │  │ ☰ Vue d'ensemble           │ │
│  │   - Nom, image              │  │   - Nom du canal           │ │
│  │   - Slug                    │  │   - Notifications perso    │ │
│  │                              │  │                            │ │
│  │ ⚡ Rôles & Permissions       │  │ ⚡ Permissions             │ │
│  │   - Liste des rôles         │  │   - Overrides par rôle     │ │
│  │   - Créer/éditer un rôle    │  │   - Matrice permissions    │ │
│  │   - Permissions de base     │  │                            │ │
│  │                              │  │ 👥 Membres                │ │
│  │ 🔗 Invitations               │  │   - Liste des membres     │ │
│  │   - Lien d'invitation        │  │   - Inviter / Modifier    │ │
│  │                              │  │     rôle / Expulser       │ │
│  │ ⚠️ Zone de danger            │  │                            │ │
│  │   - Quitter/Supprimer        │  │ ⚠️ Zone de danger         │ │
│  └──────────────────────────────┘  │   - Quitter/Supprimer     │ │
│                                     └────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 Composants à créer

| Composant | Rôle |
|---|---|
| `WorkspaceSettingsModal.svelte` | Nouveau : modal de paramètres de la communauté (structure identique à `ChannelSettingsModal`) |
| `RoleSettingsPanel.svelte` | Sous-composant : édition des permissions d'un rôle (utilisé dans les deux modals) |
| `PermissionGrid.svelte` | Sous-composant réutilisable : matrice rôle × permissions avec toggle ALLOW/DENY/NEUTRAL |
| `ChannelPermissionOverrides.svelte` | Sous-composant : liste des overrides du canal avec sélecteurs allow/deny/neutral |

### 6.3 Composants à modifier

| Composant | Modifications |
|---|---|
| `ChannelSettingsModal.svelte` | Onglet « Permissions » refondu : remplacer le toggle public/privé + allowlist par la matrice d'overrides |
| `ChannelService.ts` | Ajouter les méthodes `getChannelPermissions`, `setChannelPermissions`, `getMyChannelPermissions`, `getRolePermissions`, `setRolePermissions` |
| `ChatArea.svelte` | Ajouter un bouton d'accès aux paramètres de la communauté |

### 6.4 Design de la matrice de permissions (PermissionGrid)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Permissions du canal #général                                       │
│                                                                       │
│  ┌─────────────────┬──────────┬──────────┬──────────┐               │
│  │ Permission       │ @Admin   │ @Modéro  │ @Membre  │               │
│  ├─────────────────┼──────────┼──────────┼──────────┤               │
│  │ Voir le canal   │ ✅ (base)│ ✅ (base)│ ✅ (base)│               │
│  │ Lire les msg    │ ✅ (base)│ ✅ (base)│ ✅ (base)│               │
│  │ Envoyer des msg │ ✅ (base)│ ✅ (base)│ ✅ (base)│               │
│  │ Fichiers joints │ ✅ (base)│ ✅ (base)│ ✅ (base)│               │
│  │ Gérer le canal  │ ✅ (base)│ ⬜ neutre│ ⬜ neutre│               │
│  │ Modérer les msg │ ✅ (base)│ ✅ (base)│ ⬜ neutre│               │
│  │ Inviter membres │ ✅ (base)│ ✅ (base)│ ⬜ neutre│               │
│  │ Expulser membres│ ✅ (base)│ ⬜ neutre│ ⬜ neutre│               │
│  └─────────────────┴──────────┴──────────┴──────────┘               │
│                                                                       │
│  Légende :                                                            │
│  ✅ (base) = Hérité du rôle workspace (non overridable pour Admin)   │
│  ✅ allow  = Explicitement autorisé par un override                  │
│  ❌ deny   = Explicitement refusé par un override                    │
│  ⬜ neutre = Ni allow ni deny → l'héritage s'applique                │
│                                                                       │
│  [Réinitialiser les overrides]  [Appliquer]                          │
└──────────────────────────────────────────────────────────────────────┘
```

**Comportement des cellules :**
- Cliquer sur une cellule non-Admin cycle entre : `neutral` → `allow` → `deny` → `neutral`
- Les cellules Admin sont grisées et non cliquables (MANAGE_WORKSPACE outrepasse tout)
- Un indicateur visuel montre si la valeur vient de l'héritage ou d'un override

### 6.5 Cohérence entre les deux écrans

| Aspect | Paramètres Communauté | Paramètres Canal |
|---|---|---|
| **Layout** | Modal pleine largeur, sidebar à gauche | Modal pleine largeur, sidebar à gauche |
| **Onglets** | Vue d'ensemble, Rôles & Permissions, Invitations | Vue d'ensemble, Permissions, Membres |
| **Permissions** | Permissions de base des rôles (grille éditable) | Overrides par rôle (grille avec héritage visible) |
| **Danger zone** | Quitter/Supprimer la communauté | Quitter/Supprimer le canal |

### 6.6 Navigation utilisateur

Le flux typique pour configurer les permissions :

1. L'admin ouvre les **Paramètres de la communauté** → onglet « Rôles & Permissions »
2. Il définit les permissions de base pour chaque rôle (ex : « Modérateur peut gérer les messages et inviter »)
3. Il ouvre les **Paramètres d'un canal spécifique** → onglet « Permissions »
4. Il surcharge certaines permissions (ex : « Dans #annonces, Membre ne peut pas envoyer de messages »)
5. La matrice affiche clairement ce qui est hérité vs surchargé

---

## 7. Stratégie de migration

### 7.1 Principe de non-régression

**Aucun comportement existant ne doit être cassé.** La migration est progressive :

1. Tous les canaux gardent `usePermissionOverrides = false` par défaut
2. Le legacy code path (`canAccessChannelLegacy`) reste intact
3. Le nouveau système est opt-in par canal
4. Une migration de données convertit les permissions de rôles workspace existantes

### 7.2 Étapes de migration

#### Étape 1 : Migration du schéma DB

```sql
-- Migration 0XX: Add channel_permission_overrides table + usePermissionOverrides column

CREATE TABLE IF NOT EXISTS channel_permission_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id UUID REFERENCES channel_roles(id) ON DELETE CASCADE,
  permission VARCHAR(128) NOT NULL,
  value VARCHAR(16) NOT NULL CHECK (value IN ('allow', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, role_id, permission)
);

CREATE INDEX idx_cpo_channel ON channel_permission_overrides(channel_id);
CREATE INDEX idx_cpo_role ON channel_permission_overrides(role_id);

ALTER TABLE channels ADD COLUMN use_permission_overrides BOOLEAN NOT NULL DEFAULT FALSE;
```

#### Étape 2 : Migration des permissions de rôles existantes

Convertir les anciennes permissions `string[]` du rôle vers le nouveau format :

```typescript
// Script de migration exécuté au déploiement

const PERMISSION_MAPPING: Record<string, ChannelPermission> = {
  'MANAGE_WORKSPACE':   CHANNEL_PERMISSIONS.MANAGE_WORKSPACE,
  'MANAGE_CHANNELS':    CHANNEL_PERMISSIONS.MANAGE_CHANNEL,
  'MANAGE_ROLES':       CHANNEL_PERMISSIONS.MANAGE_ROLES,
  'SEND_MESSAGES':      CHANNEL_PERMISSIONS.SEND_MESSAGES,
  'MODERATE_MESSAGES':  CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  'INVITE_USERS':       CHANNEL_PERMISSIONS.INVITE_MEMBERS,
};

// Pour chaque rôle existant, mapper les anciennes permissions vers les nouvelles
// et ajouter VIEW_CHANNEL + READ_MESSAGES implicitement (tout le monde les avait)
for (const role of existingRoles) {
  const newPermissions = role.permissions
    .map(p => PERMISSION_MAPPING[p])
    .filter(Boolean);

  // Ajouter les permissions implicites que tout le monde avait
  newPermissions.push(CHANNEL_PERMISSIONS.VIEW_CHANNEL);
  newPermissions.push(CHANNEL_PERMISSIONS.READ_MESSAGES);

  // Dédupliquer
  role.permissions = [...new Set(newPermissions)];
  await roleRepo.save(role);
}
```

#### Étape 3 : Migration d'un canal existant vers le nouveau système

Quand un admin active `usePermissionOverrides` sur un canal :

1. Créer des overrides par défaut pour chaque rôle :
   - Admin : tous `allow` (mais en pratique tout hérité, donc `neutral`)
   - Modérateur : `neutral` partout (héritage)
   - Membre : `neutral` partout (héritage)
2. Si le canal était `isPrivate = true` avec `allowedUsers` :
   - Créer un override `VIEW_CHANNEL = deny` pour le rôle `@everyone` (ou le rôle Membre)
   - Créer des overrides `VIEW_CHANNEL = allow` pour chaque utilisateur dans `allowedUsers`
3. Si le canal était `isPrivate = false` : tous `neutral` (héritage)

#### Étape 4 : Coexistence et bascule

```typescript
// Dans canAccessChannel — point central de décision
private async canAccessChannel(channel: Channel, member: ChannelMember, userId: string): Promise<boolean> {
  if (!channel.usePermissionOverrides) {
    // LEGACY PATH — comportement inchangé
    return this.canAccessChannelLegacy(channel, member, userId);
  }
  // NEW PATH — système d'overrides
  if (await this.memberHasWorkspacePermission(channel.workspaceId, userId, 'workspace.manage')) {
    return true;
  }
  return this.hasChannelPermission(channel.id, userId, CHANNEL_PERMISSIONS.VIEW_CHANNEL);
}
```

### 7.4 Points d'attention

- **Rotation de clés** : changer `usePermissionOverrides` ne doit PAS déclencher de rotation de clé (contrairement à un changement de `allowedUsers`)
- **Cache Redis** : les permissions effectives d'un utilisateur pour un canal devraient être mises en cache dans Redis avec une TTL courte (30s) et invalidées lors de tout changement d'override ou de rôle
- **Événements** : un changement d'override doit publier un event `channel.permissions.updated` pour informer les clients connectés

---

## 8. Plan de mise en œuvre

### 8.1 Phases

| Phase | Contenu | Dépendances |
|---|---|---|
| **Phase 1** — Fondations | Nouvelle entité `ChannelPermissionOverride`, migration DB, unification de `permissions.ts`, nouveau `createWorkspace` avec permissions unifiées | Aucune |
| **Phase 2** — Logique métier | `getEffectivePermissions`, `hasChannelPermission`, refactoring de `canAccessChannel`, adaptation de tous les points de contrôle | Phase 1 |
| **Phase 3** — API | Nouveaux endpoints CRUD pour les overrides, endpoints de permissions effectives, validation | Phase 2 |
| **Phase 4** — UI Communauté | `WorkspaceSettingsModal`, `RoleSettingsPanel`, `PermissionGrid`, édition des permissions de base des rôles | Phase 3 |
| **Phase 5** — UI Canal | Refonte de l'onglet Permissions de `ChannelSettingsModal`, intégration de `PermissionGrid` avec overrides | Phase 4 |
| **Phase 6** — Migration & Tests | Script de migration des données, tests end-to-end, bascule progressive | Phase 5 |

### 8.2 Fichiers à créer

```
apps/social-service/src/channels/
  entities/channel-permission-override.entity.ts   (NOUVEAU)
  dto/channel-permission.dto.ts                     (NOUVEAU)
  permissions.ts                                    (RÉÉCRITURE)

frontend/src/lib/
  components/chat/WorkspaceSettingsModal.svelte     (NOUVEAU)
  components/chat/RoleSettingsPanel.svelte          (NOUVEAU)
  components/shared/PermissionGrid.svelte           (NOUVEAU)
  services/ChannelPermissionService.ts              (NOUVEAU)
```

### 8.3 Fichiers à modifier

```
apps/social-service/src/channels/
  entities/channel.entity.ts           (+ usePermissionOverrides)
  channel.service.ts                   (refactoring des vérifications + nouvelles méthodes)
  channels.controller.ts               (nouveaux endpoints)
  channels.module.ts                   (enregistrer la nouvelle entité)

frontend/src/lib/
  components/chat/ChannelSettingsModal.svelte  (onglet Permissions refondu)
  components/chat/ChatArea.svelte              (bouton paramètres communauté)
  services/ChannelService.ts                   (nouvelles méthodes API)
```

### 8.4 Points de test critiques

1. **Régression** : un canal legacy (`usePermissionOverrides = false`) se comporte exactement comme avant
2. **Hiérarchie** : un modérateur ne peut pas modifier les overrides du rôle Admin
3. **MANAGE_WORKSPACE** : un admin a toujours toutes les permissions, quels que soient les overrides
4. **DENY prioritaire** : un override DENY sur un rôle de priorité supérieure bloque bien la permission
5. **Héritage correct** : en l'absence d'override, les permissions du rôle workspace s'appliquent
6. **Cache** : les changements d'override invalident le cache Redis
7. **Migration** : les permissions legacy sont correctement mappées vers le nouveau format

---

## Annexe A : Table de correspondance des permissions

| Ancienne permission (`channel-role.entity`) | Nouvelle permission (`permissions.ts`) | Surchargeable par canal ? |
|---|---|---|
| `MANAGE_WORKSPACE` | `workspace.manage` | ❌ Non (réservé workspace) |
| `MANAGE_CHANNELS` | `channel.manage` | ✅ Oui |
| `MANAGE_ROLES` | `role.manage` | ❌ Non (réservé workspace) |
| `SEND_MESSAGES` | `channel.send` | ✅ Oui |
| `MODERATE_MESSAGES` | `channel.moderate` | ✅ Oui |
| `INVITE_USERS` | `member.invite` | ✅ Oui |
| _(implicite)_ | `channel.view` | ✅ Oui |
| _(implicite)_ | `channel.read` | ✅ Oui |
| _(implicite)_ | `channel.upload` | ✅ Oui |
| _(implicite)_ | `member.kick` | ✅ Oui |

## Annexe B : Comparaison avec d'autres plateformes

| Concept | Autres plateformes | Canari (après refonte) |
|---|---|---|
| Rôles serveur | Server Roles | `channel_roles` (workspace) |
| Permissions de base | Role permissions | `ChannelRole.permissions[]` |
| Overrides canal | Channel permissions (role/member) | `channel_permission_overrides` (rôle) |
| @everyone | Rôle @everyone (toujours présent) | Rôle « Membre » (priority 10) |
| Administrator | Permission « Administrator » | `workspace.manage` (MANAGE_WORKSPACE) |
| Catégories | Category permissions | Non implémenté (phase future) |
| Overrides membre | Member-specific overrides | Non implémenté (phase future, ajouter `memberId` nullable) |
