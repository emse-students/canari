### Changed - the chat entry-window test runs on fake timers, so it checks the arithmetic and not the clock

It no longer waits on real animation frames and 250/600 ms timers; it advances them explicitly. Full-suite starvation of happy-dom is a separate, still-open cause.
