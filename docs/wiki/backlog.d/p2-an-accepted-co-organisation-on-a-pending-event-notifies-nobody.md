## P2 - an accepted co-organisation on a PENDING event notifies nobody (WP-COORG-ACCEPT-NOTICE)

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

S-M, server plus native tables, no MLS. An acceptance on a VALIDATED event already notifies (`event_pending_coorganiser`, WP-Q2 #2973, `announceEventReopened`); on a pending one `CoorganisationService.apply` still announces nothing (re-read 2026-11-19), so the organiser is never told. The client floor it waited for (#1911) is below every estate's `minClientVersion`. Carried out of the decision record of 2026-10-18 ([decisions](../decisions/decided-by-the-user-on-2026-10-18-every-design-question-answered.md)).
