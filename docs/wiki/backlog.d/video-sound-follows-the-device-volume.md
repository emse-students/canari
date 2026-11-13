## P3 - the video speaker does not follow the device volume (owner, 2026-11-09)

target: 1.10.0

The owner's sound decision for the shared video player includes *"follow the device volume where the
platform exposes it (muted glyph at volume 0)"* - Instagram does, measured on the Mi 9T: at volume 0
the speaker shows struck, and raising the volume restores it. **No WebView exposes the system volume**
(`HTMLMediaElement.volume` is the element's own gain), so it needs a native producer on each phone:
Android `AudioManager.getStreamVolume(STREAM_MUSIC)` plus the volume-changed broadcast, iOS
`AVAudioSession.outputVolume` observed by KVO, each posted to the page like the theme bridge
(`themeStore.svelte.ts`). The consumer is `videoSound` (`stores/videoSound.svelte.ts`): an
`effective muted` that reads "volume 0" as muted for the glyph, WITHOUT writing the reader's stored
choice. Nothing of it exists yet; not built in the player PRs because it is native work on both shells
([video-player](../frontend/modules/video-player.md#the-sound-state)).
