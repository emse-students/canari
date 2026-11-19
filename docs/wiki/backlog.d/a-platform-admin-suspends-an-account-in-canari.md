## A platform admin suspends an account, in Canari only (owner, 2026-11-19)

target: 1.9.0

**Decided by the owner on 2026-11-19** ([decisions](owner-decisions-of-2026-11-19.md)), answering the
question parked on 2026-11-15: Canari gains a sanction stronger than the mute - a SUSPENSION.

- **In Canari only.** The person can no longer use Canari; MiConnect and the other sites are untouched
  (nothing is asked of the identity provider).
- **The platform admin alone** decides it; a BDE does not have this power
  ([moderation-authority](../moderation-authority.md#sanctions)).
- **Reversible and journaled**, like every moderation act.

**Owed (design, then build):** where the refusal lives so EVERY service honours it (core-service's
session and refresh, the WebSocket tokens, chat-delivery and the media routes - a refused session, never
a per-screen check); what the person sees on sign-in (Paraglide); what happens to their devices'
encrypted state (kept, not wiped: a lifted suspension restores the account); whether their
conversations show anything to others (principle 1 of the [charter](../../principes.md)); the GDPR
register row (a new processing); and a spec that every authenticated route refuses a suspended account.
