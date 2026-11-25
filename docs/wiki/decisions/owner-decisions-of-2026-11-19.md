## The owner's decisions of 2026-11-19

Recorded so that no question answered here is asked again. The owner took them in person on 2026-11-19, in the morning. Each line names where its detail lives.

1. **The client floor is `1.7.0` on both estates.** *"On peut remonter la version à 1.7.0."* The owner checked that the App Store serves `1.7.0`, and Play's production track serves it too. `platform_config.min_client_version` was raised from `1.6.6` to `1.7.0` on dev and production by a guarded update, and `GET /api/version` was read back on each estate. This unblocks [legacy-compatibility](../legacy-compatibility.md)'s retirements of the shims the `1.7.0` floor meets (#3837).
2. **The `1.7.1` stable ships "as soon as everything passes".** *"Dès que tout passe, au plus tôt."* What is not ready and read moves on: the open entries spread over `1.7.1`, `1.7.2` and `1.7.3`. *"Tous ces trucs là sont pour la 1.7.1, 1.7.2, 1.7.3..."* When the stable is cut, the lead moves each `target:` line it does not carry and regenerates the [plan](../plan.md).
3. **Both bench phones stay plugged in permanently.** *"L'iPhone et le Mi 9T sont branchés en permanence."* A sitting may therefore count on both phones at any hour, and a reading is never deferred for want of a plugged phone.
4. **"Voir en tant que", for platform admins:**
   - feeds and posts only;
   - platform admins only;
   - no trace: *"c'est juste un outil de tests"*;
   - target `1.7.2`.

   Its entry is [admin-view-feeds-as-a-member](../backlog.d/admin-view-feeds-as-a-member.md).

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

   Its entry is [canaquiz-a-live-quiz-anyone-can-run](../backlog.d/canaquiz-a-live-quiz-anyone-can-run.md).

6. **The order after `1.7.x`: reliability first.** Security, then lives (the viewer ceiling, then replays), the single MLS state (WP-CHECKPOINT-CAS, in `1.8.0` right after the slow-link chantier), the self-updating server images, CanaQuiz, the MiConnect profiles, the usage dashboard, the device notices, and global search. The authorization and session-liveness audit is triaged at once and its fixes land in `1.7.3`. The verified-link mobile sign-in is trialled in `1.7.3` and switched over in `1.9.0`.
7. **The MiConnect (authentik) stack on the shared host is the project's own** (#3486). The IT department's no-touch rule covers the host, not our containers, and one line in [estate-migration](../infrastructure/estate-migration.md) says so. The release's rollback copies (identity database dumps, and `.env` copies holding the stack's secrets) are kept **3 copies and 30 days at most**.
8. **The videos already posted all become CanaReels** (migration 176, #3528): *"Oui, toutes."* The owner confirmed this after reading the production examples, landscape clips included. The rule for a NEW video stays "vertical or 90 s or less". The stored ones carry no length, so the rule cannot be read on them.
9. **A group seat with no active device is shown greyed, "aucun appareil actif"**, never hidden or removed. See [entry](../backlog.d/p2-the-group-panel-lists-22-roster-seats-that-hold-no-device.md), `1.7.2`.
10. **The tab-leader lock stays one per browser:** *"Fermer... pour le moment, rien à faire, tout marche bien."* A worker independent of the tabs may come later. The entry is deleted, and the remaining case is in [mls-protocol](../protocols/mls-protocol.md).
11. **The three public names not watched from outside: the gap is accepted.** *"Supprime cette entrée, on accepte le trou et on en parle plus avant que je remette le sujet sur la table."* The entry is deleted, and the question is not raised again until the owner reopens it. See [upstream-reachability](../infrastructure/upstream-reachability.md).
12. **A guest's file on a public form:** one file, 5 MB, a limit per address, a global quota, and a 24 h purge of unlinked files. See [entry](../backlog.d/a-file-question-on-a-public-form-needs-an-abuse-design.md).

13. **A guest's file is never scanned.** The accepted types are images and PDF only, and the server never opens a guest's file.
14. **WP5 (MiConnect decides the access to each application) ships in `1.9.0`.** Separately, arriving on the Cercle, Sky and the other MiConnect sites from Canari signs the user in automatically, through the one-time handoff MiGallery already uses ([entry](../backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md)).
15. **A live viewer is never refused.** Past the lowest quality rung, a viewer waits on "Connexion au direct...".
16. **The weekly image scan releases a digest bump by itself**, through the server-only release with its health check and rollback. Anything larger opens an issue.
17. **Everything left of Stripe is removed by the lead** (`1.7.2`), and the owner handles the administrative side ([entry](../backlog.d/owed-to-the-user-after-the-stripe-removal.md)).
18. **The second campaign is closed.** The server specs cover the remaining case, so the entry is deleted.

19. **Lives: the app's ceiling is 300 Mb/s, and the broadcaster moves to WebCodecs in `1.8.0`.** The 90 Mb/s was the workstation's own path. The ceiling is set in the app, and nothing is changed on the host ([entry](../backlog.d/live-host-egress-constant-rests-on-the-workstation-path.md)).
20. **New-device notices:** a local notification when the app is in the background, disabled in one gesture. A device already in a tree this device joins is not announced. A contact's line stays 7 days ([entry](../backlog.d/new-device-notices-three-decisions-owed.md)).
21. **Sealed conversations:** a lift is built only once the seals are counted and honest users are shown to reach them ([entry](../backlog.d/history-withheld-from-a-member-device-that-let-itself-in.md)).
22. **The encryption guide was read by the owner.** It stays frank about what the server sees, and says nothing of seals. It is linked from Settings only ([entry](../backlog.d/the-mls-and-graine-guide-owes-the-user-s-read-and-one-mls-client-in-a.md)).
23. **A grant reaches an institution of another campus**, as today.
24. **The "association enrolment with conditions and documents" item is dropped:** Lydia Pro collects the documents.
25. **The global search is dropped.** The post search gains filters by person and by association in `1.8.0` ([entry](../backlog.d/post-search-filters-by-person-and-by-association.md)).
26. **Several media in a post show as a carousel with a counter**, in `1.7.2` ([entry](../backlog.d/p2-a-post-s-media-layout-one-to-many-pictures-and-videos.md)).
27. **"Créer un groupe" from a form's respondents** (a user's request), in `1.8.0`. It applies to internal, non-anonymous forms, and the button goes to whoever reads the answers ([entry](../frontend/modules/forms.md#a-group-made-from-a-forms-respondents-owner-2026-11-19)).
28. **No Lydia re-enrolment:** *"On oublie tout ça."* Les Rootz have no Lydia account ([entry](../backlog.d/the-lydia-enrolment-and-cashier-chantier-decided-by-the-user-on-2026-1.md)).
29. **Readings:**
   - The second Android package for dev is for later.
   - The lead may reset one TEST account's terms acceptance on MiConnect for the terms-prompt reading, logged and reverted after.
   - The guest-payment reading on dev is waived: *"tout fonctionne"*.

30. **A platform admin can suspend an account, in Canari only**, in `1.9.0` ([entry](../backlog.d/a-platform-admin-suspends-an-account-in-canari.md)).
31. **A Lydia Responsable may not leave the association before handing over to another member** ([entry](../backlog.d/p2-a-lydia-cashier-add-binds-the-person-not-the-number-and-overwrites-a-number-lydia-knows.md), item 7).
32. **An institution's "Personnel" calendar event reaches the staff of its ticked campuses**, as posts do, in `1.8.0` ([entry](../backlog.d/institution-events-reach-staff-by-campus.md)).
33. **A device that dropped a frame does not tell its user.** The server reports the drop to the team.

34. **A post that is not published yet takes no comment** (`1.7.2`, [decision](../moderation-and-blocking.md#a-post-that-is-not-published-yet-takes-no-comment-owner-2026-11-19)).
35. **An institution reaches the staff of its campuses beyond posts:** its shop, partnerships, directory and lives (`1.8.0`, [entry](../backlog.d/institution-reaches-staff-by-campus-beyond-posts.md)).
36. **The short technical durations and the backups stay constants**, and only the long retentions become settings ([entry](../backlog.d/retention-durations-not-yet-settings.md)).
37. **Everything goes into `1.7.1`, the two held migrations included:** the CanaReels conversion (176) and the removal of Stripe. Each runs on dev through a pre-release before the stable.

38. **`1.8.0` ships in blocks** (`1.8.0`, `1.8.1`, `1.8.2`...), each a stable as soon as its block is ready, in the order of item 6. Nothing waits for the last chantier.
39. **CanaQuiz:** the results export is a summary PDF. A player who returns after a question's time is over gets 0 for it ([entry](../backlog.d/canaquiz-a-live-quiz-anyone-can-run.md)).
40. **The usage dashboard is for platform admins only** ([entry](../usage-dashboard.md)).
41. **The live card follows the feed tab:** under "Organisations", association lives only. "Pour toi" and "Campus" keep every live the reader may watch. Who may watch is unchanged (`1.7.2`, entry deleted 2026-11-22, read).
42. **Live replays went on in production before their texts, knowingly.** *"C'est assez urgent, il faudrait le faire dès que possible et l'activer en production"*, then *"Prod maintenant, textes juste après"*. `live_replays_mode` was set `on` in production and on dev on 2026-11-19 in the evening and read back through `GET /api/version` on both; the texts (CGU, privacy policy, register C19-C20, the pre-live screen) and `LIVE_RULES_VERSION` 3 followed in the next pull request ([live-replays](../live-replays.md#wp-r6-as-built-the-texts)).

43. **The 15-day notice of the terms change (CGU art. 14, privacy policy section 12) is the owner's to send:** *"Je m'en occupe"*.
44. **The fix for a live's sound drifting from its picture ships in `1.7.1` if it is proven before the last alpha, and otherwise in `1.7.2`. It never holds the stable.** It was proven on `1.7.1-alpha.5` (S13, [readings](../device-verification.md)).
45. **The Lydia cashier trial in production runs right after the `1.7.1` stable reaches production**, with the owner.
46. **The owner's replay report:** the broadcaster was probably an iPhone that flipped its camera several times. On the replay he saw no drift, but he did see the seek jump back (fixed by #3869 and #3870). He re-watches a replay once he is back.

**Taken by the lead under the standing delegation (reversible, written to the wiki):** a group-call participant's `room-empty` stops only that participant's own devices from ringing. It never ends the other members' rings: no in-app control lets a member join a call already in progress, and principle 2 of the [charter](../../principes.md) holds. The caller's own `room-empty` is unchanged. See [calls](../frontend/modules/calls.md) (WP-GC7, #3705).
