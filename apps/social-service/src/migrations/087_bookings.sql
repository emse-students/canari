-- Migration 087: bookings (WP-B1 of docs/wiki/bookings-chantier.md) - the data model, nothing reads it yet.
--
-- See docs/wiki/bookings-chantier.md, section "WP-B1 as built", for the reasoning behind each table.
--
-- THE TREE, AND WHY EVERYTHING HANGS OFF A RESOURCE. A space owns resources (D10: a room, an
-- alumni's column); a resource owns its availability rules, its exceptions, its blocked ranges and
-- its bookings; a booking owns its participants. Hours are per resource (D10), so there is no
-- space-level rule: a "same hours for every column" is written once per resource by the organiser
-- screen (WP-B4). One parent per row means one cascade path and no row that names a resource of
-- ANOTHER space - a consistency no constraint would otherwise hold.
--
-- DELETING A SPACE DELETES EVERYTHING (D27, re-confirmed 2026-10-15): every foreign key below is
-- a cascade on delete, the history included. A space of an association goes with its association.
--
-- ONE LIVE BOOKING PER RESOURCE AND INSTANT (D12, D33), held by PostgreSQL and never by a client
-- check: `bookings_live_no_overlap` is an EXCLUSION constraint on (resource =, time range &&) among
-- the rows whose "cancelledAt" IS NULL. Concurrent inserts on the last slot: exactly one wins,
-- always. What the LOSERS are told depends on the writer (measured 2026-10-16, PostgreSQL 18.6):
-- with the resource row locked first (`SELECT ... FOR UPDATE`, the shape WP-B3 must use) every
-- loser gets SQLSTATE 23P01 (`isExclusionViolation`); with bare concurrent inserts they may get
-- 40P01 (deadlock_detected) instead. Ranges are HALF-OPEN `[start, end)`, so 10:00-10:30 and
-- 10:30-11:00 are both bookable. A cancelled booking stays as history (D15) and frees its range.
--
-- A DELETED ACCOUNT (`BOOKINGS_ERASURE_STATEMENTS` in src/internal/account-erasure.ts): its personal spaces are deleted; elsewhere its ids
-- become '[deleted]' (a linked resource is unlinked) and its name snapshots stay, bounded by the
-- one-year maximum age (D15, D19).
--
-- `=` on a uuid inside a GiST index needs the `btree_gist` extension. It is a contrib extension
-- shipped in the official postgres image, TRUSTED since PostgreSQL 13, and the deploy applies
-- migrations as the image's bootstrap role (`psql -U "$POSTGRES_USER"`, a superuser - read
-- 2026-10-16 on production: `rolsuper = t`, `btree_gist` 1.8 available, not installed). If a future
-- role cannot create it, the deploy FAILS here with the sentence below: there is no application-
-- level overlap check to fall back to, by design.
--
-- User ids are varchar(255): a user id here is a 64-char hex digest, never a uuid
-- (`user-id-column.spec.ts`). Names are SNAPSHOTS: a deleted account leaves the name it had (D15).
--
-- Idempotent for CD: IF NOT EXISTS, or a catalogue check scoped to the current schema.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    BEGIN
      CREATE EXTENSION btree_gist SCHEMA public;
    EXCEPTION
      WHEN insufficient_privilege OR undefined_file THEN
        RAISE EXCEPTION 'migration 087 needs the btree_gist extension and this role cannot create it (%). A database superuser must run, once, in auth_db: CREATE EXTENSION btree_gist SCHEMA public; then the deploy is re-run. There is no fallback: the bookings overlap rule exists only as this constraint.', SQLERRM;
    END;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS booking_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The account that created the space; for a personal space (no association), its owner (D2).
  "ownerId" varchar(255) NOT NULL,
  -- The owning association, list or institution (all `associations` rows), NULL for a person (D2).
  "associationId" uuid NULL,
  name varchar(255) NOT NULL,
  description text NULL,
  -- ONE zone per space; rules are local wall times in it, bookings store UTC instants (D25).
  "timeZone" varchar(64) NOT NULL DEFAULT 'Europe/Paris',
  -- 'step': a rule is a window cut into "stepMinutes" steps, 1..maxSteps per booking.
  -- 'slots': each rule IS one predefined slot (D3).
  "slotMode" varchar(8) NOT NULL DEFAULT 'step',
  "stepMinutes" integer NULL,
  "maxSteps" integer NULL,
  -- 'names': other bookers see who booked; 'occupied': only the organiser and the booking's people (D9).
  "nameVisibility" varchar(8) NOT NULL DEFAULT 'occupied',
  -- 'listed' on the Reservations page for the audience, or 'link' only (D31).
  discoverability varchar(8) NOT NULL DEFAULT 'listed',
  -- The forms' AudienceCondition; NULL means every signed-in account (D6).
  audience jsonb NULL,
  -- The forms' question items, the file type included (D7).
  items jsonb NOT NULL DEFAULT '[]',
  -- Shown only to a booking's people while the booking is live (D32).
  "privateInfo" text NULL,
  -- The booking window, all optional (D26).
  "opensAt" timestamptz NULL,
  "minNoticeMinutes" integer NULL,
  "horizonDays" integer NULL,
  -- Two per-person ceilings, none by default (D17).
  "maxActiveBookings" integer NULL,
  "maxMinutesPerPeriod" integer NULL,
  "quotaPeriod" varchar(8) NULL,
  -- How long before the start the holder may still cancel; 0 = until the start (D5).
  "withdrawalDelayMinutes" integer NOT NULL DEFAULT 0,
  -- People in one booking, the holder included; NULL = no ceiling (D4, D33).
  "maxPeople" integer NULL,
  -- Answers and files are purged this many days after the slot's end (D8, D18, D23).
  "retentionDays" integer NOT NULL DEFAULT 7,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_spaces_slot_mode CHECK ("slotMode" IN ('step', 'slots')),
  -- COALESCE, because a CHECK that evaluates to NULL PASSES: `"stepMinutes" > 0` on a NULL step
  -- let a step space with no step through (found by the integration spec, 2026-10-16).
  CONSTRAINT booking_spaces_step_shape CHECK (
    ("slotMode" = 'step' AND COALESCE("stepMinutes", 0) > 0 AND COALESCE("maxSteps", 0) >= 1)
    OR ("slotMode" = 'slots' AND "stepMinutes" IS NULL AND "maxSteps" IS NULL)
  ),
  CONSTRAINT booking_spaces_name_visibility CHECK ("nameVisibility" IN ('names', 'occupied')),
  CONSTRAINT booking_spaces_discoverability CHECK (discoverability IN ('listed', 'link')),
  CONSTRAINT booking_spaces_window CHECK (
    ("minNoticeMinutes" IS NULL OR "minNoticeMinutes" >= 0)
    AND ("horizonDays" IS NULL OR "horizonDays" >= 1)
  ),
  CONSTRAINT booking_spaces_quotas CHECK (
    ("maxActiveBookings" IS NULL OR "maxActiveBookings" >= 1)
    AND (("maxMinutesPerPeriod" IS NULL) = ("quotaPeriod" IS NULL))
    AND ("maxMinutesPerPeriod" IS NULL OR "maxMinutesPerPeriod" >= 1)
    AND ("quotaPeriod" IS NULL OR "quotaPeriod" IN ('day', 'week'))
  ),
  CONSTRAINT booking_spaces_withdrawal_delay CHECK ("withdrawalDelayMinutes" >= 0),
  CONSTRAINT booking_spaces_max_people CHECK ("maxPeople" IS NULL OR "maxPeople" >= 1),
  CONSTRAINT booking_spaces_retention_days CHECK ("retentionDays" BETWEEN 1 AND 30)
);

