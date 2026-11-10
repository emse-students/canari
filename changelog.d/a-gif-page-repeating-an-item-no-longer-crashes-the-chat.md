### Fixed - scrolling the GIF tab no longer crashes the chat page when KLIPY repeats an item across two pages

The GIF grid keys its tiles by id and appended page 2 as it came, so one repeated id was a Svelte `each_key_duplicate`. Pages are now merged by id (`mergeGifPages`), the first occurrence kept and the count dropped logged at debug level.
