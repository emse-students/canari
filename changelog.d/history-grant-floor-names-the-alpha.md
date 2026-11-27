### Fixed - the "send history" button can be read on a pre-release estate

The button was gated on a client floor of `1.8.3`, which no pre-release estate can serve (a 1.8.3 alpha orders below it and would be locked out). The gate now names the first alpha that draws the notice (`1.8.3-alpha.1`), the floor setting accepts `x.y.z-alpha.N`, and the server and the version report order pre-releases like the client does ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-member-may-send-their-history-to-a-newcomer-owner-2026-11-25)).
