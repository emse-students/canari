-- WP-XP-5 priority call notifications: PushKit VoIP token (iOS CallKit ring).
-- Nullable; only iOS devices running a PushKit-enabled build ever set it.
ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "voipToken" varchar(255);
