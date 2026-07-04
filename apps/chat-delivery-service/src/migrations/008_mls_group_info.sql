-- Migration 008 : dernier GroupInfo MLS par groupe (base du join par commit externe - Phase 4)
--
-- Contexte : un membre autorise sans etat MLS local (jamais Welcome, etat oublie, sous le floor du
-- commit-log) se re-joint en construisant un commit externe contre le GroupInfo COURANT, sans
-- attendre le Welcome d'un pair. Le serveur stocke le GroupInfo le plus recent (rafraichi par le
-- committer apres chaque commit accepte - le premier ajout de membre d'un nouveau groupe est
-- lui-meme un commit) et le sert UNIQUEMENT aux membres du roster.
--
-- baseEpoch = l'epoch decrit par le GroupInfo (== activeEpoch du groupe a sa production). Le joiner
-- soumet son commit externe avec ce baseEpoch ; le gate d'epoch standard (baseEpoch == activeEpoch)
-- le rejette si un commit plus recent est passe, et le joiner retry avec un GroupInfo plus frais.
-- Ecritures monotones (jamais ecraser un epoch plus recent), applique cote service.
--
-- Ne stocke que le GroupInfo serialise (base64) : aucune cle, aucun plaintext (arbre + cle publique
-- externe = etat public du groupe).
--
-- Idempotent : CREATE TABLE IF NOT EXISTS (synchronize le cree en dev ; ici pour la prod).

CREATE TABLE IF NOT EXISTS mls_group_info (
    "groupId"    UUID PRIMARY KEY,
    "groupInfo"  TEXT NOT NULL,
    "baseEpoch"  INTEGER NOT NULL,
    "updatedAt"  TIMESTAMP NOT NULL DEFAULT now()
);
