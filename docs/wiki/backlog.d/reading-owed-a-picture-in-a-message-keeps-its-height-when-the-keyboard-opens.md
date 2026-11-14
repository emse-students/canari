## Reading owed - a picture in a message keeps its height when the keyboard opens

target: 1.7.0

**What is built:** a picture in a message keeps its height when the keyboard opens (`--keyboard-free-viewport-height`, 2026-11-13; unit test and the rule applied over CDP on the installed build, [chat](../frontend/modules/chat.md#a-picture-keeps-its-height-when-the-keyboard-opens-2026-11-13))

**The reading that closes it:** on the Mi 9T, the pre-release carrying it, LatinIME: a DM ending on a tall screenshot, the keyboard raised - the frame's height equal (567 px) with the keyboard up and down, and the end of the thread right above the composer
