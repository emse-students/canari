## Reading owed - the native chat socket races IPv6 and IPv4 and closes a connect it abandoned

target: 1.7.0

**What is built:** the native chat socket races IPv6 and IPv4 and closes a connect it abandoned (CALL-WS-V6, #2167, `v1.3.1`; [mobile](../frontend/mobile.md#the-native-socket-races-ipv6-and-ipv4))

**The reading that closes it:** on the Mi 9T, on the PC's hotspot with broken IPv6 (bench P6): `Connected to Chat Gateway` within a second, one `[WS-NET] ... while the preferred address was still pending` INFO line per connect (a WARN `... the preferred address FAILED` instead means IPv6 errored rather than hung - record which), no `[WS] native socket completed ... closing it` WARN, the iPhone's call ringing the phone; back on the bench Wi-Fi, no `[WS-NET]` line above debug
