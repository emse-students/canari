## P3 - Reading owed - a post's audio, the grid viewer's Download and the post page's full text, on both phones

target: 1.8.3

Built in `1.8.3` ([decisions](../decisions/owner-decisions-of-2026-11-26.md), item 4): a post's audio file plays in the voice-note player (`VoiceMessagePlayer`) instead of the engine's native controls, the viewer opened from a grid of media offers Download, and a post's own page shows its whole text. Read on the Mi 9T and the iPhone 12, on a pre-release:

1. **Audio:** open a post with an attached audio file (in the feed and on its page). It draws the conversations' strip with the speed control, no native controls; it plays, pauses and changes speed; its level matches a voice note's (a quiet file is brought up, a loud one is not louder than a note); starting another media pauses it.
2. **Download in a grid's viewer:** on a post of four or more pictures or videos, open the viewer from a cell and from the "+N" cell: the Download button appears once the media has loaded, saves THAT media, and after a swipe to the next one it saves the new one (never the previous file).
3. **Full text:** open a long post (more than eight lines) from the feed: its page shows the whole text with no "Voir plus", while the feed card keeps the fold.
