## A file question on a PUBLIC form needs an abuse design first (asked by the user 2026-10-15, re-read 2026-11-11)

target: 1.8.0

The user asks for it; #1908 refuses a file question on a public or anonymous form, and `main` still
does (`assertFileQuestionConfigValid`, `forms.service.ts`). A guest has no account, so nothing bounds
what it uploads. Before any code, a design in [public-paid-forms-chantier](../public-paid-forms-chantier.md):
a limit per address or per token, a size cap, a global quota, a scan, and an anonymous upload path
with its own purge of files never linked to an answer. Nothing in the repository holds that design yet.
