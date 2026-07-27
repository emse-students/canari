# Canari - Agent Delegation Timeline

This file is the **delegation log**: work handed to autonomous agents (Zoo Code, Aider, background
Claude sessions), and the verification verdict once it came back.

It is a **separate timeline** from `CLAUDE.md`. Do not duplicate SESSION STATE here.

- `CLAUDE.md` -> project rules + canonical SESSION STATE (what the project needs next).
- `AGENTS.md` (this file) -> who did what, when, and whether it survived verification.

## Rules

1. **Nothing delegated is trusted until verified.** An agent reporting "done" is a claim, not a fact.
   Every entry below carries a verdict from a re-run of the gates, not from the agent's own summary.
2. **One entry per delegated batch.** Record: date, agent, scope, verdict, and any defect the
   verification pass found. Keep defects even after fixing them - they are the reason this file exists.
3. **Record the detection recipe, not just the result.** A sweep that used the wrong regex will be
   repeated by the next agent unless the gap is written down (see 2026-07-27).
4. **Gates before any verdict:** `bun run check` / `lint` / `format`, `bun run test`, per-app
   `npm run lint` / `format:check` / `test`, `cargo clippy --all-targets -- -D warnings`.
5. Prune entries once the lesson is folded into `CLAUDE.md` gotchas.

---

## Timeline

### 2026-07-27 - Post-v0.11.0 remediation, batch 2 (Lot 4 remainder + Lot 5 + T16)

**Delegated:** T11 remainder (French comments), T16 (`pin` -> `deviceKeyB64` rename), Lot 5 (CHANGELOG,
delete `plans/` + `docs/strategy/`), B1 (fr/en key parity).

**Verdict: accepted with corrections.** The work was real and largely correct, but shipped with a
broken test, unformatted files, and an incomplete sweep. Corrections applied in the verification pass:

| # | Defect found in verification | Fix |
|---|---|---|
| 1 | `setupMessageHandler.test.ts` still built deps with `pin:` after the T16 rename -> production read `deps.deviceKeyB64` and got `undefined`. **Test suite was red.** | Renamed the fixture key; 5 stale fixtures total (`setupMessageHandler`, `systemMessageHandler.exclusion`, `systemMessageHandler.readReceipt`, `outbox`, `recovery`). |
| 2 | **T11 swept only `//` line comments.** JSDoc/rustdoc block comments (`/** ... */`) were never searched - ~250 French lines across 67 files remained, including files French end to end (`epochGapRegistry.ts`, `mlsDecryptError.ts`, `groupLifecycle.ts`). | Full block-comment sweep; all translated. |
| 3 | Two frontend files left unformatted (`oxfmt` not run). | `bun run format`. |
| 4 | T7 only translated the `[Unreleased]` block; the version sections it was supposed to cut were never created. | Cut `[Unreleased]` into v0.10.10 - v0.11.0 sections, attributed from tag ranges. |
| 5 | `SECURITY.md` entry sat under `[Unreleased]` although it shipped in v0.1.0 (2026-03-08). | Moved to the v0.10.9 catch-all section. |

**Detection recipes** (ripgrep; use the `-i` **flag**, never inline `(?i)` - it fails to parse):

- Line comments: `//.*\b(le|la|les|une|des|dans|pour|avec|sur|est|sont|pas|que|qui|cette|cle|clé|chiffr|dechiffr|déchiffr|utilise|permet|renvoie|retourne|evite|évite|verifie|vérifie|charge|stocke|recupere|récupère|supprime|ajoute|lors|ainsi|afin|depuis|aucun|chaque|meme|même)\b`
- **Block comments (the half that was missed):** `^\s*(\*|/\*\*).*\b(le|la|les|une|des|dans|pour|avec|sur|est|sont|pas|que|qui|cette|clé|chiffr|déchiffr|utilise|permet|renvoie|retourne|évite|vérifie|stocke|récupère|supprime|lors|ainsi|afin|aucun|chaque|même|injecte|identifiant|valide|filtre)\b`
- Rust: same pattern with `^\s*(///|//!|\*)`.
- Known false positives: `Carte de la Vie Asso`, `double-charge`, `charge-saved-method`,
  `Destination charge`, `Avec alcool`, `Rejoindre la communauté` (quoted UI strings),
  `Maison des eleves`, `Le Cercle`.

**Gates after correction:** svelte-check 0 errors / 0 warnings / 7320 files - frontend 565/565 -
social-service 124/124 - chat-delivery 70/70 - oxlint + oxfmt clean on all three - clippy clean on
chat-gateway. `fr.json` / `en.json` both 2165 keys, zero orphans either way.

**Unrelated pre-existing issue fixed in passing:** `apps/social-service` had 19 files failing
`oxfmt --check` on `HEAD` (double-quoted strings never formatted). Fixed; tests still 124/124.

---

### 2026-07-27 - Post-v0.11.0 remediation, batch 1 (Lots 1-3, interactive)

Done in-session, not delegated. Summarized in `CLAUDE.md` SESSION STATE. Two findings worth keeping
here because they show the failure mode this file guards against:

- **Lot 2:** `store_push_context` declared a `pin` parameter while all three call sites passed
  `deviceKeyB64` -> the invoke failed on a missing argument *every time*, silently swallowed by
  `.catch(() => {})`. A naming lie that shipped and stayed invisible.
- **Lot 3:** the audit claimed prod migrations were hand-applied. They were not. The real defect was
  the absence of a ledger, so one-shot backfills replayed on every deploy.

---

## Open device checks (cannot be verified from a dev machine)

- [ ] Decrypted push notification on Android **and** iOS (Lot 1 - the whole point of the fix).
- [ ] Login, PIN change, biometric enable/disable on a real device (Lot 2).
- [ ] v0.11.1 auth fixes: PIN change must KEEP biometrics enabled (was silently disabling them);
      the fingerprint button must stay on the PIN sheet after a cancelled biometric prompt;
      the enrolment bottom sheet must appear right after the first PIN entry, once only.
