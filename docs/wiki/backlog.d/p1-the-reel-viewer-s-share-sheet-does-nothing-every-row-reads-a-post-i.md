## P1 - The reel viewer's share sheet does nothing: every row reads a post id its own close erased (Mi 9T, 2026-10-28)

In the CanaReels viewer, "Partager" opens `PostShareSheet`, and each of its rows - a conversation of
the grid, "Copier le lien", "Partager via..." - closes the sheet and nothing else happens: no
landing, no clipboard, no chooser, and the WebView logs `Uncaught TypeError: Cannot read properties
of null (reading 'slice')` (three of three rows read, 1.5.1 `da43b8447`). **The cause, read in the
code:** the sheet's `act()` calls `close()` BEFORE the action, and `ReelViewer` mounts the sheet with
`postId={shareFor}` and `onClose={() => (shareFor = null)}`; the action then reads the live prop,
now `null`, and `sendPostLinkInApp` / `copyPostLink` / `sharePostLinkOut` throw on `postId.slice`.
The post menu and the `/posts/<id>` page pass a constant id and a boolean `open`, which is why the
same sheet works there. Fix where the id is read: the row captures `postId` before it closes, and a
viewer test drives a row of the REAL sheet rather than `PostShareSheetStub`, whose one button
closes and never reads the id afterwards. #2609's "the viewer closes after an in-app send" is unread until then.
**Fix MERGED (#2644), read `PASS` on the Mi 9T, rig build `203e46606` on dev (2026-10-28), synthetic reel:**
a tap on a conversation of the viewer's sheet closes the viewer and opens that DM with the reel's link
waiting in its composer, NOT sent (#2609's dismissal; `[sharePost] sending the link of <id>`, then
`[SHARE] landing on <conversation>`). "Partager via..." opens the system chooser on the link, and
"Copier le lien" logs `copying the public link of <id>`. No error in the window. The draft was cleared
and the reel deleted.
