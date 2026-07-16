-- Migration 021 : managed thematic categories for the "Carte de la Vie Asso" poster.
-- Categories are data (editable in admin), not a hardcoded enum, so a zone can be added /
-- renamed / reordered without a migration. Each association points to at most one category
-- via associations."categoryId" (loose uuid, no FK, matching the other reference columns;
-- nulled in the service layer when a category is deleted). Idempotent for CD.

CREATE TABLE IF NOT EXISTS association_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label varchar(100) NOT NULL,
  slug varchar(60) NOT NULL UNIQUE,
  "sortOrder" int NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_association_categories_slug ON association_categories (slug);

-- Seed the printed poster's sections (no-op when the slug already exists).
INSERT INTO association_categories (label, slug, "sortOrder") VALUES
  ('Ecole, Vie a la Me', 'ecole-vie-me', 0),
  ('Cuisine, Decouverte culinaire', 'cuisine', 1),
  ('Technologies, Entreprenariat', 'techno-entrepreneuriat', 2),
  ('Culture, Arts', 'culture-arts', 3),
  ('Sport, Humain, Societe', 'sport-humain-societe', 4)
ON CONFLICT (slug) DO NOTHING;

-- Each association may belong to one category (nullable = uncategorised).
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "categoryId" uuid;
CREATE INDEX IF NOT EXISTS idx_associations_category ON associations ("categoryId");
