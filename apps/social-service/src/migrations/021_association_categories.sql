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

-- No categories are seeded: the printed poster's sections are created + managed exclusively from
-- the admin UI. Seeding them here re-inserted rows an admin had deleted every time the migration
-- was re-applied (a deleted slug no longer conflicts, so ON CONFLICT DO NOTHING did not protect
-- it). The table therefore starts empty and stays entirely admin-driven.

-- Each association may belong to one category (nullable = uncategorised).
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "categoryId" uuid;
CREATE INDEX IF NOT EXISTS idx_associations_category ON associations ("categoryId");
