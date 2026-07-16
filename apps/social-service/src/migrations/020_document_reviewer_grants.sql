-- Migration 020 : global document-reviewer grants.
-- Lets a specific user review every association's *public* documents on the
-- cross-association reviewer page. Granting is restricted to global admins and
-- BDE super-admins (enforced in the service layer). Idempotent for CD.

CREATE TABLE IF NOT EXISTS document_reviewer_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" varchar(255) NOT NULL UNIQUE,
  "grantedBy" varchar(255) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_reviewer_grants_user
  ON document_reviewer_grants ("userId");
