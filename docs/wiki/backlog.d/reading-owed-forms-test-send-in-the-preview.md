## P2 - Reading owed - "Tester l'envoi" in a form's preview, and the two form entries built in 1.8.2

target: 1.8.3

What is built, in three parts:

- **"Tester l'envoi"** (owner, 2026-11-17): a button in the preview that judges the answer as the send does and
  reports the total, sending, storing and announcing nothing; no marker row was built, the decision and
  what it leaves untested are in [forms](../frontend/modules/forms.md#tester-lenvoi-in-the-preview-owner-2026-11-17-built-2026-11-26).
- **Answer formats on a short text question** (owner, 2026-11-21): `number`, `phone`, `email`, one rule
  on the page and the server, a skipped optional answer stored as absent
  ([forms](../frontend/modules/forms.md#answer-formats-on-a-short-text-question-and-the-empty-answer-stored-as-absent-owner-2026-11-21-180)).
- **A free comment and "Autre : precisez"** on choice questions
  ([forms](../frontend/modules/forms.md#a-choice-questions-free-comment-and-its-autre-owner-2026-11-21-180)).

**The reading that closes it, on a dev pre-release, with a real form**: open the preview of a draft with a
required question; press "Tester l'envoi" empty (the question is flagged, no report), fill it, press again (the
report names the total and says nothing was saved); change an answer (the report goes); check that no answer
and no bell notice exists afterwards. Then on the live form: fill a short question with a `number`, a `phone`
and an `email` format (a refusal is worded, a valid one is stored normalised and exported as a number), leave an
optional one empty (absent in the export), fill a choice question with its comment and its "Autre" (shown in
the responses table, searched, exported in its own column), and edit such an answer.
