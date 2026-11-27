## P3 - the Debian trixie base for the two Rust runtimes, and one MiConnect hardening still to do

target: 1.8.5

Left open by the owner's answers of 2026-10-23 ([decisions](../decisions/decided-by-the-user-on-2026-10-23-bookings-redesign-sharing-reels-calls.md)): (1) the two Rust runtimes still build `FROM debian:bookworm-slim`; the target is the Debian trixie base (the non-root half of the containers lot is done, [backlog](p3-two-service-images-still-run-as-root.md)). (2) Under MiConnect, impersonation is to be disabled; it is not visible in `infrastructure/authentik/`, so the first step is to state where it is set. (The profile-editor token's half - restricted to non-admin accounts - is built for `1.8.1`: its one write path refuses a superuser account, [authentik](../infrastructure/authentik.md#the-profile-editors-one-write-path-181).)
