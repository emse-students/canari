-- Migration 030: remplace les anciennes clés de permissions dans channel_roles
-- par les nouvelles clés unifiées (migration du format legacy MANAGE_WORKSPACE → workspace.manage, etc.).
-- La colonne `permissions` est un simple-array TypeORM stocké en texte séparé par des virgules.
-- Chaque REPLACE ne touche que la sous-chaîne exacte de la clé legacy ; les clés déjà migrées
-- (ex: workspace.manage) ne contiennent pas ces motifs et restent inchangées.
-- Idempotent : si la clé n'existe pas, REPLACE est un no-op.

BEGIN;

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'MANAGE_WORKSPACE', 'workspace.manage');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'MANAGE_CHANNELS', 'channel.manage');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'MANAGE_ROLES', 'role.manage');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'SEND_MESSAGES', 'channel.send');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'MODERATE_MESSAGES', 'channel.moderate');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'INVITE_USERS', 'member.invite');

COMMIT;
