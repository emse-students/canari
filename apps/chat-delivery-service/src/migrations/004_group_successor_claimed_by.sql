-- Migration 004: Ajouter la colonne successorClaimedByDeviceId a dm_groups
--
-- Contexte : pour diagnostiquer les reboots MLS, on enregistre le device qui a
-- gagne le CAS du successeur (claimSuccessor) en meme temps que successorId.
-- Sans cette colonne, impossible d'attribuer un reboot au device qui l'a declenche.
--
-- Idempotent : skip si la table n'existe pas ou si la colonne est deja presente.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'dm_groups'
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dm_groups'
      AND column_name = 'successorClaimedByDeviceId'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE dm_groups ADD COLUMN "successorClaimedByDeviceId" text;

  RAISE NOTICE 'Migration 004 appliquee : dm_groups.successorClaimedByDeviceId ajoutee';
END $$;
