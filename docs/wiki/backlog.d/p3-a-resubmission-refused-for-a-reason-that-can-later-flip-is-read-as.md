## P3 - A resubmission refused for a reason that can later flip is read as definitive (ADM-3 review, 2026-10-26)

target: 1.9.0

The settlement of an unresolved commit classifies a refusal from its body once, and treats it as
final even when the reason is a state that can change later (a seat, a block). Owed: name which
refusal reasons are definitive, and re-plan rather than settle on the others, with a test per reason.

**Plan (batch 13, 2026-11-11).** `resubmissionVerdict` (`mls-client/commitSubmission.ts`) answers `refused` for every reason but `concurrent_commit`. The gate's reasons (`messaging.service.ts`) split into the commit's own bytes (`epoch_mismatch`, `committer_not_on_roster`, `revoked`, `unresolved_identity`) and states that can change (`admit_refused`, `awaiting_admission`, `no_key_package`, `departed`, `welcome_target_not_member`). Build: a typed set of the second kind, and on those the settle clears the stage AND re-plans the invitation (the lost-invitation re-plan) instead of settling it as done; a test per reason. MLS settlement code: an agent of its own, with an adversarial review.
