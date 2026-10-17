### Security - an association response no longer carries its Lydia vendor token, dashboard URL or vault key

Every signed-in member could read the token, which with a request id is all Lydia's cancel needs; the member reads are now an allowlist and the Lydia panel reads the account from a MANAGE_PAYOUT_ACCOUNT route ([forms](docs/wiki/frontend/modules/forms.md#what-a-client-reads-of-a-submission-is-an-allowlist-2026-10-15)).
