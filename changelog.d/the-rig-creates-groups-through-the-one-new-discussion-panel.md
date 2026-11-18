### Fixed - the cross-client rig creates a group through the single "Nouvelle discussion" panel

`createGroup` and `createDM` now drive the people-first panel by stable test ids (`new-chat-proceed`,
`new-group-submit`) and `closeOverlays` closes a panel left open
([cross-client-harness](tools/cross-client-harness/README.md)).
