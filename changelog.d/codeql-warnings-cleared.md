### Fixed - the fifteen open CodeQL warnings are fixed in the code, not dismissed

Twelve were a test stub of `ResizeObserver` with no constructor parameter; the others re-checked a flag the compiler had narrowed to `false` (`ChannelService` boot reads), a dead initial assignment (`pinSessionRefusal`) and a returnless call's result (`focusOnMount.test`). None was a runtime bug.
