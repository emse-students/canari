### Changed - the call reading across networks: relayed calls are clean, CALL-GATHER-0 is a false alarm, a P1 found

Forced relay (UDP, TCP, TLS 443) carries clean E2E audio on desktops and both phones; the callee's "no TURN relay candidate" warning fires whenever the direct pair wins first; and on a Wi-Fi with broken IPv6 the Android chat socket never connects, so no call rings (CALL-WS-V6) ([readings](docs/wiki/device-readings-2026-10.md#2026-10-20-afternoon---v131-alpha4-across-networks-forced-relay-tcp-and-tls-turn-a-nated-hotspot)).
