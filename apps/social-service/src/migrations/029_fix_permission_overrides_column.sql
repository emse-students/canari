-- Migration 029 : renomme la colonne use_permission_overrides (snake_case, créée par erreur
-- dans la migration 028) en "usePermissionOverrides" (camelCase double-quoté, convention du projet).
-- La colonne a été créée sans guillemets → PostgreSQL l'a repliée en minuscules (use_permission_overrides),
-- mais TypeORM attend le nom camelCase "usePermissionOverrides" → erreur 42703 (colonne introuvable)
-- sur toute requête SELECT de la table channels.
-- Idempotent : ne fait rien si la colonne source n'existe pas.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'channels' AND column_name = 'use_permission_overrides'
  ) THEN
    ALTER TABLE channels RENAME COLUMN use_permission_overrides TO "usePermissionOverrides";
  END IF;
END $$;

COMMIT;
