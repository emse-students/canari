## P3 - the pin register outlives sign-out, account erasure and an account switch (found 2026-11-09)

Found reviewing per-conversation nicknames (PR #3177), which had the same flaw and fixed it for
its own register. `pinStore.svelte.ts` keeps each conversation's pins in `localStorage` under
`canari_pins_<conversationId>`. That key does not name the account, and nothing removes it: it is
not in `ACCOUNT_KEY` (`utils/accountLocalKeys.ts`), so neither `clearUserLocally` (sign-out) nor
`eraseAccountRecordsLocally` (account erasure) sweeps it. Two accounts on one install that share
a conversation therefore share one pin register, and the ids of messages a person pinned stay on
the device after they sign out.

What is held is message ids and dates, not message text, so this is P3. It is bigger than a
one-line sweep. The fix is a key under `ACCOUNT_KEY` (`canari_pins:v1:<account>:<conversation>`),
added to `keyPrefixes`, plus a ONE-TIME move of the legacy `canari_pins_*` keys to the signed-in
account. That move is a legacy shim, so it needs a removal date in
[legacy-compatibility](../legacy-compatibility.md). The nickname register's per-account keys are
the model ([chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08)).

The reactivity half of the same review WAS fixed in #3177. A register born inside a `$derived` did
not notify it of the first pin, and one module-level revision now carries the reactivity
(`pinStore.reactive.svelte.test.ts`).
