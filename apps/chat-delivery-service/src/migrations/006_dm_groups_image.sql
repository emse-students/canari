-- Migration 006 : colonne imageMediaId sur dm_groups
--
-- Contexte : les groupes de messagerie peuvent desormais porter une photo (avatar), stockee
-- comme un blob media-service raw/public (meme principe que les images de channels). Le serveur
-- ne fait que conserver l'identifiant du media ; getUserGroups le propage aux membres.
--
-- Idempotent : ADD COLUMN IF NOT EXISTS (synchronize la cree en dev ; ici pour la prod).

ALTER TABLE dm_groups ADD COLUMN IF NOT EXISTS "imageMediaId" VARCHAR(255);
