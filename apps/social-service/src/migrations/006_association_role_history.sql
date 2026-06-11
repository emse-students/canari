-- Historical association roles for user profiles (e.g. "Président BDE 2018-2019").

CREATE TABLE IF NOT EXISTS association_role_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  association_id UUID NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  role_title VARCHAR(120) NOT NULL,
  start_year INT NULL,
  end_year INT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_association_role_history_user
  ON association_role_history (user_id);

CREATE INDEX IF NOT EXISTS idx_association_role_history_assoc
  ON association_role_history (association_id);
