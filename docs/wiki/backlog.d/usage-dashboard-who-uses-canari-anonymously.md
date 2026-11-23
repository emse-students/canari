## The usage dashboard: who uses Canari, and how - anonymously (owner, 2026-11-16)

target: 1.8.0

**Owner, 2026-11-19:** the dashboard is seen by the PLATFORM ADMINS ONLY - aggregated figures, never a person ([decisions](../decisions/owner-decisions-of-2026-11-19.md)).

`/admin/status` today shows one measure: live sockets, sampled each minute, the period's peak, by
platform (web / android / ios) and app version ([chat-gateway census](../services/chat-gateway.md#the-anonymous-census-and-its-24-hour-series-2026-11-02)).
It answers "does the server hold", not "who uses Canari": a 30 s visit barely registers, the same
person returning ten times is never grouped, and "web" merges the phone and the computer.

The owner's decisions (2026-11-16 evening):

- **Distinct people per day, week and month**, in total, per platform and per version - counted
  without keeping who (a probabilistic distinct counter such as a Redis HyperLogLog per day; no id
  stored anywhere).
- **Six platform categories**: app Android, app iOS, app desktop, web on an Android phone, web on an
  iPhone, web on a computer. Derived at connection; only the category is kept, never the user agent.
- **Usage hours**: a week-by-hour map of when Canari is used.
- **Daily activity totals for the whole platform**: messages sent, posts, CanaReels, lives, calls,
  forms answered - per DAY only, never per hour, per platform or per conversation; no content, no
  author.
- **No small-number threshold** (the owner chose none, for activity, people and hours).
- **History**: the daily figures are kept with no limit (anonymous and tiny, so one school year can be
  compared with the next); the per-minute detail 30 days.

Owed with it: a line in the Art. 30 register and the privacy policy ([register-of-processing](../compliance/register-of-processing.md)),
citing principle 1 ("tes messages sont a toi": counted as volume only, never per conversation) and
principle 3 (the figures serve the platform's health, never engagement targets).
