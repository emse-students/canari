## P2 - forms: answer formats on a short text question (G-VALID), and no more empty strings

target: 1.8.0

Owner decision 2026-11-21 (read-only production survey: of 419 short answers 18% bare numbers, 6 phone numbers,
18 hand-typed oui/non/x; 93 skipped optional answers stored as `""`). Built: `number` (min, max, decimals off by
default), `phone` and `email` formats judged by one shared rule on the page and on the server (typed refusal), numbers
exported as numbers, a skipped optional answer stored as absent. The yes/no editor hint was not built (too noisy to be
cheap). Read on dev with a real form (fill, refuse, export) before the stable.

The mechanism and every reader checked before dropping `""`:
[forms, answer formats](../frontend/modules/forms.md#answer-formats-on-a-short-text-question-and-the-empty-answer-stored-as-absent-owner-2026-11-21-180).
