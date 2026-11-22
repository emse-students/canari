## Reading owed - a respondent sees their own answer, read-only, on a phone

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Built ([forms](../frontend/modules/forms.md#a-respondent-sees-their-own-answer-owner-2026-11-21)):
the check's `myAnswers`, the read-only answer of a named form (pending cash and several answers
included, the lock line on price-fixing questions), and "Vous avez déjà répondu" on an anonymous form
already answered. The reading that closes it, on dev with a test account: a named form with the edit
switch off shows the answer read-only; a form taking several answers lists them and "Voir" opens each;
an anonymous form answered shows "Vous avez déjà répondu" and no empty question.
