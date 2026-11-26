## Reading owed - the picked file's copy shows its progress, and a pick over the ceiling is said as too large (2026-11-26)

target: 1.8.2

Built and unit-tested; the native half compiles and is read on the Mi 9T ([chat](../frontend/modules/chat.md#what-the-picked-files-copy-tells-the-page-2026-11-26)).

1. A large PDF (tens of MB) picked in the composer: a "Lecture du fichier..." line with a rising percent shows until it is staged.
2. A non-video over 200 MB (a large PDF or archive): the banner says it is too large with the 200 Mo limit, not "could not be read"; the in-app log carries the `PickedFiles` line `refused: ... over 200 MB` once.
3. A video over 200 MB (a long camera clip): it is copied (progress shown), prepared by the encoder and sent. A failing disk would be refused, said.
4. A Google Photos cloud item: no `PickedFiles` WARN line (a provider stating no size is a debug line).
5. A log save to Downloads: ONE `[download]` line for the provider's recorded size (debug when it matches), none from Kotlin or Rust above debug.
