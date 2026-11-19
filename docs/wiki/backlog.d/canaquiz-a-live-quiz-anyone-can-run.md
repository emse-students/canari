## CanaQuiz - a live quiz anyone can run, with points and a ranking (owner, 2026-11-19)

target: 1.8.0

Designed with the owner on 2026-11-19 ([decisions](owner-decisions-of-2026-11-19.md)). Nothing is built yet.
It is a live quiz built the Canari way: a host runs it, the players answer from their phones, they
score on correctness and speed, and a ranking shows between the questions. **It is our own
design**: no other product's name, branding, layout or look is reused.

**Who runs it, and who plays: the same rules as a form** ([forms](../frontend/modules/forms.md)).

- Any member can create a CanaQuiz, either as a personal one or for an association they manage,
  with the same authority rules as a form.
- A quiz is either PUBLIC, so guests with no account join with its code or QR code, as on `/f/:id`,
  or RESTRICTED to the platform's members.
- A switch lets every player choose a pseudonym. Otherwise a member plays under their display
  name, and a guest always types a pseudonym.
- **No teams, ever.** The owner's words: *"Pas du tout. Pas d'équipe."*
- **No visible ceiling on the number of players.** The owner's words: *"Aucune limite"*. As with
  lives, the capacity is raised in measured steps, and the build owes a load measurement that
  names the first limit hit.

**Question types** (the owner's list, under our own names). Each scored question is worth 0, 1,000
or 2,000 points, chosen by its creator. Each question can carry an image, and has a time limit
set per question or for the whole quiz.

| Type | How a player answers | Scored |
| --- | --- | --- |
| Multiple choice | 2 to 6 answers (text or image); one or several correct; single or multi-select | yes |
| True / false | two fixed answers, one correct | yes |
| Typed answer | short text (20 characters) against up to 4 accepted answers; case, repeated spaces and punctuation are ignored; the host may accept another answer live | yes |
| Ordering | put 3 or 4 items in the right order | yes |
| Slider | a number on a range; a margin decides how close earns points (accuracy 80 %, speed 20 %) | yes |
| Pin on an image | tap the correct area of an image; the creator draws the area | yes |
| Poll | choose one or several answers; no right one | no |
| Word cloud | a word or a short phrase (20 characters); frequent answers are drawn larger | no |
| Open answer | up to 250 characters, shown on the host's screen | no |
| Brainstorm | up to 5 ideas each, grouped, then voted on; the 3 most voted ideas earn their authors points | votes only |
| Drop a pin | everyone pins an image; all pins show together | no |
| Scale | a 1-5 agreement scale, or a custom 0-10 scale with labels; a recommendation (NPS) variant | no |
| Slide | a text or image page between questions, not a question | no |

**Scoring.** A correct answer earns half the points, and the other half goes down with the
time taken to answer. **The server's clock times every answer**, from the moment it opened the
question to the moment it received the answer. A phone's clock is never trusted, so a slow link
costs only its own transit time.

**Screens.** The host chooses at launch between two modes:

- a PROJECTED web screen shows each question, while the phones show only the answer controls;
- or everything is shown on the phones, which suits a game played remotely.

Between questions, the projected screen shows the top 5 and each player sees their own rank and
points on their phone. A podium closes the game. Nobody is ever shown as last (kindness principle,
[charter](../../principes.md)).

**Moderation.** Free text reaches the big screen: word cloud, open answers, brainstorm ideas and
pseudonyms. Everything shows at once, and **the host hides any of it with one gesture**, or removes
a player from the game. Hidden text never appears in the results.

**Brainstorm grouping.** The server groups ideas that are identical or nearly identical, ignoring
case, accents and small typos, **with no AI and no third party** (independence principle). The
host can then fix the groups by hand.

**Results.** The host sees the per-question detail and the full ranking, and can export them.
**The results are deleted after 30 days**, through a retention sweep like the other retention
durations. The quiz itself stays and can be run again. The Art. 30 register is updated for the new
processing ([register](../compliance/register-of-processing.md)).

**Attention (principle 3).** A game is started by a person and played while it lasts. It sends no
re-engagement push, and a player is notified only of a game they joined.

**Building blocks already in Canari:**

- the form editor and its question model;
- the public form's guest identity;
- the WebSocket gateway, for the live state;
- the lives' "no visible ceiling" stepping;
- the minesweeper's ranking.

**Owed before it is built (design):**

- the live-state protocol: one authority, the server, holds the question and its timer, and every
  answer is idempotent by `(game, question, player)`;
- the reconnect rule: a player who drops returns to the current question with their score kept;
- the export format;
- the load test.

**Closed when** a game with each question type has been played end to end on dev:
- by a member and by a guest;
- in projected mode and in phones-only mode;
- with the ranking, the hide gesture and the 30-day sweep each read.