CREATE INDEX IF NOT EXISTS booking_spaces_association_idx ON booking_spaces ("associationId");
CREATE INDEX IF NOT EXISTS booking_spaces_owner_idx ON booking_spaces ("ownerId");

CREATE TABLE IF NOT EXISTS booking_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "spaceId" uuid NOT NULL,
  name varchar(255) NOT NULL,
  -- The public free text: a sector, a remark (D10).
  description text NULL,
  -- The "after booking" text: a video link, a room code (D32).
  "privateInfo" text NULL,
  -- An optional account that sees this resource's bookings and may block itself (D10).
  "linkedUserId" varchar(255) NULL,
  position integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_resources_space_idx ON booking_resources ("spaceId");
CREATE INDEX IF NOT EXISTS booking_resources_linked_user_idx ON booking_resources ("linkedUserId");

-- A typical-week line (weekday set) or a dated line (onDate set), in the space's local wall time
-- (D11, D25). In 'step' mode it is a window; in 'slots' mode it is one slot.
CREATE TABLE IF NOT EXISTS booking_availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "resourceId" uuid NOT NULL,
  -- ISO weekday, 1 = Monday .. 7 = Sunday.
  weekday smallint NULL,
  "onDate" date NULL,
  "startTime" time NOT NULL,
  "endTime" time NOT NULL,
  CONSTRAINT booking_availability_rules_one_kind CHECK ((weekday IS NULL) <> ("onDate" IS NULL)),
  CONSTRAINT booking_availability_rules_weekday CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  CONSTRAINT booking_availability_rules_order CHECK ("startTime" < "endTime")
);

CREATE INDEX IF NOT EXISTS booking_availability_rules_resource_idx
  ON booking_availability_rules ("resourceId");

-- Whole local days removed from the typical week (holidays), both ends INCLUDED (D11).
CREATE TABLE IF NOT EXISTS booking_availability_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "resourceId" uuid NOT NULL,
  "fromDate" date NOT NULL,
  "toDate" date NOT NULL,
  CONSTRAINT booking_availability_exceptions_order CHECK ("fromDate" <= "toDate")
);

CREATE INDEX IF NOT EXISTS booking_availability_exceptions_resource_idx
  ON booking_availability_exceptions ("resourceId");

