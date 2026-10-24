### Security - client-side bounds on server-provided retention

The Graine seed sweep never uses a window shorter than the product's 365 days, whatever the server answers, and says so at `error` when the answer is below it ([channel-encryption](docs/wiki/protocols/channel-encryption.md#8-retention-one-window-and-the-seeds-derived-from-it---shipped-2026-08-19)).
