-- An anonymous form (user request, 2026-09-30): the answers carry NO author, and the fact that an
-- account has answered lives in a separate table that knows no answer.
--
-- `submissions.userId` becomes nullable so an anonymous row simply has none, rather than carrying a
-- sentinel that every `WHERE userId = ...` would have to learn about.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS anonymous boolean NOT NULL DEFAULT false;
ALTER TABLE submissions ALTER COLUMN "userId" DROP NOT NULL;

-- "This account has already answered this form" and nothing else: no answer id, no timestamp. A
-- column linking it to a submission, or a clock, would let anybody holding the database join the
-- two tables back into the identity the form promised to forget.
CREATE TABLE IF NOT EXISTS form_respondents (
  "formId" uuid NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  "userId" varchar(255) NOT NULL,
  PRIMARY KEY ("formId", "userId")
);
