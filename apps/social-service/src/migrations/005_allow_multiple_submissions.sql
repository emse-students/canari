-- Migration 005 : allowMultipleSubmissions sur la table forms
-- Permet aux formulaires de commande d'accepter plusieurs soumissions par utilisateur.

ALTER TABLE forms
  ADD COLUMN IF NOT EXISTS "allowMultipleSubmissions" boolean NOT NULL DEFAULT false;
