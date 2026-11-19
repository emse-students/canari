### Changed - an unsealed history answer, or an ask with no key, is refused

With the `1.7.0` floor every build seals: an unsealed answer to a keyed ask is refused at error, an ask without `answerKey` is answered nothing, and an answer that cannot be addressed is never sent ([legacy-compatibility](docs/wiki/legacy-compatibility.md#entries-170-retires-the-floor-raise-of-both-estates-once-both-stores-serve-170)).
