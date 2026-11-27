## The mail client for the school mailbox (Partage), in four lots (owner, 2026-11-27)

target: 1.10.0

**Decided by the owner on 2026-11-27**, with the mockups validated the same day. The design, the
charter citations, the twelve decisions and every measurement are on [mail-client](../mail-client.md),
the only copy.

The lots, in order:

1. the transport: rustls in WASM and native, and the blind relay in `chat-gateway`;
2. the Zimbra client: sign-in, the sealed password, mail, actions, the directory, typed errors;
3. the screens and the "Mail" tab, the HTML sandbox, and the register and privacy lines;
4. Android notifications, with a battery measurement.

The whole is built behind a server switch, off by default. It ships with the desktop app
([entry](a-desktop-app-for-windows-macos-and-linux.md)).
