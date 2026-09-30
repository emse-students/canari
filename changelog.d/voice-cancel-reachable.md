### Fixed - sliding a voice note to the screen edge cancels it instead of sending it

The cancel distance (96 px) was larger than the room left of the microphone on a phone (~86 px), so a real finger could never reach the bin and releasing at the edge sent the note. It is now capped to the room available, and the hint carries a chevron showing which way to slide. Found on an iPhone 12 and a Mi 9T, 2026-09-30.
