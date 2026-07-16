-- Migration 019 : association document sharing (private/public) + original filename
-- `visibility` gates whether a vault document is exposed to authorized document
-- reviewers on the cross-association page. `originalFilename` preserves the file
-- extension when the display name is renamed. Idempotent for CD.

ALTER TABLE association_documents
  ADD COLUMN IF NOT EXISTS "visibility" varchar(16) NOT NULL DEFAULT 'private';

ALTER TABLE association_documents
  ADD COLUMN IF NOT EXISTS "originalFilename" varchar(255);

CREATE INDEX IF NOT EXISTS idx_association_documents_visibility
  ON association_documents ("visibility");
