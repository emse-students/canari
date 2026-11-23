## P3 - the Debian trixie base for the two Rust runtimes, and two MiConnect hardenings still to do

target: 1.9.0

Left open by the owner's answers of 2026-10-23 ([decisions](../decisions/decided-by-the-user-on-2026-10-23-bookings-redesign-sharing-reels-calls.md)): (1) the two Rust runtimes still build `FROM debian:bookworm-slim`; the target is the Debian trixie base (the non-root half of the containers lot is done, [backlog](p3-two-service-images-still-run-as-root.md)). (2) Under MiConnect, impersonation is to be disabled and the profile-editor token restricted to non-admin accounts; neither is visible in `infrastructure/authentik/`, so the first step is to state where each is set.
