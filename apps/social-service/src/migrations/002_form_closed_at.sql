-- Migration 002: add closedAt column to forms table
-- Allows automatic form closure at a given instant; null means the form never closes automatically.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMPTZ DEFAULT NULL;
