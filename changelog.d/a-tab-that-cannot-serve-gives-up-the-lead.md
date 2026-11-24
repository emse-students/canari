### Fixed - a second tab was refused "Nouvelle discussion" while the main tab sat locked or signed out

The leader tab kept the lead after its own session ended (keypad, sign-out, expired session); it now gives it up once its in-flight MLS work settles, a tab that can serve takes it, and a gesture asked by the tab that is promoted survives its reload ([chat](docs/wiki/frontend/modules/chat.md#a-leader-whose-own-session-ended-gives-the-lead-up-2026-11-24)).
