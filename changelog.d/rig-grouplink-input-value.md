### Fixed - ADM rows wait for the group link where the panel puts it

`mintGroupLink` waited for the link in `innerHTML`, but the panel holds it in an input's `value` property, which `innerHTML` never shows. ADM-1 timed out on a panel that already showed the link. It now waits on the input it reads ([cross-client-testing](docs/wiki/cross-client-testing.md)).
