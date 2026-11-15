## P3 - a comment push tapped while its post is the page left open lands on the post, not on the comment

target: 1.8.0

**Read 2026-11-15 on dev (iPhone 12, TestFlight `1.6.12-alpha.2`), 1 of 1.** Gamma had the post
`6e5b6c16` open with its comments sheet, went to the home screen, and the delta web seat replied to
gamma's comment there; the "a répondu" row, held and tapped, brought the app back on that post with
the sheet CLOSED and the new reply neither loaded nor ringed. The same gesture with the app left on
the chat list opened the post with the sheet open and the reply ringed. So a notification link to the
route already on screen (same post, a new `?comment=`) is not acted on. The fix reads the
`comment` parameter on a navigation to the current post too; the reading is this gesture twice.
