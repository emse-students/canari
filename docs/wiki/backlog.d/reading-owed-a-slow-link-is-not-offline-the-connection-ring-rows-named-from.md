## Reading owed - a slow link is not offline, the connection ring, rows named from local names

target: 1.7.0

**What is built:** a slow link is not offline, the connection ring, rows named from local names (#3342, after the `1.6.10` throttled-link reading of 2026-11-11; [offline-and-weak-network](../frontend/offline-and-weak-network.md#the-connection-ring-owner-2026-11-11))

**The reading that closes it:** on a pre-release, the Mi 9T through the throttling CONNECT proxy (+800 ms RTT, 250 kbps down, 100 kbps up): no grey ring while answers still arrive; 1:1 rows named on the first frame of a cold start, initials before the PIN then names once unlocked; the ring a circle in light and dark on both headers; the live region announcing offline and back; and a feed video keeping its first frame across a tab round trip (#3337)
