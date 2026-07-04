-- Migration 007 : commit-log MLS ordonne et rejouable (backbone rung-1)
--
-- Contexte : le serveur linearise les commits (validateCommit : lock Redis + gate strict
-- baseEpoch == activeEpoch). Jusqu'ici les bytes du commit n'etaient stockes nulle part de
-- maniere indexee par epoch : un device en retard ne pouvait pas rejouer les commits manques et
-- tombait en recuperation destructive (forget_group + re-Welcome). Cette table enregistre chaque
-- commit accepte, cle par l'epoch qu'il fait avancer (baseEpoch), pour que le client comble un gap
-- en rejouant exactement les commits manquants (baseEpoch >= son epoch local).
--
-- Un seul commit peut faire avancer un epoch donne (linearisation) -> index unique (groupId, baseEpoch).
-- Ne stocke que du chiffre (Commit MLS serialise, base64) : aucune cle, aucun plaintext.
--
-- Idempotent : CREATE TABLE / INDEX IF NOT EXISTS (synchronize les cree en dev ; ici pour la prod).

CREATE TABLE IF NOT EXISTS mls_commit_log (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "groupId"      UUID NOT NULL,
    "baseEpoch"    INTEGER NOT NULL,
    commit         TEXT NOT NULL,
    "senderDeviceId" VARCHAR(255),
    "createdAt"    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mls_commit_log_group_epoch"
    ON mls_commit_log ("groupId", "baseEpoch");

-- Index de purge par age (retention longue ~1 an, voir pruneCommitLog dans messaging.service).
CREATE INDEX IF NOT EXISTS "IDX_mls_commit_log_created_at"
    ON mls_commit_log ("createdAt");
