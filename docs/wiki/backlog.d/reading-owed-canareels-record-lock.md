## Reading owed - CanaReels: slide to the padlock locks a take, one tap on stop ends it

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

Built 2026-11-27 (`feat/canareels-record-lock`, owner decision of the day): while a take is held, a
padlock appears left of the shutter; lifting the finger over it keeps recording hands-free and the
shutter shows stop ([reels](../frontend/modules/reels.md#slide-to-lock-owner-2026-11-27)). The reducer, the
rectangle test and the shutter's gesture are pinned by unit and component tests; happy-dom draws no
frame and has no thumb.

The reading, on the Mi 9T and the iPhone 12, on the first alpha carrying it, in a CanaReels take:
(1) hold the shutter 3 s and lift: the take ends as before; (2) hold, slide the thumb left onto the
padlock (it lights up), lift: recording continues, the button shows stop, the timer keeps counting;
tap stop: the take ends and goes to the review; (3) hold, slide onto the padlock, slide back off, lift:
the take ends (not locked); (4) a short tap still takes a photo. **Passes when** all four hold, the
page never scrolls or selects during the slide, and the padlock clears the floating tab bar and the
notch on both phones.
