BEGIN;

-- Table des overrides de permissions par canal × rôle
CREATE TABLE IF NOT EXISTS channel_permission_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id UUID REFERENCES channel_roles(id) ON DELETE CASCADE,
  permission VARCHAR(128) NOT NULL,
  value VARCHAR(16) NOT NULL CHECK (value IN ('allow', 'deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, role_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_cpo_channel ON channel_permission_overrides(channel_id);
CREATE INDEX IF NOT EXISTS idx_cpo_role ON channel_permission_overrides(role_id);

-- Ajout de la colonne d'activation du nouveau système de permissions sur channels
ALTER TABLE channels ADD COLUMN IF NOT EXISTS use_permission_overrides BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
