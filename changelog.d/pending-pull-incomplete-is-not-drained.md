### Fixed - a refused page no longer reads as a drained mailbox, and a stalled resend after a 401 is asked smaller

The pending pull throws a typed incomplete error on a non-2xx page, and the resend joins the page-halving ladder ([sessions](docs/wiki/sessions.md)).
