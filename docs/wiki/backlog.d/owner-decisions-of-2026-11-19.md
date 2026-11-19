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

**Taken by the lead under the standing delegation (reversible, written to the wiki):** a group-call participant's `room-empty` stops only that participant's own devices from ringing. It never ends the other members' rings: no in-app control lets a member join a call already in progress, and principle 2 of the [charter](../../principes.md) holds. The caller's own `room-empty` is unchanged. See [calls](../frontend/modules/calls.md) (WP-GC7, #3705).
