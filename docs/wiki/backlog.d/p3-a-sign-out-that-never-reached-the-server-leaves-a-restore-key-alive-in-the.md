## P3 - a sign-out that never reached the server leaves a restore key alive in the Google backup

target: 1.10.0

A restore key dies with the session that registered it (`ON DELETE CASCADE`), and a sign-out revokes that session under a deadline (`clearAuthUnderway`). Past the deadline the row lives on for its 7-day idle life, and so does the key's copy in a Google backup taken before the sign-out: a new phone restored from that backup would restore a session its owner signed out of. The phone that signed out cannot do it (`canari_restore_attempted` is written at every sign-out). This is the residual the refresh row already has, made reachable from a restored phone. **Remedy, not built:** a durable sign-out - the revocation kept and retried until a status answers it - which is a sessions change, not a restore one ([account-restore](../account-restore.md#threat-model)).
