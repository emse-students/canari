## The owner's decisions of 2026-11-19

target: 1.7.1

Recorded so that no question answered here is asked again. The owner took them in person on 2026-11-19, in the morning. Each line names where its detail lives.

1. **The client floor is `1.7.0` on both estates.** *"On peut remonter la version à 1.7.0."* The owner checked that the App Store serves `1.7.0`, and Play's production track serves it too. `platform_config.min_client_version` was raised from `1.6.6` to `1.7.0` on dev and production by a guarded update, and `GET /api/version` was read back on each estate. This unblocks [legacy-compatibility](../legacy-compatibility.md)'s retirements of the shims the `1.7.0` floor meets (#3837).
2. **The `1.7.1` stable ships "as soon as everything passes".** *"Dès que tout passe, au plus tôt."* What is not ready and read moves on: the open entries spread over `1.7.1`, `1.7.2` and `1.7.3`. *"Tous ces trucs là sont pour la 1.7.1, 1.7.2, 1.7.3..."* When the stable is cut, the lead moves each `target:` line it does not carry and regenerates the [plan](../plan.md).
3. **Both bench phones stay plugged in permanently.** *"L'iPhone et le Mi 9T sont branchés en permanence."* A sitting may therefore count on both phones at any hour, and a reading is never deferred for want of a plugged phone.
4. **"Voir en tant que", for platform admins:**
   - feeds and posts only;
   - platform admins only;
   - no trace: *"c'est juste un outil de tests"*;
   - target `1.7.2`.

   Its entry is [admin-view-feeds-as-a-member](admin-view-feeds-as-a-member.md).

5. **CanaQuiz: designed, to be built for `1.8.0`.** It is a live quiz with points and a ranking.
   - **Who:** anyone can run one, with the same rules as a form (public or restricted to the
     platform, optional pseudonyms).
   - **Questions:** the owner's full list of question types.
   - **Scoring:** points for a correct answer, plus a speed bonus timed by the server.
   - **Display:** either a projected screen or phones only; the top 5 is shown on screen, and
     each player sees their own rank.
   - **Moderation:** the host hides anything in one gesture. Brainstorm ideas are grouped
     automatically, with no AI.
   - **Limits:** no player ceiling, and **no teams**.
   - **Results:** kept 30 days.

   Its entry is [canaquiz-a-live-quiz-anyone-can-run](canaquiz-a-live-quiz-anyone-can-run.md).

6. **The order after `1.7.x`: reliability first.** Security, then lives (the viewer ceiling, then replays), the single MLS state (WP-CHECKPOINT-CAS, in `1.8.0` right after the slow-link chantier), the self-updating server images, CanaQuiz, the MiConnect profiles, the usage dashboard, the device notices, and global search. The authorization and session-liveness audit is triaged at once and its fixes land in `1.7.3`. The verified-link mobile sign-in is trialled in `1.7.3` and switched over in `1.9.0`.
7. **The MiConnect (authentik) stack on the shared host is the project's own** (#3486). The IT department's no-touch rule covers the host, not our containers, and one line in [estate-migration](../infrastructure/estate-migration.md) says so. The release's rollback copies (identity database dumps, and `.env` copies holding the stack's secrets) are kept **3 copies and 30 days at most**.
8. **The videos already posted all become CanaReels** (migration 176, #3528): *"Oui, toutes."* The owner confirmed this after reading the production examples, landscape clips included. The rule for a NEW video stays "vertical or 90 s or less". The stored ones carry no length, so the rule cannot be read on them.
9. **A group seat with no active device is shown greyed, "aucun appareil actif"**, never hidden or removed. See [entry](p2-the-group-panel-lists-22-roster-seats-that-hold-no-device.md), `1.7.2`.
10. **The tab-leader lock stays one per browser:** *"Fermer... pour le moment, rien à faire, tout marche bien."* A worker independent of the tabs may come later. The entry is deleted, and the remaining case is in [mls-protocol](../protocols/mls-protocol.md).
11. **The three public names not watched from outside: the gap is accepted.** *"Supprime cette entrée, on accepte le trou et on en parle plus avant que je remette le sujet sur la table."* The entry is deleted, and the question is not raised again until the owner reopens it. See [upstream-reachability](../infrastructure/upstream-reachability.md).
12. **A guest's file on a public form:** one file, 5 MB, a limit per address, a global quota, and a 24 h purge of unlinked files. See [entry](a-file-question-on-a-public-form-needs-an-abuse-design.md).

**Taken by the lead under the standing delegation (reversible, written to the wiki):** a group-call participant's `room-empty` stops only that participant's own devices from ringing. It never ends the other members' rings: no in-app control lets a member join a call already in progress, and principle 2 of the [charter](../../principes.md) holds. The caller's own `room-empty` is unchanged. See [calls](../frontend/modules/calls.md) (WP-GC7, #3705).
