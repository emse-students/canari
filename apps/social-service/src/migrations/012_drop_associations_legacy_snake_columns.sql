-- Migration 012 : supprimer les colonnes snake_case mortes de la table associations
--
-- Contexte : la migration 001 (permissions bitmask) a cree is_bde, document_vault_key et
-- document_quota_bytes en snake_case. Mais l'entite Association (comme tout social-service)
-- n'utilise pas de naming strategy snake_case : TypeORM a cree EN PLUS les colonnes camelCase
-- isBDE, documentVaultKey et documentQuotaBytes, qui sont les seules lues/ecrites par le code.
-- Les versions snake_case sont donc des doublons morts qui n'ont jamais ete utilises.
--
-- Idempotent : DROP COLUMN IF EXISTS. Ne touche pas aux colonnes camelCase actives.

BEGIN;

ALTER TABLE associations DROP COLUMN IF EXISTS "is_bde";
ALTER TABLE associations DROP COLUMN IF EXISTS "document_vault_key";
ALTER TABLE associations DROP COLUMN IF EXISTS "document_quota_bytes";

COMMIT;
