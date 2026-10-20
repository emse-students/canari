### Fixed - the native chat socket races IPv6 and IPv4, and closes a connect it abandoned

On a Wi-Fi handing out an IPv6 that routes nowhere, the phone app's chat socket waited 20 s on IPv6 and never connected within 15 s, so no message or call invite arrived live; it now connects by Happy Eyeballs, and a socket that completes after the deadline is closed instead of left open. The `no TURN relay candidate` call WARN now fires only when no direct pair works ([mobile](docs/wiki/frontend/mobile.md#the-native-socket-races-ipv6-and-ipv4)).
