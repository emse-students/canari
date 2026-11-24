## A file question on a PUBLIC form needs an abuse design first (asked by the user 2026-10-15, re-read 2026-11-11)

target: 1.9.0

**Limits decided by the owner, 2026-11-19:** a guest attaches ONE file of at most 5 MB per answer; a limit
per address, a global quota, and a purge within 24 h of any file never linked to a submitted answer
(principle 7 of the [charter](../../principes.md)). **No scan** (owner, same day): the accepted types are images and PDF only, and the server never opens
or parses a guest's file ([decisions](../decisions/owner-decisions-of-2026-11-19.md)).

The user asks for it; #1908 refuses a file question on a public or anonymous form, and `main` still
does (`assertFileQuestionConfigValid`, `forms.service.ts`). A guest has no account, so nothing bounds
what it uploads. Before any code, a design in [public-paid-forms-chantier](../public-paid-forms-chantier.md):
a limit per address or per token, a size cap, a global quota, a scan, and an anonymous upload path
with its own purge of files never linked to an answer. Nothing in the repository holds that design yet.
