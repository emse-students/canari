-- Migration 007 : supprimer la colonne orpheline lastEpochSeen de dm_device_group_memberships
--
-- Contexte : "lastEpochSeen" a ete retiree de l'entite DeviceGroupMembership mais jamais
-- droppee en base. Elle n'est plus lue ni ecrite ; cette migration nettoie le schema.
--
-- Idempotent : DROP COLUMN IF EXISTS.

ALTER TABLE dm_device_group_memberships DROP COLUMN IF EXISTS "lastEpochSeen";
