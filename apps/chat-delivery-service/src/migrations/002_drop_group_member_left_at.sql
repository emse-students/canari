-- Migration 002: Supprimer la colonne leftAt de dm_group_members
--
-- Contexte : la réécriture MLS (Phase 7) a remplacé le soft-delete (leftAt)
-- par un hard-delete dans GroupMember. L'entité ne porte plus la colonne ;
-- cette migration nettoie le schéma PostgreSQL.
-- Sans cette migration la colonne reste en base sans jamais être lue.
--
-- Idempotent : skip si la table ou la colonne n'existe pas.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dm_group_members'
      AND column_name = 'left_at'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE dm_group_members DROP COLUMN left_at;

  RAISE NOTICE 'Migration 002 appliquée : dm_group_members.left_at supprimée';
END $$;
