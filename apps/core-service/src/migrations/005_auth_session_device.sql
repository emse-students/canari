-- Migration 005 : let a session say which device it belongs to.
--
-- A session (auth_sessions, core-service) and an MLS device (key_package,
-- chat-delivery-service) are two records of the same physical thing, held by
-- two services, with nothing joining them. The settings screen therefore had
-- two lists - "Connexions actives" and "Gestion des appareils" - and neither
-- was complete: one knew when you last connected and what browser you used,
-- the other knew the device's name and what it could decrypt. A reader had to
-- open both and guess which row on one was which row on the other.
--
-- The column is the join. It is written by the CLIENT, once per app start,
-- after it has unlocked MLS and knows its own device id - which is why it is
-- nullable rather than NOT NULL: the session is opened by the OIDC callback,
-- long before that, and a holder who cannot unlock MLS never names a device at
-- all. That second case is the one worth keeping visible: a stolen refresh
-- cookie is exactly a session with no device, and the panel shows it on its own
-- rather than folding it into a device row.
--
-- Never used for authorization. It is a label the client asserts about itself,
-- for display; anything that has to be TRUE about a device is decided by the
-- delivery service against its own records.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (TypeORM synchronize creates it in dev;
-- this covers production where synchronize is disabled).

ALTER TABLE auth_sessions
    ADD COLUMN IF NOT EXISTS "deviceId" VARCHAR(128);
