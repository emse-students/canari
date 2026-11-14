## Reading owed - one live notification per post, on both phones

target: 1.7.0

**What is built:** comments and reactions on your own post leave the daily cap and come as ONE
notification per post, replaced in place, ringing only when the post had no unread bell row (owner,
2026-11-14; [engagement](../engagement.md#the-owners-decision-of-2026-11-14---what-concerns-you-directly-is-never-dropped-one-live-notification-per-post)).
The server half is proven on PostgreSQL; Android compiled; the iOS NSE and `canari_push.mm` were NOT
compiled (Windows), and that a remote push under `apns-collapse-id` and a local request with the same
identifier replace each other is inferred, not read.

**The reading that closes it**, on the Mi 9T and the iPhone 12, app killed and app open, against dev:

- three accounts comment the bench account's post: ONE notification, one ring, titled
  "X et 2 autres ont commenté";
- open the bell (the post read), comment again: it rings again;
- three reactions: one notification, "3 réactions", rung once;
- the quiet updates neither sound nor show a banner; the iPhone build compiles.
