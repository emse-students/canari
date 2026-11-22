### Fixed - CI: the order-key derivation tests no longer depend on who wins a race with the page read

A page read starts a derivation nobody awaits, so a test calling `orderKeysDerived` afterwards joined it or, on a loaded runner, found it finished and read `derived: 0`. The cases now sum the keys over every run they caused; the product was correct ([testing-methodology](docs/wiki/testing-methodology.md)).
