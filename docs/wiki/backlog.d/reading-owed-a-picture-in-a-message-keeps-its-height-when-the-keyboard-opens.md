## Reading owed - a picture in a message keeps its height when the keyboard opens

target: 1.7.0

**What is built:** a picture in a message keeps its height when the keyboard opens (`--keyboard-free-viewport-height`, 2026-11-13; unit test and the rule applied over CDP on the installed build, [chat](../frontend/modules/chat.md#a-picture-keeps-its-height-when-the-keyboard-opens-2026-11-13))

**The reading that closes it:** on the Mi 9T, the pre-release carrying it, LatinIME: a DM ending on a tall screenshot, the keyboard raised - the frame's height equal (567 px) with the keyboard up and down, and the end of the thread right above the composer

**Read on the Mi 9T 2026-11-14 (`1.6.12`, dev, LatinIME), the mechanism half:** the variable is 945 px with the keyboard up and unset down, a 256 CSS px picture keeps its height over two cycles and the thread ends right above the composer ([chat](../frontend/modules/chat.md#a-picture-keeps-its-height-when-the-keyboard-opens-2026-11-13)). **Left: the tall screenshot itself** (a DM carrying a 567 px frame), sent from the second bench account.
