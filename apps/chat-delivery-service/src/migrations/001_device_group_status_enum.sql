-- Migration 001: Simplifier DeviceGroupMembership.status → pending | active
--
-- Contexte : la réécriture MLS (Phase 7) a supprimé les états welcome_sent,
-- welcome_received et stale en faveur de active/pending uniquement.
-- Le type enum PostgreSQL doit être mis à jour pour refléter ce changement.
-- Sans cette migration, toutes les queries avec status = 'active' retournent 500.
--
-- Idempotent : skip si la table n'existe pas ou si déjà migrée.

DO $$
BEGIN
  -- Vérifier que la table existe (skip si pas encore créée)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'dm_device_group_memberships'
  ) THEN
    RETURN;
  END IF;

  -- Skip si la migration est déjà appliquée (enum n'a plus les vieilles valeurs)
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname LIKE '%device_group_memberships%status%'
      AND e.enumlabel IN ('welcome_sent', 'welcome_received', 'stale')
  ) THEN
    RETURN;
  END IF;

  -- Étape 1 : convertir en TEXT pour libérer le type enum
  ALTER TABLE dm_device_group_memberships
    ALTER COLUMN status TYPE TEXT;

  -- Étape 2 : migrer les données
  UPDATE dm_device_group_memberships
    SET status = 'active'
    WHERE status IN ('welcome_received', 'welcome_sent');

  UPDATE dm_device_group_memberships
    SET status = 'pending'
    WHERE status NOT IN ('active', 'pending');

  -- Étape 3 : supprimer l'ancien type enum (nom généré par TypeORM)
  DROP TYPE IF EXISTS dm_device_group_memberships_status_enum;

  -- Étape 4 : recréer le type avec les valeurs correctes
  CREATE TYPE dm_device_group_memberships_status_enum AS ENUM ('pending', 'active');

  -- Étape 5 : restaurer la colonne avec le nouveau type
  ALTER TABLE dm_device_group_memberships
    ALTER COLUMN status TYPE dm_device_group_memberships_status_enum
    USING status::dm_device_group_memberships_status_enum;

  RAISE NOTICE 'Migration 001 appliquée : dm_device_group_memberships.status → pending | active';
END $$;
