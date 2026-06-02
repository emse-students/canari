-- Migration 004 : MANAGE_STRIPE_CONNECT (1 << 9 = 512)
-- Grant to members who could configure Stripe via POST_AS_ASSO or manage the boutique.

BEGIN;

UPDATE association_members
SET permissions = permissions | 512
WHERE (permissions & 512) = 0
  AND (
    (permissions & 1) <> 0
    OR (permissions & 256) <> 0
    OR permissions = 287
  );

COMMIT;
