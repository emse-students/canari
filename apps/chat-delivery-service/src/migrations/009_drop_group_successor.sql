-- Migration 009 : retrait du mecanisme successeur/reboot (Phase 4b).
--
-- L'external join (commit externe self-service, Phase 4) remplace toute la machinerie
-- successeur/CAS/reboot. Les colonnes de succession ne sont plus lues ni ecrites cote serveur ni
-- cote client.
--
-- Aplatissement deja acquis : un groupe portant un successorId a toujours ete un predecesseur
-- soft-deleted (claimSuccessor posait deletedAt EN MEME TEMPS que successorId), et ses membres
-- avaient deja ete propages vers le terminal. getUserGroups filtre desormais les groupes
-- deletedAt, donc les clients convergent naturellement vers le terminal. Les tombstones
-- predecesseurs restants sont purges par le cron existant cleanupSoftDeletedGroups (90 jours) -
-- on ne fait donc que retirer les colonnes ici.
--
-- Idempotent : DROP COLUMN IF EXISTS (synchronize les retire en dev ; ici pour la prod).

ALTER TABLE dm_groups DROP COLUMN IF EXISTS "successorId";
ALTER TABLE dm_groups DROP COLUMN IF EXISTS "successorClaimedByDeviceId";
