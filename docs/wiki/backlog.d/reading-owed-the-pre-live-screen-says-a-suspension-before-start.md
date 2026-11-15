## Reading owed - the pre-live screen says a suspension before Start

target: 1.7.0

Built 2026-11-15: the pre-live sheet reads `GET /api/lives/standing` with the limits and the rules,
says a running suspension (with its end date) or a withdrawal, and disables Start
([live](../frontend/modules/live.md#the-broadcaster-as-built)). Proven by unit and component tests
only; no device has shown it.

**The reading, on the first pre-release that carries it, on dev, one phone is enough (the sheet is
the same web code on both):** a test account whose lives staff cut twice within 90 days (two cuts
through `/admin/moderation`, the app's own path) opens the live sheet. It closes when the sheet
shows "Vous ne pouvez plus lancer de live jusqu'au <date>" with the date 30 days after the second
cut, Start is greyed, and the session's log carries `[LIVE] standing` and NO `[LIVE] start`. Read
again in English. The same sheet on an account in good standing still offers Start.
