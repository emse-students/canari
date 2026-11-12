### Changed - `/history/batch` reads every group's arrival facts in one query each

The arrival facts behind the reader's withheld span were read twice per group. They are now read once per request, so a 50-group batch makes two queries ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md), D062).
