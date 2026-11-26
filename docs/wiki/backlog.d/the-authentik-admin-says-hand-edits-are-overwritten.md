## P3 - authentik's admin says that a hand edit is overwritten at the next stable

target: 1.8.3

_2026-11-26: moved to 1.8.3 when 1.8.2 shipped._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

The owner asked on 2026-11-23 for something visible INSIDE authentik's admin saying that any hand
edit to MiConnect's configuration is overwritten at the next stable: the stable re-applies the
blueprints, and the daily drift job reports the differences
([authentik](../infrastructure/authentik.md#the-configuration-is-code-infrastructureauthentikblueprints-2026-09-30)).

Candidate mechanisms, each to be MEASURED on authentik 2026.8 before one is chosen:

- the brand's custom CSS or a banner text shown in the admin interface;
- the blueprint's own description or managed metadata, as the admin displays it;
- a notice in the name or description of each managed object.

If one is cheap and clearly correct it is built directly, and this entry is deleted the day it ships.
