-- Migration 022 : saved "Carte de la Vie Asso" poster layouts.
-- Stores layout only (bubbles / doodles / free texts / theme / background) as JSONB; the live
-- content (colors, logos, members, avatars) is re-resolved at render time. Managed by global
-- admins and BDE super-admins (enforced in the controller). Idempotent for CD.

CREATE TABLE IF NOT EXISTS poster_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdBy" varchar(255) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poster_projects_creator ON poster_projects ("createdBy");
