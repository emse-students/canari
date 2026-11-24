## The owner's decisions of 2026-11-24

Recorded so no question answered here is asked again.

1. **Tabs: fix the symptom in `1.8.0`, design the browser-wide worker now, build it in `1.9.0`** (owner, 2026-11-24, after a screenshot of a second tab refusing "Nouvelle discussion" with "L'onglet principal de Canari n'est pas prêt"). The `1.8.0` fix is architectural: the lead belongs to a tab whose session can serve it, and is given up from the session's own flags, never after a timeout ([chat](../frontend/modules/chat.md#a-leader-whose-own-session-ended-gives-the-lead-up-2026-11-24)). The `SharedWorker` that replaces the leader tab is designed in [its entry](../backlog.d/a-browser-wide-worker-holds-the-mls-state-instead-of-a-leader-tab.md) and built in `1.9.0` under an adversarial review. Charter principle 2, *the essential is never lost* ([principes](../../principes.md)): a gesture must not dead-end because another tab went to sleep.
