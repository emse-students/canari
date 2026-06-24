-- Migration 002: Supprimer la colonne leftAt de dm_group_members
--
-- Contexte : la reecriture MLS (Phase 7) a remplace le soft-delete (leftAt)
-- par un hard-delete dans GroupMember. L'entite ne porte plus la colonne ;
-- cette migration nettoie le schema PostgreSQL.
--
-- Note : la colonne reelle est "leftAt" (camelCase). social-service/chat-delivery
-- n'utilisent pas de naming strategy snake_case, donc TypeORM conserve le nom de
-- propriete tel quel. La version initiale de cette migration ciblait "left_at" et
-- etait donc un no-op : la colonne morte n'a jamais ete supprimee.
--
-- Idempotent : DROP COLUMN IF EXISTS.

ALTER TABLE dm_group_members DROP COLUMN IF EXISTS "leftAt";
