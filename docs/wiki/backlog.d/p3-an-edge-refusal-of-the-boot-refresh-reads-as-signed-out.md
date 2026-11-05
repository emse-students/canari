## P3 - an edge 5xx or an HTML 403 on the boot refresh sends the user to login

`auth.ts` treats a 5xx, or a 403 an edge answered in HTML, as transient (the credential is untouched),
but the boot's session question ([bootSession](../frontend/offline-and-weak-network.md#first-paint-never-waits-on-the-network-the-boot-session-question-2026-11-05))
only reads a transport failure as "unreachable"; any other refusal routes to login. A user behind a
failing edge is shown a sign-in page that is not the truth. Fix: have the refresh throw a typed
transient error for those statuses and let the boot read it like a transport failure; test it with a
503 and an HTML 403.
