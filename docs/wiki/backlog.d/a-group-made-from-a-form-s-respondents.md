## "Créer un groupe" from a form's respondents (owner, 2026-11-19)

target: 1.8.0

**Asked by the owner on 2026-11-19, from a user's request** ([decisions](owner-decisions-of-2026-11-19.md)):
a button that creates a group conversation with every person who answered a form - the same effect
as "créer un groupe" and adding each respondent by hand.

**Decided the same day:**

- **Internal forms only**: never on a public form (a guest has no account to add).
- **Never on an anonymous form**: the group would reveal who answered (principle 1 of the
  [charter](../../principes.md)); the button is absent there.
- **Who has it:** whoever already reads the form's named answers (its creator and the managers who
  see responses).
- **Same rules as a manual add**: the same group-size ceiling, the same invitation and admission
  path - the button only fills the member picker; it grants no new power.

**Owed:** where the button sits on the responses screen; what happens past the group-size ceiling
(refused with the count, never silently truncated); respondents who have left the platform skipped
and counted on screen; a spec that the anonymous and public cases have no button and that the
server refuses the call for them. User strings in Paraglide.

**Closed when** a group is made from a form's respondents on dev and read on a phone.