-- "Indisponible": a range the organiser, or the resource's linked account, took out (D10, D20).
CREATE TABLE IF NOT EXISTS booking_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "resourceId" uuid NOT NULL,
  "startsAt" timestamptz NOT NULL,
  "endsAt" timestamptz NOT NULL,
  reason text NULL,
  "reasonVisible" boolean NOT NULL DEFAULT false,
  "createdById" varchar(255) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_blocks_order CHECK ("startsAt" < "endsAt")
);

CREATE INDEX IF NOT EXISTS booking_blocks_resource_idx ON booking_blocks ("resourceId", "startsAt");

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "resourceId" uuid NOT NULL,
  "holderId" varchar(255) NOT NULL,
  "holderName" varchar(255) NOT NULL,
  -- The holder, or the organiser booking on their behalf (D20).
  "bookedById" varchar(255) NOT NULL,
  -- UTC instants of the half-open range [startsAt, endsAt) (D25).
  "startsAt" timestamptz NOT NULL,
  "endsAt" timestamptz NOT NULL,
  -- The forms-shaped answers (D7); NULL once purged (D18), "answersPurgedAt" saying when.
  answers jsonb NULL,
  "answersPurgedAt" timestamptz NULL,
  -- LIVE = "cancelledAt" IS NULL. A cancellation stays visible, and by whom (D15).
  "cancelledAt" timestamptz NULL,
  "cancelledById" varchar(255) NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_order CHECK ("startsAt" < "endsAt"),
  CONSTRAINT bookings_cancellation_pair CHECK (("cancelledAt" IS NULL) = ("cancelledById" IS NULL))
);

CREATE INDEX IF NOT EXISTS bookings_holder_idx ON bookings ("holderId", "startsAt");
-- A resource's bookings in time order (the grid, the planning, the D29 refusal).
CREATE INDEX IF NOT EXISTS bookings_resource_starts_idx ON bookings ("resourceId", "startsAt");
-- The purges select on the slot's end: answers N days after it (D18), everything a year after (D19).
CREATE INDEX IF NOT EXISTS bookings_ends_idx ON bookings ("endsAt");

-- The people of a booking other than its holder (D4). Withdrawal keeps the row (D15). A surrogate
-- key, because a deleted account's "userId" becomes '[deleted]' and two of them may share a booking:
-- one row per (booking, account) - a withdrawn row counts, so withdrawing does not re-open the
-- door (D36) - is a partial UNIQUE index that leaves the tombstones out.
CREATE TABLE IF NOT EXISTS booking_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bookingId" uuid NOT NULL,
  "userId" varchar(255) NOT NULL,
  "userName" varchar(255) NOT NULL,
  "addedAt" timestamptz NOT NULL DEFAULT now(),
  "withdrawnAt" timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_participants_booking_user_uq
  ON booking_participants ("bookingId", "userId") WHERE "userId" <> '[deleted]';
CREATE INDEX IF NOT EXISTS booking_participants_user_idx ON booking_participants ("userId");

-- Constraints with no IF NOT EXISTS: one guarded block, each looked up in the CURRENT schema only.
DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_spaces_association_fk' AND connamespace = ns) THEN
    ALTER TABLE booking_spaces ADD CONSTRAINT booking_spaces_association_fk
      FOREIGN KEY ("associationId") REFERENCES associations (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_resources_space_fk' AND connamespace = ns) THEN
    ALTER TABLE booking_resources ADD CONSTRAINT booking_resources_space_fk
      FOREIGN KEY ("spaceId") REFERENCES booking_spaces (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_availability_rules_resource_fk' AND connamespace = ns) THEN
    ALTER TABLE booking_availability_rules ADD CONSTRAINT booking_availability_rules_resource_fk
      FOREIGN KEY ("resourceId") REFERENCES booking_resources (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_availability_exceptions_resource_fk' AND connamespace = ns) THEN
    ALTER TABLE booking_availability_exceptions ADD CONSTRAINT booking_availability_exceptions_resource_fk
      FOREIGN KEY ("resourceId") REFERENCES booking_resources (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_blocks_resource_fk' AND connamespace = ns) THEN
    ALTER TABLE booking_blocks ADD CONSTRAINT booking_blocks_resource_fk
      FOREIGN KEY ("resourceId") REFERENCES booking_resources (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_resource_fk' AND connamespace = ns) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_resource_fk
      FOREIGN KEY ("resourceId") REFERENCES booking_resources (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_participants_booking_fk' AND connamespace = ns) THEN
    ALTER TABLE booking_participants ADD CONSTRAINT booking_participants_booking_fk
      FOREIGN KEY ("bookingId") REFERENCES bookings (id) ON DELETE CASCADE;
  END IF;
  -- THE rule of the module. Its text is the entity's `@Exclusion` expression, character for
  -- character (`booking.entity.spec.ts` compares them), so a development database built by
  -- `synchronize` holds the same constraint as production.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_live_no_overlap' AND connamespace = ns) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_live_no_overlap
      EXCLUDE USING gist ("resourceId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("cancelledAt" IS NULL);
  END IF;
END
$$;
