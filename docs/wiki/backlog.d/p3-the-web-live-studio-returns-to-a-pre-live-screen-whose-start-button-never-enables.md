## P3 - on the web, ending a live leaves the studio on a pre-live screen whose "Start the live" stays disabled on "Reading the live's rules..." (S13, 2026-11-20)

target: 1.7.2

Seen on `1.7.1-alpha.5` (dev), desktop Chrome, twice (after the first and after the third live ended)
([S13](../device-verification.md#the-readings-of-2026-11-20-s13-171-alpha5-replays-sound-under-15-fps-messages-and-the-iphone)):
after "End the live" (confirmed) the broadcaster overlay did not close; it showed the pre-live screen
("Go live", the scene buttons, the rules text) with the red button greyed and the line "Reading the
live's rules...", and it stayed so for at least two minutes: no `GET /api/lives/rules` was logged in that
time (the request is logged at every normal open, answered in about 110 ms), and the button never
enabled, so a second live cannot be started from that screen. Closing the overlay with its X and
opening "Publier > En direct" again reads the rules and starts normally
(the next live of the sitting did). A person who ends a live and wants to go on again meets a dead button with a line that
promises something that is not happening. **Not known**: whether the overlay is meant to close at the
end (the phones show a "Live termine" screen with "Fermer"); the web end screen was not read in
this state. **Test first**: end a live on the web seat and read the overlay's state and the rules
request.
