-- Migration 005 : table dm_user_dismissed_groups
--
-- Contexte : quand un utilisateur supprime ou quitte une conversation manuellement, elle doit
-- disparaitre de TOUS ses appareils. Depuis l'etat de membership seul, "je l'ai supprimee/quittee"
-- est indistinguable de "un pair l'a supprimee" ou "j'ai ete exclu" (qui doivent rester visibles
-- avec banniere + suppression manuelle). Cette table per-user/per-group est le signal qui permet
-- a la discovery de PURGER au lieu d'afficher la banniere.
--
-- Idempotent : skip si la table existe deja (synchronize la cree en dev ; ici pour la prod).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'dm_user_dismissed_groups'
  ) THEN
    RETURN;
  END IF;

  CREATE TABLE dm_user_dismissed_groups (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "userId" varchar(255) NOT NULL,
    "groupId" varchar(255) NOT NULL,
    "dismissedAt" TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT "PK_dm_user_dismissed_groups" PRIMARY KEY ("id"),
    CONSTRAINT "UQ_dm_user_dismissed_groups_user_group" UNIQUE ("userId", "groupId")
  );

  CREATE INDEX "IDX_dm_user_dismissed_groups_user" ON dm_user_dismissed_groups ("userId");

  RAISE NOTICE 'Migration 005 appliquee : table dm_user_dismissed_groups creee';
END $$;
